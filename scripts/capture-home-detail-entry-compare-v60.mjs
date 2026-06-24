import fs from 'node:fs';
import sharp from 'sharp';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const REF_URL = process.env.REF_URL || 'https://aristidebenoist.com/';
const LOCAL_URL = process.env.LOCAL_URL || 'http://localhost:5279/';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
const TIMING_ONLY = process.env.TIMING_ONLY === '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logStep = (label) => {
  if (process.env.SUMMARY_ONLY) console.error(`[v60] ${label}`);
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
  await client.send('Input.dispatchMouseEvent', {
    button: 'left',
    clickCount: 1,
    type: 'mousePressed',
    x,
    y,
  });
  await client.send('Input.dispatchMouseEvent', {
    button: 'left',
    clickCount: 1,
    type: 'mouseReleased',
    x,
    y,
  });
}

async function waitFor(client, expression, label, timeout = 12000) {
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

async function navigate(client, url) {
  await client.send('Page.navigate', { url });
  await waitFor(client, 'document.readyState === "complete"', `document ready at ${url}`, 18000);
}

async function collectReference(client) {
  logStep('reference navigate');
  await navigate(client, REF_URL);
  logStep('reference wait home');
  await waitFor(
    client,
    'window._A && _A.engine && _A.mode === "out" && document.querySelector("#n0") && document.querySelectorAll("canvas").length >= 2',
    'reference Home ready',
    18000,
  );
  await sleep(1500);
  const before = await sampleReference(client, 'reference-home-before');
  await screenshot(client, '/tmp/ref-v60-home-detail-before.png');

  logStep('reference enter detail');
  await pressOrClickUntil(
    client,
    'Enter',
    'Enter',
    13,
    'window._A && _A.mode === "in"',
    'reference Detail mode',
    [{ x: 720, y: 450 }],
  );
  const entryStartedAt = await evaluate(client, 'performance.now()');
  await waitUntilPageElapsed(client, entryStartedAt, 120);
  const entry120 = await sampleReference(client, 'reference-home-detail-120ms', entryStartedAt);
  await screenshot(client, '/tmp/ref-v60-home-detail-120ms.png');
  await waitUntilPageElapsed(client, entryStartedAt, 300);
  const entry300 = await sampleReference(client, 'reference-home-detail-300ms', entryStartedAt);
  await screenshot(client, '/tmp/ref-v60-home-detail-300ms.png');
  await waitUntilPageElapsed(client, entryStartedAt, 750);
  const entry750 = await sampleReference(client, 'reference-home-detail-750ms', entryStartedAt);
  await screenshot(client, '/tmp/ref-v60-home-detail-750ms.png');
  await waitUntilPageElapsed(client, entryStartedAt, 1750);
  const stable = await sampleReference(client, 'reference-home-detail-stable', entryStartedAt);
  await screenshot(client, '/tmp/ref-v60-home-detail-stable.png');

  return { before, entry120, entry300, entry750, stable };
}

async function collectLocal(client) {
  logStep('local navigate');
  await navigate(client, LOCAL_URL);
  logStep('local wait home');
  await waitFor(
    client,
    'document.querySelector(".gallery-shell")?.dataset.mode === "index" && Number.isFinite(Number(document.querySelector("#webgl")?.dataset.activePlaneTargetX))',
    'local Home ready',
    14000,
  );
  await sleep(1500);
  const before = await sampleLocal(client, 'local-home-before');
  await screenshot(client, '/tmp/local-v60-home-detail-before.png');

  logStep('local enter detail');
  await pressUntil(
    client,
    'Enter',
    'Enter',
    13,
    'document.querySelector(".gallery-shell")?.dataset.mode === "detail"',
    'local Detail mode',
  );
  const entryStartedAt = await evaluate(client, 'performance.now()');
  await waitUntilPageElapsed(client, entryStartedAt, 120);
  const entry120 = await sampleLocal(client, 'local-home-detail-120ms', entryStartedAt);
  await screenshot(client, '/tmp/local-v60-home-detail-120ms.png');
  await waitUntilPageElapsed(client, entryStartedAt, 300);
  const entry300 = await sampleLocal(client, 'local-home-detail-300ms', entryStartedAt);
  await screenshot(client, '/tmp/local-v60-home-detail-300ms.png');
  await waitUntilPageElapsed(client, entryStartedAt, 750);
  const entry750 = await sampleLocal(client, 'local-home-detail-750ms', entryStartedAt);
  await screenshot(client, '/tmp/local-v60-home-detail-750ms.png');
  await waitUntilPageElapsed(client, entryStartedAt, 1750);
  const stable = await sampleLocal(client, 'local-home-detail-stable', entryStartedAt);
  await screenshot(client, '/tmp/local-v60-home-detail-stable.png');

  return { before, entry120, entry300, entry750, stable };
}

async function sampleReference(client, label, entryStartedAt = 0) {
  return evaluate(client, `(() => {
    const entryStartedAt = ${Number(entryStartedAt)};
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
      const s = el ? getComputedStyle(el) : null;
      return s ? {
        animationDelay: s.animationDelay,
        animationDuration: s.animationDuration,
        animationName: s.animationName,
        color: s.color,
        opacity: s.opacity,
        transform: s.transform,
      } : null;
    };
    const titleLines = [...document.querySelectorAll('.t' + (window._A?.index ?? 0))].map((line, lineIndex) => ({
      lineIndex,
      text: line.textContent.trim().replace(/\\s+/g, ' '),
      rect: rect(line),
      style: css(line),
      chars: [...line.children].map((char, charIndex) => ({
        charIndex,
        text: char.textContent.trim(),
        rect: rect(char),
        style: css(char),
        innerStyle: css(char.children[0]),
      })),
    }));
    const pgn = document.querySelectorAll('.pgn')[window._A?.index ?? 0];
    const activePlane = window._A?.h?.pCurr?.[window._A?.index ?? 0] || null;
    const activeTarget = window._A?.h?.pTarg?.[window._A?.index ?? 0] || null;
    return {
      label: ${JSON.stringify(label)},
      sampleMs: entryStartedAt ? Number((performance.now() - entryStartedAt).toFixed(2)) : null,
      mode: window._A?.mode || '',
      modePrev: window._A?.modePrev || '',
      index: window._A?.index ?? -1,
      path: location.pathname,
      x: Number.isFinite(window._A?.x) ? Number(window._A.x.toFixed(4)) : null,
      latencyX: Number.isFinite(window._A?.latency?.x) ? Number(window._A.latency.x.toFixed(4)) : null,
      title: titleLines,
      infoLeft: {
        rect: rect(document.querySelectorAll('.i-l')[window._A?.index ?? 0]),
        style: css(document.querySelectorAll('.i-l')[window._A?.index ?? 0]),
      },
      pgn: {
        rect: rect(pgn),
        text: pgn?.textContent.trim().replace(/\\s+/g, ' ') || '',
        style: css(pgn),
        a: css(pgn?.querySelector('.pgn-a > div')),
        b: css(pgn?.querySelector('.pgn-b > div')),
      },
      plane: {
        current: activePlane ? Object.fromEntries(Object.entries(activePlane).map(([key, value]) => [key, Number.isFinite(value) ? Number(value.toFixed(2)) : value])) : null,
        target: activeTarget ? Object.fromEntries(Object.entries(activeTarget).map(([key, value]) => [key, Number.isFinite(value) ? Number(value.toFixed(2)) : value])) : null,
      },
    };
  })()`);
}

async function sampleLocal(client, label, entryStartedAt = 0) {
  return evaluate(client, `(() => {
    const entryStartedAt = ${Number(entryStartedAt)};
    const shell = document.querySelector('.gallery-shell');
    const canvas = document.querySelector('#webgl');
    const data = canvas?.dataset || {};
    const number = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const planeRect = (prefix) => {
      const top = number(data[prefix + 'TopPx']);
      const left = number(data[prefix + 'LeftPx']);
      const width = number(data[prefix + 'WidthPx']);
      const height = number(data[prefix + 'HeightPx']);
      const right = number(data[prefix + 'RightPx']);
      const bottom = number(data[prefix + 'BottomPx']);
      if ([top, left, width, height].some((value) => value === null)) return null;
      return { bottom, height, left, right, top, width };
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
    const css = (el) => {
      const s = el ? getComputedStyle(el) : null;
      return s ? {
        animationDelay: s.animationDelay,
        animationDuration: s.animationDuration,
        animationName: s.animationName,
        color: s.color,
        opacity: s.opacity,
        transform: s.transform,
      } : null;
    };
    const titleLines = [...document.querySelectorAll('.project-shadow-title-active .title-line')].map((line, lineIndex) => ({
      lineIndex,
      text: line.textContent.trim().replace(/\\s+/g, ' '),
      rect: rect(line),
      style: css(line),
      chars: [...line.querySelectorAll('.title-char')].map((char, charIndex) => ({
        charIndex,
        text: char.textContent.trim(),
        rect: rect(char),
        style: css(char),
        innerStyle: css(char.querySelector('span')),
      })),
    }));
    const pgnItems = [...document.querySelectorAll('.pgn')];
    const pgn = pgnItems.find((item) => item.classList.contains('is-visible') || item.classList.contains('is-leaving'))
      || pgnItems.find((item) => item.style.width !== '0px' && item.style.height !== '0px');
    return {
      label: ${JSON.stringify(label)},
      sampleMs: entryStartedAt ? Number((performance.now() - entryStartedAt).toFixed(2)) : null,
      mode: shell?.dataset.mode || '',
      shellClass: shell?.className || '',
      activeIndex: Number(document.querySelector('[data-current]')?.textContent || 0) - 1,
      path: location.pathname,
      title: titleLines,
      infoLeft: {
        rect: rect(document.querySelector('.project-shadow-meta:not(.project-shadow-meta-prev)')),
        style: css(document.querySelector('.project-shadow-meta:not(.project-shadow-meta-prev)')),
      },
      pgn: {
        rect: rect(pgn),
        text: pgn?.textContent.trim().replace(/\\s+/g, ' ') || '',
        className: pgn?.className || '',
        style: css(pgn),
        a: css(pgn?.querySelector('.pgn-a > div')),
        b: css(pgn?.querySelector('.pgn-b > div')),
      },
      plane: {
        current: planeRect('activePlane'),
        target: planeRect('activePlaneTarget'),
        debug: {
          x: number(data.activePlaneX),
          targetX: number(data.activePlaneTargetX),
          detailMix: number(data.activePlaneDetailMix),
          detailTarget: number(data.activePlaneDetailTarget),
          targetYPx: number(data.activePlaneTargetYPx),
          targetH: number(data.activePlaneTargetH),
          alpha: number(data.activePlaneAlpha),
          alphaTarget: number(data.activePlaneAlphaTarget),
          curve: number(data.activePlaneCurve),
        },
      },
      scroll: {
        px: number(data.scrollPx),
        targetPx: number(data.targetScrollPx),
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

function rectSummary(rect) {
  return rect ? {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  } : null;
}

function transformX(transform) {
  if (!transform || transform === 'none') return 0;
  const matrix3d = transform.match(/^matrix3d\((.+)\)$/);
  if (matrix3d) {
    const values = matrix3d[1].split(',').map((value) => Number(value.trim()));
    return Number.isFinite(values[12]) ? values[12] : 0;
  }
  const matrix = transform.match(/^matrix\((.+)\)$/);
  if (matrix) {
    const values = matrix[1].split(',').map((value) => Number(value.trim()));
    return Number.isFinite(values[4]) ? values[4] : 0;
  }
  return 0;
}

function titleResidual(char) {
  const width = char?.rect?.width || 0;
  if (!width) return null;
  const x = transformX(char.innerStyle?.transform || char.style?.transform || '');
  return Number((Math.abs(x) / width).toFixed(4));
}

function pgnTransformSummary(pgn) {
  return {
    a: transformX(pgn?.a?.transform || ''),
    b: transformX(pgn?.b?.transform || ''),
  };
}

function metricSummary(reference, local) {
  const titleSummary = (state) => ({
    sampleMs: state.sampleMs ?? null,
    title: rectSummary(state.title?.[0]?.rect),
    chars: state.title?.[0]?.chars?.map((char) => ({
      rect: rectSummary(char.rect),
      transform: char.innerStyle?.transform || char.style?.transform || '',
      residual: titleResidual(char),
    })) || [],
    pgn: {
      rect: rectSummary(state.pgn?.rect),
      text: state.pgn?.text || '',
      aTransform: state.pgn?.a?.transform || '',
      bTransform: state.pgn?.b?.transform || '',
      x: pgnTransformSummary(state.pgn),
    },
    plane: state.plane,
  });
  return ['before', 'entry120', 'entry300', 'entry750', 'stable'].reduce((summary, key) => {
    const referenceTitle = titleSummary(reference[key]);
    const localTitle = titleSummary(local[key]);
    const residualPairs = referenceTitle.chars
      .slice(0, Math.min(referenceTitle.chars.length, localTitle.chars.length))
      .map((char, index) => ({
        reference: char.residual,
        local: localTitle.chars[index].residual,
        delta: char.residual === null || localTitle.chars[index].residual === null
          ? null
          : Number((localTitle.chars[index].residual - char.residual).toFixed(4)),
      }));
    const residualDeltas = residualPairs
      .map((pair) => pair.delta)
      .filter((value) => value !== null);
    const titleResidualMae = residualDeltas.length
      ? Number((residualDeltas.reduce((sum, value) => sum + Math.abs(value), 0) / residualDeltas.length).toFixed(4))
      : null;
    summary[key] = {
      reference: referenceTitle,
      local: localTitle,
      comparison: {
        titleResidualPairs: residualPairs,
        titleResidualMae,
        pgnDelta: {
          a: Number((localTitle.pgn.x.a - referenceTitle.pgn.x.a).toFixed(4)),
          b: Number((localTitle.pgn.x.b - referenceTitle.pgn.x.b).toFixed(4)),
        },
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
  const pairs = [
    ['before', 'before', 'Home before'],
    ['entry120', '120ms', 'Home to Detail 120ms'],
    ['entry300', '300ms', 'Home to Detail 300ms'],
    ['entry750', '750ms', 'Home to Detail 750ms'],
    ['stable', 'stable', 'Detail stable'],
  ];

  if (!TIMING_ONLY) {
    for (const [, suffix, label] of pairs) {
      await combinePair(
        `/tmp/ref-v60-home-detail-${suffix}.png`,
        `/tmp/local-v60-home-detail-${suffix}.png`,
        `/tmp/compare-v60-home-detail-${suffix}.jpg`,
        label,
      );
    }
  }

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const report = {
    screenshots: TIMING_ONLY
      ? []
      : [
          '/tmp/compare-v60-home-detail-before.jpg',
          '/tmp/compare-v60-home-detail-120ms.jpg',
          '/tmp/compare-v60-home-detail-300ms.jpg',
          '/tmp/compare-v60-home-detail-750ms.jpg',
          '/tmp/compare-v60-home-detail-stable.jpg',
        ],
    reference,
    local,
    metrics: metricSummary(reference, local),
    runtimeExceptions,
  };
  fs.writeFileSync('/tmp/capture-v60-home-detail-entry-report.json', JSON.stringify(report, null, 2));
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
