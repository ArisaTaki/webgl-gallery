import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertSourcePort() {
  const source = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const checks = [
    'const WEBGL_DPR = 1.5;',
    'const PAGINATION_DPR = 2;',
    'renderer.setPixelRatio(WEBGL_DPR);',
    'const dpr = PAGINATION_DPR;',
    'canvas.dataset.webglDpr = String(WEBGL_DPR);',
    'canvas.dataset.paginationDpr = String(dpr);',
    'new THREE.PlaneGeometry(1, 1, 19, 1)',
  ];
  const missing = checks.filter((check) => !source.includes(check));
  if (missing.length) {
    throw new Error(`Missing reference DPR/geometry port checks: ${missing.join(', ')}`);
  }
  if (source.includes('renderer.setPixelRatio(Math.min(window.devicePixelRatio')) {
    throw new Error('Renderer still derives DPR from devicePixelRatio instead of fixed reference 1.5.');
  }
  if (source.includes('const dpr = Math.min(window.devicePixelRatio || 1, 2);')) {
    throw new Error('Pagination canvas still derives DPR from devicePixelRatio instead of fixed reference 2.');
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
    const pgn = document.querySelector('.pagination-canvas');
    const readCanvas = (item) => {
      if (!item) return null;
      const rect = item.getBoundingClientRect();
      const data = item.dataset || {};
      return {
        backingHeight: item.height,
        backingWidth: item.width,
        cssHeight: rect.height,
        cssWidth: rect.width,
        dpr: Number(data.webglDpr || data.paginationDpr || 0),
        ratioX: item.width / Math.max(rect.width, 1),
        ratioY: item.height / Math.max(rect.height, 1),
      };
    };
    return {
      label: ${JSON.stringify(label)},
      devicePixelRatio: window.devicePixelRatio,
      mode: shell?.dataset.mode || '',
      path: location.pathname,
      pagination: readCanvas(pgn),
      viewport: { height: window.innerHeight, width: window.innerWidth },
      webgl: readCanvas(webgl),
    };
  })()`);
}

function approx(value, expected, tolerance = 0.01) {
  return Math.abs(value - expected) <= tolerance;
}

assertSourcePort();

const client = createCdpClient(await getPageWebSocket());
try {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
  await client.send('Page.navigate', { url: TARGET_URL });
  await waitForMode(client, 'index');
  await sleep(1300);

  const home = await sample(client, 'home-stable');
  await screenshot(client, '/tmp/local-reference-dpr-v40-home.png');

  await key(client, 'Enter', 'Enter', 13);
  await waitForMode(client, 'detail');
  await sleep(1200);
  const detail = await sample(client, 'detail-stable');
  await screenshot(client, '/tmp/local-reference-dpr-v40-detail.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];

  for (const state of [home, detail]) {
    if (!state.webgl || !state.pagination) {
      failures.push(`Expected both canvases in ${state.label}, got ${JSON.stringify(state)}.`);
      continue;
    }
    if (!approx(state.webgl.dpr, 1.5) || !approx(state.webgl.ratioX, 1.5) || !approx(state.webgl.ratioY, 1.5)) {
      failures.push(`Expected WebGL fixed DPR 1.5 in ${state.label}, got ${JSON.stringify(state.webgl)}.`);
    }
    if (!approx(state.pagination.dpr, 2) || !approx(state.pagination.ratioX, 2) || !approx(state.pagination.ratioY, 2)) {
      failures.push(`Expected pagination fixed DPR 2 in ${state.label}, got ${JSON.stringify(state.pagination)}.`);
    }
    if (state.webgl.backingWidth !== 2160 || state.webgl.backingHeight !== 1350) {
      failures.push(`Expected 1440x900 WebGL backing 2160x1350 in ${state.label}, got ${JSON.stringify(state.webgl)}.`);
    }
    if (state.pagination.backingWidth !== 2880 || state.pagination.backingHeight !== 1800) {
      failures.push(`Expected 1440x900 pagination backing 2880x1800 in ${state.label}, got ${JSON.stringify(state.pagination)}.`);
    }
  }

  if (home.mode !== 'index' || detail.mode !== 'detail') {
    failures.push(`Expected Home then Detail states, got ${JSON.stringify({ home, detail })}.`);
  }
  if (runtimeExceptions.length) {
    failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);
  }

  console.log(JSON.stringify({
    status: failures.length ? 'fail' : 'pass',
    home,
    detail,
    runtimeExceptions: runtimeExceptions.length,
    screenshots: [
      '/tmp/local-reference-dpr-v40-home.png',
      '/tmp/local-reference-dpr-v40-detail.png',
    ],
    failures,
  }, null, 2));

  if (failures.length) process.exitCode = 1;
} finally {
  client.close();
}
