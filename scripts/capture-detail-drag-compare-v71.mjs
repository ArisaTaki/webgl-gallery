import fs from 'node:fs';
import sharp from 'sharp';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const REF_URL = process.env.REF_URL || 'https://aristidebenoist.com/';
const LOCAL_URL = process.env.LOCAL_URL || 'http://localhost:5279/';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertSourcePort() {
  const source = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const checks = [
    'function getDragSensitivity()',
    'return getReferenceMetrics().pxToWorld * 1.2;',
    'state.dragOriginScroll = carryTarget;',
    'setMode(VIEW.index);',
    'DETAIL_EXIT_EARLY_PLANE_EASE',
    'earlyDetailExitGeometry',
    'canvas.dataset.dragMoved = state.dragMoved.toFixed(2);',
  ];
  const missing = checks.filter((check) => !source.includes(check));
  if (missing.length) {
    throw new Error(`Missing Detail drag source checks: ${missing.join(', ')}`);
  }
}

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

async function mouse(client, type, x, y, buttons = 0) {
  await client.send('Input.dispatchMouseEvent', {
    button: buttons ? 'left' : 'none',
    buttons,
    clickCount: buttons ? 1 : 0,
    type,
    x,
    y,
  });
}

async function waitFor(client, expression, label, timeout = 14000) {
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

async function waitForMaybe(client, expression, timeout = 1200) {
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

async function pressUntil(client, keyName, code, keyCode, expression, label, attempts = 4) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await key(client, keyName, code, keyCode);
    if (await waitForMaybe(client, expression, 1400)) return;
  }
  await waitFor(client, expression, label);
}

async function navigate(client, url) {
  await client.send('Page.navigate', { url });
  await waitFor(client, 'document.readyState === "complete"', `document ready at ${url}`, 18000);
}

async function collectReference(client) {
  await navigate(client, REF_URL);
  await waitFor(
    client,
    'window._A && _A.engine && _A.mode === "out" && document.querySelector("#n0") && document.querySelectorAll("canvas").length >= 2',
    'reference Home ready',
    18000,
  );
  await sleep(1500);
  await pressUntil(client, 'Enter', 'Enter', 13, 'window._A && _A.mode === "in"', 'reference Detail mode');
  await sleep(1500);

  const before = await sampleReference(client, 'reference-detail-drag-before');
  await screenshot(client, '/tmp/ref-v71-detail-drag-before.png');

  await mouse(client, 'mousePressed', 720, 450, 1);
  await sleep(40);
  await mouse(client, 'mouseMoved', 560, 450, 1);
  await sleep(120);
  const drag120 = await sampleReference(client, 'reference-detail-drag-120ms');
  await screenshot(client, '/tmp/ref-v71-detail-drag-120ms.png');

  await mouse(client, 'mouseMoved', 520, 450, 1);
  await sleep(140);
  const drag260 = await sampleReference(client, 'reference-detail-drag-260ms');
  await screenshot(client, '/tmp/ref-v71-detail-drag-260ms.png');

  await mouse(client, 'mouseReleased', 520, 450, 0);
  await sleep(700);
  const settled = await sampleReference(client, 'reference-detail-drag-settled');
  await screenshot(client, '/tmp/ref-v71-detail-drag-settled.png');

  return { before, drag120, drag260, settled };
}

