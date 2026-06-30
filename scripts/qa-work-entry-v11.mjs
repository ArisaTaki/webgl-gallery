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

const client = createCdpClient(await getPageWebSocket());
try {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
  await client.send('Page.navigate', { url: TARGET_URL });
  await sleep(1800);
  await evaluate(client, `
    new Promise((resolve) => {
      const ready = () => document.querySelector('.visit-link') && document.querySelector('.work-layer');
      if (ready()) resolve(true);
      const started = performance.now();
      const timer = setInterval(() => {
        if (ready() || performance.now() - started > 3000) {
          clearInterval(timer);
          resolve(Boolean(ready()));
        }
      }, 50);
    })
  `);

  const before = await evaluate(client, `(() => {
    const active = document.querySelector('.work-layer.is-active') || document.querySelector('.work-layer');
    const activeImg = active?.querySelector('.work-layer-img');
    const visit = document.querySelector('.visit-link');
    return {
      mode: document.querySelector('.gallery-shell')?.dataset.mode,
      activeY: active?.style.getPropertyValue('--work-layer-y') || '',
      activeOpacity: active?.style.getPropertyValue('--work-layer-opacity') || '',
      computedActiveOpacity: activeImg ? getComputedStyle(activeImg).opacity : '',
      visitOpacity: visit ? getComputedStyle(visit).opacity : '',
    };
  })()`);

  await evaluate(client, `document.querySelector('.visit-link')?.click()`);
  await sleep(150);
  const entry150 = await evaluate(client, `(() => {
    const active = document.querySelector('.work-layer.is-active');
    const activeImg = active?.querySelector('.work-layer-img');
    const stage = document.querySelector('.work-stage');
    const shell = document.querySelector('.gallery-shell');
    const bg = document.querySelector('.work-stage-bg');
    return {
      mode: shell?.dataset.mode,
      shellClass: shell?.className,
      activeY: active?.style.getPropertyValue('--work-layer-y') || '',
      activeOpacity: active?.style.getPropertyValue('--work-layer-opacity') || '',
      computedActiveOpacity: activeImg ? getComputedStyle(activeImg).opacity : '',
      activeTransform: active ? getComputedStyle(active).transform : '',
      stageTransform: stage ? getComputedStyle(stage).transform : '',
      bgOpacity: bg?.style.getPropertyValue('--work-bg-opacity') || '',
      workMix: window.__NIAN_STATE__?.workMix,
    };
  })()`);
  await screenshot(client, '/tmp/local-work-entry-lt3d-v11-150ms.png');

  await sleep(300);
  const entry450 = await evaluate(client, `(() => {
    const active = document.querySelector('.work-layer.is-active');
    const activeImg = active?.querySelector('.work-layer-img');
    const stage = document.querySelector('.work-stage');
    const shell = document.querySelector('.gallery-shell');
    const bg = document.querySelector('.work-stage-bg');
    return {
      mode: shell?.dataset.mode,
      activeY: active?.style.getPropertyValue('--work-layer-y') || '',
      activeOpacity: active?.style.getPropertyValue('--work-layer-opacity') || '',
      computedActiveOpacity: activeImg ? getComputedStyle(activeImg).opacity : '',
      activeTransform: active ? getComputedStyle(active).transform : '',
      stageTransform: stage ? getComputedStyle(stage).transform : '',
      bgOpacity: bg?.style.getPropertyValue('--work-bg-opacity') || '',
    };
  })()`);
  await screenshot(client, '/tmp/local-work-entry-lt3d-v11-450ms.png');

  await sleep(1350);
  const stable = await evaluate(client, `(() => {
    const active = document.querySelector('.work-layer.is-active');
    const activeImg = active?.querySelector('.work-layer-img');
    const shell = document.querySelector('.gallery-shell');
    const bg = document.querySelector('.work-stage-bg');
    return {
      mode: shell?.dataset.mode,
      activeY: active?.style.getPropertyValue('--work-layer-y') || '',
      activeOpacity: active?.style.getPropertyValue('--work-layer-opacity') || '',
      computedActiveOpacity: activeImg ? getComputedStyle(activeImg).opacity : '',
      activeTransform: active ? getComputedStyle(active).transform : '',
      bgOpacity: bg?.style.getPropertyValue('--work-bg-opacity') || '',
    };
  })()`);
  await screenshot(client, '/tmp/local-work-entry-lt3d-v11-stable.png');

  const diagnostics = client.events
    .filter((event) => ['Runtime.exceptionThrown', 'Log.entryAdded'].includes(event.method))
    .map((event) => event.params);

  console.log(JSON.stringify({
    screenshots: [
      '/tmp/local-work-entry-lt3d-v11-150ms.png',
      '/tmp/local-work-entry-lt3d-v11-450ms.png',
      '/tmp/local-work-entry-lt3d-v11-stable.png',
    ],
    before,
    entry150,
    entry450,
    stable,
    diagnostics,
  }, null, 2));
} finally {
  client.close();
}
