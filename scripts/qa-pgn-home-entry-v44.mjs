import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertSourcePort() {
  const source = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const checks = [
    'paginationDigitShowOut: false,',
    'startPaginationDigitMotion(state.activeIndex, state.activeIndex, { out: true });',
    'const showOutEnterDelay = 220;',
    'const aShowOutStart = 101;',
    'const bShowOutStart = -101;',
    'state.paginationDigitShowOut && !enterStarted',
    'aX = aShowOutStart;',
    'bX = bShowOutStart;',
    'state.paginationDigitShowOut ? aShowOutStart : enterStart',
    'state.paginationDigitShowOut ? bShowOutStart : enterStart',
    'state.paginationDigitShowOut = Boolean(options.out);',
  ];
  const missing = checks.filter((check) => !source.includes(check));
  if (missing.length) {
    throw new Error(`Missing Home-to-Detail pgn split source checks: ${missing.join(', ')}`);
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
    const allEntries = [...document.querySelectorAll('.pgn')].map((item, index) => {
      const a = item.querySelector('.pgn-a > div');
      const b = item.querySelector('.pgn-b > div');
      const rootVisible = item.style.opacity !== '0';
      const visible = item.className.includes('is-visible') || item.className.includes('is-leaving');
      const windowed = item.style.width !== '0px' && item.style.height !== '0px';
      return {
        index,
        className: item.className,
        itemOpacity: item.style.opacity,
        rootVisible,
        visible,
        windowed,
        itemTop: item.style.top,
        itemWidth: item.style.width,
        itemHeight: item.style.height,
        aOpacity: a?.style.opacity || '',
        bOpacity: b?.style.opacity || '',
        aTransform: a?.style.transform || '',
        bTransform: b?.style.transform || '',
        aText: a?.textContent || '',
        bText: b?.textContent || '',
      };
    });
    const entries = allEntries.filter((entry) => entry.visible);
    const windows = allEntries.filter((entry) => entry.windowed);
    return {
      label: ${JSON.stringify(label)},
      current: document.querySelector('[data-current]')?.textContent?.trim() || '',
      mode: shell?.dataset.mode || '',
      path: location.pathname,
      rootVisibleCount: allEntries.filter((entry) => entry.rootVisible).length,
      entries,
      windows,
    };
  })()`);
}

function percentFromTransform(transform) {
  const match = /translate3d\((-?\d+(?:\.\d+)?)%/.exec(transform || '');
  return match ? Number(match[1]) : 0;
}

assertSourcePort();

const client = createCdpClient(await getPageWebSocket());
try {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
  await client.send('Page.navigate', { url: TARGET_URL });
  await waitForMode(client, 'index');
  await sleep(1300);

  const home = await sample(client, 'home-stable');
  await screenshot(client, '/tmp/local-pgn-home-entry-v44-home.png');

  await key(client, 'Enter', 'Enter', 13);
  await waitForMode(client, 'detail');
  await sleep(120);
  const entry120 = await sample(client, 'entry-120ms');
  await screenshot(client, '/tmp/local-pgn-home-entry-v44-120ms.png');

  await sleep(1300);
  const stable = await sample(client, 'detail-stable');
  await screenshot(client, '/tmp/local-pgn-home-entry-v44-stable.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];
  const entry = entry120.entries.find((item) => item.index === 0);
  const settled = stable.entries.find((item) => item.index === 0);

  const homeWindow = home.windows.find((item) => item.index === 0);
  if (home.mode !== 'index' || home.rootVisibleCount !== 30 || home.entries.length !== 0 || !homeWindow || home.windows.length !== 1) {
    failures.push(`Expected Home to keep 30 root-visible pgn slots and one hidden window at slot 0, got ${JSON.stringify(home)}.`);
  } else {
    const aX = percentFromTransform(homeWindow.aTransform);
    const bX = percentFromTransform(homeWindow.bTransform);
    if (aX > -35) failures.push(`Expected Home pgn-a to sit outside the left crop, got ${homeWindow.aTransform}.`);
    if (bX > -35) failures.push(`Expected Home pgn-b to sit outside the left crop, got ${homeWindow.bTransform}.`);
  }
  if (entry120.mode !== 'detail' || entry120.path !== '/nian-nian-001') {
    failures.push(`Expected Home Enter to open Detail /nian-nian-001, got ${JSON.stringify(entry120)}.`);
  }
  if (!entry) {
    failures.push(`Expected active pgn 0 entering at 120ms, got ${JSON.stringify(entry120.entries)}.`);
  } else {
    const aX = percentFromTransform(entry.aTransform);
    const bX = percentFromTransform(entry.bTransform);
    if (aX < 35) failures.push(`Expected pgn-a to wait outside the right crop at 120ms, got ${entry.aTransform}.`);
    if (bX > -35) failures.push(`Expected pgn-b to wait outside the left crop at 120ms, got ${entry.bTransform}.`);
    if (Number(entry.aOpacity) <= 0 || Number(entry.bOpacity) <= 0) {
      failures.push(`Expected entering pgn digits to be visible, got ${JSON.stringify(entry)}.`);
    }
  }
  if (stable.mode !== 'detail' || !settled) {
    failures.push(`Expected stable Detail pgn 0, got ${JSON.stringify(stable)}.`);
  } else {
    if (Math.abs(percentFromTransform(settled.aTransform)) > 0.1) {
      failures.push(`Expected stable pgn-a settled at 0, got ${settled.aTransform}.`);
    }
    if (Math.abs(percentFromTransform(settled.bTransform)) > 0.1) {
      failures.push(`Expected stable pgn-b settled at 0, got ${settled.bTransform}.`);
    }
  }
  if (runtimeExceptions.length) {
    failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);
  }

  const report = {
    screenshots: [
      '/tmp/local-pgn-home-entry-v44-home.png',
      '/tmp/local-pgn-home-entry-v44-120ms.png',
      '/tmp/local-pgn-home-entry-v44-stable.png',
    ],
    home,
    entry120,
    stable,
    runtimeExceptions,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  client.close();
}
