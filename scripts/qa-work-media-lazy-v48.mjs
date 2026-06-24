import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/nian-nian-002';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertSourcePort() {
  const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const checks = [
    ['empty media source constant', "const EMPTY_MEDIA_SRC = 'data:,';"],
    ['work layer starts empty', 'src="${EMPTY_MEDIA_SRC}" data-work-src='],
    ['thumb source held in data attr', 'data-thumb-src="${photo.thumb || photo.medium || \'\'}"'],
    ['work layer reset source', 'img.src = EMPTY_MEDIA_SRC;'],
    ['work layer decode loader', 'function requestWorkLayerImageLoad(index, motion, delay = 100)'],
    ['thumb background reset', "image.style.backgroundImage = 'none';"],
    ['thumb decode loader', 'function requestWorkThumbImageLoad(index, motion, delay = 0)'],
    ['reference active large delay', 'requestWorkLayerImageLoad(index, motion, WORK_ENTRY_REVEAL_DELAY);'],
    ['reference switch large delay', 'requestWorkLayerImageLoad(index, motion, WORK_SWITCH_REVEAL_DELAY);'],
    ['reference thumb queue delay', 'requestWorkThumbImageLoad(index, motion, mediaOrder * 80);'],
    ['stale large load guard', "if (img.dataset.loadToken !== token) return;"],
    ['stale thumb load guard', "if (image.dataset.loadToken !== token) return;"],
  ];
  const missing = checks.filter(([, needle]) => !main.includes(needle));
  if (missing.length) {
    throw new Error(`Missing Work lazy media source checks: ${missing.map(([label]) => label).join(', ')}`);
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
    const layers = [...document.querySelectorAll('.work-layer')].map((layer) => {
      const img = layer.querySelector('.work-layer-img');
      const src = img?.getAttribute('src') || '';
      const computedSrc = img?.currentSrc || '';
      const style = img ? getComputedStyle(img) : null;
      return {
        index: Number(layer.dataset.workIndex),
        active: layer.classList.contains('is-active'),
        exiting: layer.classList.contains('is-exiting'),
        src,
        computedSrc,
        dataSrc: img?.dataset.workSrc || '',
        loaded: img?.dataset.loaded || '',
        empty: src === 'data:,',
        styleOpacity: parseFloat(layer.style.getPropertyValue('--work-layer-opacity') || '0'),
        computedOpacity: style ? Number(style.opacity) : -1,
      };
    });
    const thumbs = [...document.querySelectorAll('.detail-thumb')].map((button) => {
      const image = button.querySelector('span');
      const bg = image ? getComputedStyle(image).backgroundImage : '';
      return {
        index: Number(button.dataset.index),
        order: Number(button.dataset.workOrder),
        workMedia: button.classList.contains('is-work-media'),
        active: button.classList.contains('is-active'),
        visibleClass: button.classList.contains('is-thumb-image-visible'),
        loaded: image?.dataset.loaded || '',
        hasBg: bg && bg !== 'none',
        bg,
        computedOpacity: image ? Number(getComputedStyle(image).opacity) : -1,
      };
    });
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      path: location.pathname,
      activeLayer: layers.find((item) => item.active) || null,
      loadedLayerIndices: layers.filter((item) => !item.empty).map((item) => item.index),
      emptyLayerCount: layers.filter((item) => item.empty).length,
      workThumbs: thumbs.filter((item) => item.workMedia).sort((a, b) => a.order - b.order),
      nonWorkThumbsWithBg: thumbs.filter((item) => !item.workMedia && item.hasBg).map((item) => item.index),
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
  const detailBeforeWork = await sample(client, 'detail-before-work');
  await screenshot(client, '/tmp/local-work-media-lazy-v48-detail.png');

  await key(client, 'e', 'KeyE', 69);
  await waitForMode(client, 'work');
  await sleep(1600);
  const workStable = await sample(client, 'work-stable-first');
  await screenshot(client, '/tmp/local-work-media-lazy-v48-work-stable.png');

  await key(client, 'ArrowDown', 'ArrowDown', 40);
  await sleep(80);
  const switchEarly = await sample(client, 'work-switch-80ms');
  await screenshot(client, '/tmp/local-work-media-lazy-v48-switch-80ms.png');

  await sleep(1500);
  const switchStable = await sample(client, 'work-switch-stable');
  await screenshot(client, '/tmp/local-work-media-lazy-v48-switch-stable.png');

  await key(client, 'p', 'KeyP', 80);
  await waitForMode(client, 'detail');
  await sleep(550);
  await key(client, 'e', 'KeyE', 69);
  await waitForMode(client, 'work');
  await sleep(60);
  const freshReentry = await sample(client, 'fresh-reentry-60ms');
  await screenshot(client, '/tmp/local-work-media-lazy-v48-reentry-60ms.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];

  if (detailBeforeWork.mode !== 'detail') {
    failures.push(`Expected initial route to settle in Detail, got ${JSON.stringify(detailBeforeWork)}.`);
  }
  if (detailBeforeWork.loadedLayerIndices.length !== 0 || detailBeforeWork.emptyLayerCount < 17) {
    failures.push(`Expected all Work large media to stay data:, before Work, got ${JSON.stringify(detailBeforeWork)}.`);
  }
  if (workStable.mode !== 'work' || workStable.loadedLayerIndices.length !== 1 || workStable.loadedLayerIndices[0] !== 1) {
    failures.push(`Expected first Work entry to load only active large media index 1, got ${JSON.stringify(workStable)}.`);
  }
  const expectedWorkThumbIndices = '1,3,4,5,7,9,10';
  const stableWorkThumbIndices = workStable.workThumbs.map((item) => item.index).join(',');
  if (stableWorkThumbIndices !== expectedWorkThumbIndices) {
    failures.push(`Expected sparse Work thumbnail indices ${expectedWorkThumbIndices}, got ${stableWorkThumbIndices}.`);
  }
  if (workStable.workThumbs.length !== 7 || workStable.workThumbs.some((item) => !item.hasBg || item.loaded !== 'true')) {
    failures.push(`Expected only the seven Work thumbnails to load their backgrounds, got ${JSON.stringify(workStable.workThumbs)}.`);
  }
  if (workStable.nonWorkThumbsWithBg.length !== 0) {
    failures.push(`Expected non-Work thumbnails to keep empty backgrounds, got ${JSON.stringify(workStable.nonWorkThumbsWithBg)}.`);
  }
  if (!switchEarly.activeLayer || switchEarly.activeLayer.index !== 3) {
    failures.push(`Expected ArrowDown to switch active large media to sparse index 3, got ${JSON.stringify(switchEarly)}.`);
  }
  if (switchEarly.activeLayer.computedOpacity > 0.2) {
    failures.push(`Expected newly loaded Work large media to still be near the start of its fade at 80ms, got ${JSON.stringify(switchEarly.activeLayer)}.`);
  }
  if (switchStable.loadedLayerIndices.length !== 2 || !switchStable.loadedLayerIndices.includes(1) || !switchStable.loadedLayerIndices.includes(3)) {
    failures.push(`Expected same Work session to keep only visited large media loaded, got ${JSON.stringify(switchStable.loadedLayerIndices)}.`);
  }
  if (freshReentry.mode !== 'work' || freshReentry.activeLayer?.computedOpacity > 0.08) {
    failures.push(`Expected fresh Work re-entry to reset active large opacity before reveal, got ${JSON.stringify(freshReentry)}.`);
  }
  if (runtimeExceptions.length) {
    failures.push(`Runtime exceptions were thrown: ${JSON.stringify(runtimeExceptions.slice(0, 2))}`);
  }
  if (failures.length) {
    throw new Error(failures.join('\n'));
  }

  console.log(JSON.stringify({
    ok: true,
    screenshots: [
      '/tmp/local-work-media-lazy-v48-detail.png',
      '/tmp/local-work-media-lazy-v48-work-stable.png',
      '/tmp/local-work-media-lazy-v48-switch-80ms.png',
      '/tmp/local-work-media-lazy-v48-switch-stable.png',
      '/tmp/local-work-media-lazy-v48-reentry-60ms.png',
    ],
    detailBeforeWork,
    workStable,
    switchEarly,
    switchStable,
    freshReentry,
  }, null, 2));
} finally {
  client.close();
}
