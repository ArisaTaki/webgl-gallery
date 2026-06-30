import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const HOME_URL = process.env.HOME_URL || 'http://localhost:5279/';
const DETAIL_URL = process.env.DETAIL_URL || 'http://localhost:5279/webgl-gallery-002';
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
    const canvas = document.querySelector('.pagination-canvas');
    const pgn = document.querySelector('.pgn.is-visible');
    const pgnA = pgn?.querySelector('.pgn-a');
    const pgnInner = pgnA?.querySelector('div');
    const pgnRect = pgnA?.getBoundingClientRect();
    const pgnStyle = pgn ? getComputedStyle(pgn) : null;
    const innerStyle = pgnInner ? getComputedStyle(pgnInner) : null;
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      canvas: {
        metricHeight: Number(canvas?.dataset.paginationMetricHeight || 0),
        height: Number(canvas?.dataset.paginationHeight || 0),
        heightTarget: Number(canvas?.dataset.paginationHeightTarget || 0),
        top: Number(canvas?.dataset.paginationTop || 0),
        topTarget: Number(canvas?.dataset.paginationTopTarget || 0),
      },
      pgn: pgn ? {
        rectHeight: Number((pgnRect?.height || 0).toFixed(3)),
        fontSize: pgnStyle?.fontSize || '',
        lineHeight: pgnStyle?.lineHeight || '',
        innerTransform: innerStyle?.transform || '',
      } : null,
    };
  })()`);
}

function near(actual, expected, tolerance = 0.8) {
  return Math.abs(actual - expected) <= tolerance;
}

const client = createCdpClient(await getPageWebSocket());
try {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Emulation.setDeviceMetricsOverride', VIEWPORT);

  await client.send('Page.navigate', { url: HOME_URL });
  await waitForMode(client, 'index');
  await sleep(1200);
  const home = await sample(client, 'home-stable');
  await screenshot(client, '/tmp/local-pagination-scale-v25-home.png');

  await client.send('Page.navigate', { url: DETAIL_URL });
  await waitForMode(client, 'detail');
  await sleep(1800);
  const detail = await sample(client, 'detail-stable');
  await screenshot(client, '/tmp/local-pagination-scale-v25-detail.png');

  await key(client, 'e', 'KeyE', 69);
  await waitForMode(client, 'work');
  await sleep(1400);
  const work = await sample(client, 'work-stable');
  await screenshot(client, '/tmp/local-pagination-scale-v25-work.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];

  if (home.mode !== 'index' || home.canvas.metricHeight !== 14 || !near(home.canvas.heightTarget, 14)) {
    failures.push(`Expected Home pagination metric/target height 14, got ${JSON.stringify(home)}.`);
  }
  if (!near(home.canvas.topTarget, 49)) {
    failures.push(`Expected Home pagination top target 49, got ${JSON.stringify(home.canvas)}.`);
  }
  if (detail.mode !== 'detail' || detail.canvas.metricHeight !== 14 || !near(detail.canvas.heightTarget, 7)) {
    failures.push(`Expected Detail pagination half-height target 7 from base 14, got ${JSON.stringify(detail)}.`);
  }
  if (!near(detail.canvas.topTarget, 0, 0.2)) {
    failures.push(`Expected Detail pagination top target 0, got ${JSON.stringify(detail.canvas)}.`);
  }
  if (work.mode !== 'work' || work.canvas.metricHeight !== 14 || !near(work.canvas.heightTarget, 7)) {
    failures.push(`Expected Work pagination half-height target 7 from base 14, got ${JSON.stringify(work)}.`);
  }
  if (!near(work.canvas.topTarget, 0, 0.2)) {
    failures.push(`Expected Work pagination top target 0, got ${JSON.stringify(work.canvas)}.`);
  }
  for (const state of [detail, work]) {
    if (!state.pgn || !near(state.pgn.rectHeight, 14, 0.2) || state.pgn.fontSize !== '12px' || state.pgn.lineHeight !== '14px') {
      failures.push(`Expected visible pgn DOM digits at 14px/12px/14px in ${state.label}, got ${JSON.stringify(state.pgn)}.`);
    }
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: [
      '/tmp/local-pagination-scale-v25-home.png',
      '/tmp/local-pagination-scale-v25-detail.png',
      '/tmp/local-pagination-scale-v25-work.png',
    ],
    home,
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
