import fs from 'node:fs';
import sharp from 'sharp';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const REF_URL = process.env.REF_URL || 'https://aristidebenoist.com/';
const LOCAL_URL = process.env.LOCAL_URL || 'http://localhost:5279/nian-nian-001';
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

async function click(client, x, y) {
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await client.send('Input.dispatchMouseEvent', { button: 'left', clickCount: 1, type: 'mousePressed', x, y });
  await client.send('Input.dispatchMouseEvent', { button: 'left', clickCount: 1, type: 'mouseReleased', x, y });
}

async function waitFor(client, expression, label, timeout = 10000) {
  const ok = await evaluate(client, `
    new Promise((resolve) => {
      const ready = () => Boolean(${expression});
      if (ready()) resolve(true);
      const started = performance.now();
      const timer = setInterval(() => {
        if (ready() || performance.now() - started > ${timeout}) {
          clearInterval(timer);
          resolve(Boolean(ready()));
        }
      }, 50);
    })
  `);
  if (!ok) throw new Error(`Timed out waiting for ${label}.`);
}

async function waitForMaybe(client, expression, timeout = 1000) {
  return evaluate(client, `
    new Promise((resolve) => {
      const ready = () => Boolean(${expression});
      if (ready()) resolve(true);
      const started = performance.now();
      const timer = setInterval(() => {
        if (ready() || performance.now() - started > ${timeout}) {
          clearInterval(timer);
          resolve(Boolean(ready()));
        }
      }, 50);
    })
  `);
}

async function pressUntil(client, keyName, code, keyCode, expression, label, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await key(client, keyName, code, keyCode);
    if (await waitForMaybe(client, expression, 1400)) return;
  }
  await waitFor(client, expression, label);
}

async function pressOrClickUntil(client, keyName, code, keyCode, expression, label, clickPoints = [], attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await key(client, keyName, code, keyCode);
    if (await waitForMaybe(client, expression, 1200)) return;
    const point = clickPoints[attempt % Math.max(clickPoints.length, 1)];
    if (point) {
      await click(client, point.x, point.y);
      if (await waitForMaybe(client, expression, 1600)) return;
    }
  }
  await waitFor(client, expression, label);
}

async function navigate(client, url) {
  await client.send('Page.navigate', { url });
  await waitFor(client, 'document.readyState === "complete"', `document ready at ${url}`);
}

async function collectReference(client) {
  await navigate(client, REF_URL);
  await waitFor(
    client,
    'window._A && _A.engine && _A.mode === "out" && document.querySelector("#n0") && document.querySelectorAll("canvas").length >= 2',
    'reference app ready',
    16000,
  );
  await sleep(900);
  await pressOrClickUntil(
    client,
    'Enter',
    'Enter',
    13,
    'window._A && _A.mode === "in"',
    'reference Detail mode',
    [{ x: 720, y: 450 }],
  );
  await sleep(1300);
  const detail = await sampleReference(client, 'reference-detail-stable');
  await screenshot(client, '/tmp/ref-v51-detail-stable.png');

  await pressOrClickUntil(
    client,
    'e',
    'KeyE',
    69,
    'window._A && _A.mode === "w"',
    'reference Work mode',
    [{ x: 720, y: 820 }],
  );
  await sleep(300);
  const work300 = await sampleReference(client, 'reference-work-entry-300ms');
  await screenshot(client, '/tmp/ref-v51-work-entry-300ms.png');
  await sleep(1300);
  const workStable = await sampleReference(client, 'reference-work-stable');
  await screenshot(client, '/tmp/ref-v51-work-stable.png');

  return { detail, work300, workStable };
}

async function collectLocal(client) {
  await navigate(client, LOCAL_URL);
  await waitFor(
    client,
    'document.querySelector(".gallery-shell")?.dataset.mode === "detail"',
    'local Detail mode',
  );
  await sleep(1300);
  const detail = await sampleLocal(client, 'local-detail-stable');
  await screenshot(client, '/tmp/local-v51-detail-stable.png');

  await pressUntil(
    client,
    'e',
    'KeyE',
    69,
    'document.querySelector(".gallery-shell")?.dataset.mode === "work"',
    'local Work mode',
  );
  await sleep(300);
  const work300 = await sampleLocal(client, 'local-work-entry-300ms');
  await screenshot(client, '/tmp/local-v51-work-entry-300ms.png');
  await sleep(1300);
  const workStable = await sampleLocal(client, 'local-work-stable');
  await screenshot(client, '/tmp/local-v51-work-stable.png');

  return { detail, work300, workStable };
}

