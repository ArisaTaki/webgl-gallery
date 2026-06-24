import fs from 'node:fs';
import sharp from 'sharp';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const REF_URL = process.env.REF_URL || 'https://aristidebenoist.com/';
const LOCAL_URL = process.env.LOCAL_URL || 'http://localhost:5279/';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

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

async function navigate(client, url) {
  await client.send('Page.navigate', { url });
  await waitFor(client, 'document.readyState === "complete"', `document ready at ${url}`, 18000);
}

async function runDrag(client, sample, prefix) {
  const before = await sample(client, `${prefix}-home-drag-before`);
  await screenshot(client, `/tmp/${prefix}-v76-home-drag-before.png`);

  await mouse(client, 'mousePressed', 720, 450, 1);
  await sleep(40);
  await mouse(client, 'mouseMoved', 560, 450, 1);
  await sleep(80);
  const drag80 = await sample(client, `${prefix}-home-drag-80ms`);
  await screenshot(client, `/tmp/${prefix}-v76-home-drag-80ms.png`);

  await mouse(client, 'mouseMoved', 520, 450, 1);
  await sleep(120);
  const drag200 = await sample(client, `${prefix}-home-drag-200ms`);
  await screenshot(client, `/tmp/${prefix}-v76-home-drag-200ms.png`);

  await mouse(client, 'mouseReleased', 520, 450, 0);
  await sleep(760);
  const settled = await sample(client, `${prefix}-home-drag-settled`);
  await screenshot(client, `/tmp/${prefix}-v76-home-drag-settled.png`);

  return { before, drag80, drag200, settled };
}

async function collectReference(client) {
  await navigate(client, REF_URL);
  await waitFor(
    client,
    'window._A && _A.engine && _A.mode === "out" && document.querySelector("#c2d")',
    'reference Home ready',
    18000,
  );
  await sleep(1500);
  return runDrag(client, sampleReference, 'ref');
}

async function collectLocal(client) {
  await navigate(client, LOCAL_URL);
  await waitFor(
    client,
    'document.querySelector(".gallery-shell")?.dataset.mode === "index" && Number.isFinite(Number(document.querySelector("#webgl")?.dataset.scrollPx))',
    'local Home ready',
    14000,
  );
  await sleep(1500);
  return runDrag(client, sampleLocal, 'local');
}

async function sampleReference(client, label) {
  return evaluate(client, `(() => {
    const round = (value, places = 4) => Number.isFinite(value) ? Number(value.toFixed(places)) : null;
    const activeIndex = window._A?.index ?? 0;
    const h = window._A?.h;
    const x = h?.x || {};
    const gap = h?.gapXW || null;
    const plane = h?.pCurr?.[activeIndex] || null;
    return {
      label: ${JSON.stringify(label)},
      mode: window._A?.mode || '',
      index: activeIndex,
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
        dragTargetIndex: gap ? round(h?.targ / gap, 3) : null,
      },
      latency: {
        x: round(window._A?.latency?.x, 4),
        rotate: round(window._A?.latency?.rotate, 4),
      },
      plane: plane ? {
        x: round(plane.x, 2),
        w: round(plane.w, 2),
        light: round(plane.light, 4),
        o: round(plane.o, 4),
      } : null,
      pgn: {
        visual: Number.isFinite(window._A?.x) && Number.isFinite(window._A?.config?.data?.workL)
          ? round(window._A.x * window._A.config.data.workL, 3)
          : null,
        pOver: window._A?.pOver ?? null,
      },
    };
  })()`);
}

