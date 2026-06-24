import fs from 'node:fs';
import sharp from 'sharp';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const REF_URL = process.env.REF_URL || 'https://aristidebenoist.com/';
const LOCAL_URL = process.env.LOCAL_URL || 'http://localhost:5279/';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
const TIMING_ONLY = process.env.TIMING_ONLY === '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logStep = (label) => {
  if (process.env.SUMMARY_ONLY) console.error(`[v53] ${label}`);
};

async function getPageTarget() {
  const created = await fetch(`${CDP_URL}/json/new?about:blank`, { method: 'PUT' })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  if (created?.webSocketDebuggerUrl) return created;

  const targets = await fetch(`${CDP_URL}/json`).then((response) => response.json());
  const page =
    targets.find((target) => target.type === 'page' && target.url.startsWith('http')) ||
    targets.find((target) => target.type === 'page') ||
    targets[0];
  if (!page?.webSocketDebuggerUrl) throw new Error('No Chrome page target available.');
  return page;
}

function createCdpClient(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const events = [];
  let nextId = 1;
  let closed = false;

  const rejectAll = (error) => {
    closed = true;
    for (const [id, entry] of pending.entries()) {
      clearTimeout(entry.timeoutId);
      entry.reject(error);
      pending.delete(id);
    }
  };

  socket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.id && pending.has(payload.id)) {
      const { resolve, reject, timeoutId } = pending.get(payload.id);
      clearTimeout(timeoutId);
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
  socket.addEventListener('close', () => rejectAll(new Error('CDP socket closed.')));
  socket.addEventListener('error', () => rejectAll(new Error('CDP socket error.')));

  return {
    events,
    async send(method, params = {}) {
      await open;
      if (closed) throw new Error(`Cannot send ${method}; CDP socket is closed.`);
      const id = nextId;
      nextId += 1;
      const promise = new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for CDP response to ${method}.`));
        }, 20000);
        pending.set(id, { resolve, reject, timeoutId });
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
  if (TIMING_ONLY) return;
  const result = await client.send('Page.captureScreenshot', {
    captureBeyondViewport: false,
    format: 'png',
    fromSurface: true,
  });
  fs.writeFileSync(path, Buffer.from(result.data, 'base64'));
}

async function waitUntilPageElapsed(client, startedAt, targetMs) {
  await evaluate(client, `
    new Promise((resolve) => {
      const startedAt = ${Number(startedAt)};
      const targetMs = ${Number(targetMs)};
      const tick = () => {
        if (performance.now() - startedAt >= targetMs) {
          resolve(true);
          return;
        }
        requestAnimationFrame(tick);
      };
      tick();
    })
  `);
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
  if (!ok) {
    const state = await evaluate(client, `(() => JSON.stringify({
      url: location.href,
      ready: document.readyState,
      title: document.title,
      hasA: Boolean(window._A),
      hasEngine: Boolean(window._A?.engine),
      mode: window._A?.mode || null,
      index: window._A?.index ?? null,
      liRun: typeof window._A?.li?.run,
      pCurrLength: window._A?.h?.pCurr?.length || 0,
      localMode: document.querySelector(".gallery-shell")?.dataset.mode || null,
      localShellClass: document.querySelector(".gallery-shell")?.className || null,
      webglDataset: document.querySelector("#webgl") ? {...document.querySelector("#webgl").dataset} : null,
      workLayerCount: document.querySelectorAll(".work-layer").length,
      activeWorkLayer: document.querySelector(".work-layer.is-active")?.dataset.workIndex || null,
      n0: Boolean(document.querySelector("#n0")),
      canvasCount: document.querySelectorAll("canvas").length,
      bodyText: document.body.innerText.slice(0, 240)
    }))()`).catch((error) => JSON.stringify({ error: String(error) }));
    const runtimeExceptions = client.events
      .filter((event) => event.method === 'Runtime.exceptionThrown')
      .slice(-5)
      .map((event) => ({
        text: event.params?.exceptionDetails?.text,
        description: event.params?.exceptionDetails?.exception?.description,
        url: event.params?.exceptionDetails?.url,
        lineNumber: event.params?.exceptionDetails?.lineNumber,
        columnNumber: event.params?.exceptionDetails?.columnNumber,
      }));
    throw new Error(`Timed out waiting for ${label}: ${state}; exceptions=${JSON.stringify(runtimeExceptions)}`);
  }
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

async function pressOrClickUntil(
  client,
  keyName,
  code,
  keyCode,
  expression,
  label,
  clickPoints = [],
  attempts = 4,
  fallbackExpression = '',
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await key(client, keyName, code, keyCode);
    if (await waitForMaybe(client, expression, 1200)) return;
    const point = clickPoints[attempt % Math.max(clickPoints.length, 1)];
    if (point) {
      await click(client, point.x, point.y);
      if (await waitForMaybe(client, expression, 1600)) return;
    }
  }
  if (fallbackExpression) {
    await evaluate(client, fallbackExpression);
    if (await waitForMaybe(client, expression, 1800)) return;
  }
  await waitFor(client, expression, label);
}

async function navigate(client, url) {
  await client.send('Page.navigate', { url });
  await waitFor(client, 'document.readyState === "complete"', `document ready at ${url}`, 16000);
}

async function switchNext(client) {
  await key(client, 'ArrowRight', 'ArrowRight', 39);
}

async function collectReference(client) {
  logStep('reference navigate');
  await navigate(client, REF_URL);
  logStep('reference wait ready');
  await waitFor(
    client,
    'window._A && _A.engine && _A.mode === "out" && typeof _A.li?.run === "function" && _A.h?.pCurr?.length && document.querySelector("#n0") && document.querySelectorAll("canvas").length >= 2',
    'reference app ready',
    60000,
  );
  await sleep(900);
  logStep('reference enter detail');
  await pressOrClickUntil(
    client,
    'Enter',
    'Enter',
    13,
    'window._A && _A.mode === "in"',
    'reference Detail mode',
    [{ x: 720, y: 450 }],
    4,
    'window._A && _A.h && typeof _A.li?.run === "function" && _A.mode !== "in" && _A.h.modeIn(0)',
  );
  await sleep(1300);
  logStep('reference enter work');
  await pressOrClickUntil(
    client,
    'e',
    'KeyE',
    69,
    'window._A && _A.mode === "w"',
    'reference Work mode',
    [{ x: 720, y: 820 }],
    4,
    'window._A && _A.mode === "in" && document.querySelectorAll(".e")[_A.index || 0]?.click()',
  );
  await sleep(1500);

  logStep('reference sample before');
  const before = await sampleReference(client, 'reference-work-switch-before');
  await screenshot(client, '/tmp/ref-v53-work-switch-before.png');

  logStep('reference switch samples');
  await switchNext(client);
  const switchStartedAt = await evaluate(client, 'performance.now()');
  await waitUntilPageElapsed(client, switchStartedAt, 120);
  const switch120 = await sampleReference(client, 'reference-work-switch-120ms', before.workIndex, switchStartedAt);
  await screenshot(client, '/tmp/ref-v53-work-switch-120ms.png');
  await waitUntilPageElapsed(client, switchStartedAt, 300);
  const switch300 = await sampleReference(client, 'reference-work-switch-300ms', before.workIndex, switchStartedAt);
  await screenshot(client, '/tmp/ref-v53-work-switch-300ms.png');
  await waitUntilPageElapsed(client, switchStartedAt, 1600);
  const stable = await sampleReference(client, 'reference-work-switch-stable', before.workIndex, switchStartedAt);
  await screenshot(client, '/tmp/ref-v53-work-switch-stable.png');

  return { before, switch120, switch300, stable };
}

async function collectLocal(client) {
  logStep('local navigate');
  await navigate(client, LOCAL_URL);
  logStep('local wait home');
  await waitFor(
    client,
    'document.querySelector(".gallery-shell")?.dataset.mode === "index"',
    'local Home mode',
    14000,
  );
  await sleep(900);
  logStep('local enter detail');
  await pressOrClickUntil(
    client,
    'Enter',
    'Enter',
    13,
    'document.querySelector(".gallery-shell")?.dataset.mode === "detail"',
    'local Detail mode',
    [{ x: 720, y: 450 }],
  );
  await sleep(1300);
  logStep('local enter work');
  await pressOrClickUntil(
    client,
    'e',
    'KeyE',
    69,
    'document.querySelector(".gallery-shell")?.dataset.mode === "work"',
    'local Work mode',
  );
  logStep('local wait motion telemetry');
  await waitFor(
    client,
    'document.querySelector("#webgl")?.dataset.workMotionLength',
    'local Work motion telemetry',
  );
  await sleep(1500);

  const before = await sampleLocal(client, 'local-work-switch-before');
  await screenshot(client, '/tmp/local-v53-work-switch-before.png');

  await switchNext(client);
  const switchStartedAt = await evaluate(client, 'performance.now()');
  await waitUntilPageElapsed(client, switchStartedAt, 120);
  const switch120 = await sampleLocal(client, 'local-work-switch-120ms', before.workIndex, switchStartedAt);
  await screenshot(client, '/tmp/local-v53-work-switch-120ms.png');
  await waitUntilPageElapsed(client, switchStartedAt, 300);
  const switch300 = await sampleLocal(client, 'local-work-switch-300ms', before.workIndex, switchStartedAt);
  await screenshot(client, '/tmp/local-v53-work-switch-300ms.png');
  await waitUntilPageElapsed(client, switchStartedAt, 1600);
  const stable = await sampleLocal(client, 'local-work-switch-stable', before.workIndex, switchStartedAt);
  await screenshot(client, '/tmp/local-v53-work-switch-stable.png');

  return { before, switch120, switch300, stable };
}

async function sampleReference(client, label, previousWorkIndex = -1, switchStartedAt = 0) {
  return evaluate(client, `(() => {
    const previousWorkIndex = ${Number(previousWorkIndex)};
    const switchStartedAt = ${Number(switchStartedAt)};
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
    const layerInfo = (layer, index) => {
      const img = layer?.querySelector('.w-l-img');
      const bg = layer?.querySelector('.w-l-bg');
      const layerRect = rect(layer);
      const viewportArea = layerRect
        ? Math.max(0, Math.min(layerRect.right, innerWidth) - Math.max(layerRect.left, 0))
          * Math.max(0, Math.min(layerRect.bottom, innerHeight) - Math.max(layerRect.top, 0))
        : 0;
      const imgOpacity = Number(style(img)?.opacity || 0);
      const bgOpacity = Number(style(bg)?.opacity || 0);
      const srcEmpty = img?.getAttribute('src') === 'data:,';
      return {
        index,
        rect: layerRect,
        transform: style(layer)?.transform || '',
        viewportArea: Number(viewportArea.toFixed(2)),
        visualOpacity: Math.max(imgOpacity, bgOpacity),
        imgOpacity,
        imgClassName: img?.className || '',
        srcEmpty,
        bgOpacity,
      };
    };
    const layers = [...document.querySelectorAll('#w-l > div')].map(layerInfo);
    const pickVisibleLayer = (kind) => layers
      .map((layer) => ({
        layer,
        score: layer.viewportArea * (kind === 'image' && layer.srcEmpty ? 0 : layer[kind === 'image' ? 'imgOpacity' : 'visualOpacity']),
      }))
      .filter((entry) => entry.score > 1)
      .sort((a, b) => b.score - a.score)[0]?.layer || null;
    const workIndex = window._A?.wIndex ?? -1;
    const activeLayer = layers.find((layer) => layer.index === workIndex) || null;
    const exitingLayer = layers.find((layer) => layer.index === previousWorkIndex) || null;
    const thumbs = [...document.querySelectorAll('.w-s')].map((thumb, index) => ({
      index,
      opacity: Number(style(thumb)?.opacity || 0),
      transform: style(thumb)?.transform || '',
      rect: rect(thumb),
    })).filter((thumb) => thumb.rect && thumb.rect.width > 0).slice(0, 8);
    return {
      label: ${JSON.stringify(label)},
      sampleMs: switchStartedAt ? Number((performance.now() - switchStartedAt).toFixed(2)) : null,
      mode: window._A?.mode || '',
      index: window._A?.index ?? -1,
      workIndex,
      previousWorkIndex,
      path: location.pathname,
      activeFrame: {
        rect: rect(document.querySelector('#w-a')),
        opacity: Number(style(document.querySelector('#w-a'))?.opacity || 0),
        transform: style(document.querySelector('#w-a'))?.transform || '',
      },
      activeLayer,
      exitingLayer,
      visibleSurfaceLayer: pickVisibleLayer('surface'),
      visibleImageLayer: pickVisibleLayer('image'),
      layers,
      thumbs,
    };
  })()`);
}

async function sampleLocal(client, label, previousWorkIndex = -1, switchStartedAt = 0) {
  return evaluate(client, `(() => {
    const previousWorkIndex = ${Number(previousWorkIndex)};
    const switchStartedAt = ${Number(switchStartedAt)};
    const webgl = document.querySelector('#webgl');
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
    const layerInfo = (layer) => {
      const img = layer?.querySelector('.work-layer-img');
      const bg = layer?.querySelector('.work-layer-bg');
      const layerRect = rect(layer);
      const viewportArea = layerRect
        ? Math.max(0, Math.min(layerRect.right, innerWidth) - Math.max(layerRect.left, 0))
          * Math.max(0, Math.min(layerRect.bottom, innerHeight) - Math.max(layerRect.top, 0))
        : 0;
      const imgOpacity = Number(style(img)?.opacity || 0);
      const bgOpacity = Number(style(bg)?.opacity || 0);
      return {
        index: Number(layer?.dataset.workIndex ?? -1),
        className: layer?.className || '',
        rect: layerRect,
        transform: style(layer)?.transform || '',
        viewportArea: Number(viewportArea.toFixed(2)),
        visualOpacity: Math.max(imgOpacity, bgOpacity),
        y: Number.parseFloat(layer?.style.getPropertyValue('--work-layer-y') || '0'),
        styleOpacity: Number.parseFloat(layer?.style.getPropertyValue('--work-layer-opacity') || '0'),
        imgOpacity,
        loaded: img?.dataset.loaded || '',
        bgOpacity,
      };
    };
    const layers = [...document.querySelectorAll('.work-layer')].map(layerInfo);
    const pickVisibleLayer = (kind) => layers
      .map((layer) => ({
        layer,
        score: layer.viewportArea * (kind === 'image' ? layer.imgOpacity : layer.visualOpacity),
      }))
      .filter((entry) => entry.score > 1)
      .sort((a, b) => b.score - a.score)[0]?.layer || null;
    const activeLayer = layerInfo(document.querySelector('.work-layer.is-active'));
    const exitingLayer = layers.find((layer) => layer.index === previousWorkIndex)
      || layerInfo(document.querySelector('.work-layer.is-exiting'));
    const thumbs = [...document.querySelectorAll('.detail-thumb.is-work-media')].map((thumb) => ({
      index: Number(thumb.dataset.index),
      order: Number(thumb.dataset.workOrder),
      opacity: Number(style(thumb)?.opacity || 0),
      transform: style(thumb)?.transform || '',
      rect: rect(thumb),
    }));
    return {
      label: ${JSON.stringify(label)},
      sampleMs: switchStartedAt ? Number((performance.now() - switchStartedAt).toFixed(2)) : null,
      mode: document.querySelector('.gallery-shell')?.dataset.mode || '',
      activeIndex: Number(document.querySelector('[data-current]')?.textContent || 0) - 1,
      workIndex: activeLayer.index,
      previousWorkIndex,
      path: location.pathname,
      webgl: {
        activePlaneAlpha: webgl?.dataset.activePlaneAlpha || '',
        activePlaneAlphaTarget: webgl?.dataset.activePlaneAlphaTarget || '',
        workMotionActive: webgl?.dataset.workMotionActive || '',
        workMotionLength: webgl?.dataset.workMotionLength || '',
        workMotionTargetY: webgl?.dataset.workMotionTargetY || '',
        workMotionY: webgl?.dataset.workMotionY || '',
      },
      activeFrame: {
        rect: rect(document.querySelector('.detail-rail-active')),
        opacity: Number(style(document.querySelector('.detail-rail-active'))?.opacity || 0),
        transform: style(document.querySelector('.detail-rail-active'))?.transform || '',
      },
      activeLayer,
      exitingLayer,
      visibleSurfaceLayer: pickVisibleLayer('surface'),
      visibleImageLayer: pickVisibleLayer('image'),
      layers,
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

function metricSummary(reference, local) {
  const summarizeState = (state) => ({
    sampleMs: state.sampleMs ?? null,
    activeTop: state.activeLayer?.rect?.top ?? null,
    activeY: state.activeLayer?.transform || '',
    activeOpacity: state.activeLayer?.imgOpacity ?? null,
    exitingTop: state.exitingLayer?.rect?.top ?? null,
    exitingY: state.exitingLayer?.transform || '',
    exitingOpacity: state.exitingLayer?.imgOpacity ?? null,
    frameTop: state.activeFrame?.rect?.top ?? null,
    frameY: state.activeFrame?.transform || '',
    visibleSurfaceIndex: state.visibleSurfaceLayer?.index ?? null,
    visibleSurfaceTop: state.visibleSurfaceLayer?.rect?.top ?? null,
    visibleSurfaceOpacity: state.visibleSurfaceLayer?.visualOpacity ?? null,
    visibleImageIndex: state.visibleImageLayer?.index ?? null,
    visibleImageTop: state.visibleImageLayer?.rect?.top ?? null,
    visibleImageOpacity: state.visibleImageLayer?.imgOpacity ?? null,
    workIndex: state.workIndex,
  });
  const delta = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? Number((b - a).toFixed(2)) : null);
  const progress = (start, current, end) => {
    if (!Number.isFinite(start) || !Number.isFinite(current) || !Number.isFinite(end)) return null;
    const travel = end - start;
    if (Math.abs(travel) < 0.001) return null;
    return Number(((current - start) / travel).toFixed(4));
  };
  const stateProgress = (states, state) => {
    const before = summarizeState(states.before);
    const stable = summarizeState(states.stable);
    const beforeActiveLayer = states.before.layers?.find((layer) => layer.index === state.workIndex);
    const activeStartTop = beforeActiveLayer?.rect?.top ?? before.activeTop;
    return {
      activeTop: progress(activeStartTop, state.activeTop, stable.activeTop),
      frameTop: progress(before.frameTop, state.frameTop, stable.frameTop),
    };
  };
  return ['switch120', 'switch300', 'stable'].reduce((summary, key) => {
    const refState = summarizeState(reference[key]);
    const localState = summarizeState(local[key]);
    const refProgress = stateProgress(reference, refState);
    const localProgress = stateProgress(local, localState);
    summary[key] = {
      reference: refState,
      local: localState,
      progress: {
        reference: refProgress,
        local: localProgress,
        delta: {
          activeTop: delta(refProgress.activeTop, localProgress.activeTop),
          frameTop: delta(refProgress.frameTop, localProgress.frameTop),
        },
      },
      delta: {
        activeTop: delta(refState.activeTop, localState.activeTop),
        activeOpacity: delta(refState.activeOpacity, localState.activeOpacity),
        exitingTop: delta(refState.exitingTop, localState.exitingTop),
        frameTop: delta(refState.frameTop, localState.frameTop),
        visibleSurfaceTop: delta(refState.visibleSurfaceTop, localState.visibleSurfaceTop),
        visibleSurfaceOpacity: delta(refState.visibleSurfaceOpacity, localState.visibleSurfaceOpacity),
        visibleImageTop: delta(refState.visibleImageTop, localState.visibleImageTop),
        visibleImageOpacity: delta(refState.visibleImageOpacity, localState.visibleImageOpacity),
      },
    };
    return summary;
  }, {});
}

const target = await getPageTarget();
const client = createCdpClient(target.webSocketDebuggerUrl);
try {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Network.enable');
  await client.send('Network.setCacheDisabled', { cacheDisabled: true });
  await client.send('Page.bringToFront');
  await client.send('Emulation.setDeviceMetricsOverride', VIEWPORT);

  const reference = await collectReference(client);
  const local = await collectLocal(client);

  if (!TIMING_ONLY) {
    await combinePair(
      '/tmp/ref-v53-work-switch-before.png',
      '/tmp/local-v53-work-switch-before.png',
      '/tmp/compare-v53-work-switch-before.jpg',
      'Work switch before',
    );
    await combinePair(
      '/tmp/ref-v53-work-switch-120ms.png',
      '/tmp/local-v53-work-switch-120ms.png',
      '/tmp/compare-v53-work-switch-120ms.jpg',
      'Work switch 120ms',
    );
    await combinePair(
      '/tmp/ref-v53-work-switch-300ms.png',
      '/tmp/local-v53-work-switch-300ms.png',
      '/tmp/compare-v53-work-switch-300ms.jpg',
      'Work switch 300ms',
    );
    await combinePair(
      '/tmp/ref-v53-work-switch-stable.png',
      '/tmp/local-v53-work-switch-stable.png',
      '/tmp/compare-v53-work-switch-stable.jpg',
      'Work switch stable',
    );
  }

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const report = {
    screenshots: TIMING_ONLY
      ? []
      : [
          '/tmp/ref-v53-work-switch-before.png',
          '/tmp/local-v53-work-switch-before.png',
          '/tmp/compare-v53-work-switch-before.jpg',
          '/tmp/ref-v53-work-switch-120ms.png',
          '/tmp/local-v53-work-switch-120ms.png',
          '/tmp/compare-v53-work-switch-120ms.jpg',
          '/tmp/ref-v53-work-switch-300ms.png',
          '/tmp/local-v53-work-switch-300ms.png',
          '/tmp/compare-v53-work-switch-300ms.jpg',
          '/tmp/ref-v53-work-switch-stable.png',
          '/tmp/local-v53-work-switch-stable.png',
          '/tmp/compare-v53-work-switch-stable.jpg',
        ],
    reference,
    local,
    metrics: metricSummary(reference, local),
    runtimeExceptions,
  };
  fs.writeFileSync('/tmp/capture-v53-work-switch-report.json', JSON.stringify(report, null, 2));
  if (process.env.SUMMARY_ONLY) {
    console.log(JSON.stringify({
      screenshots: report.screenshots,
      metrics: report.metrics,
      runtimeExceptions,
    }, null, 2));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
  if (runtimeExceptions.length) process.exitCode = 1;
} finally {
  client.close();
  if (target.id) {
    await fetch(`${CDP_URL}/json/close/${target.id}`).catch(() => {});
  }
}
