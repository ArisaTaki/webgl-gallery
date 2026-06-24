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

async function wheel(client, x, y, deltaY) {
  await client.send('Input.dispatchMouseEvent', {
    button: 'none',
    clickCount: 0,
    type: 'mouseMoved',
    x,
    y,
  });
  await client.send('Input.dispatchMouseEvent', {
    deltaX: 0,
    deltaY,
    type: 'mouseWheel',
    x,
    y,
  });
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
  const before = await sampleReference(client, 'reference-home-before');
  await screenshot(client, '/tmp/ref-v61-home-wheel-before.png');

  await wheel(client, 720, 450, 900);
  await sleep(80);
  const wheel80 = await sampleReference(client, 'reference-home-wheel-80ms');
  await screenshot(client, '/tmp/ref-v61-home-wheel-80ms.png');
  await sleep(80);
  const wheel160 = await sampleReference(client, 'reference-home-wheel-160ms');
  await screenshot(client, '/tmp/ref-v61-home-wheel-160ms.png');
  await sleep(160);
  const wheel320 = await sampleReference(client, 'reference-home-wheel-320ms');
  await screenshot(client, '/tmp/ref-v61-home-wheel-320ms.png');
  await sleep(900);
  const stable = await sampleReference(client, 'reference-home-wheel-stable');
  await screenshot(client, '/tmp/ref-v61-home-wheel-stable.png');

  return { before, wheel80, wheel160, wheel320, stable };
}

