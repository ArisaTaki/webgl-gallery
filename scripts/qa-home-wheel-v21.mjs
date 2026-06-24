import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
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

async function wheel(client, x, y, deltaY) {
  await client.send('Input.dispatchMouseEvent', {
    button: 'none',
    clickCount: 0,
    type: 'mouseMoved',
    x,
    y,
  });
  await client.send('Input.dispatchMouseEvent', {
    deltaX: 0,
    deltaY,
    type: 'mouseWheel',
    x,
    y,
  });
}

async function sample(client, label) {
  return evaluate(client, `(() => {
    const shell = document.querySelector('.gallery-shell');
    const canvas = document.querySelector('#webgl');
    const frame = document.querySelector('[data-meta-frame]');
    const pgnEntries = [...document.querySelectorAll('.pgn')].map((item, index) => ({
      index,
      rootVisible: item.style.opacity !== '0',
      windowed: item.style.width !== '0px' && item.style.height !== '0px',
      painted: item.className.includes('is-visible') || item.className.includes('is-leaving'),
      text: item.textContent.trim().replace(/\\s+/g, ' '),
    }));
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      pathname: location.pathname,
      frame: frame?.textContent?.trim() || '',
      pgnRootVisibleCount: pgnEntries.filter((entry) => entry.rootVisible).length,
      pgnWindows: pgnEntries.filter((entry) => entry.windowed),
      paintedPgn: pgnEntries.filter((entry) => entry.painted),
      canvasCount: document.querySelectorAll('canvas').length,
      webglRect: canvas ? (() => {
        const rect = canvas.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      })() : null,
    };
  })()`);
}

const client = createCdpClient(await getPageWebSocket());
try {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Emulation.setDeviceMetricsOverride', VIEWPORT);

  await client.send('Page.navigate', { url: 'http://localhost:5279/' });
  await waitForMode(client, 'index');
  await sleep(700);
  const homeBefore = await sample(client, 'home-before-wheel');
  await wheel(client, 720, 450, 900);
  await sleep(160);
  const homeMid = await sample(client, 'home-wheel-160ms');
  await screenshot(client, '/tmp/local-home-wheel-v21-mid.png');
  await sleep(700);
  const homeAfter = await sample(client, 'home-wheel-after');
  await screenshot(client, '/tmp/local-home-wheel-v21-after.png');

  await client.send('Page.navigate', { url: 'http://localhost:5279/nian-nian-002' });
  await waitForMode(client, 'detail');
  await sleep(900);
  const detailBefore = await sample(client, 'detail-before-tiny-wheel');
  await wheel(client, 720, 450, 1);
  await sleep(550);
  const detailAfter = await sample(client, 'detail-after-tiny-wheel');
  await screenshot(client, '/tmp/local-detail-wheel-v21-out.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];

  if (homeBefore.mode !== 'index' || homeBefore.canvasCount !== 2) {
    failures.push(`Expected Home index mode with two canvases before wheel, got ${JSON.stringify(homeBefore)}.`);
  }
  if (homeMid.mode !== 'index' || homeAfter.mode !== 'index') {
    failures.push(`Expected Home wheel to remain on index surface, got ${JSON.stringify({ homeMid, homeAfter })}.`);
  }
  if (detailBefore.mode !== 'detail' || detailBefore.pathname !== '/nian-nian-002') {
    failures.push(`Expected Detail before tiny wheel at /nian-nian-002, got ${JSON.stringify(detailBefore)}.`);
  }
  if (detailAfter.mode !== 'index' || detailAfter.pathname !== '/') {
    failures.push(`Expected any Detail wheel to modeOut to Home like reference class v.sXFn, got ${JSON.stringify(detailAfter)}.`);
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: [
      '/tmp/local-home-wheel-v21-mid.png',
      '/tmp/local-home-wheel-v21-after.png',
      '/tmp/local-detail-wheel-v21-out.png',
    ],
    homeBefore,
    homeMid,
    homeAfter,
    detailBefore,
    detailAfter,
    runtimeExceptions,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  client.close();
}
