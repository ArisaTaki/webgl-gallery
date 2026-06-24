import fs from 'node:fs';
import sharp from 'sharp';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const REF_URL = process.env.REF_URL || 'https://aristidebenoist.com/';
const LOCAL_URL = process.env.LOCAL_URL || 'http://localhost:5279/nian-nian-002';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

const CROPS = {
  project: { left: 640, top: 30, width: 160, height: 130 },
  explore: { left: 640, top: 715, width: 160, height: 160 },
};

const HOVER_TARGET = {
  project: 'symbolRect',
  explore: 'rootRect',
};

const EXPECTED_MORPH = {
  project: false,
  explore: true,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getPageWebSocket() {
  const targets = await fetch(`${CDP_URL}/json`).then((response) => response.json());
  const page =
    targets.find((target) => target.type === 'page' && target.url.startsWith('http')) ||
    targets.find((target) => target.type === 'page') ||
    targets[0];
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

async function navigate(client, url) {
  await client.send('Page.navigate', { url });
  await waitFor(client, 'document.readyState === "complete"', `document ready at ${url}`, 18000);
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

async function pressOrClickUntil(client, keyName, code, keyCode, expression, label, clickPoints = [], attempts = 4) {
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

async function click(client, x, y) {
  await mouseMove(client, x, y);
  await client.send('Input.dispatchMouseEvent', { button: 'left', buttons: 1, clickCount: 1, type: 'mousePressed', x, y });
  await client.send('Input.dispatchMouseEvent', { button: 'left', buttons: 0, clickCount: 1, type: 'mouseReleased', x, y });
}

async function mouseMove(client, x, y) {
  await client.send('Input.dispatchMouseEvent', {
    button: 'none',
    clickCount: 0,
    type: 'mouseMoved',
    x,
    y,
  });
}

async function screenshot(client, path) {
  const result = await client.send('Page.captureScreenshot', {
    captureBeyondViewport: false,
    format: 'png',
    fromSurface: true,
  });
  fs.writeFileSync(path, Buffer.from(result.data, 'base64'));
}

async function enterReferenceDetail(client) {
  await navigate(client, REF_URL);
  await waitFor(
    client,
    'window._A && _A.engine && _A.mode === "out" && document.querySelector("#n0") && document.querySelectorAll("canvas").length >= 2',
    'reference app ready',
    18000,
  );
  await sleep(1500);
  await pressOrClickUntil(
    client,
    'Enter',
    'Enter',
    13,
    'window._A && _A.mode === "in"',
    'reference Detail mode',
    [{ x: 720, y: 450 }],
  );
}

async function enterLocalDetail(client) {
  await navigate(client, LOCAL_URL);
  await waitFor(client, 'document.querySelector(".gallery-shell")?.dataset.mode === "detail"', 'local Detail mode', 14000);
  await sleep(1800);
}

function centerOf(rect) {
  if (!rect) return null;
  return {
    x: Number((rect.left + rect.width / 2).toFixed(2)),
    y: Number((rect.top + rect.height / 2).toFixed(2)),
  };
}

function pointsChanged(a, b) {
  return Boolean(a && b && a.replace(/\s+/g, ' ').trim() !== b.replace(/\s+/g, ' ').trim());
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
    const css = (el) => {
      if (!el) return null;
      const s = getComputedStyle(el);
      return {
        cursor: s.cursor,
        display: s.display,
        opacity: s.opacity,
        pointerEvents: s.pointerEvents,
        transform: s.transform,
        visibility: s.visibility,
      };
    };
    const activeIndex = window._A?.index ?? 0;
    const projectRoot = document.querySelector('#p');
    const projectSymbol = document.querySelector('#p-s');
    const projectPolygon = document.querySelector('#p-s-p') || projectSymbol?.querySelector('polygon') || projectRoot?.querySelector('polygon');
    const explores = [...document.querySelectorAll('.e')];
    const visibleExplore = explores.find((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && Number.parseFloat(s.opacity || '0') > 0.01;
    });
    const exploreRoot = explores[activeIndex] || visibleExplore || explores[0];
    const exploreSymbol = exploreRoot?.querySelector('.e-s') || exploreRoot?.querySelector('svg');
    const explorePolygon = exploreRoot?.querySelector('polygon');
    return {
      label: ${JSON.stringify(label)},
      mode: window._A?.mode || '',
      index: activeIndex,
      project: {
        rootRect: rect(projectRoot),
        rootStyle: css(projectRoot),
        symbolRect: rect(projectSymbol),
        symbolStyle: css(projectSymbol),
        points: projectPolygon?.getAttribute('points') || '',
      },
      explore: {
        rootRect: rect(exploreRoot),
        rootStyle: css(exploreRoot),
        symbolRect: rect(exploreSymbol),
        symbolStyle: css(exploreSymbol),
        points: explorePolygon?.getAttribute('points') || '',
      },
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
    const css = (el) => {
      if (!el) return null;
      const s = getComputedStyle(el);
      return {
        cursor: s.cursor,
        display: s.display,
        opacity: s.opacity,
        pointerEvents: s.pointerEvents,
        transform: s.transform,
        visibility: s.visibility,
      };
    };
    const shell = document.querySelector('.gallery-shell');
    const projectRoot = document.querySelector('.project-pagination');
    const projectSymbol = document.querySelector('.pagination-switch');
    const projectPolygon = projectSymbol?.querySelector('polygon') || projectRoot?.querySelector('polygon');
    const exploreRoot = document.querySelector('.visit-link');
    const exploreSymbol = document.querySelector('.visit-symbol');
    const explorePolygon = exploreSymbol?.querySelector('polygon') || exploreRoot?.querySelector('polygon');
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      pathname: location.pathname,
      project: {
        rootRect: rect(projectRoot),
        rootStyle: css(projectRoot),
        symbolRect: rect(projectSymbol),
        symbolStyle: css(projectSymbol),
        points: projectPolygon?.getAttribute('points') || '',
      },
      explore: {
        rootRect: rect(exploreRoot),
        rootStyle: css(exploreRoot),
        symbolRect: rect(exploreSymbol),
        symbolStyle: css(exploreSymbol),
        points: explorePolygon?.getAttribute('points') || '',
      },
    };
  })()`);
}

async function collectHoverSet(client, kind, sampleFn, screenshotPrefix) {
  const baseline = await sampleFn(`${screenshotPrefix}-${kind}-baseline`);
  const target = HOVER_TARGET[kind] || 'rootRect';
  const rect = baseline[kind][target];
  const point = centerOf(rect);
  if (!point) throw new Error(`Missing ${screenshotPrefix} ${kind} ${target} hover rect.`);

  await mouseMove(client, point.x, point.y);
  await sleep(360);
  const mid = await sampleFn(`${screenshotPrefix}-${kind}-hover-360ms`);
  await sleep(540);
  const stable = await sampleFn(`${screenshotPrefix}-${kind}-hover-stable`);
  const path = `/tmp/${screenshotPrefix}-v57-control-${kind}-${target.replace('Rect', '')}-hover.png`;
  await screenshot(client, path);
  await mouseMove(client, 20, 20);
  await sleep(800);

  return { baseline, mid, stable, point, target, screenshot: path };
}

function makeSvgLabel(text, width) {
  return Buffer.from(`
    <svg width="${width}" height="28" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="28" fill="#111"/>
      <text x="12" y="19" fill="#fff" font-family="Arial, Helvetica, sans-serif" font-size="11" letter-spacing="1">${text}</text>
    </svg>
  `);
}

async function cropWithLabel(input, crop, label, output) {
  const image = sharp(input).extract(crop);
  const meta = await image.metadata();
  const labelSvg = makeSvgLabel(label, meta.width);
  await sharp({
    create: {
      width: meta.width,
      height: meta.height + 28,
      channels: 3,
      background: '#ffffff',
    },
  })
    .composite([
      { input: labelSvg, left: 0, top: 0 },
      { input: await image.png().toBuffer(), left: 0, top: 28 },
    ])
    .jpeg({ quality: 92 })
    .toFile(output);
}

async function combinePair(refInput, localInput, crop, output) {
  const refCrop = `/tmp/ref-v57-${output.split('/').pop()}`;
  const localCrop = `/tmp/local-v57-${output.split('/').pop()}`;
  await cropWithLabel(refInput, crop, 'REFERENCE', refCrop);
  await cropWithLabel(localInput, crop, 'LOCAL', localCrop);
  const [refMeta, localMeta] = await Promise.all([sharp(refCrop).metadata(), sharp(localCrop).metadata()]);
  await sharp({
    create: {
      width: refMeta.width + localMeta.width,
      height: Math.max(refMeta.height, localMeta.height),
      channels: 3,
      background: '#ffffff',
    },
  })
    .composite([
      { input: refCrop, left: 0, top: 0 },
      { input: localCrop, left: refMeta.width, top: 0 },
    ])
    .jpeg({ quality: 92 })
    .toFile(output);
}

function collectFailures(reference, local, runtimeExceptions) {
  const failures = [];
  for (const kind of ['project', 'explore']) {
    if (!reference[kind].stable[kind].points) failures.push(`Reference ${kind} polygon points were missing.`);
    if (!local[kind].stable[kind].points) failures.push(`Local ${kind} polygon points were missing.`);
    const expected = EXPECTED_MORPH[kind];
    const referenceChanged = pointsChanged(reference[kind].baseline[kind].points, reference[kind].stable[kind].points);
    const localChanged = pointsChanged(local[kind].baseline[kind].points, local[kind].stable[kind].points);
    if (referenceChanged !== expected) {
      failures.push(`Reference ${kind} ${reference[kind].target} hover expected changed=${expected}, got ${referenceChanged}.`);
    }
    if (localChanged !== expected) {
      failures.push(`Local ${kind} ${local[kind].target} hover expected changed=${expected}, got ${localChanged}.`);
    }
  }
  const projectHeightDelta = Math.abs(reference.project.baseline.project.rootRect.height - local.project.baseline.project.rootRect.height);
  const exploreHeightDelta = Math.abs(reference.explore.baseline.explore.rootRect.height - local.explore.baseline.explore.rootRect.height);
  if (projectHeightDelta > 2) failures.push(`Project control height drifted by ${projectHeightDelta.toFixed(2)}px.`);
  if (exploreHeightDelta > 2) failures.push(`Explore control height drifted by ${exploreHeightDelta.toFixed(2)}px.`);
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);
  return failures;
}

const client = createCdpClient(await getPageWebSocket());

try {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Emulation.setDeviceMetricsOverride', VIEWPORT);

  await enterReferenceDetail(client);
  const reference = {
    project: await collectHoverSet(client, 'project', (label) => sampleReference(client, label), 'ref'),
    explore: await collectHoverSet(client, 'explore', (label) => sampleReference(client, label), 'ref'),
  };

  await enterLocalDetail(client);
  const local = {
    project: await collectHoverSet(client, 'project', (label) => sampleLocal(client, label), 'local'),
    explore: await collectHoverSet(client, 'explore', (label) => sampleLocal(client, label), 'local'),
  };

  const comparisonPaths = {
    project: '/tmp/compare-v57-control-project-symbol-hover-crop.jpg',
    explore: '/tmp/compare-v57-control-explore-root-hover-crop.jpg',
  };
  await combinePair(reference.project.screenshot, local.project.screenshot, CROPS.project, comparisonPaths.project);
  await combinePair(reference.explore.screenshot, local.explore.screenshot, CROPS.explore, comparisonPaths.explore);

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = collectFailures(reference, local, runtimeExceptions);

  const report = {
    urls: { reference: REF_URL, local: LOCAL_URL },
    viewport: VIEWPORT,
    screenshots: {
      referenceProject: reference.project.screenshot,
      localProject: local.project.screenshot,
      projectComparison: comparisonPaths.project,
      referenceExplore: reference.explore.screenshot,
      localExplore: local.explore.screenshot,
      exploreComparison: comparisonPaths.explore,
    },
    reference,
    local,
    runtimeExceptions,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  client.close();
}
