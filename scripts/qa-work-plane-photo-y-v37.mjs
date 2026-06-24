import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/nian-nian-002';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertSourcePort() {
  const main = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const checks = [
    'const detailPhotoY = 0;',
    'const workPhotoY = detailLarge ? -0.1 : detailPhotoY;',
    'canvas.dataset.activePlanePhotoY = uniforms.uPhotoY.value.toFixed(4);',
    'canvas.dataset.activePlanePhotoYTarget = photoYTarget.toFixed(4);',
    'canvas.dataset.activePlaneTargetYPx =',
  ];
  const missing = checks.filter((needle) => !main.includes(needle));
  if (missing.length) throw new Error(`Missing reference plane pY source checks: ${missing.join(', ')}`);
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
    const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(description || 'Runtime evaluation failed.');
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
        if (ready() || performance.now() - started > 10000) {
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
    const canvas = document.querySelector('#webgl');
    const data = canvas?.dataset || {};
    const number = (value) => Number.parseFloat(value || '0');
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      photoY: number(data.activePlanePhotoY),
      photoYTarget: number(data.activePlanePhotoYTarget),
      targetTopPx: number(data.activePlaneTargetYPx),
      targetH: number(data.activePlaneTargetH),
      workTarget: number(data.activePlaneWorkTarget),
      workMix: number(data.activePlaneWorkMix),
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
  await sleep(1400);
  const detail = await sample(client, 'detail-stable');
  await screenshot(client, '/tmp/local-work-plane-photo-y-v37-detail.png');

  await key(client, 'e', 'KeyE', 69);
  await waitForMode(client, 'work');
  await sleep(360);
  const workEarly = await sample(client, 'work-360ms');
  await screenshot(client, '/tmp/local-work-plane-photo-y-v37-work-360ms.png');

  await sleep(1500);
  const workStable = await sample(client, 'work-stable');
  await screenshot(client, '/tmp/local-work-plane-photo-y-v37-work-stable.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];

  if (detail.mode !== 'detail') failures.push(`Expected Detail mode, got ${detail.mode}.`);
  if (Math.abs(detail.photoYTarget) > 0.001 || Math.abs(detail.photoY) > 0.02) {
    failures.push(`Expected Detail active plane pY target/current near 0, got ${JSON.stringify(detail)}.`);
  }
  if (workEarly.mode !== 'work' || workEarly.workTarget !== 1) {
    failures.push(`Expected early Work mode with Work target 1, got ${JSON.stringify(workEarly)}.`);
  }
  if (Math.abs(workEarly.photoYTarget + 0.1) > 0.001) {
    failures.push(`Expected early Work active plane pY target -0.1, got ${JSON.stringify(workEarly)}.`);
  }
  if (workStable.mode !== 'work' || Math.abs(workStable.photoYTarget + 0.1) > 0.001) {
    failures.push(`Expected stable Work active plane pY target -0.1, got ${JSON.stringify(workStable)}.`);
  }
  if (workStable.photoY > -0.08 || workStable.photoY < -0.12) {
    failures.push(`Expected stable Work active plane pY current to settle near -0.1, got ${JSON.stringify(workStable)}.`);
  }
  if (workStable.targetTopPx > -250) {
    failures.push(`Expected Work active GL plane target top above viewport, got ${JSON.stringify(workStable)}.`);
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: [
      '/tmp/local-work-plane-photo-y-v37-detail.png',
      '/tmp/local-work-plane-photo-y-v37-work-360ms.png',
      '/tmp/local-work-plane-photo-y-v37-work-stable.png',
    ],
    detail,
    workEarly,
    workStable,
    runtimeExceptions,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  client.close();
}
