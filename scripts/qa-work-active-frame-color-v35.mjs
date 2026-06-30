import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/webgl-gallery-002';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertSourcePort() {
  const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const checks = [
    'border-color: rgb(var(--text-rgb));',
    'background: rgb(var(--work-rgb));',
    'opacity: 0.7;',
  ];
  const missing = checks.filter((needle) => !css.includes(needle));
  if (missing.length) throw new Error(`Missing Work active-frame color CSS: ${missing.join(', ')}`);
  if (css.includes('transition: opacity 420ms')) throw new Error('Work active frame should not fade its opacity; reference #w-a is already at opacity 0.7 during Work entry.');
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

function closeTo(value, target, tolerance = 0.02) {
  return Math.abs(Number(value) - target) <= tolerance;
}

async function sample(client, label) {
  return evaluate(client, `(() => {
    const shell = document.querySelector('.gallery-shell');
    const shellStyle = getComputedStyle(shell);
    const activeFrame = document.querySelector('.detail-rail-active');
    const activeThumb = document.querySelector('.detail-thumb.is-active');
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      shellClass: shell?.className || '',
      textVar: shellStyle.getPropertyValue('--text-rgb').trim(),
      workVar: shellStyle.getPropertyValue('--work-rgb').trim(),
      frameBorderColor: activeFrame ? getComputedStyle(activeFrame).borderTopColor : '',
      frameOpacity: activeFrame ? getComputedStyle(activeFrame).opacity : '',
      thumbBg: activeThumb ? getComputedStyle(activeThumb).backgroundColor : '',
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
  await sleep(1000);

  await key(client, 'e', 'KeyE', 69);
  await waitForMode(client, 'work');
  await sleep(1500);
  const stable = await sample(client, 'work-stable');
  await screenshot(client, '/tmp/local-work-active-frame-color-v35-stable.png');

  await key(client, 'ArrowRight', 'ArrowRight', 39);
  await sleep(220);
  const switching = await sample(client, 'work-switching');
  await screenshot(client, '/tmp/local-work-active-frame-color-v35-switch.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];
  const stableText = parseRgb(stable.textVar);
  const stableWork = parseRgb(stable.workVar);

  if (stable.mode !== 'work') failures.push(`Expected stable Work mode, got ${stable.mode}.`);
  if (!sameRgb(parseRgb(stable.frameBorderColor), stableText, 2)) {
    failures.push(`Expected active frame border to use --text-rgb ${stable.textVar}, got ${stable.frameBorderColor}.`);
  }
  if (!sameRgb(parseRgb(switching.frameBorderColor), stableText, 2)) {
    failures.push(`Expected switching frame border to retain --text-rgb ${stable.textVar}, got ${switching.frameBorderColor}.`);
  }
  if (!sameRgb(parseRgb(stable.thumbBg), stableWork, 2)) {
    failures.push(`Expected active thumb background to use --work-rgb ${stable.workVar}, got ${stable.thumbBg}.`);
  }
  if (sameRgb(parseRgb(stable.frameBorderColor), stableWork, 2)) {
    failures.push(`Expected frame border to stay distinct from Work media background, got ${stable.frameBorderColor}.`);
  }
  if (!closeTo(stable.frameOpacity, 0.7) || !closeTo(switching.frameOpacity, 0.7)) {
    failures.push(`Expected active frame opacity to match reference 0.7, got stable ${stable.frameOpacity} and switching ${switching.frameOpacity}.`);
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: [
      '/tmp/local-work-active-frame-color-v35-stable.png',
      '/tmp/local-work-active-frame-color-v35-switch.png',
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
