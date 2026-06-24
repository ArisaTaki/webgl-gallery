import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/nian-nian-002';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertSourcePort() {
  const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const checks = [
    'dragOriginScroll',
    'dragOriginX',
    'dragPreviousX',
    'const dragTarget = getPointerDragTarget(event.clientX);',
    'const targetMovement = Math.abs(dragTarget - state.dragOriginScroll) / getDragSensitivity();',
    'if (targetMovement > 6) {',
    'state.dragOriginScroll = carryTarget;',
    'function getPointerDragTarget(clientX)',
    'canvas.dataset.targetScrollPx =',
  ];
  const missing = checks.filter((needle) => !main.includes(needle));
  if (missing.length) throw new Error(`Missing reference drag-carry source checks: ${missing.join(', ')}`);
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
      frame: document.querySelector('[data-shadow-frame]')?.textContent?.trim() || '',
      scrollPx: number(data.scrollPx),
      targetScrollPx: number(data.targetScrollPx),
      dragMoved: number(data.dragMoved),
      detailMix: number(data.activePlaneDetailMix),
      detailTarget: number(data.activePlaneDetailTarget),
      rootVisiblePgn: [...document.querySelectorAll('.pgn')].filter((item) => getComputedStyle(item).opacity !== '0').length,
      visiblePgn: [...document.querySelectorAll('.pgn.is-visible')].length,
      windowedPgn: [...document.querySelectorAll('.pgn')].filter((item) => item.style.width !== '0px' && item.style.height !== '0px').length,
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
  await sleep(1200);

  const before = await sample(client, 'detail-before-drag');
  await screenshot(client, '/tmp/local-detail-drag-carry-v38-before.png');

  await mouse(client, 'mousePressed', 720, 450, 1);
  await sleep(40);
  await mouse(client, 'mouseMoved', 560, 450, 1);
  await sleep(140);
  const mid = await sample(client, 'drag-crossed-to-index');
  await screenshot(client, '/tmp/local-detail-drag-carry-v38-crossed.png');

  await mouse(client, 'mouseMoved', 520, 450, 1);
  await sleep(140);
  const carried = await sample(client, 'drag-carried-in-index');
  await screenshot(client, '/tmp/local-detail-drag-carry-v38-carried.png');

  await mouse(client, 'mouseReleased', 520, 450, 0);
  await sleep(650);
  const final = await sample(client, 'drag-final');
  await screenshot(client, '/tmp/local-detail-drag-carry-v38-final.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];

  if (before.mode !== 'detail' || before.path !== '/nian-nian-002') {
    failures.push(`Expected to start in Detail /nian-nian-002, got ${JSON.stringify(before)}.`);
  }
  if (mid.mode !== 'index' || mid.path !== '/') {
    failures.push(`Expected drag threshold to leave Detail for Home, got ${JSON.stringify(mid)}.`);
  }
  if (carried.rootVisiblePgn !== 30 || final.rootVisiblePgn !== 30 || carried.visiblePgn !== 0 || final.visiblePgn !== 0 || carried.windowedPgn !== 1 || final.windowedPgn !== 1) {
    failures.push(`Expected reference-like Home pgn state with 30 root-visible slots, one hidden window, and no painted digit after drag out, got carried=${JSON.stringify(carried)}, final=${JSON.stringify(final)}.`);
  }
  if (Math.abs((mid.targetScrollPx || 0) - (before.targetScrollPx || 0)) > 4) {
    failures.push(`Expected threshold-crossing move to leave Home target at the route index, got before ${before.targetScrollPx}, mid ${mid.targetScrollPx}.`);
  }
  if ((carried.targetScrollPx || 0) < (mid.targetScrollPx || 0) + 320) {
    failures.push(`Expected continued Home drag target to keep reference origin carry, got mid ${mid.targetScrollPx}, carried ${carried.targetScrollPx}.`);
  }
  if (final.mode !== 'index' || final.path !== '/') {
    failures.push(`Expected final state to remain Home, got ${JSON.stringify(final)}.`);
  }
  if ((final.scrollPx || 0) <= (before.scrollPx || 0) + 320) {
    failures.push(`Expected Home strip scroll to move materially after drag carry, got before ${before.scrollPx}, final ${final.scrollPx}.`);
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: [
      '/tmp/local-detail-drag-carry-v38-before.png',
      '/tmp/local-detail-drag-carry-v38-crossed.png',
      '/tmp/local-detail-drag-carry-v38-carried.png',
      '/tmp/local-detail-drag-carry-v38-final.png',
    ],
    before,
    mid,
    carried,
    final,
    runtimeExceptions,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  client.close();
}