async function collectLocal(client) {
  await navigate(client, LOCAL_URL);
  await waitFor(
    client,
    'document.querySelector(".gallery-shell")?.dataset.mode === "index"',
    'local Home ready',
    14000,
  );
  await sleep(1500);
  const before = await sampleLocal(client, 'local-home-before');
  await screenshot(client, '/tmp/local-v61-home-wheel-before.png');

  await wheel(client, 720, 450, 900);
  await sleep(80);
  const wheel80 = await sampleLocal(client, 'local-home-wheel-80ms');
  await screenshot(client, '/tmp/local-v61-home-wheel-80ms.png');
  await sleep(80);
  const wheel160 = await sampleLocal(client, 'local-home-wheel-160ms');
  await screenshot(client, '/tmp/local-v61-home-wheel-160ms.png');
  await sleep(160);
  const wheel320 = await sampleLocal(client, 'local-home-wheel-320ms');
  await screenshot(client, '/tmp/local-v61-home-wheel-320ms.png');
  await sleep(900);
  const stable = await sampleLocal(client, 'local-home-wheel-stable');
  await screenshot(client, '/tmp/local-v61-home-wheel-stable.png');

  return { before, wheel80, wheel160, wheel320, stable };
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
    const canvasAlphaBox = (() => {
      const c2d = document.querySelector('#c2d');
      if (!c2d) return null;
      const dpr = c2d.width / Math.max(c2d.getBoundingClientRect().width, 1);
      const yStart = Math.floor(30 * dpr);
      const yEnd = Math.min(c2d.height, Math.ceil(96 * dpr));
      const image = c2d.getContext('2d').getImageData(0, yStart, c2d.width, yEnd - yStart);
      let minY = Infinity;
      let maxY = -Infinity;
      let alphaPixels = 0;
      let alphaSum = 0;
      for (let y = 0; y < image.height; y += 1) {
        for (let x = 0; x < image.width; x += 1) {
          const alpha = image.data[(y * image.width + x) * 4 + 3];
          alphaSum += alpha;
          if (alpha > 8) {
            alphaPixels += 1;
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
          }
        }
      }
      return {
        alphaPixels,
        alphaSum,
        spanCss: alphaPixels ? Number(((maxY - minY + 1) / dpr).toFixed(2)) : 0,
        topCss: alphaPixels ? Number(((yStart + minY) / dpr).toFixed(2)) : null,
        bottomCss: alphaPixels ? Number(((yStart + maxY) / dpr).toFixed(2)) : null,
      };
    })();
    const activeIndex = window._A?.index ?? 0;
    const plane = window._A?.h?.pCurr?.[activeIndex] || null;
    const target = window._A?.h?.pTarg?.[activeIndex] || null;
    return {
      label: ${JSON.stringify(label)},
      mode: window._A?.mode || '',
      index: activeIndex,
      path: location.pathname,
      workL: window._A?.config?.data?.workL ?? null,
      x: round(window._A?.x),
      xTarg: round(window._A?.xTarg ?? window._A?.x?.targ),
      latencyX: round(window._A?.latency?.x),
      latencyRotate: round(window._A?.latency?.rotate),
      pOver: window._A?.pOver ?? null,
      plane: plane ? {
        x: round(plane.x, 2),
        w: round(plane.w, 2),
        light: round(plane.light, 4),
        o: round(plane.o, 4),
      } : null,
      target: target ? {
        x: round(target.x, 2),
        w: round(target.w, 2),
        light: round(target.light, 4),
        o: round(target.o, 4),
      } : null,
      pgn: {
        canvas: rect(document.querySelector('#c2d')),
        dpr: window._A?.pgn?.dpr ?? null,
        gapX: round(window._A?.pgn?.p?.gapX, 3),
        outWidth: round(window._A?.pgn?.p?.w?.out, 3),
        leftOut: round(window._A?.pgn?.p?.left?.out, 3),
        alphaBox: canvasAlphaBox,
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
    const canvasAlphaBox = (() => {
      if (!c2d) return null;
      const dpr = c2d.width / Math.max(c2d.getBoundingClientRect().width, 1);
      const yStart = Math.floor(30 * dpr);
      const yEnd = Math.min(c2d.height, Math.ceil(96 * dpr));
      const image = c2d.getContext('2d').getImageData(0, yStart, c2d.width, yEnd - yStart);
      let minY = Infinity;
      let maxY = -Infinity;
      let alphaPixels = 0;
      let alphaSum = 0;
      for (let y = 0; y < image.height; y += 1) {
        for (let x = 0; x < image.width; x += 1) {
          const alpha = image.data[(y * image.width + x) * 4 + 3];
          alphaSum += alpha;
          if (alpha > 8) {
            alphaPixels += 1;
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
          }
        }
      }
      return {
        alphaPixels,
        alphaSum,
        spanCss: alphaPixels ? Number(((maxY - minY + 1) / dpr).toFixed(2)) : 0,
        topCss: alphaPixels ? Number(((yStart + minY) / dpr).toFixed(2)) : null,
        bottomCss: alphaPixels ? Number(((yStart + maxY) / dpr).toFixed(2)) : null,
      };
    })();
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      activeIndex: Number(document.querySelector('[data-current]')?.textContent || 0) - 1,
      path: location.pathname,
      scrollPx: number(data.scrollPx),
      targetScrollPx: number(data.targetScrollPx),
      plane: {
        curve: number(data.activePlaneCurve),
        rotateY: number(data.activePlaneRotateY),
        x: number(data.activePlaneX),
        targetX: number(data.activePlaneTargetX),
        alpha: number(data.activePlaneAlpha),
      },
      pgn: {
        canvas: rect(c2d),
        activeVisual: number(pData.paginationActiveVisual),
        count: number(pData.paginationCount),
        photoCount: number(pData.paginationPhotoCount),
        height: number(pData.paginationHeight),
        latencyLift: number(pData.paginationLatencyLift),
        step: number(pData.paginationStep),
        top: number(pData.paginationTop),
        waveCenter: number(pData.paginationWaveCenter),
        alphaBox: canvasAlphaBox,
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

function metricSummary(reference, local) {
  const keys = ['before', 'wheel80', 'wheel160', 'wheel320', 'stable'];
  return keys.reduce((summary, key) => {
    const ref = reference[key];
    const loc = local[key];
    const referenceTravel = Number.isFinite(ref?.x) && Number.isFinite(ref?.workL)
      ? Number((ref.x * ref.workL).toFixed(3))
      : null;
    const localTravel = Number.isFinite(loc?.pgn?.waveCenter) ? loc.pgn.waveCenter : null;
    const referenceLatency = Number.isFinite(ref?.latencyX) ? ref.latencyX : null;
    const localLatency = Number.isFinite(loc?.pgn?.latencyLift)
      ? Number((loc.pgn.latencyLift / 30).toFixed(4))
      : null;
    summary[key] = {
      reference: {
        mode: ref?.mode,
        index: ref?.index,
        workL: ref?.workL,
        x: ref?.x,
        latencyX: ref?.latencyX,
        latencyRotate: ref?.latencyRotate,
        plane: ref?.plane,
        pgnGeometry: {
          dpr: ref?.pgn?.dpr,
          gapX: ref?.pgn?.gapX,
          outWidth: ref?.pgn?.outWidth,
          leftOut: ref?.pgn?.leftOut,
        },
        pgnAlphaBox: ref?.pgn?.alphaBox,
      },
      local: {
        mode: loc?.mode,
        index: loc?.activeIndex,
        scrollPx: loc?.scrollPx,
        targetScrollPx: loc?.targetScrollPx,
        plane: loc?.plane,
        pgn: {
          activeVisual: loc?.pgn?.activeVisual,
          count: loc?.pgn?.count,
          photoCount: loc?.pgn?.photoCount,
          latencyLift: loc?.pgn?.latencyLift,
          step: loc?.pgn?.step,
          waveCenter: loc?.pgn?.waveCenter,
          alphaBox: loc?.pgn?.alphaBox,
        },
      },
      comparison: {
        travelVisual: {
          reference: referenceTravel,
          local: localTravel,
          delta: referenceTravel === null || localTravel === null
            ? null
            : Number((localTravel - referenceTravel).toFixed(3)),
        },
        latency: {
          reference: referenceLatency,
          local: localLatency,
          delta: referenceLatency === null || localLatency === null
            ? null
            : Number((localLatency - referenceLatency).toFixed(4)),
        },
        pgnAlphaSpanDelta: Number.isFinite(loc?.pgn?.alphaBox?.spanCss) && Number.isFinite(ref?.pgn?.alphaBox?.spanCss)
          ? Number((loc.pgn.alphaBox.spanCss - ref.pgn.alphaBox.spanCss).toFixed(2))
          : null,
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
    ['before', 'before', 'Home before wheel'],
    ['wheel80', '80ms', 'Home wheel 80ms'],
    ['wheel160', '160ms', 'Home wheel 160ms'],
    ['wheel320', '320ms', 'Home wheel 320ms'],
    ['stable', 'stable', 'Home wheel stable'],
  ];

  for (const [, suffix, label] of pairs) {
    await combinePair(
      `/tmp/ref-v61-home-wheel-${suffix}.png`,
      `/tmp/local-v61-home-wheel-${suffix}.png`,
      `/tmp/compare-v61-home-wheel-${suffix}.jpg`,
      label,
    );
  }

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const report = {
    screenshots: [
      '/tmp/compare-v61-home-wheel-before.jpg',
      '/tmp/compare-v61-home-wheel-80ms.jpg',
      '/tmp/compare-v61-home-wheel-160ms.jpg',
      '/tmp/compare-v61-home-wheel-320ms.jpg',
      '/tmp/compare-v61-home-wheel-stable.jpg',
    ],
    reference,
    local,
    metrics: metricSummary(reference, local),
    runtimeExceptions,
  };
  fs.writeFileSync('/tmp/capture-v61-home-wheel-report.json', JSON.stringify(report, null, 2));
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
