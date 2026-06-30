import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/webgl-gallery-002';
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
    const canvas = document.querySelector('#webgl');
    const data = canvas?.dataset || {};
    const number = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      path: location.pathname,
      shellClass: shell?.className || '',
      activePlaneX: number(data.activePlaneX),
      activePlaneTargetX: number(data.activePlaneTargetX),
      detailScrollOffsetPx: number(data.detailScrollOffsetPx),
      exitingPlaneX: number(data.exitingPlaneX),
      exitingPlaneTargetX: number(data.exitingPlaneTargetX),
      frame: document.querySelector('[data-shadow-frame]')?.textContent?.trim() || '',
    };
  })()`);
}

const client = createCdpClient(await getPageWebSocket());
try {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
  await client.send('Page.navigate', { url: TARGET_URL });
  await waitForMode(client, 'detail');
  await sleep(1000);

  const before = await sample(client, 'before');
  await screenshot(client, '/tmp/local-detail-plane-offset-v27-before.png');

  await key(client, 'ArrowRight', 'ArrowRight', 39);
  await sleep(120);
  const switch120 = await sample(client, 'switch-120ms');
  await screenshot(client, '/tmp/local-detail-plane-offset-v27-120ms.png');

  await sleep(530);
  const switch650 = await sample(client, 'switch-650ms');
  await screenshot(client, '/tmp/local-detail-plane-offset-v27-650ms.png');

  await sleep(1600);
  const stable = await sample(client, 'stable');
  await screenshot(client, '/tmp/local-detail-plane-offset-v27-stable.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];

  if (before.mode !== 'detail' || before.frame !== '002 / 017') {
    failures.push(`Expected starting Detail frame 002, got ${JSON.stringify(before)}.`);
  }
  if (Math.abs(before.detailScrollOffsetPx || 0) > 1.5) {
    failures.push(`Expected starting detail scroll offset near 0, got ${before.detailScrollOffsetPx}.`);
  }
  if (switch120.mode !== 'detail' || switch120.frame !== '003 / 017') {
    failures.push(`Expected 120ms Detail frame 003 after ArrowRight, got ${JSON.stringify(switch120)}.`);
  }
  if (!switch120.shellClass.includes('is-project-switching')) {
    failures.push(`Expected switching class at 120ms, got ${switch120.shellClass}.`);
  }
  if ((switch120.detailScrollOffsetPx || 0) < 25) {
    failures.push(`Expected positive reference-style scroll offset during forward Detail switch, got ${switch120.detailScrollOffsetPx}.`);
  }
  if (switch120.activePlaneTargetX === null || switch120.activePlaneX === null) {
    failures.push(`Expected active plane debug positions at 120ms, got ${JSON.stringify(switch120)}.`);
  }
  if (switch120.exitingPlaneTargetX === null || switch120.exitingPlaneX === null) {
    failures.push(`Expected exiting plane debug positions at 120ms, got ${JSON.stringify(switch120)}.`);
  }
  if ((stable.detailScrollOffsetPx || 0) > 1.5 || stable.shellClass.includes('is-project-switching')) {
    failures.push(`Expected stable Detail switch offset to settle near 0 with no switching class, got ${JSON.stringify(stable)}.`);
  }
  if (stable.frame !== '003 / 017') {
    failures.push(`Expected stable frame 003, got ${stable.frame}.`);
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: [
      '/tmp/local-detail-plane-offset-v27-before.png',
      '/tmp/local-detail-plane-offset-v27-120ms.png',
      '/tmp/local-detail-plane-offset-v27-650ms.png',
      '/tmp/local-detail-plane-offset-v27-stable.png',
    ],
    before,
    switch120,
    switch650,
    stable,
    runtimeExceptions,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  client.close();
}