async function collectLocal(client) {
  await navigate(client, LOCAL_URL);
  await waitFor(
    client,
    'document.querySelector(".gallery-shell")?.dataset.mode === "index" && Number.isFinite(Number(document.querySelector("#webgl")?.dataset.activePlaneTargetX))',
    'local Home ready',
    14000,
  );
  await sleep(1500);
  await pressUntil(
    client,
    'Enter',
    'Enter',
    13,
    'document.querySelector(".gallery-shell")?.dataset.mode === "detail"',
    'local Detail mode',
  );
  await sleep(1500);

  const before = await sampleLocal(client, 'local-detail-drag-before');
  await screenshot(client, '/tmp/local-v71-detail-drag-before.png');

  await mouse(client, 'mousePressed', 720, 450, 1);
  await sleep(40);
  await mouse(client, 'mouseMoved', 560, 450, 1);
  await sleep(120);
  const drag120 = await sampleLocal(client, 'local-detail-drag-120ms');
  await screenshot(client, '/tmp/local-v71-detail-drag-120ms.png');

  await mouse(client, 'mouseMoved', 520, 450, 1);
  await sleep(140);
  const drag260 = await sampleLocal(client, 'local-detail-drag-260ms');
  await screenshot(client, '/tmp/local-v71-detail-drag-260ms.png');

  await mouse(client, 'mouseReleased', 520, 450, 0);
  await sleep(700);
  const settled = await sampleLocal(client, 'local-detail-drag-settled');
  await screenshot(client, '/tmp/local-v71-detail-drag-settled.png');

  return { before, drag120, drag260, settled };
}

async function sampleReference(client, label) {
  return evaluate(client, `(() => {
    const round = (value, places = 4) => Number.isFinite(value) ? Number(value.toFixed(places)) : null;
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
    const index = window._A?.index ?? 0;
    const h = window._A?.h;
    const x = h?.x || {};
    const gap = h?.gapXW || null;
    const plane = window._A?.engine?.gl?.planeTex?.plane?.[index]?.tr || null;
    const pCurr = h?.pCurr?.[index] || null;
    const pTarg = h?.pTarg?.[index] || null;
    return {
      label: ${JSON.stringify(label)},
      mode: window._A?.mode || '',
      modePrev: window._A?.modePrev || '',
      index,
      path: location.pathname,
      isDown: Boolean(h?.isDown),
      isDragging: Boolean(h?.isDragging),
      dragTarg: round(h?.targ, 2),
      dragTargPrev: round(h?.targPrev, 2),
      gapXW: round(gap, 2),
      x: {
        normalized: round(window._A?.x, 4),
        curr: round(x.curr, 2),
        targ: round(x.targ, 2),
        currLatency: round(x.currLatency, 2),
        targetIndex: gap ? round(x.targ / gap, 3) : null,
        currentIndex: gap ? round(x.curr / gap, 3) : null,
      },
      latency: {
        x: round(window._A?.latency?.x, 4),
        rotate: round(window._A?.latency?.rotate, 4),
      },
      plane: plane ? {
        x: round(plane.x, 2),
        y: round(plane.y, 2),
        w: round(plane.w, 2),
        h: round(plane.h, 2),
        o: round(plane.o, 4),
        light: round(plane.light, 4),
      } : null,
      planeModel: pCurr ? {
        current: {
          x: round(pCurr.x, 2),
          y: round(pCurr.y, 2),
          w: round(pCurr.w, 2),
          h: round(pCurr.h, 2),
          o: round(pCurr.o, 4),
        },
        target: pTarg ? {
          x: round(pTarg.x, 2),
          y: round(pTarg.y, 2),
          w: round(pTarg.w, 2),
          h: round(pTarg.h, 2),
          o: round(pTarg.o, 4),
        } : null,
      } : null,
      pgn: {
        visible: [...document.querySelectorAll('.pgn')].filter((el) => getComputedStyle(el).opacity !== '0').length,
        activeRect: rect(document.querySelectorAll('.pgn')[index]),
        canvasRect: rect(document.querySelector('#c2d')),
      },
    };
  })()`);
}

