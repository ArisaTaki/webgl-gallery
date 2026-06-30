import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/webgl-gallery-002';
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

async function waitForDetail(client) {
  await evaluate(client, `
    new Promise((resolve) => {
      const ready = () => document.querySelector('.gallery-shell')?.dataset.mode === 'detail';
      if (ready()) resolve(true);
      const started = performance.now();
      const timer = setInterval(() => {
        if (ready() || performance.now() - started > 7000) {
          clearInterval(timer);
          resolve(Boolean(ready()));
        }
      }, 50);
    })
  `);
}

async function sample(client, label) {
  return evaluate(client, `(() => {
    const shell = document.querySelector('.gallery-shell');
    const allEntries = [...document.querySelectorAll('.pgn')].map((item, index) => {
      const a = item.querySelector('.pgn-a > div');
      const b = item.querySelector('.pgn-b > div');
      const rootVisible = item.style.opacity !== '0';
      const visible = item.className.includes('is-visible') || item.className.includes('is-leaving');
      return {
        index,
        className: item.className,
        itemOpacity: item.style.opacity,
        rootVisible,
        visible,
        aOpacity: a?.style.opacity || '',
        bOpacity: b?.style.opacity || '',
        aTransform: a?.style.transform || '',
        bTransform: b?.style.transform || '',
        aText: a?.textContent || '',
        bText: b?.textContent || '',
      };
    });
    const entries = allEntries.filter((entry) => entry.visible);
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      pathname: location.pathname,
      rootVisibleCount: allEntries.filter((entry) => entry.rootVisible).length,
      visibleCount: entries.length,
      entries,
    };
  })()`);
}

function percentFromTransform(transform) {
  const match = /translate3d\((-?\d+(?:\.\d+)?)%/.exec(transform || '');
  return match ? Number(match[1]) : 0;
}

const client = createCdpClient(await getPageWebSocket());
try {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
  await client.send('Page.navigate', { url: TARGET_URL });
  await waitForDetail(client);
  await sleep(650);

  const before = await sample(client, 'before');
  await screenshot(client, '/tmp/local-pgn-v15-before.png');

  await key(client, 'ArrowRight', 'ArrowRight', 39);
  await sleep(120);
  const switch120 = await sample(client, 'switch-120ms');
  await screenshot(client, '/tmp/local-pgn-v15-switch-120ms.png');

  await sleep(530);
  const switch650 = await sample(client, 'switch-650ms');
  await screenshot(client, '/tmp/local-pgn-v15-switch-650ms.png');

  await sleep(950);
  const stable = await sample(client, 'stable');

  await key(client, 'e', 'KeyE', 69);
  await sleep(900);
  const work = await sample(client, 'work');
  await screenshot(client, '/tmp/local-pgn-v15-work.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);

  const leaving120 = switch120.entries.find((entry) => entry.className.includes('is-leaving'));
  const entering120 = switch120.entries.find((entry) => entry.index === 4 && entry.className.includes('is-visible'));
  const entering650 = switch650.entries.find((entry) => entry.index === 4 && entry.className.includes('is-visible'));
  const stableEntry = stable.entries.find((entry) => entry.index === 4);
  const workEntry = work.entries.find((entry) => entry.index === 4);
  const failures = [];

  if (before.rootVisibleCount !== 30 || stable.rootVisibleCount !== 30) {
    failures.push(`Expected reference-like 30 root-visible pgn slots, got before/stable ${before.rootVisibleCount}/${stable.rootVisibleCount}.`);
  }
  if (before.visibleCount !== 1 || before.entries[0]?.index !== 2) {
    failures.push(`Expected one painted starting pgn at visual slot 2, got ${JSON.stringify(before.entries)}.`);
  }
  if (!leaving120 || leaving120.index !== 2) {
    failures.push(`Expected previous pgn visual slot 2 to be leaving at 120ms, got ${JSON.stringify(switch120.entries)}.`);
  } else if (percentFromTransform(leaving120.aTransform) >= -1) {
    failures.push(`Expected leaving pgn to move left, got ${leaving120.aTransform}.`);
  }
  if (!entering120) {
    failures.push(`Expected active pgn visual slot 4 to be entering at 120ms, got ${JSON.stringify(switch120.entries)}.`);
  } else if (percentFromTransform(entering120.aTransform) <= 1) {
    failures.push(`Expected entering pgn to start from the right, got ${entering120.aTransform}.`);
  }
  if (!entering650 || Math.abs(percentFromTransform(entering650.aTransform)) > 12) {
    failures.push(`Expected entering pgn near settled by 650ms, got ${entering650?.aTransform}.`);
  }
  if (stable.visibleCount !== 1 || Math.abs(percentFromTransform(stableEntry?.aTransform)) > 0.1) {
    failures.push(`Expected one stable pgn at visual slot 4, got ${JSON.stringify(stable.entries)}.`);
  }
  if (work.mode !== 'work' || !workEntry) {
    failures.push(`Expected pgn to remain visible in Work mode at visual slot 4, got ${JSON.stringify(work)}.`);
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: [
      '/tmp/local-pgn-v15-before.png',
      '/tmp/local-pgn-v15-switch-120ms.png',
      '/tmp/local-pgn-v15-switch-650ms.png',
      '/tmp/local-pgn-v15-work.png',
    ],
    before,
    switch120,
    switch650,
    stable,
    work,
    runtimeExceptions,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));

  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  client.close();
}
