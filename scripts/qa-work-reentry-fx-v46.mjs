import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/webgl-gallery-002';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertSourcePort() {
  const main = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const checks = [
    ['preserveImages option', 'function primeWorkLayerMotion(options = {})'],
    ['default reset branch', 'const { preserveImages = false } = options;'],
    ['reference fresh Work entry', 'primeWorkLayerMotion({ preserveImages: preserveWorkFx });'],
    ['resize preserves visible Work images', 'primeWorkLayerMotion({ preserveImages: true });'],
    ['About return preservation gate', 'previousMode === VIEW.about && state.aboutReturnMode === VIEW.work'],
    ['reset class toggle', "classList.toggle('is-work-media-resetting', resetFx)"],
    ['reset reflow gate', 'void galleryEls.workStage?.offsetHeight;'],
  ];
  const cssChecks = [
    ['work layer reset CSS', '.gallery-shell.is-work-media-resetting .work-layer-img'],
    ['thumb reset CSS', '.gallery-shell.is-work-media-resetting .detail-thumb span'],
  ];
  const missing = [
    ...checks.filter(([, needle]) => !main.includes(needle)),
    ...cssChecks.filter(([, needle]) => !css.includes(needle)),
  ];
  if (missing.length) {
    throw new Error(`Missing Work re-entry fx source checks: ${missing.map(([label]) => label).join(', ')}`);
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
    const active = document.querySelector('.work-layer.is-active');
    const img = active?.querySelector('.work-layer-img');
    const bg = active?.querySelector('.work-layer-bg');
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      activeIndex: active ? Number(active.dataset.workIndex) : -1,
      activeY: parseFloat(active?.style.getPropertyValue('--work-layer-y') || '0'),
      styleImageOpacity: parseFloat(active?.style.getPropertyValue('--work-layer-opacity') || '0'),
      computedImageOpacity: img ? Number(getComputedStyle(img).opacity) : -1,
      bgOpacity: bg ? Number(getComputedStyle(bg).opacity) : -1,
      transform: active ? getComputedStyle(active).transform : '',
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
  await screenshot(client, '/tmp/local-work-reentry-fx-v46-first-stable.png');

  await key(client, 'p', 'KeyP', 80);
  await waitForMode(client, 'detail');
  await sleep(550);
  const detail = await sample(client, 'returned-detail');

  await key(client, 'e', 'KeyE', 69);
  await waitForMode(client, 'work');
  await sleep(60);
  const reentryEarly = await sample(client, 'reentry-60ms');
  await screenshot(client, '/tmp/local-work-reentry-fx-v46-60ms.png');

  await sleep(180);
  const reentryFade = await sample(client, 'reentry-240ms');
  await screenshot(client, '/tmp/local-work-reentry-fx-v46-240ms.png');

  await sleep(1300);
  const reentryStable = await sample(client, 'reentry-stable');
  await screenshot(client, '/tmp/local-work-reentry-fx-v46-stable.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];

  if (firstStable.mode !== 'work' || firstStable.activeIndex !== 1 || firstStable.computedImageOpacity < 0.98) {
    failures.push(`Expected first Work visit to settle on visible index 1, got ${JSON.stringify(firstStable)}.`);
  }
  if (detail.mode !== 'detail') {
    failures.push(`Expected p key to return to Detail before re-entry, got ${JSON.stringify(detail)}.`);
  }
  if (reentryEarly.mode !== 'work' || reentryEarly.activeIndex !== 1) {
    failures.push(`Expected re-entry to Work index 1, got ${JSON.stringify(reentryEarly)}.`);
  }
  if (reentryEarly.computedImageOpacity > 0.05) {
    failures.push(`Expected fresh Work re-entry image to remain visually reset early, got ${JSON.stringify(reentryEarly)}.`);
  }
  if (reentryEarly.activeY < 80) {
    failures.push(`Expected fresh Work re-entry active layer to start below center, got y ${reentryEarly.activeY}.`);
  }
  if (
    reentryFade.styleImageOpacity < 0.98 ||
    reentryFade.computedImageOpacity <= 0 ||
    reentryFade.computedImageOpacity >= 0.98
  ) {
    failures.push(`Expected fresh Work re-entry to be mid-fade after reveal gate, got ${JSON.stringify(reentryFade)}.`);
  }
  if (reentryStable.computedImageOpacity < 0.98 || Math.abs(reentryStable.activeY) > 1.5) {
    failures.push(`Expected re-entry to settle with visible centered image, got ${JSON.stringify(reentryStable)}.`);
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: [
      '/tmp/local-work-reentry-fx-v46-first-stable.png',
      '/tmp/local-work-reentry-fx-v46-60ms.png',
      '/tmp/local-work-reentry-fx-v46-240ms.png',
      '/tmp/local-work-reentry-fx-v46-stable.png',
    ],
    firstStable,
    detail,
    reentryEarly,
    reentryFade,
    reentryStable,
    runtimeExceptions,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  client.close();
}
