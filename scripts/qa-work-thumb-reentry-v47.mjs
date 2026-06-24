import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/nian-nian-002';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertSourcePort() {
  const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const checks = [
    ['thumb order delay', 'imageEnterAt: now + (participates ? mediaOrder * 80 : 0)'],
    ['thumb reset class off', "thumb.classList.toggle('is-thumb-image-visible', visible)"],
    ['thumb fresh target reset', 'motion.imageTargetOpacity = 0;'],
    ['thumb reveal class', "thumb.classList.add('is-thumb-image-visible')"],
    ['work media reset class', "classList.toggle('is-work-media-resetting', resetFx)"],
  ];
  const cssChecks = [
    ['thumb base has no transition', '.detail-thumb span'],
    ['thumb visible transition', '.gallery-shell.is-work .detail-thumb.is-thumb-image-visible span'],
    ['reset disables thumb transition', '.gallery-shell.is-work-media-resetting .detail-thumb span'],
  ];
  const missing = [
    ...checks.filter(([, needle]) => !main.includes(needle)),
    ...cssChecks.filter(([, needle]) => !css.includes(needle)),
  ];
  if (missing.length) {
    throw new Error(`Missing Work thumbnail re-entry source checks: ${missing.map(([label]) => label).join(', ')}`);
  }
}

async function getPageWebSocket() {
  const targets = await fetch(`${CDP_URL}/json`).then((response) => response.json());
  const page = targets.find((target) => target.type === 'page') || targets[0];
  if (!page?.webSocketDebuggerUrl) throw new Error('No Chrome page target available.');
  return page.webSocketDebuggerUrl;
}

function createCdpClient(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const events = [];
  let nextId = 1;

  socket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.id && pending.has(payload.id)) {
      const { resolve, reject } = pending.get(payload.id);
      pending.delete(payload.id);
      if (payload.error) reject(new Error(payload.error.message));
      else resolve(payload.result || {});
      return;
    }
    if (payload.method) events.push(payload);
  });

  const open = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  return {
    events,
    async send(method, params = {}) {
      await open;
      const id = nextId;
      nextId += 1;
      const promise = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      socket.send(JSON.stringify({ id, method, params }));
      return promise;
    },
    close() {
      socket.close();
    },
  };
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    awaitPromise: true,
    expression,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const description = details.exception?.description || details.text || 'Runtime evaluation failed.';
    throw new Error(description);
  }
  return result.result?.value;
}

async function screenshot(client, path) {
  const result = await client.send('Page.captureScreenshot', {
    captureBeyondViewport: false,
    format: 'png',
    fromSurface: true,
  });
  fs.writeFileSync(path, Buffer.from(result.data, 'base64'));
}

async function key(client, keyName, code, keyCode) {
  await client.send('Input.dispatchKeyEvent', {
    code,
    key: keyName,
    nativeVirtualKeyCode: keyCode,
    type: 'keyDown',
    windowsVirtualKeyCode: keyCode,
  });
  await client.send('Input.dispatchKeyEvent', {
    code,
    key: keyName,
    nativeVirtualKeyCode: keyCode,
    type: 'keyUp',
    windowsVirtualKeyCode: keyCode,
  });
}

async function waitForMode(client, mode) {
  const ok = await evaluate(client, `
    new Promise((resolve) => {
      const ready = () => document.querySelector('.gallery-shell')?.dataset.mode === ${JSON.stringify(mode)};
      if (ready()) resolve(true);
      const started = performance.now();
      const timer = setInterval(() => {
        if (ready() || performance.now() - started > 8000) {
          clearInterval(timer);
          resolve(Boolean(ready()));
        }
      }, 50);
    })
  `);
  if (!ok) throw new Error(`Timed out waiting for mode ${mode}.`);
}

