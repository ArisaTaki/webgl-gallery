import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/webgl-gallery-002';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertSourcePort() {
  const source = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const checks = [
    'function getPlaneSourceMode()',
    'return state.aboutReturnMode || VIEW.index;',
    'const planeMode = getPlaneSourceMode();',
    'referenceModeInRect(metrics, detailDistance, isAboutPlane && planeMode === VIEW.detail)',
    'metrics.in.gapX + metrics.in.w) + (isAbout ? metrics.in.gapX : 0)',
    'metrics.in.x - (metrics.in.gapX + sideW) - (isAbout ? metrics.in.gapX : 0)',
    'canvas.dataset.activePlaneTextureScaleTarget',
    'canvas.dataset.nextPlaneTargetLeftPx',
  ];
  const missing = checks.filter((check) => !source.includes(check));
  if (missing.length) {
    throw new Error(`Missing About plane-source reference checks: ${missing.join(', ')}`);
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
    const data = document.querySelector('#webgl')?.dataset || {};
    const number = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    const psdW = 1600;
    const psdH = 1200;
    const ratio = winW / winH > psdW / psdH ? winH / psdH : winW / psdW;
    const inW = 1054 * ratio;
    const inGap = 152 * (winW / psdW);
    const inX = 0.5 * (winW - inW);
    const normalNextLeft = inX + inGap + inW;
    const aboutNextLeft = normalNextLeft + inGap;
    return {
      label: ${JSON.stringify(label)},
      aboutHidden: document.querySelector('.about-panel')?.getAttribute('aria-hidden') || '',
      activePlaneAlpha: number(data.activePlaneAlpha),
      activePlaneAlphaTarget: number(data.activePlaneAlphaTarget),
      activePlaneDetailMix: number(data.activePlaneDetailMix),
      activePlaneDetailTarget: number(data.activePlaneDetailTarget),
      activePlanePhotoYTarget: number(data.activePlanePhotoYTarget),
      activePlaneTextureScale: number(data.activePlaneTextureScale),
      activePlaneTextureScaleTarget: number(data.activePlaneTextureScaleTarget),
      activePlaneWorkMix: number(data.activePlaneWorkMix),
      activePlaneWorkTarget: number(data.activePlaneWorkTarget),
      expectedAboutNextLeft: Number(aboutNextLeft.toFixed(2)),
      expectedNormalNextLeft: Number(normalNextLeft.toFixed(2)),
      mode: shell?.dataset.mode || '',
      nextPlaneAlphaTarget: number(data.nextPlaneAlphaTarget),
      nextPlaneTargetLeftPx: number(data.nextPlaneTargetLeftPx),
      nextPlaneTargetWidthPx: number(data.nextPlaneTargetWidthPx),
      path: location.pathname,
      planeSourceMode: data.planeSourceMode || '',
    };
  })()`);
}

function near(value, expected, tolerance = 1.5) {
  return Math.abs((value ?? Number.NaN) - expected) <= tolerance;
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
  await sleep(1200);

  const detail = await sample(client, 'detail-stable');
  await screenshot(client, '/tmp/local-about-plane-source-v41-detail.png');

  await key(client, 'a', 'KeyA', 65);
  await waitForMode(client, 'about');
  await sleep(180);
  const detailAbout = await sample(client, 'detail-about-180ms');
  await screenshot(client, '/tmp/local-about-plane-source-v41-detail-about.png');

  await key(client, 'c', 'KeyC', 67);
  await waitForMode(client, 'detail');
  await sleep(700);
  await key(client, 'e', 'KeyE', 69);
  await waitForMode(client, 'work');
  await sleep(1000);
  const work = await sample(client, 'work-stable');
  await screenshot(client, '/tmp/local-about-plane-source-v41-work.png');

  await key(client, 'a', 'KeyA', 65);
  await waitForMode(client, 'about');
  await sleep(180);
  const workAbout = await sample(client, 'work-about-180ms');
  await screenshot(client, '/tmp/local-about-plane-source-v41-work-about.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];

  if (detail.mode !== 'detail' || detail.planeSourceMode !== 'detail') {
    failures.push(`Expected stable Detail source mode, got ${JSON.stringify(detail)}.`);
  }
  if (!near(detail.nextPlaneTargetLeftPx, detail.expectedNormalNextLeft)) {
    failures.push(`Expected Detail next plane at normal modeIn left, got ${JSON.stringify(detail)}.`);
  }
  if (detailAbout.mode !== 'about' || detailAbout.aboutHidden !== 'false') {
    failures.push(`Expected About panel after Detail key A, got ${JSON.stringify(detailAbout)}.`);
  }
  if (detailAbout.planeSourceMode !== 'detail' || detailAbout.activePlaneDetailTarget !== 1 || detailAbout.activePlaneWorkTarget !== 0) {
    failures.push(`Expected Detail-sourced About to keep Detail plane target, got ${JSON.stringify(detailAbout)}.`);
  }
  if (detailAbout.activePlaneAlphaTarget !== 0 || (detailAbout.activePlaneAlpha ?? 0) >= 0.85) {
    failures.push(`Expected Detail-sourced About to fade active plane toward 0, got ${JSON.stringify(detailAbout)}.`);
  }
  if (!near(detailAbout.activePlaneTextureScaleTarget, 0.15, 0.01)) {
    failures.push(`Expected Detail-sourced About active texture scale target .15, got ${JSON.stringify(detailAbout)}.`);
  }
  if (!near(detailAbout.nextPlaneTargetLeftPx, detailAbout.expectedAboutNextLeft)) {
    failures.push(`Expected Detail-sourced About next plane to shift out by one in-gap, got ${JSON.stringify(detailAbout)}.`);
  }
  if (work.mode !== 'work' || work.planeSourceMode !== 'work') {
    failures.push(`Expected stable Work source mode, got ${JSON.stringify(work)}.`);
  }
  if (workAbout.mode !== 'about' || workAbout.planeSourceMode !== 'work') {
    failures.push(`Expected Work-sourced About to preserve Work source mode, got ${JSON.stringify(workAbout)}.`);
  }
  if (workAbout.activePlaneDetailTarget !== 1 || workAbout.activePlaneWorkTarget !== 1) {
    failures.push(`Expected Work-sourced About to keep Detail+Work targets, got ${JSON.stringify(workAbout)}.`);
  }
  if (workAbout.activePlaneAlphaTarget !== 0 || !near(workAbout.activePlanePhotoYTarget, -0.1, 0.001)) {
    failures.push(`Expected Work-sourced About to fade Work plane while preserving pY -0.1, got ${JSON.stringify(workAbout)}.`);
  }
  if (!near(workAbout.activePlaneTextureScaleTarget, 0, 0.001)) {
    failures.push(`Expected Work-sourced About texture scale target 0, got ${JSON.stringify(workAbout)}.`);
  }
  if (runtimeExceptions.length) {
    failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);
  }

  console.log(JSON.stringify({
    status: failures.length ? 'fail' : 'pass',
    screenshots: [
      '/tmp/local-about-plane-source-v41-detail.png',
      '/tmp/local-about-plane-source-v41-detail-about.png',
      '/tmp/local-about-plane-source-v41-work.png',
      '/tmp/local-about-plane-source-v41-work-about.png',
    ],
    detail,
    detailAbout,
    work,
    workAbout,
    runtimeExceptions,
    failures,
  }, null, 2));

  if (failures.length) process.exitCode = 1;
} finally {
  client.close();
}
