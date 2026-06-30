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

async function sample(client, label) {
  return evaluate(client, `(() => {
    const shell = document.querySelector('.gallery-shell');
    const activeLayer = document.querySelector('.work-layer.is-active');
    const activeImg = activeLayer?.querySelector('.work-layer-img');
    const exitingLayer = document.querySelector('.work-layer.is-exiting');
    const activeThumb = document.querySelector('.detail-thumb.is-active');
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      pathname: location.pathname,
      activeWorkIndex: activeLayer?.dataset.workIndex || '',
      exitingWorkIndex: exitingLayer?.dataset.workIndex || '',
      activeThumbIndex: activeThumb?.dataset.index || '',
      activeLayerY: activeLayer?.style.getPropertyValue('--work-layer-y') || '',
      activeLayerOpacity: activeLayer?.style.getPropertyValue('--work-layer-opacity') || '',
      activeLayerComputedOpacity: activeImg ? getComputedStyle(activeImg).opacity : '',
      railActiveY: document.querySelector('.detail-rail')?.style.getPropertyValue('--rail-active-y') || '',
      aboutHidden: document.querySelector('.about-panel')?.getAttribute('aria-hidden') || '',
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
  await sleep(1800);
  await evaluate(client, `
    new Promise((resolve) => {
      const ready = () => document.querySelector('.visit-link') && document.querySelector('.work-layer');
      if (ready()) resolve(true);
      const started = performance.now();
      const timer = setInterval(() => {
        if (ready() || performance.now() - started > 3000) {
          clearInterval(timer);
          resolve(Boolean(ready()));
        }
      }, 50);
    })
  `);

  await evaluate(client, `document.querySelector('.visit-link')?.click()`);
  await sleep(1450);
  const workStart = await sample(client, 'work-start');

  await key(client, 'ArrowRight', 'ArrowRight', 39);
  await sleep(300);
  const arrowRight = await sample(client, 'arrow-right-300ms');
  await screenshot(client, '/tmp/local-work-keyboard-v12-arrowright.png');

  await sleep(900);
  await key(client, 'ArrowUp', 'ArrowUp', 38);
  await sleep(350);
  const arrowUpToFirst = await sample(client, 'arrow-up-to-first');

  await key(client, 'ArrowUp', 'ArrowUp', 38);
  await sleep(500);
  const arrowUpCloses = await sample(client, 'arrow-up-closes');

  await evaluate(client, `document.querySelector('.visit-link')?.click()`);
  await sleep(900);
  await key(client, 'a', 'KeyA', 65);
  await sleep(500);
  const keyAAbout = await sample(client, 'key-a-about');
  await screenshot(client, '/tmp/local-work-keyboard-v12-about.png');

  const diagnostics = client.events
    .filter((event) => ['Runtime.exceptionThrown', 'Log.entryAdded'].includes(event.method))
    .map((event) => event.params);

  console.log(JSON.stringify({
    screenshots: [
      '/tmp/local-work-keyboard-v12-arrowright.png',
      '/tmp/local-work-keyboard-v12-about.png',
    ],
    workStart,
    arrowRight,
    arrowUpToFirst,
    arrowUpCloses,
    keyAAbout,
    diagnostics,
  }, null, 2));
} finally {
  client.close();
}
