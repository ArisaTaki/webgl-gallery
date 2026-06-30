import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/webgl-gallery-001';
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

async function wheel(client, deltaY) {
  await client.send('Input.dispatchMouseEvent', {
    deltaX: 0,
    deltaY,
    type: 'mouseWheel',
    x: 720,
    y: 450,
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
    const activeLayer = document.querySelector('.work-layer.is-active');
    const activeThumb = document.querySelector('.detail-thumb.is-active');
    const visiblePgn = [...document.querySelectorAll('.pgn')].filter((item) =>
      item.style.opacity !== '0' || item.className.includes('is-visible')
    );
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      pathname: location.pathname,
      activeLayerIndex: activeLayer ? Number(activeLayer.dataset.workIndex) : -1,
      activeLayerOpacity: activeLayer ? getComputedStyle(activeLayer).opacity : '',
      activeLayerTransform: activeLayer ? getComputedStyle(activeLayer).transform : '',
      activeThumbIndex: activeThumb ? Number(activeThumb.dataset.index) : -1,
      visiblePgn: visiblePgn.length,
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
  await sleep(700);

  await key(client, 'e', 'KeyE', 69);
  await waitForMode(client, 'work');
  await sleep(1100);
  const before = await sample(client, 'work-before-wheel');

  await wheel(client, 900);
  await sleep(450);
  const wheelDown = await sample(client, 'work-after-wheel-down');
  await screenshot(client, '/tmp/local-work-wheel-v17-down.png');

  await wheel(client, -900);
  await sleep(450);
  const wheelUp = await sample(client, 'work-after-wheel-up');
  await screenshot(client, '/tmp/local-work-wheel-v17-up.png');

  await key(client, 'ArrowUp', 'ArrowUp', 38);
  await sleep(650);
  const arrowUp = await sample(client, 'work-arrowup-close');
  await screenshot(client, '/tmp/local-work-wheel-v17-arrowup-close.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];

  if (before.mode !== 'work' || before.activeLayerIndex !== 0) {
    failures.push(`Expected to start Work at media 0, got ${JSON.stringify(before)}.`);
  }
  if (wheelDown.mode !== 'work' || wheelDown.activeLayerIndex !== 0 || wheelDown.pathname !== before.pathname) {
    failures.push(`Expected wheel down to be ignored in Work, got ${JSON.stringify(wheelDown)}.`);
  }
  if (wheelUp.mode !== 'work' || wheelUp.activeLayerIndex !== 0 || wheelUp.pathname !== before.pathname) {
    failures.push(`Expected wheel up to be ignored in Work, got ${JSON.stringify(wheelUp)}.`);
  }
  if (arrowUp.mode !== 'detail') {
    failures.push(`Expected ArrowUp at first media to close Work like reference class b.key(), got ${JSON.stringify(arrowUp)}.`);
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: [
      '/tmp/local-work-wheel-v17-down.png',
      '/tmp/local-work-wheel-v17-up.png',
      '/tmp/local-work-wheel-v17-arrowup-close.png',
    ],
    before,
    wheelDown,
    wheelUp,
    arrowUp,
    runtimeExceptions,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  client.close();
}
