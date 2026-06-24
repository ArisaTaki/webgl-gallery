import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/nian-nian-002';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertSourcePort() {
  const main = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const checks = [
    ['background plane singleton', 'let backgroundPlane = null;'],
    ['reference solid branch uniform', 'uHasTexture: { value: 0 }'],
    ['texture branch uniform', 'uHasTexture: { value: 1 }'],
    ['shared shader solid branch', 'if (uHasTexture != 1)'],
    ['solid color output', 'gl_FragColor = vec4(uSolidColor, 1.0);'],
    ['transparent renderer clear', 'renderer.setClearColor(rendererClearColor, 0);'],
    ['background plane telemetry', "canvas.dataset.webglBackgroundPlane = '1';"],
  ];
  const missing = checks.filter(([, needle]) => !main.includes(needle));
  if (missing.length) {
    throw new Error(`Missing WebGL background source checks: ${missing.map(([label]) => label).join(', ')}`);
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
    const webgl = document.querySelector('#webgl');
    const shellStyle = shell ? getComputedStyle(shell) : null;
    const canvases = [...document.querySelectorAll('canvas')].map((canvas) => ({
      id: canvas.id,
      className: canvas.className,
      width: canvas.width,
      height: canvas.height,
    }));
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      path: location.pathname,
      canvases,
      backgroundPlane: webgl?.dataset.webglBackgroundPlane || '',
      backgroundColor: webgl?.dataset.webglBackgroundColor || '',
      surfaceRgb: shellStyle?.getPropertyValue('--surface-rgb').trim() || '',
      webglBackingWidth: webgl?.dataset.webglBackingWidth || '',
      webglBackingHeight: webgl?.dataset.webglBackingHeight || '',
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
  await sleep(900);
  const detail = await sample(client, 'detail');
  await screenshot(client, '/tmp/local-webgl-background-v64-detail.png');

  await key(client, 'e', 'KeyE', 69);
  await waitForMode(client, 'work');
  await sleep(900);
  const work = await sample(client, 'work');
  await screenshot(client, '/tmp/local-webgl-background-v64-work.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];

  for (const state of [detail, work]) {
    if (state.backgroundPlane !== '1') {
      failures.push(`Expected WebGL background plane telemetry in ${state.label}, got ${JSON.stringify(state)}.`);
    }
    if (state.backgroundColor !== state.surfaceRgb) {
      failures.push(`Expected shader background color to track shell surface rgb in ${state.label}, got ${JSON.stringify(state)}.`);
    }
    if (
      state.canvases.length !== 2 ||
      !state.canvases.some((canvas) => canvas.id === 'webgl') ||
      !state.canvases.some((canvas) => canvas.className === 'pagination-canvas')
    ) {
      failures.push(`Expected reference-like two canvas stack in ${state.label}, got ${JSON.stringify(state.canvases)}.`);
    }
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: [
      '/tmp/local-webgl-background-v64-detail.png',
      '/tmp/local-webgl-background-v64-work.png',
    ],
    detail,
    work,
    runtimeExceptions,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  client.close();
}