async function sampleLocal(client, label) {
  return evaluate(client, `(() => {
    const shell = document.querySelector('.gallery-shell');
    const webgl = document.querySelector('#webgl');
    const c2d = document.querySelector('.pagination-canvas');
    const data = webgl?.dataset || {};
    const pData = c2d?.dataset || {};
    const number = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const outGapPx = (() => {
      const step = number(pData.paginationStep);
      if (!Number.isFinite(step)) return null;
      const ratio = window.innerWidth / window.innerHeight > 1600 / 1200
        ? window.innerHeight / 1200
        : window.innerWidth / 1600;
      return 120 * ratio;
    })();
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      index: Number(document.querySelector('[data-current]')?.textContent || 0) - 1,
      path: location.pathname,
      scrollPx: number(data.scrollPx),
      targetScrollPx: number(data.targetScrollPx),
      dragMoved: number(data.dragMoved),
      dragBoundReset: data.dragBoundReset || '',
      outGapPx,
      x: {
        targetIndex: outGapPx ? number(data.targetScrollPx) / outGapPx : null,
        currentIndex: outGapPx ? number(data.scrollPx) / outGapPx : null,
      },
      latency: {
        x: number(pData.paginationLatencyLift) / 30,
        rotate: number(data.activePlaneRotateY),
      },
      plane: {
        curve: number(data.activePlaneCurve),
        rotateY: number(data.activePlaneRotateY),
        x: number(data.activePlaneX),
        targetX: number(data.activePlaneTargetX),
      },
      pgn: {
        activeVisual: number(pData.paginationActiveVisual),
        waveCenter: number(pData.paginationWaveCenter),
        latencyLift: number(pData.paginationLatencyLift),
      },
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

function rounded(value, places = 3) {
  return Number.isFinite(value) ? Number(value.toFixed(places)) : null;
}

function metricSummary(reference, local) {
  const keys = ['before', 'drag80', 'drag200', 'settled'];
  return keys.reduce((summary, key) => {
    const ref = reference[key];
    const loc = local[key];
    const refCurrent = ref?.x?.currentIndex;
    const locCurrent = loc?.x?.currentIndex;
    const refTarget = key === 'settled' ? ref?.x?.targetIndex : ref?.x?.dragTargetIndex;
    const locTarget = loc?.x?.targetIndex;
    summary[key] = {
      reference: {
        mode: ref?.mode,
        index: ref?.index,
        isDragging: ref?.isDragging,
        targetIndex: refTarget,
        currentIndex: refCurrent,
        latencyX: ref?.latency?.x,
        plane: ref?.plane,
      },
      local: {
        mode: loc?.mode,
        index: loc?.index,
        dragMoved: loc?.dragMoved,
        targetIndex: rounded(locTarget),
        currentIndex: rounded(locCurrent),
        latencyX: rounded(loc?.latency?.x, 4),
        plane: loc?.plane,
        pgn: loc?.pgn,
      },
      comparison: {
        targetIndexDelta: rounded((locTarget ?? Number.NaN) - (refTarget ?? Number.NaN)),
        currentIndexDelta: rounded((locCurrent ?? Number.NaN) - (refCurrent ?? Number.NaN)),
        latencyDelta: rounded((loc?.latency?.x ?? Number.NaN) - (ref?.latency?.x ?? Number.NaN), 4),
      },
    };
    return summary;
  }, {});
}

const client = createCdpClient(await getPageWebSocket());
try {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Emulation.setDeviceMetricsOverride', VIEWPORT);

  const reference = await collectReference(client);
  const local = await collectLocal(client);
  const pairs = [
    ['before', 'before', 'Home drag before'],
    ['80ms', 'drag80', 'Home drag 80ms'],
    ['200ms', 'drag200', 'Home drag 200ms'],
    ['settled', 'settled', 'Home drag settled'],
  ];

  for (const [suffix, , label] of pairs) {
    await combinePair(
      `/tmp/ref-v76-home-drag-${suffix}.png`,
      `/tmp/local-v76-home-drag-${suffix}.png`,
      `/tmp/compare-v76-home-drag-${suffix}.jpg`,
      label,
    );
  }

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const report = {
    screenshots: pairs.flatMap(([suffix]) => [
      `/tmp/ref-v76-home-drag-${suffix}.png`,
      `/tmp/local-v76-home-drag-${suffix}.png`,
      `/tmp/compare-v76-home-drag-${suffix}.jpg`,
    ]),
    reference,
    local,
    metrics: metricSummary(reference, local),
    runtimeExceptions,
  };
  fs.writeFileSync('/tmp/capture-v76-home-drag-report.json', JSON.stringify(report, null, 2));
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
