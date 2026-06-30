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

async function mouseMove(client, x, y) {
  await client.send('Input.dispatchMouseEvent', {
    button: 'none',
    clickCount: 0,
    type: 'mouseMoved',
    x,
    y,
  });
}

async function mouseClick(client, x, y) {
  await mouseMove(client, x, y);
  await client.send('Input.dispatchMouseEvent', {
    button: 'left',
    buttons: 1,
    clickCount: 1,
    type: 'mousePressed',
    x,
    y,
  });
  await client.send('Input.dispatchMouseEvent', {
    button: 'left',
    buttons: 0,
    clickCount: 1,
    type: 'mouseReleased',
    x,
    y,
  });
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
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      pathname: location.pathname,
      frame: document.querySelector('[data-meta-frame]')?.textContent?.trim() || '',
      pgn: [...document.querySelectorAll('.pgn')]
        .filter((item) => item.style.opacity !== '0' || item.className.includes('is-visible'))
        .map((item) => item.textContent.trim().replace(/\\s+/g, ' '))
        .join(' | '),
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
  await sleep(500);
  await mouseMove(client, 810, 450);
  await sleep(220);
  const homeHover = await sample(client, 'home-hover-second-plane');
  await key(client, 'Enter', 'Enter', 13);
  await sleep(700);
  const homeEnter = await sample(client, 'home-enter-hover');
  await screenshot(client, '/tmp/local-reference-hover-v20-home-enter.png');

  await client.send('Page.navigate', { url: 'http://localhost:5279/webgl-gallery-002' });
  await waitForMode(client, 'detail');
  await sleep(900);
  const detailBefore = await sample(client, 'detail-before-side-click');
  await mouseClick(client, 1270, 450);
  await sleep(900);
  const detailAfter = await sample(client, 'detail-after-side-click');
  await screenshot(client, '/tmp/local-reference-hover-v20-detail-side-click.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];

  if (homeEnter.mode !== 'detail' || homeEnter.pathname !== '/webgl-gallery-002') {
    failures.push(`Expected Enter from reference-style pixel hovered plane to open /webgl-gallery-002, got ${JSON.stringify({ homeHover, homeEnter })}.`);
  }
  if (detailBefore.pathname !== '/webgl-gallery-002' || !detailBefore.frame.includes('002')) {
    failures.push(`Expected detail before click at /webgl-gallery-002, got ${JSON.stringify(detailBefore)}.`);
  }
  if (detailAfter.mode !== 'detail' || detailAfter.pathname !== '/webgl-gallery-003' || !detailAfter.frame.includes('003')) {
    failures.push(`Expected side-plane click to switch to /webgl-gallery-003 in detail mode, got ${JSON.stringify(detailAfter)}.`);
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: [
      '/tmp/local-reference-hover-v20-home-enter.png',
      '/tmp/local-reference-hover-v20-detail-side-click.png',
    ],
    homeHover,
    homeEnter,
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
