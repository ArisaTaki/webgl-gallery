import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/nian-nian-017';
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
    const active = document.querySelector('.work-layer.is-active');
    const exiting = document.querySelector('.work-layer.is-exiting');
    const layerInfo = (layer) => ({
      index: layer ? Number(layer.dataset.workIndex) : -1,
      y: parseFloat(layer?.style.getPropertyValue('--work-layer-y') || '0'),
      transform: layer ? getComputedStyle(layer).transform : '',
    });
    const media = [...document.querySelectorAll('.detail-thumb.is-work-media')]
      .map((thumb) => ({
        index: Number(thumb.dataset.index),
        order: Number(thumb.dataset.workOrder),
        active: thumb.classList.contains('is-active'),
      }))
      .sort((a, b) => a.order - b.order);
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      path: location.pathname,
      shellClass: shell?.className || '',
      switchForward: shell?.classList.contains('is-switch-forward') || false,
      switchBackward: shell?.classList.contains('is-switch-backward') || false,
      active: layerInfo(active),
      exiting: layerInfo(exiting),
      media,
    };
  })()`);
}

const source = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const staticFailures = [];
[
  'const media = getWorkMediaIndices();',
  'const previousOrder = media.indexOf(previousIndex);',
  'const nextOrder = media.indexOf(nextIndex);',
  'prepareWorkLayerSwitch(previousIndex, nextIndex, direction);',
  'state.switchDirection = direction;',
].forEach((needle) => {
  if (!source.includes(needle)) staticFailures.push(`Missing static Work media-order direction code: ${needle}`);
});

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
  await sleep(1500);
  const before = await sample(client, 'tail-work-stable');
  await screenshot(client, '/tmp/local-work-media-order-direction-v34-before.png');

  await key(client, 'ArrowRight', 'ArrowRight', 39);
  await sleep(180);
  const switch180 = await sample(client, 'tail-next-180ms');
  await screenshot(client, '/tmp/local-work-media-order-direction-v34-180ms.png');

  await sleep(1300);
  const stable = await sample(client, 'tail-next-stable');
  await screenshot(client, '/tmp/local-work-media-order-direction-v34-stable.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [...staticFailures];

  const beforeOrder = before.media.map((item) => item.index).join(',');
  if (before.mode !== 'work' || before.active.index !== 16) {
    failures.push(`Expected tail Work to open on global index 16, got ${JSON.stringify(before)}.`);
  }
  if (beforeOrder !== '16,15,14,13,12,11,10') {
    failures.push(`Expected tail fallback media order 16,15,14,13,12,11,10, got ${beforeOrder}.`);
  }
  if (!switch180.switchForward || switch180.switchBackward) {
    failures.push(`Expected media-order next to mark switch as forward even though global index decreases, got ${switch180.shellClass}.`);
  }
  if (switch180.active.index !== 15 || switch180.exiting.index !== 16) {
    failures.push(`Expected next Work media to activate index 15 and exit index 16, got ${JSON.stringify(switch180)}.`);
  }
  if (!(switch180.active.y > 0)) {
    failures.push(`Expected next media to enter from below for media-order forward motion, got active y ${switch180.active.y}.`);
  }
  if (!(switch180.exiting.y < 0)) {
    failures.push(`Expected previous media to exit upward for media-order forward motion, got exiting y ${switch180.exiting.y}.`);
  }
  if (stable.active.index !== 15 || Math.abs(stable.active.y) > 1) {
    failures.push(`Expected stable Work media index 15 centered, got ${JSON.stringify(stable.active)}.`);
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: [
      '/tmp/local-work-media-order-direction-v34-before.png',
      '/tmp/local-work-media-order-direction-v34-180ms.png',
      '/tmp/local-work-media-order-direction-v34-stable.png',
    ],
    before,
    switch180,
    stable,
    runtimeExceptions,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  client.close();
}
