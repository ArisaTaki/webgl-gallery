import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/webgl-gallery-002';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertSourcePort() {
  const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const checks = [
    '@media (max-width: 1150px)',
    '.gallery-shell.is-work .detail-rail',
    'display: none;',
    'opacity: 0.7;',
  ];
  const missing = checks.filter((needle) => !css.includes(needle));
  if (missing.length) throw new Error(`Missing reference Work rail breakpoint CSS: ${missing.join(', ')}`);
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
        if (ready() || performance.now() - started > 10000) {
          clearInterval(timer);
          resolve(Boolean(ready()));
        }
      }, 50);
    })
  `);
  if (!ok) throw new Error(`Timed out waiting for mode ${mode}.`);
}

async function openWorkAtViewport(client, viewport) {
  await client.send('Emulation.setDeviceMetricsOverride', {
    ...viewport,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await client.send('Page.navigate', { url: TARGET_URL });
  await waitForMode(client, 'detail');
  await sleep(900);
  await key(client, 'e', 'KeyE', 69);
  await waitForMode(client, 'work');
  await sleep(1100);
}

async function sample(client, label) {
  return evaluate(client, `(() => {
    const shell = document.querySelector('.gallery-shell');
    const rail = document.querySelector('.detail-rail');
    const frame = document.querySelector('.detail-rail-active');
    const railStyle = rail ? getComputedStyle(rail) : null;
    const frameStyle = frame ? getComputedStyle(frame) : null;
    const railRect = rail?.getBoundingClientRect();
    return {
      label: ${JSON.stringify(label)},
      width: window.innerWidth,
      mode: shell?.dataset.mode || '',
      railDisplay: railStyle?.display || '',
      railOpacity: railStyle?.opacity || '',
      frameDisplay: frameStyle?.display || '',
      frameOpacity: frameStyle?.opacity || '',
      railRect: railRect ? { width: railRect.width, height: railRect.height } : null,
    };
  })()`);
}

assertSourcePort();

const client = createCdpClient(await getPageWebSocket());
try {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');

  await openWorkAtViewport(client, { width: 1000, height: 900 });
  const narrow = await sample(client, 'work-1000');
  await screenshot(client, '/tmp/local-work-rail-breakpoint-v36-1000.png');

  await openWorkAtViewport(client, { width: 1440, height: 900 });
  const desktop = await sample(client, 'work-1440');
  await screenshot(client, '/tmp/local-work-rail-breakpoint-v36-1440.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];

  if (narrow.mode !== 'work') failures.push(`Expected narrow sample in Work mode, got ${narrow.mode}.`);
  if (narrow.railDisplay !== 'none') {
    failures.push(`Expected Work rail hidden at 1000px like reference max-width 1150, got ${JSON.stringify(narrow)}.`);
  }
  if (desktop.mode !== 'work') failures.push(`Expected desktop sample in Work mode, got ${desktop.mode}.`);
  if (desktop.railDisplay === 'none' || Number(desktop.railOpacity) < 0.5) {
    failures.push(`Expected Work rail visible at 1440px, got ${JSON.stringify(desktop)}.`);
  }
  if (desktop.frameDisplay === 'none' || Math.abs(Number(desktop.frameOpacity) - 0.7) > 0.02) {
    failures.push(`Expected active frame opacity 0.7 at 1440px, got ${JSON.stringify(desktop)}.`);
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: [
      '/tmp/local-work-rail-breakpoint-v36-1000.png',
      '/tmp/local-work-rail-breakpoint-v36-1440.png',
    ],
    narrow,
    desktop,
    runtimeExceptions,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  client.close();
}
