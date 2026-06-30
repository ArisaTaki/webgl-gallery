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
    const activeMeta = document.querySelector('.project-shadow-meta:not(.project-shadow-meta-prev)');
    const prevMeta = document.querySelector('.project-shadow-meta-prev');
    const activeCopy = document.querySelector('.project-shadow-copy:not(.project-shadow-copy-prev)');
    const prevCopy = document.querySelector('.project-shadow-copy-prev');
    const firstActive = activeMeta?.querySelector('strong');
    const firstPrev = prevMeta?.querySelector('strong');
    const activeFrame = document.querySelector('[data-shadow-frame]');
    const prevFrame = document.querySelector('[data-shadow-frame-prev]');
    const copyLine = activeCopy?.querySelector('div');
    const prevCopyLine = prevCopy?.querySelector('div');
    const info = (el) => {
      const cs = el ? getComputedStyle(el) : null;
      return {
        animationDelay: cs?.animationDelay || '',
        animationDuration: cs?.animationDuration || '',
        animationName: cs?.animationName || '',
        transform: cs?.transform || '',
      };
    };
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      path: location.pathname,
      shellClass: shell?.className || '',
      activeFrame: activeFrame?.textContent?.trim() || '',
      prevFrame: prevFrame?.textContent?.trim() || '',
      activeMetaDisplay: activeMeta ? getComputedStyle(activeMeta).display : '',
      prevMetaDisplay: prevMeta ? getComputedStyle(prevMeta).display : '',
      activeCopyDisplay: activeCopy ? getComputedStyle(activeCopy).display : '',
      prevCopyDisplay: prevCopy ? getComputedStyle(prevCopy).display : '',
      activeMetaStrong: info(firstActive),
      prevMetaStrong: info(firstPrev),
      activeCopyLine: info(copyLine),
      prevCopyLine: info(prevCopyLine),
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
  await sleep(900);

  const before = await sample(client, 'before');
  await screenshot(client, '/tmp/local-detail-meta-switch-v26-before.png');

  await key(client, 'ArrowRight', 'ArrowRight', 39);
  await sleep(120);
  const switch120 = await sample(client, 'switch-120ms');
  await screenshot(client, '/tmp/local-detail-meta-switch-v26-120ms.png');

  await sleep(530);
  const switch650 = await sample(client, 'switch-650ms');
  await screenshot(client, '/tmp/local-detail-meta-switch-v26-650ms.png');

  await sleep(1250);
  const stable = await sample(client, 'stable');
  await screenshot(client, '/tmp/local-detail-meta-switch-v26-stable.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];

  if (before.mode !== 'detail' || before.activeFrame !== '002 / 017' || before.prevMetaDisplay !== 'none') {
    failures.push(`Expected stable starting Detail frame 002 with previous meta hidden, got ${JSON.stringify(before)}.`);
  }
  if (!switch120.shellClass.includes('is-project-switching') || switch120.activeFrame !== '003 / 017') {
    failures.push(`Expected 120ms switch state to show active frame 003 and switching class, got ${JSON.stringify(switch120)}.`);
  }
  if (switch120.prevFrame !== '002 / 017' || switch120.prevMetaDisplay !== 'grid' || switch120.prevCopyDisplay !== 'block') {
    failures.push(`Expected previous meta/copy layer to show old frame 002 at 120ms, got ${JSON.stringify(switch120)}.`);
  }
  if (switch120.prevMetaStrong.animationName !== 'text-line-drop-out' || switch120.prevMetaStrong.animationDuration !== '0.5s') {
    failures.push(`Expected previous meta to run 500ms text-line-drop-out, got ${JSON.stringify(switch120.prevMetaStrong)}.`);
  }
  if (switch120.activeMetaStrong.animationName !== 'text-line-drop-in' || switch120.activeMetaStrong.animationDuration !== '1.6s') {
    failures.push(`Expected active meta to run 1600ms text-line-drop-in, got ${JSON.stringify(switch120.activeMetaStrong)}.`);
  }
  if (switch120.activeMetaStrong.animationDelay !== '0.4s') {
    failures.push(`Expected active meta first row delay 0.4s like reference info show delay, got ${switch120.activeMetaStrong.animationDelay}.`);
  }
  if (switch120.activeCopyLine.animationDelay !== '0.6s') {
    failures.push(`Expected active copy first row delay 0.6s like reference explore show delay, got ${switch120.activeCopyLine.animationDelay}.`);
  }
  if (switch650.prevMetaStrong.animationName !== 'text-line-drop-out') {
    failures.push(`Expected previous meta layer to keep completed out animation during switch window, got ${JSON.stringify(switch650.prevMetaStrong)}.`);
  }
  if (stable.shellClass.includes('is-project-switching') || stable.prevMetaDisplay !== 'none' || stable.activeFrame !== '003 / 017') {
    failures.push(`Expected stable frame 003 with previous layer hidden, got ${JSON.stringify(stable)}.`);
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: [
      '/tmp/local-detail-meta-switch-v26-before.png',
      '/tmp/local-detail-meta-switch-v26-120ms.png',
      '/tmp/local-detail-meta-switch-v26-650ms.png',
      '/tmp/local-detail-meta-switch-v26-stable.png',
    ],
    before,
    switch120,
    switch650,
    stable,
    runtimeExceptions,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  client.close();
}
