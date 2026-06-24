import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/nian-nian-002';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const title = document.querySelector('.project-shadow-title-active');
    const chars = [...title.querySelectorAll('.title-line:first-child .title-char')].slice(0, 4);
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      titleClass: title?.className || '',
      lineTransform: getComputedStyle(title.querySelector('.title-line:first-child')).transform,
      chars: chars.map((char) => {
        const rect = char.getBoundingClientRect();
        const style = getComputedStyle(char);
        return {
          index: Number(char.style.getPropertyValue('--char-index') || char.dataset.charIndex || 0),
          left: Number(rect.left.toFixed(2)),
          transitionDelay: style.transitionDelay,
          transitionDuration: style.transitionDuration,
          transitionProperty: style.transitionProperty,
        };
      }),
    };
  })()`);
}

function matrixScaleX(transform) {
  const match = transform.match(/matrix\(([^,]+)/);
  if (!match) return Number.NaN;
  return Number.parseFloat(match[1]);
}

const client = createCdpClient(await getPageWebSocket());
try {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
  await client.send('Page.navigate', { url: TARGET_URL });
  await waitForMode(client, 'detail');
  await sleep(900);
  const detail = await sample(client, 'detail-stable');
  await screenshot(client, '/tmp/local-title-work-delay-v23-detail.png');

  await key(client, 'e', 'KeyE', 69);
  await waitForMode(client, 'work');
  await sleep(300);
  const work300 = await sample(client, 'work-300ms');
  await screenshot(client, '/tmp/local-title-work-delay-v23-300ms.png');

  await sleep(1100);
  const workStable = await sample(client, 'work-stable');
  await screenshot(client, '/tmp/local-title-work-delay-v23-stable.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];
  const detailDelayMs = detail.chars.map((char) => Number.parseFloat(char.transitionDelay) * 1000);
  const workDelayMs = work300.chars.map((char) => Number.parseFloat(char.transitionDelay) * 1000);
  const detailPositions = detail.chars.map((char) => char.left);
  const workPositions = work300.chars.map((char) => char.left);
  const stablePositions = workStable.chars.map((char) => char.left);
  const work300ScaleX = matrixScaleX(work300.lineTransform);
  const workStableScaleX = matrixScaleX(workStable.lineTransform);

  if (detail.mode !== 'detail') failures.push(`Expected Detail before Work entry, got ${detail.mode}.`);
  if (work300.mode !== 'work' || workStable.mode !== 'work') {
    failures.push(`Expected Work after pressing e, got ${JSON.stringify({ work300: work300.mode, workStable: workStable.mode })}.`);
  }
  if (detailDelayMs[1] < 8) {
    failures.push(`Expected Detail/Home-position title to retain staggered return delay, got ${JSON.stringify(detail.chars)}.`);
  }
  if (workDelayMs.some((delay) => delay !== 0)) {
    failures.push(`Expected Work title horizontal move to have zero per-character delay, got ${JSON.stringify(work300.chars)}.`);
  }
  if (!(work300ScaleX < 0.95 && work300ScaleX > 0.83)) {
    failures.push(`Expected Work title line to be moving toward 0.84 scale at 300ms, got ${work300.lineTransform}.`);
  }
  if (Math.abs(workStableScaleX - 0.84) > 0.002) {
    failures.push(`Expected stable Work title line scale to settle at 0.84, got ${workStable.lineTransform}.`);
  }
  if (workPositions.every((left, index) => Math.abs(left - detailPositions[index]) < 2)) {
    failures.push(`Expected title letters to move between Detail and Work at 300ms, got ${JSON.stringify({ detailPositions, workPositions })}.`);
  }
  if (stablePositions.some((left, index) => Math.abs(left - workPositions[index]) > 180)) {
    failures.push(`Expected Work stable positions to continue same target track, got ${JSON.stringify({ workPositions, stablePositions })}.`);
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: [
      '/tmp/local-title-work-delay-v23-detail.png',
      '/tmp/local-title-work-delay-v23-300ms.png',
      '/tmp/local-title-work-delay-v23-stable.png',
    ],
    detail,
    work300,
    workStable,
    runtimeExceptions,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  client.close();
}