async function sampleReference(client, label) {
  return evaluate(client, `(() => {
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        bottom: Number(r.bottom.toFixed(2)),
        height: Number(r.height.toFixed(2)),
        left: Number(r.left.toFixed(2)),
        right: Number(r.right.toFixed(2)),
        top: Number(r.top.toFixed(2)),
        width: Number(r.width.toFixed(2)),
      };
    };
    const style = (el) => el ? getComputedStyle(el) : null;
    const workLayers = [...document.querySelectorAll('#w-l > div')].map((layer, index) => ({
      index,
      rect: rect(layer),
      transform: style(layer)?.transform || '',
      imgOpacity: style(layer.querySelector('.w-l-img'))?.opacity || '',
      imgClassName: layer.querySelector('.w-l-img')?.className || '',
      srcEmpty: layer.querySelector('.w-l-img')?.getAttribute('src') === 'data:,',
    }));
    const workImgs = [...document.querySelectorAll('.w-l-img')].map((img, index) => ({
      index,
      className: img.className,
      opacity: style(img)?.opacity || '',
      srcEmpty: img.getAttribute('src') === 'data:,',
    }));
    const thumbs = [...document.querySelectorAll('.w-s')].map((thumb, index) => ({
      index,
      opacity: style(thumb)?.opacity || '',
      transform: style(thumb)?.transform || '',
      rect: rect(thumb),
    })).filter((thumb) => thumb.rect && thumb.rect.width > 0).slice(0, 8);
    const activeFrame = document.querySelector('#w-a');
    const title = document.querySelector('.t');
    const project = document.querySelector('#p');
    const visit = document.querySelector('#v');
    return {
      label: ${JSON.stringify(label)},
      mode: window._A?.mode || '',
      modePrev: window._A?.modePrev || '',
      index: window._A?.index ?? -1,
      workIndex: window._A?.wIndex ?? -1,
      path: location.pathname,
      canvases: [...document.querySelectorAll('canvas')].map((canvas) => ({ id: canvas.id, rect: rect(canvas) })),
      activeFrame: { rect: rect(activeFrame), opacity: style(activeFrame)?.opacity || '', transform: style(activeFrame)?.transform || '' },
      project: { rect: rect(project), opacity: style(project)?.opacity || '', transform: style(project)?.transform || '' },
      title: { rect: rect(title), opacity: style(title)?.opacity || '', transform: style(title)?.transform || '' },
      visit: { rect: rect(visit), opacity: style(visit)?.opacity || '', transform: style(visit)?.transform || '' },
      workLargeWrap: { rect: rect(document.querySelector('#w-l')), transform: style(document.querySelector('#w-l'))?.transform || '' },
      workLayers,
      workImgs,
      thumbs,
    };
  })()`);
}

async function sampleLocal(client, label) {
  return evaluate(client, `(() => {
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        bottom: Number(r.bottom.toFixed(2)),
        height: Number(r.height.toFixed(2)),
        left: Number(r.left.toFixed(2)),
        right: Number(r.right.toFixed(2)),
        top: Number(r.top.toFixed(2)),
        width: Number(r.width.toFixed(2)),
      };
    };
    const style = (el) => el ? getComputedStyle(el) : null;
    const active = document.querySelector('.work-layer.is-active');
    const activeImg = active?.querySelector('.work-layer-img');
    const workLayers = [...document.querySelectorAll('.work-layer')].map((layer, index) => ({
      index,
      workIndex: Number(layer.dataset.workIndex || -1),
      className: layer.className,
      rect: rect(layer),
      transform: style(layer)?.transform || '',
      styleOpacity: layer.style.getPropertyValue('--work-layer-opacity') || '',
      imgOpacity: style(layer.querySelector('.work-layer-img'))?.opacity || '',
      loaded: layer.querySelector('.work-layer-img')?.dataset.loaded || '',
    }));
    const thumbs = [...document.querySelectorAll('.detail-thumb.is-work-media')].map((thumb) => ({
      index: Number(thumb.dataset.index),
      order: Number(thumb.dataset.workOrder),
      opacity: style(thumb)?.opacity || '',
      transform: style(thumb)?.transform || '',
      rect: rect(thumb),
    }));
    return {
      label: ${JSON.stringify(label)},
      mode: document.querySelector('.gallery-shell')?.dataset.mode || '',
      activeIndex: Number(document.querySelector('[data-current]')?.textContent || 0) - 1,
      workIndex: Number(active?.dataset.workIndex || -1),
      path: location.pathname,
      canvases: [...document.querySelectorAll('canvas')].map((canvas) => ({ id: canvas.id || canvas.className, rect: rect(canvas) })),
      activeFrame: { rect: rect(document.querySelector('.detail-rail-active')), opacity: style(document.querySelector('.detail-rail-active'))?.opacity || '', transform: style(document.querySelector('.detail-rail-active'))?.transform || '' },
      project: { rect: rect(document.querySelector('.project-pagination')), opacity: style(document.querySelector('.project-pagination'))?.opacity || '', transform: style(document.querySelector('.project-pagination'))?.transform || '' },
      title: { rect: rect(document.querySelector('.project-shadow-title-active')), opacity: style(document.querySelector('.project-shadow-title-active'))?.opacity || '', transform: style(document.querySelector('.project-shadow-title-active'))?.transform || '' },
      visit: { rect: rect(document.querySelector('.visit-link')), opacity: style(document.querySelector('.visit-link'))?.opacity || '', transform: style(document.querySelector('.visit-link'))?.transform || '' },
      workLargeWrap: { rect: rect(document.querySelector('.work-stage')), transform: style(document.querySelector('.work-stage'))?.transform || '' },
      activeLayer: {
        rect: rect(active),
        transform: style(active)?.transform || '',
        styleOpacity: active?.style.getPropertyValue('--work-layer-opacity') || '',
        computedImageOpacity: style(activeImg)?.opacity || '',
        loaded: activeImg?.dataset.loaded || '',
      },
      workLayers,
      thumbs,
    };
  })()`);
}