async function sample(client, label) {
  return evaluate(client, `(() => {
    const shell = document.querySelector('.gallery-shell');
    const thumbs = [...document.querySelectorAll('.detail-thumb.is-work-media')]
      .map((button) => {
        const image = button.querySelector('span');
        const style = getComputedStyle(button);
        const imageStyle = image ? getComputedStyle(image) : null;
        return {
          index: Number(button.dataset.index),
          order: Number(button.dataset.workOrder),
          active: button.classList.contains('is-active'),
          visibleClass: button.classList.contains('is-thumb-image-visible'),
          opacity: Number(style.opacity),
          y: parseFloat(button.style.getPropertyValue('--thumb-y') || '0'),
          styleImageOpacity: parseFloat(button.style.getPropertyValue('--thumb-image-opacity') || '0'),
          computedImageOpacity: imageStyle ? Number(imageStyle.opacity) : -1,
          transitionDuration: imageStyle ? imageStyle.transitionDuration : '',
        };
      })
      .sort((a, b) => a.order - b.order);
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      resetClass: shell?.classList.contains('is-work-media-resetting') || false,
      media: thumbs.slice(0, 5),
    };
  })()`);
}

assertSourcePort();

const client = createCdpClient(await getPageWebSocket());
try {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
  await client.send('Page.navigate', { url: TARGET_URL });
  await waitForMode(client, 'detail');
  await sleep(800);

  await key(client, 'e', 'KeyE', 69);
  await waitForMode(client, 'work');
  await sleep(1500);
  const firstStable = await sample(client, 'first-work-stable');
  await screenshot(client, '/tmp/local-work-thumb-reentry-v47-first-stable.png');

  await key(client, 'p', 'KeyP', 80);
  await waitForMode(client, 'detail');
  await sleep(550);

  await key(client, 'e', 'KeyE', 69);
  await waitForMode(client, 'work');
  await sleep(40);
  const early = await sample(client, 'reentry-40ms');
  await screenshot(client, '/tmp/local-work-thumb-reentry-v47-40ms.png');

  await sleep(90);
  const delayed = await sample(client, 'reentry-130ms');
  await screenshot(client, '/tmp/local-work-thumb-reentry-v47-130ms.png');

  await sleep(1350);
  const stable = await sample(client, 'reentry-stable');
  await screenshot(client, '/tmp/local-work-thumb-reentry-v47-stable.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];
  const first0 = firstStable.media[0];
  const early0 = early.media[0];
  const early1 = early.media[1];
  const delayed0 = delayed.media[0];
  const delayed1 = delayed.media[1];

  if (firstStable.mode !== 'work' || firstStable.media.length !== 5) {
    failures.push(`Expected first Work visit to expose five thumbnails, got ${JSON.stringify(firstStable)}.`);
  }
  if (!first0 || first0.computedImageOpacity < 0.98) {
    failures.push(`Expected first Work thumbnail 0 to settle visible, got ${JSON.stringify(first0)}.`);
  }
  if (!early0 || !early0.visibleClass || early0.opacity <= 0 || early0.opacity >= 0.9 || early0.y < 80) {
    failures.push(`Expected thumbnail order 0 to restart mid-fade on fresh Work re-entry, got ${JSON.stringify(early0)}.`);
  }
  if (!early1 || early1.computedImageOpacity > 0.05 || early1.visibleClass) {
    failures.push(`Expected thumbnail order 1 to wait for its 80ms reveal gate at 40ms, got ${JSON.stringify(early1)}.`);
  }
  if (!delayed0 || delayed0.computedImageOpacity <= early0.computedImageOpacity) {
    failures.push(`Expected thumbnail order 0 to keep fading in by 130ms, got ${JSON.stringify({ early0, delayed0 })}.`);
  }
  if (!delayed1 || delayed1.computedImageOpacity <= 0 || delayed1.computedImageOpacity >= 0.9) {
    failures.push(`Expected thumbnail order 1 to be mid-fade after its 80ms reveal gate, got ${JSON.stringify(delayed1)}.`);
  }
  if (stable.media.some((thumb) => thumb.computedImageOpacity < 0.98 || Math.abs(thumb.y) > 2)) {
    failures.push(`Expected all Work thumbnails to settle visible at y 0, got ${JSON.stringify(stable.media)}.`);
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: [
      '/tmp/local-work-thumb-reentry-v47-first-stable.png',
      '/tmp/local-work-thumb-reentry-v47-40ms.png',
      '/tmp/local-work-thumb-reentry-v47-130ms.png',
      '/tmp/local-work-thumb-reentry-v47-stable.png',
    ],
    firstStable,
    early,
    delayed,
    stable,
    runtimeExceptions,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  client.close();
}
