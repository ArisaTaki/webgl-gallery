import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/webgl-gallery-002';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getPageWebSocket() {
  const targets = await fetch(`${CDP_URL}/json`).then((response) => response.json());
  const page = targets.find((target) => target.type === 'page') || targets[0];
  if (!page?.webSocketDebuggerUrl) throw new Error('No Chrome page target available.');
  return page.webSocketUrl || page.webSocketDebuggerUrl;
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
    const root = document.querySelector('.project-pagination');
    const symbol = document.querySelector('.pagination-switch');
    const line = document.querySelector('.project-pagination-line');
    const labelEl = document.querySelector('.project-pagination-label > span');
    const symbolStyle = getComputedStyle(symbol);
    const lineStyle = getComputedStyle(line, '::before');
    const labelStyle = getComputedStyle(labelEl);
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      rootOpacity: root ? getComputedStyle(root).opacity : '',
      rootVisibility: root ? getComputedStyle(root).visibility : '',
      symbol: {
        delay: symbolStyle.animationDelay,
        duration: symbolStyle.animationDuration,
        name: symbolStyle.animationName,
        transform: symbolStyle.transform,
      },
      line: {
        delay: lineStyle.animationDelay,
        duration: lineStyle.animationDuration,
        name: lineStyle.animationName,
        transform: lineStyle.transform,
      },
      text: {
        delay: labelStyle.animationDelay,
        duration: labelStyle.animationDuration,
        name: labelStyle.animationName,
        transform: labelStyle.transform,
      },
    };
  })()`);
}

function matrixY(transform) {
  const match = transform.match(/matrix\([^,]+,\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*([^)]+)\)/);
  if (!match) return 0;
  return Number.parseFloat(match[1]);
}

const client = createCdpClient(await getPageWebSocket());
try {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
  await client.send('Page.navigate', { url: TARGET_URL });
  await waitForMode(client, 'detail');
  await sleep(900);

  await key(client, 'e', 'KeyE', 69);
  await waitForMode(client, 'work');
  await sleep(450);
  const mid450 = await sample(client, 'work-450ms');
  await screenshot(client, '/tmp/local-project-control-v24-450ms.png');

  await sleep(1550);
  const stable = await sample(client, 'work-stable');
  await screenshot(client, '/tmp/local-project-control-v24-stable.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];
  const symbolY450 = matrixY(mid450.symbol.transform);
  const lineY450 = matrixY(mid450.line.transform);
  const textY450 = matrixY(mid450.text.transform);
  const symbolYStable = matrixY(stable.symbol.transform);
  const lineYStable = matrixY(stable.line.transform);
  const textYStable = matrixY(stable.text.transform);

  if (mid450.mode !== 'work' || stable.mode !== 'work') {
    failures.push(`Expected Work mode during PROJECTS control check, got ${JSON.stringify({ mid450: mid450.mode, stable: stable.mode })}.`);
  }
  if (mid450.symbol.duration !== '1.4s' || mid450.symbol.delay !== '0.6s') {
    failures.push(`Expected symbol 1400ms/600ms timing, got ${JSON.stringify(mid450.symbol)}.`);
  }
  if (mid450.line.duration !== '1.2s' || mid450.line.delay !== '0.6s') {
    failures.push(`Expected line 1200ms/600ms timing, got ${JSON.stringify(mid450.line)}.`);
  }
  if (mid450.text.duration !== '1.4s' || mid450.text.delay !== '0.4s') {
    failures.push(`Expected label 1400ms/400ms timing, got ${JSON.stringify(mid450.text)}.`);
  }
  if (symbolY450 <= 0 || lineY450 <= 0 || textY450 <= 0) {
    failures.push(`Expected PROJECTS control to enter from positive Y like reference L motion, got ${JSON.stringify({ symbolY450, lineY450, textY450, mid450 })}.`);
  }
  if (Math.abs(symbolYStable) > 0.5 || Math.abs(lineYStable) > 0.5 || Math.abs(textYStable) > 0.5) {
    failures.push(`Expected PROJECTS control to settle at zero Y, got ${JSON.stringify({ symbolYStable, lineYStable, textYStable, stable })}.`);
  }
  if (stable.rootOpacity !== '1' || stable.rootVisibility !== 'visible') {
    failures.push(`Expected PROJECTS control visible in stable Work, got ${JSON.stringify(stable)}.`);
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: [
      '/tmp/local-project-control-v24-450ms.png',
      '/tmp/local-project-control-v24-stable.png',
    ],
    mid450,
    stable,
    runtimeExceptions,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  client.close();
}