function labelSvg(text, width) {
  const safe = text.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
  return Buffer.from(`
    <svg width="${width}" height="42" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#111110"/>
      <text x="20" y="27" font-family="Arial, sans-serif" font-size="16" fill="#ecebe3">${safe}</text>
    </svg>
  `);
}

async function combinePair(refPath, localPath, outPath, label) {
  const ref = await sharp(refPath).resize(VIEWPORT.width, VIEWPORT.height).png().toBuffer();
  const local = await sharp(localPath).resize(VIEWPORT.width, VIEWPORT.height).png().toBuffer();
  await sharp({
    create: {
      width: VIEWPORT.width * 2,
      height: VIEWPORT.height + 42,
      channels: 4,
      background: '#111110',
    },
  })
    .composite([
      { input: labelSvg(`${label}: reference`, VIEWPORT.width), left: 0, top: 0 },
      { input: labelSvg(`${label}: local`, VIEWPORT.width), left: VIEWPORT.width, top: 0 },
      { input: ref, left: 0, top: 42 },
      { input: local, left: VIEWPORT.width, top: 42 },
    ])
    .jpeg({ quality: 88 })
    .toFile(outPath);
}

const client = createCdpClient(await getPageWebSocket());
try {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Emulation.setDeviceMetricsOverride', VIEWPORT);

  const reference = await collectReference(client);
  const local = await collectLocal(client);

  await combinePair(
    '/tmp/ref-v51-detail-stable.png',
    '/tmp/local-v51-detail-stable.png',
    '/tmp/compare-v51-detail-stable.jpg',
    'Detail stable',
  );
  await combinePair(
    '/tmp/ref-v51-work-entry-300ms.png',
    '/tmp/local-v51-work-entry-300ms.png',
    '/tmp/compare-v51-work-entry-300ms.jpg',
    'Work entry 300ms',
  );
  await combinePair(
    '/tmp/ref-v51-work-stable.png',
    '/tmp/local-v51-work-stable.png',
    '/tmp/compare-v51-work-stable.jpg',
    'Work stable',
  );

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const report = {
    screenshots: [
      '/tmp/ref-v51-detail-stable.png',
      '/tmp/local-v51-detail-stable.png',
      '/tmp/compare-v51-detail-stable.jpg',
      '/tmp/ref-v51-work-entry-300ms.png',
      '/tmp/local-v51-work-entry-300ms.png',
      '/tmp/compare-v51-work-entry-300ms.jpg',
      '/tmp/ref-v51-work-stable.png',
      '/tmp/local-v51-work-stable.png',
      '/tmp/compare-v51-work-stable.jpg',
    ],
    reference,
    local,
    runtimeExceptions,
  };

  fs.writeFileSync('/tmp/capture-v51-report.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (runtimeExceptions.length) throw new Error(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);
} finally {
  client.close();
}