async function sampleLocal(client, label) {
  return evaluate(client, `(() => {
    const number = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
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
    const planeRect = (data, prefix) => {
      const bottom = number(data[prefix + 'BottomPx']);
      const height = number(data[prefix + 'HeightPx']);
      const left = number(data[prefix + 'LeftPx']);
      const right = number(data[prefix + 'RightPx']);
      const top = number(data[prefix + 'TopPx']);
      const width = number(data[prefix + 'WidthPx']);
      if ([bottom, height, left, right, top, width].some((value) => value === null)) return null;
      return { bottom, height, left, right, top, width };
    };
    const shell = document.querySelector('.gallery-shell');
    const canvas = document.querySelector('#webgl');
    const data = canvas?.dataset || {};
    const pgns = [...document.querySelectorAll('.pgn')];
    const activeIndex = Number(document.querySelector('[data-current]')?.textContent || 0) - 1;
    const photoCount = Math.max(document.querySelectorAll('.detail-thumb').length, 1);
    const activeSlot = pgns.length > 1 && photoCount > 1
      ? Math.round((Math.max(0, activeIndex) / (photoCount - 1)) * (pgns.length - 1))
      : 0;
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      activeIndex,
      path: location.pathname,
      scrollPx: number(data.scrollPx),
      targetScrollPx: number(data.targetScrollPx),
      dragMoved: number(data.dragMoved),
      detailMix: number(data.activePlaneDetailMix),
      detailTarget: number(data.activePlaneDetailTarget),
      activePlane: {
        current: planeRect(data, 'activePlane'),
        target: planeRect(data, 'activePlaneTarget'),
        debug: {
          x: number(data.activePlaneX),
          targetX: number(data.activePlaneTargetX),
          targetYPx: number(data.activePlaneTargetYPx),
          rotateY: number(data.activePlaneRotateY),
          curve: number(data.activePlaneCurve),
          detailScrollOffsetPx: number(data.detailScrollOffsetPx),
        },
      },
      pgn: {
        visible: pgns.filter((el) => getComputedStyle(el).opacity !== '0').length,
        activeRect: rect(pgns[activeSlot]),
        canvasRect: rect(document.querySelector('.pagination-canvas')),
      },
    };
  })()`);
}

function labelSvg(text, width) {
  const safe = text.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
  return Buffer.from(`
    <svg width="${width}" height="42" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#141414"/>
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
      background: '#141414',
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

function rectSummary(rect) {
  return rect ? {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  } : null;
}

function metricSummary(reference, local) {
  const states = ['before', 'drag120', 'drag260', 'settled'];
  return states.reduce((summary, key) => {
    const ref = reference[key];
    const loc = local[key];
    summary[key] = {
      reference: {
        mode: ref?.mode,
        index: ref?.index,
        dragTarg: ref?.dragTarg,
        x: ref?.x,
        latency: ref?.latency,
        plane: ref?.plane,
        planeModel: ref?.planeModel,
        pgnVisible: ref?.pgn?.visible,
      },
      local: {
        mode: loc?.mode,
        index: loc?.activeIndex,
        scrollPx: loc?.scrollPx,
        targetScrollPx: loc?.targetScrollPx,
        dragMoved: loc?.dragMoved,
        detailMix: loc?.detailMix,
        plane: {
          current: rectSummary(loc?.activePlane?.current),
          target: rectSummary(loc?.activePlane?.target),
          debug: loc?.activePlane?.debug,
        },
        pgnVisible: loc?.pgn?.visible,
      },
    };
    return summary;
  }, {});
}

assertSourcePort();

const client = createCdpClient(await getPageWebSocket());
try {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Emulation.setDeviceMetricsOverride', VIEWPORT);

  const reference = await collectReference(client);
  const local = await collectLocal(client);
  const pairs = [
    ['before', 'before', 'Detail drag before'],
    ['120ms', 'drag120', 'Detail drag 120ms'],
    ['260ms', 'drag260', 'Detail drag 260ms'],
    ['settled', 'settled', 'Detail drag settled'],
  ];

  for (const [suffix, key, label] of pairs) {
    await combinePair(
      `/tmp/ref-v71-detail-drag-${suffix}.png`,
      `/tmp/local-v71-detail-drag-${suffix}.png`,
      `/tmp/compare-v71-detail-drag-${suffix}.jpg`,
      label,
    );
  }

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const report = {
    screenshots: pairs.flatMap(([suffix]) => [
      `/tmp/ref-v71-detail-drag-${suffix}.png`,
      `/tmp/local-v71-detail-drag-${suffix}.png`,
      `/tmp/compare-v71-detail-drag-${suffix}.jpg`,
    ]),
    reference,
    local,
    metrics: metricSummary(reference, local),
    runtimeExceptions,
  };
  fs.writeFileSync('/tmp/capture-v71-detail-drag-report.json', JSON.stringify(report, null, 2));
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
}
