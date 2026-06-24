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
      activePlaneAlpha: number(data.activePlaneAlpha),
      activePlaneAlphaTarget: number(data.activePlaneAlphaTarget),
      activePlaneLight: number(data.activePlaneLight),
      activePlaneMultiply: number(data.activePlaneMultiply),
      frame: document.querySelector('[data-shadow-frame]')?.textContent?.trim() || '',
      visiblePgn: [...document.querySelectorAll('.pgn.is-visible')]
        .map((item) => item.textContent.trim().replace(/\\s+/g, ' '))
        .join(' | '),
    };
  })()`);
}

const source = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const staticFailures = [];
if (!source.includes('float light = vCurve + uColorMix;')) {
  staticFailures.push('Expected shader to use unclamped reference light mix: vCurve + uColorMix.');
}
if (source.includes('float light = clamp(vCurve + uColorMix')) {
  staticFailures.push('Found old clamped shader light mix.');
}
if (!source.includes('const alphaEase = target.alpha <= 0.001 ? 0.23 : 0.07;')) {
  staticFailures.push('Expected reference alpha damping: hide 0.23, show 0.07.');
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

  const detail = await sample(client, 'detail-stable');
  await screenshot(client, '/tmp/local-shader-light-v28-detail.png');

  await key(client, 'e', 'KeyE', 69);
  await waitForMode(client, 'work');
  await sleep(360);
  const workEntering = await sample(client, 'work-entering-360ms');
  await screenshot(client, '/tmp/local-shader-light-v28-work-entering.png');

  await sleep(1100);
  const workStable = await sample(client, 'work-stable');
  await screenshot(client, '/tmp/local-shader-light-v28-work-stable.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [...staticFailures];

  if (detail.mode !== 'detail' || detail.frame !== '002 / 017') {
    failures.push(`Expected stable Detail frame 002, got ${JSON.stringify(detail)}.`);
  }
  if ((detail.activePlaneAlpha || 0) < 0.9 || detail.activePlaneAlphaTarget !== 1) {
    failures.push(`Expected active Detail plane alpha to settle toward target 1, got ${JSON.stringify(detail)}.`);
  }
  if ((detail.activePlaneLight || 0) < 0.9) {
    failures.push(`Expected active Detail plane light near 1, got ${JSON.stringify(detail)}.`);
  }
  if (workEntering.mode !== 'work' || workStable.mode !== 'work') {
    failures.push(`Expected Work mode after key e, got ${JSON.stringify({ workEntering, workStable })}.`);
  }
  if ((workStable.activePlaneAlpha || 0) < 0.9 || workStable.activePlaneAlphaTarget !== 1) {
    failures.push(`Expected active Work plane alpha to remain near target 1, got ${JSON.stringify(workStable)}.`);
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: [
      '/tmp/local-shader-light-v28-detail.png',
      '/tmp/local-shader-light-v28-work-entering.png',
      '/tmp/local-shader-light-v28-work-stable.png',
    ],
    detail,
    workEntering,
    workStable,
    runtimeExceptions,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  client.close();
}
