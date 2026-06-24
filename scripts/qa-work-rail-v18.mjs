import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/nian-nian-001';
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
    const rail = document.querySelector('.detail-rail');
    const active = document.querySelector('.detail-rail-active');
    const track = document.querySelector('.detail-rail-track');
    const activeThumb = document.querySelector('.detail-thumb.is-active');
    const railRect = rail?.getBoundingClientRect();
    const activeRect = active?.getBoundingClientRect();
    const thumbRect = activeThumb?.getBoundingClientRect();
    const expectedStep = 80 * (window.innerHeight / 1200);
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      activeThumbIndex: activeThumb ? Number(activeThumb.dataset.index) : -1,
      expectedStep,
      railOffset: parseFloat(rail?.style.getPropertyValue('--rail-offset') || '0'),
      railActiveY: parseFloat(rail?.style.getPropertyValue('--rail-active-y') || '0'),
      railRect: railRect ? { top: railRect.top, height: railRect.height, right: window.innerWidth - railRect.right } : null,
      activeRect: activeRect ? { top: activeRect.top, height: activeRect.height, right: window.innerWidth - activeRect.right } : null,
      thumbRect: thumbRect ? { top: thumbRect.top, height: thumbRect.height, right: window.innerWidth - thumbRect.right } : null,
      trackTransform: track ? getComputedStyle(track).transform : '',
    };
  })()`);
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
  await sleep(1300);
  const index0 = await sample(client, 'work-index-0');

  await key(client, 'ArrowRight', 'ArrowRight', 39);
  await sleep(1100);
  const index1 = await sample(client, 'work-index-1');

  await key(client, 'ArrowRight', 'ArrowRight', 39);
  await sleep(1100);
  const index2 = await sample(client, 'work-index-2');
  await screenshot(client, '/tmp/local-work-rail-v18-index2.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];

  if (index0.mode !== 'work' || index0.activeThumbIndex !== 0) {
    failures.push(`Expected Work index 0 start, got ${JSON.stringify(index0)}.`);
  }
  if (Math.abs(index0.railOffset) > 0.5 || Math.abs(index1.railOffset) > 0.5 || Math.abs(index2.railOffset) > 0.5) {
    failures.push(`Expected fixed reference rail offset 0 in Work, got ${JSON.stringify({ index0, index1, index2 })}.`);
  }
  if (Math.abs(index1.railActiveY - index1.expectedStep * 2) > 4) {
    failures.push(`Expected active frame y ~= two reference aYTarg steps after first Work media jump, got ${index1.railActiveY} vs ${index1.expectedStep * 2}.`);
  }
  if (Math.abs(index2.railActiveY - index2.expectedStep * 3) > 4) {
    failures.push(`Expected active frame y ~= three reference aYTarg steps after second Work media jump, got ${index2.railActiveY} vs ${index2.expectedStep * 3}.`);
  }
  if (Math.abs(index2.activeRect.right - 44) > 1.5) {
    failures.push(`Expected active frame right offset 44px like reference #w-a, got ${index2.activeRect?.right}.`);
  }
  if (Math.abs(index2.thumbRect.right - 50) > 1.5) {
    failures.push(`Expected thumb right offset 50px like reference #w-s-w, got ${index2.thumbRect?.right}.`);
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: ['/tmp/local-work-rail-v18-index2.png'],
    index0,
    index1,
    index2,
    runtimeExceptions,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  client.close();
}
