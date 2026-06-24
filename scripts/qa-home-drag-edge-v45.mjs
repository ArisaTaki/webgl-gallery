import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertSourcePort() {
  const source = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const checks = [
    'function adjustDragOriginAtBounds(clientX, previousClientX)',
    'clientX > previousClientX && state.targetScroll <= 0.0001',
    'clientX < previousClientX && state.targetScroll >= maxScroll - 0.0001',
    'state.dragOriginX = clientX - (state.dragOriginScroll - bound) / sensitivity;',
    'canvas.dataset.dragBoundReset',
  ];
  const missing = checks.filter((check) => !source.includes(check));
  if (missing.length) {
    throw new Error(`Missing drag edge-reset source checks: ${missing.join(', ')}`);
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

async function mouse(client, type, x, y, buttons = 0) {
  await client.send('Input.dispatchMouseEvent', {
    button: buttons ? 'left' : 'none',
    buttons,
    clickCount: buttons ? 1 : 0,
    type,
    x,
    y,
  });
}

async function sample(client, label) {
  return evaluate(client, `(() => {
    const shell = document.querySelector('.gallery-shell');
    const data = document.querySelector('#webgl')?.dataset || {};
    const number = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    return {
      label: ${JSON.stringify(label)},
      current: document.querySelector('[data-current]')?.textContent?.trim() || '',
      dragBoundReset: data.dragBoundReset || '',
      dragMoved: number(data.dragMoved),
      mode: shell?.dataset.mode || '',
      path: location.pathname,
      scrollPx: number(data.scrollPx),
      targetScrollPx: number(data.targetScrollPx),
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
  await waitForMode(client, 'index');
  await sleep(1300);

  const before = await sample(client, 'home-before-drag');
  await screenshot(client, '/tmp/local-home-drag-edge-v45-before.png');

  await mouse(client, 'mousePressed', 720, 450, 1);
  await sleep(40);
  await mouse(client, 'mouseMoved', 1200, 450, 1);
  await sleep(80);
  const outsideMin = await sample(client, 'outside-min-bound');
  await screenshot(client, '/tmp/local-home-drag-edge-v45-outside-min.png');

  await mouse(client, 'mouseMoved', 1040, 450, 1);
  await sleep(120);
  const reversed = await sample(client, 'reversed-from-min-bound');
  await screenshot(client, '/tmp/local-home-drag-edge-v45-reversed.png');

  await mouse(client, 'mouseReleased', 1040, 450, 0);
  await sleep(450);
  const final = await sample(client, 'final');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];

  if (before.mode !== 'index' || before.current !== '001') {
    failures.push(`Expected Home 001 before drag, got ${JSON.stringify(before)}.`);
  }
  if (outsideMin.mode !== 'index' || Math.abs(outsideMin.targetScrollPx ?? 999) > 2) {
    failures.push(`Expected overshoot beyond min to stay clamped near 0, got ${JSON.stringify(outsideMin)}.`);
  }
  if (outsideMin.dragBoundReset !== '0') {
    failures.push(`Expected min-bound drag reset telemetry 0, got ${JSON.stringify(outsideMin)}.`);
  }
  if ((reversed.targetScrollPx ?? 0) < 150) {
    failures.push(`Expected reverse drag to immediately move target past 150px, got ${JSON.stringify(reversed)}.`);
  }
  if ((reversed.dragMoved ?? 0) < 500) {
    failures.push(`Expected drag movement to include overshoot and reverse, got ${JSON.stringify(reversed)}.`);
  }
  if (final.mode !== 'index' || final.path !== '/') {
    failures.push(`Expected final state to remain Home, got ${JSON.stringify(final)}.`);
  }
  if (runtimeExceptions.length) {
    failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);
  }

  const report = {
    screenshots: [
      '/tmp/local-home-drag-edge-v45-before.png',
      '/tmp/local-home-drag-edge-v45-outside-min.png',
      '/tmp/local-home-drag-edge-v45-reversed.png',
    ],
    before,
    outsideMin,
    reversed,
    final,
    runtimeExceptions,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  client.close();
}
