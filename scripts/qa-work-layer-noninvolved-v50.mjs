import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/nian-nian-002';
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
    const layer = (index) => {
      const el = document.querySelector(\`.work-layer[data-work-index="\${index}"]\`);
      const img = el?.querySelector('.work-layer-img');
      return {
        index,
        active: el?.classList.contains('is-active') || false,
        exiting: el?.classList.contains('is-exiting') || false,
        loaded: img?.dataset.loaded || 'missing',
        opacity: parseFloat(el?.style.getPropertyValue('--work-layer-opacity') || '0'),
        y: parseFloat(el?.style.getPropertyValue('--work-layer-y') || '0'),
      };
    };
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      path: location.pathname,
      classes: shell?.className || '',
      layers: {
        nonInvolved: layer(2),
        previous: layer(1),
        active: layer(3),
      },
    };
  })()`);
}

const source = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const staticFailures = [];
[
  'const exitY = -travel * direction;',
  'const enterY = travel * direction;',
  'if (index === previousIndex)',
  'if (index === nextIndex)',
].forEach((needle) => {
  if (!source.includes(needle)) staticFailures.push(`Missing Work layer switch source check: ${needle}`);
});
if (source.includes('const side = index < nextIndex')) {
  staticFailures.push('Work layer switch still mass-repositions non-involved layers.');
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
  await sleep(1500);
  const before = await sample(client, 'work-stable-index-1');
  await screenshot(client, '/tmp/local-work-layer-noninvolved-v50-before.png');

  await key(client, 'ArrowRight', 'ArrowRight', 39);
  await sleep(180);
  const switch180 = await sample(client, 'work-switch-180ms');
  await screenshot(client, '/tmp/local-work-layer-noninvolved-v50-180ms.png');

  await sleep(1300);
  const stable = await sample(client, 'work-stable-index-3');
  await screenshot(client, '/tmp/local-work-layer-noninvolved-v50-stable.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [...staticFailures];

  if (before.mode !== 'work' || !before.layers.previous.active) {
    failures.push(`Expected Work to open on layer 1, got ${JSON.stringify(before)}.`);
  }
  if (!(before.layers.nonInvolved.y > 80)) {
    failures.push(`Expected non-involved layer 2 to start below the stage, got ${before.layers.nonInvolved.y}.`);
  }
  if (switch180.mode !== 'work' || !switch180.layers.active.active || !switch180.layers.previous.exiting) {
    failures.push(`Expected switch to activate layer 3 and keep layer 1 exiting, got ${JSON.stringify(switch180)}.`);
  }
  if (!(switch180.layers.previous.y < -20)) {
    failures.push(`Expected previous layer 1 to exit upward, got ${switch180.layers.previous.y}.`);
  }
  if (!(switch180.layers.active.y > 20)) {
    failures.push(`Expected incoming layer 3 to enter from below, got ${switch180.layers.active.y}.`);
  }
  if (!(switch180.layers.nonInvolved.y > 80)) {
    failures.push(`Expected non-involved layer 2 to preserve its below-stage position, got ${switch180.layers.nonInvolved.y}.`);
  }
  if (switch180.layers.nonInvolved.exiting || switch180.layers.nonInvolved.active) {
    failures.push(`Expected non-involved layer 2 to stay outside active/exiting classes, got ${JSON.stringify(switch180.layers.nonInvolved)}.`);
  }
  if (stable.layers.active.index !== 3 || Math.abs(stable.layers.active.y) > 1.5) {
    failures.push(`Expected stable active layer 3 centered, got ${JSON.stringify(stable.layers.active)}.`);
  }
  if (!(stable.layers.nonInvolved.y > 80)) {
    failures.push(`Expected non-involved layer 2 to remain below after settle, got ${stable.layers.nonInvolved.y}.`);
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: [
      '/tmp/local-work-layer-noninvolved-v50-before.png',
      '/tmp/local-work-layer-noninvolved-v50-180ms.png',
      '/tmp/local-work-layer-noninvolved-v50-stable.png',
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
