import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/nian-nian-002';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertSourcePort() {
  const main = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const checks = [
    'paginationDigitOut',
    'startPaginationDigitExit(state.activeIndex);',
    'const aOutEnd = 101;',
    'const bOutEnd = -101;',
    'state.paginationDigitOut ? aOutEnd : leaveEnd',
    'function startPaginationDigitExit(index)',
  ];
  const missing = checks.filter((needle) => !main.includes(needle));
  if (missing.length) throw new Error(`Missing pgn out-split source checks: ${missing.join(', ')}`);
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
        if (ready() || performance.now() - started > 8000) {
          clearInterval(timer);
          resolve(Boolean(ready()));
        }
      }, 50);
    })
  `);
  if (!ok) throw new Error(`Timed out waiting for mode ${mode}.`);
}

function percentFromTransform(transform) {
  const match = /translate3d\((-?\d+(?:\.\d+)?)%/.exec(transform || '');
  return match ? Number(match[1]) : 0;
}

async function sample(client, label) {
  return evaluate(client, `(() => {
    const shell = document.querySelector('.gallery-shell');
    const allEntries = [...document.querySelectorAll('.pgn')].map((item, index) => {
      const a = item.querySelector('.pgn-a > div');
      const b = item.querySelector('.pgn-b > div');
      const rootVisible = item.style.opacity !== '0';
      const painted = item.className.includes('is-visible') || item.className.includes('is-leaving');
      const windowed = item.style.width !== '0px' && item.style.height !== '0px';
      return {
        index,
        className: item.className,
        rootVisible,
        painted,
        windowed,
        itemTop: item.style.top,
        itemWidth: item.style.width,
        itemHeight: item.style.height,
        itemOpacity: item.style.opacity,
        aOpacity: a?.style.opacity || '',
        bOpacity: b?.style.opacity || '',
        aTransform: a?.style.transform || '',
        bTransform: b?.style.transform || '',
        aText: a?.textContent || '',
        bText: b?.textContent || '',
      };
    });
    const entries = allEntries.filter((entry) => entry.painted);
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      path: location.pathname,
      rootVisiblePgn: allEntries.filter((entry) => entry.rootVisible).length,
      entries,
      windows: allEntries.filter((entry) => entry.windowed),
      visiblePgn: [...document.querySelectorAll('.pgn.is-visible')].length,
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
  await sleep(900);

  const before = await sample(client, 'detail-before-out');
  await screenshot(client, '/tmp/local-pgn-out-split-v39-before.png');

  await key(client, 'ArrowUp', 'ArrowUp', 38);
  await waitForMode(client, 'index');
  await sleep(80);
  const exit80 = await sample(client, 'home-out-80ms');
  await screenshot(client, '/tmp/local-pgn-out-split-v39-80ms.png');

  await sleep(240);
  const settled = await sample(client, 'home-out-settled');
  await screenshot(client, '/tmp/local-pgn-out-split-v39-settled.png');

  const leaving = exit80.entries.find((entry) => entry.className.includes('is-leaving'));
  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];

  if (before.mode !== 'detail' || before.rootVisiblePgn !== 30 || before.visiblePgn !== 1 || before.entries[0]?.index !== 2) {
    failures.push(`Expected 30 root-visible slots and one visible Detail pgn at visual slot 2 before exit, got ${JSON.stringify(before)}.`);
  }
  if (exit80.mode !== 'index' || exit80.path !== '/') {
    failures.push(`Expected ArrowUp to exit to Home, got ${JSON.stringify(exit80)}.`);
  }
  if (!leaving || leaving.index !== 2) {
    failures.push(`Expected previous pgn visual slot 2 to keep a leaving layer at 80ms, got ${JSON.stringify(exit80.entries)}.`);
  } else {
    const aX = percentFromTransform(leaving.aTransform);
    const bX = percentFromTransform(leaving.bTransform);
    if (aX <= 5) failures.push(`Expected pgn-a to split right on Home exit, got ${leaving.aTransform}.`);
    if (bX >= -5) failures.push(`Expected pgn-b to split left on Home exit, got ${leaving.bTransform}.`);
    if (Number(leaving.aOpacity) < 0.95 || Number(leaving.bOpacity) < 0.95) {
      failures.push(`Expected out split opacity to stay visible while the crop hides it, got ${JSON.stringify(leaving)}.`);
    }
  }
  const settledWindow = settled.windows.find((entry) => entry.index === 2);
  if (settled.rootVisiblePgn !== 30 || settled.entries.length !== 0 || settled.visiblePgn !== 0 || !settledWindow || settled.windows.length !== 1) {
    failures.push(`Expected Home to settle with 30 root-visible slots and one hidden current window at slot 2, got ${JSON.stringify(settled)}.`);
  } else {
    const aX = percentFromTransform(settledWindow.aTransform);
    const bX = percentFromTransform(settledWindow.bTransform);
    if (aX <= 35) failures.push(`Expected settled Home pgn-a to remain split right, got ${settledWindow.aTransform}.`);
    if (bX >= -35) failures.push(`Expected settled Home pgn-b to remain split left, got ${settledWindow.bTransform}.`);
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: [
      '/tmp/local-pgn-out-split-v39-before.png',
      '/tmp/local-pgn-out-split-v39-80ms.png',
      '/tmp/local-pgn-out-split-v39-settled.png',
    ],
    before,
    exit80,
    settled,
    runtimeExceptions,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  client.close();
}
