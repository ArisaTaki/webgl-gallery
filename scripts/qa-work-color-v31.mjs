import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/webgl-gallery-002';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertSourcePort() {
  const main = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const checks = [
    ['main palette work', 'work: photoWorkColorFor(rgb, surface)'],
    ['main work css var', "galleryEls.shell.style.setProperty('--work-rgb'"],
    ['css thumb work background', 'background: rgb(var(--work-rgb));'],
    ['css stage work background', '.work-stage-bg'],
    ['css layer work background', '.work-layer-bg'],
  ];
  const missing = checks.filter(([_, needle]) => !(main.includes(needle) || css.includes(needle)));
  if (missing.length) {
    throw new Error(`Missing Work color source checks: ${missing.map(([label]) => label).join(', ')}`);
  }
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

function parseRgb(value) {
  const match = String(value || '').match(/\d+(?:\.\d+)?/g);
  return match ? match.slice(0, 3).map((number) => Math.round(Number(number))) : [];
}

function sameRgb(a, b, tolerance = 2) {
  return a.length === 3 && b.length === 3 && a.every((value, index) => Math.abs(value - b[index]) <= tolerance);
}

async function sample(client, label) {
  return evaluate(client, `(() => {
    const shell = document.querySelector('.gallery-shell');
    const style = getComputedStyle(shell);
    const activeLayer = document.querySelector('.work-layer.is-active');
    const activeThumb = document.querySelector('.detail-thumb.is-active');
    const layerBg = activeLayer?.querySelector('.work-layer-bg');
    const stageBg = document.querySelector('.work-stage-bg');
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      path: location.pathname,
      workVar: style.getPropertyValue('--work-rgb').trim(),
      surfaceVar: style.getPropertyValue('--surface-rgb').trim(),
      photoVar: style.getPropertyValue('--photo-rgb').trim(),
      activeLayerBg: layerBg ? getComputedStyle(layerBg).backgroundColor : '',
      activeThumbBg: activeThumb ? getComputedStyle(activeThumb).backgroundColor : '',
      stageBg: stageBg ? getComputedStyle(stageBg).backgroundColor : '',
      workBgOpacity: style.getPropertyValue('--work-bg-opacity').trim(),
      activeImageOpacity: activeLayer ? getComputedStyle(activeLayer.querySelector('.work-layer-img')).opacity : '',
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

  await key(client, 'e', 'KeyE', 69);
  await waitForMode(client, 'work');
  await sleep(1500);
  const stable = await sample(client, 'work-stable');
  await screenshot(client, '/tmp/local-work-color-v31-stable.png');

  await key(client, 'ArrowRight', 'ArrowRight', 39);
  await sleep(180);
  const switching = await sample(client, 'work-switch-180ms');
  await screenshot(client, '/tmp/local-work-color-v31-switch.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];
  const stableWork = parseRgb(stable.workVar);
  const stableSurface = parseRgb(stable.surfaceVar);
  const stablePhoto = parseRgb(stable.photoVar);

  if (stable.mode !== 'work') failures.push(`Expected Work mode, got ${stable.mode}.`);
  if (sameRgb(stableWork, stableSurface, 4)) {
    failures.push(`Expected Work color to be distinct from surface color, got work=${stable.workVar}, surface=${stable.surfaceVar}.`);
  }
  if (sameRgb(stableWork, stablePhoto, 2)) {
    failures.push(`Expected Work color to be derived but not identical to photo average, got work=${stable.workVar}, photo=${stable.photoVar}.`);
  }
  for (const [label, color] of [
    ['activeLayerBg', stable.activeLayerBg],
    ['activeThumbBg', stable.activeThumbBg],
    ['stageBg', stable.stageBg],
    ['switching activeLayerBg', switching.activeLayerBg],
    ['switching activeThumbBg', switching.activeThumbBg],
  ]) {
    if (!sameRgb(parseRgb(color), stableWork, 2)) {
      failures.push(`Expected ${label} to use --work-rgb ${stable.workVar}, got ${color}.`);
    }
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: [
      '/tmp/local-work-color-v31-stable.png',
      '/tmp/local-work-color-v31-switch.png',
    ],
    stable,
    switching,
    runtimeExceptions,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  client.close();
}
