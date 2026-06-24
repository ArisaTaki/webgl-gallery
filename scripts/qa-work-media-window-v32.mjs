import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/nian-nian-002';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertSourcePort() {
  const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const checks = [
    ['media window constant', 'const WORK_MEDIA_WINDOW = 7'],
    ['reference media slots', 'const REFERENCE_WORK_MEDIA_OFFSETS = [0, 2, 3, 4, 6, 8, 9]'],
    ['media resolver', 'function getWorkMediaIndices'],
    ['work order helper', 'function getWorkMediaOrder'],
    ['keyboard media traversal', 'const media = getWorkMediaIndices();'],
    ['thumb work class', "button.classList.toggle('is-work-media'"],
    ['non-media pointer guard', '.gallery-shell.is-work .detail-thumb:not(.is-work-media)'],
  ];
  const missing = checks.filter(([, needle]) => !(main.includes(needle) || css.includes(needle)));
  if (missing.length) {
    throw new Error(`Missing Work media-window source checks: ${missing.map(([label]) => label).join(', ')}`);
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

async function sample(client, label) {
  return evaluate(client, `(() => {
    const shell = document.querySelector('.gallery-shell');
    const thumbs = [...document.querySelectorAll('.detail-thumb')];
    const mapThumb = (button) => {
      const style = getComputedStyle(button);
      const image = button.querySelector('span');
      return {
        index: Number(button.dataset.index),
        workOrder: Number(button.dataset.workOrder),
        order: Number(style.order),
        active: button.classList.contains('is-active'),
        workMedia: button.classList.contains('is-work-media'),
        opacity: Number(style.opacity),
        pointerEvents: style.pointerEvents,
        tabIndex: button.tabIndex,
        ariaHidden: button.getAttribute('aria-hidden'),
        transform: style.transform,
        imageOpacity: image ? Number(getComputedStyle(image).opacity) : -1,
      };
    };
    const media = thumbs
      .filter((button) => button.classList.contains('is-work-media'))
      .map(mapThumb)
      .sort((a, b) => a.workOrder - b.workOrder);
    const hidden = thumbs.filter((button) => !button.classList.contains('is-work-media')).slice(0, 5).map(mapThumb);
    const active = thumbs.find((button) => button.classList.contains('is-active'));
    const frame = document.querySelector('.detail-rail-active');
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      path: location.pathname,
      frame: document.querySelector('[data-shadow-frame]')?.textContent || '',
      activeThumbIndex: active ? Number(active.dataset.index) : -1,
      activeThumbOrder: active ? Number(active.dataset.workOrder) : -1,
      visibleMediaCount: media.length,
      media,
      hidden,
      railActiveTransform: frame ? getComputedStyle(frame).transform : '',
    };
  })()`);
}

function referenceSlotOrders(media) {
  return media.every((item, index) => item.workOrder === index && item.order === item.index);
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
  await sleep(1400);
  const stable = await sample(client, 'work-window-stable');
  await screenshot(client, '/tmp/local-work-media-window-v32-stable.png');

  await key(client, 'ArrowRight', 'ArrowRight', 39);
  await sleep(500);
  const next = await sample(client, 'work-window-next');
  await screenshot(client, '/tmp/local-work-media-window-v32-next.png');

  await key(client, 'ArrowUp', 'ArrowUp', 38);
  await sleep(500);
  const returnedFirst = await sample(client, 'work-window-return-first');

  await key(client, 'ArrowUp', 'ArrowUp', 38);
  await waitForMode(client, 'detail');
  await sleep(450);
  const closed = await sample(client, 'work-window-close');
  await screenshot(client, '/tmp/local-work-media-window-v32-close.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];

  if (stable.mode !== 'work') failures.push(`Expected stable Work mode, got ${stable.mode}.`);
  if (stable.visibleMediaCount !== 7) {
    failures.push(`Expected 7 visible Work media thumbs, got ${stable.visibleMediaCount}.`);
  }
  const stableMediaOrder = stable.media.map((item) => item.index).join(',');
  if (stableMediaOrder !== '1,3,4,5,7,9,10') {
    failures.push(`Expected reference-like Work media slots 1,3,4,5,7,9,10, got ${stableMediaOrder}.`);
  }
  if (!referenceSlotOrders(stable.media)) {
    failures.push(`Expected sequential Work media orders with global CSS slots, got ${JSON.stringify(stable.media)}.`);
  }
  if (stable.media[0]?.index !== stable.activeThumbIndex || stable.activeThumbOrder !== 0) {
    failures.push(`Expected first Work media to be active initially, got ${JSON.stringify(stable)}.`);
  }
  if (!stable.hidden.length) {
    failures.push('Expected hidden non-media thumbnails to remain in the rail but outside the current Work media set.');
  }
  for (const hidden of stable.hidden) {
    if (hidden.pointerEvents !== 'none' || hidden.tabIndex !== -1 || hidden.ariaHidden !== 'true') {
      failures.push(`Expected hidden thumb to be non-interactive, got ${JSON.stringify(hidden)}.`);
      break;
    }
  }
  if (next.activeThumbOrder !== 1 || next.activeThumbIndex !== stable.media[1]?.index) {
    failures.push(`Expected ArrowRight to advance to second Work media, got ${JSON.stringify(next)}.`);
  }
  if (returnedFirst.activeThumbOrder !== 0 || returnedFirst.activeThumbIndex !== stable.media[0]?.index) {
    failures.push(`Expected ArrowUp to return to first Work media, got ${JSON.stringify(returnedFirst)}.`);
  }
  if (closed.mode !== 'detail') {
    failures.push(`Expected ArrowUp at first Work media to close to Detail, got ${closed.mode}.`);
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: [
      '/tmp/local-work-media-window-v32-stable.png',
      '/tmp/local-work-media-window-v32-next.png',
      '/tmp/local-work-media-window-v32-close.png',
    ],
    stable,
    next,
    returnedFirst,
    closed,
    runtimeExceptions,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exit(1);
} finally {
  client.close();
}
