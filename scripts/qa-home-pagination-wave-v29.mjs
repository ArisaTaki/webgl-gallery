import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/';
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

async function sample(client, label) {
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
    const canvasAlphaBox = (() => {
      if (!c2d) return null;
      const rect = c2d.getBoundingClientRect();
      const dpr = c2d.width / Math.max(rect.width, 1);
      const yStart = Math.floor(30 * dpr);
      const yEnd = Math.min(c2d.height, Math.ceil(92 * dpr));
      const image = c2d.getContext('2d').getImageData(0, yStart, c2d.width, yEnd - yStart);
      let minY = Infinity;
      let maxY = -Infinity;
      let alphaPixels = 0;
      for (let y = 0; y < image.height; y += 1) {
        for (let x = 0; x < image.width; x += 1) {
          const alpha = image.data[(y * image.width + x) * 4 + 3];
          if (alpha > 8) {
            alphaPixels += 1;
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
          }
        }
      }
      return {
        alphaPixels,
        spanCss: alphaPixels ? (maxY - minY + 1) / dpr : 0,
        topCss: alphaPixels ? (yStart + minY) / dpr : null,
        bottomCss: alphaPixels ? (yStart + maxY) / dpr : null,
      };
    })();
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      path: location.pathname,
      activePlaneCurve: number(data.activePlaneCurve),
      activePlaneRotateY: number(data.activePlaneRotateY),
      frame: document.querySelector('[data-meta-frame]')?.textContent?.trim() || '',
      paginationActiveVisual: number(pData.paginationActiveVisual),
      paginationHeight: number(pData.paginationHeight),
      paginationHeightTarget: number(pData.paginationHeightTarget),
      paginationLatencyLift: number(pData.paginationLatencyLift),
      paginationMetricHeight: number(pData.paginationMetricHeight),
      paginationTop: number(pData.paginationTop),
      paginationWaveCenter: number(pData.paginationWaveCenter),
      canvasAlphaBox,
    };
  })()`);
}

const source = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const staticFailures = [];
if (!source.includes('const latencyLift = 30 * clamp(state.curveLatency, 0, 1);')) {
  staticFailures.push('Expected Home pagination wave to use reference 30 * latency.x amplitude.');
}
if (!source.includes('const tickHeight = state.paginationHeight + wave;')) {
  staticFailures.push('Expected pagination tick height to use pH.curr + wave, not a local scaled base height.');
}
if (!source.includes('const count = Math.max(photoCount, 30);')) {
  staticFailures.push('Expected pagination to keep at least the reference 30 visual ticks.');
}
if (!source.includes('const outWidth = 1 / PAGINATION_DPR;')) {
  staticFailures.push('Expected pagination out-width to mirror the reference 1 backing-pixel tick width.');
}
if (!source.includes('const left = (window.innerWidth - count * gapX) * 0.5;')) {
  staticFailures.push('Expected Home pagination left edge to use the reference centered c2d coordinate system.');
}
if (source.includes('index * (metrics.step + metrics.outWidth)')) {
  staticFailures.push('Expected pagination open positions to use step once; step already includes outWidth.');
}
if (!source.includes('roundTo((state.scroll / getMaxScroll()) * metrics.photoCount, 2)')) {
  staticFailures.push('Expected Home pagination wave center to use true photo count while visual ticks can stay reference-dense.');
}
if (source.includes('state.paginationLeft[index] - state.paginationWidth[index] * 0.5')) {
  staticFailures.push('Expected pagination tick rect x to use reference left-edge pLeft semantics, not centered rectangles.');
}
if (!source.includes('paginationCtx.setTransform(1, 0, 0, 1, 0, 0);')) {
  staticFailures.push('Expected pagination canvas to draw in raw DPR-backed device pixels like the reference c2d renderer.');
}
if (!source.includes('ctx.lineWidth = dpr;')) {
  staticFailures.push('Expected pagination stroke width to use DPR-backed reference line width.');
}
if (!source.includes('state.paginationLeft[index] * dpr')) {
  staticFailures.push('Expected pagination rect coordinates to be multiplied into device pixels at draw time.');
}

const client = createCdpClient(await getPageWebSocket());
try {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
  await client.send('Page.navigate', { url: TARGET_URL });
  await waitForMode(client, 'index');
  await sleep(1700);

  const before = await sample(client, 'home-before-wheel');
  await screenshot(client, '/tmp/local-home-pagination-wave-v29-before.png');

  await wheel(client, 720, 450, 900);
  await sleep(160);
  const mid = await sample(client, 'home-wheel-160ms');
  await screenshot(client, '/tmp/local-home-pagination-wave-v29-mid.png');

  await sleep(760);
  const after = await sample(client, 'home-wheel-after');
  await screenshot(client, '/tmp/local-home-pagination-wave-v29-after.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [...staticFailures];

  if (before.mode !== 'index' || before.path !== '/') {
    failures.push(`Expected Home index state before wheel, got ${JSON.stringify(before)}.`);
  }
  if ((before.paginationMetricHeight || 0) !== 14 || (before.paginationHeightTarget || 0) !== 14) {
    failures.push(`Expected reference 14px Home pagination height target, got ${JSON.stringify(before)}.`);
  }
  if ((before.canvasAlphaBox?.spanCss || 0) < 12) {
    failures.push(`Expected rest pagination alpha span to reflect a full-height 14px tick, got ${JSON.stringify(before.canvasAlphaBox)}.`);
  }
  if (mid.mode !== 'index' || after.mode !== 'index') {
    failures.push(`Expected wheel interaction to stay in Home index mode, got ${JSON.stringify({ mid, after })}.`);
  }
  if ((mid.paginationLatencyLift || 0) <= 0.5) {
    failures.push(`Expected Home wheel to produce reference pagination wave lift, got ${JSON.stringify(mid)}.`);
  }
  if ((mid.activePlaneCurve || 0) <= 0.01) {
    failures.push(`Expected Home wheel to activate WebGL curve uniform, got ${JSON.stringify(mid)}.`);
  }
  if (Math.abs(mid.activePlaneRotateY || 0) <= 0.005) {
    failures.push(`Expected Home wheel to rotate active plane around Y, got ${JSON.stringify(mid)}.`);
  }
  if ((mid.canvasAlphaBox?.spanCss || 0) < (before.canvasAlphaBox?.spanCss || 0)) {
    failures.push(`Expected wheel wave alpha span not to shrink below rest span, got ${JSON.stringify({ before: before.canvasAlphaBox, mid: mid.canvasAlphaBox })}.`);
  }
  if ((after.paginationLatencyLift || 0) >= (mid.paginationLatencyLift || 0)) {
    failures.push(`Expected pagination wave lift to decay after wheel input, got ${JSON.stringify({ mid, after })}.`);
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: [
      '/tmp/local-home-pagination-wave-v29-before.png',
      '/tmp/local-home-pagination-wave-v29-mid.png',
      '/tmp/local-home-pagination-wave-v29-after.png',
    ],
    before,
    mid,
    after,
    runtimeExceptions,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  client.close();
}
