import fs from 'node:fs';
import sharp from 'sharp';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const REF_URL = process.env.REF_URL || 'https://aristidebenoist.com/';
const LOCAL_URL = process.env.LOCAL_URL || 'http://localhost:5279/';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  await waitFor(client, 'document.readyState === "complete"', `document ready at ${url}`, 18000);
}

async function collectReference(client) {
  await navigate(client, REF_URL);
  await waitFor(
    client,
    'window._A && _A.engine && _A.mode === "out" && typeof _A.li?.run === "function" && _A.h?.pCurr?.length && document.querySelector("#n0") && document.querySelectorAll("canvas").length >= 2',
    'reference app ready',
    60000,
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
    4,
    'window._A && _A.h && typeof _A.li?.run === "function" && _A.mode !== "in" && _A.h.modeIn(0)',
  );
  await sleep(1500);

  const before = await sampleReference(client, 'reference-detail-switch-before');
  await screenshot(client, '/tmp/ref-v54-detail-switch-before.png');

  await key(client, 'ArrowRight', 'ArrowRight', 39);
  await sleep(120);
  const switch120 = await sampleReference(client, 'reference-detail-switch-120ms', before.index);
  await screenshot(client, '/tmp/ref-v54-detail-switch-120ms.png');
  await sleep(530);
  const switch650 = await sampleReference(client, 'reference-detail-switch-650ms', before.index);
  await screenshot(client, '/tmp/ref-v54-detail-switch-650ms.png');
  await sleep(1250);
  const stable = await sampleReference(client, 'reference-detail-switch-stable', before.index);
  await screenshot(client, '/tmp/ref-v54-detail-switch-stable.png');

  return { before, switch120, switch650, stable };
}

async function collectLocal(client) {
  await navigate(client, LOCAL_URL);
  await waitFor(
    client,
    'document.querySelector(".gallery-shell")?.dataset.mode === "index"',
    'local Home mode',
    14000,
  );
  await sleep(900);
  await pressOrClickUntil(
    client,
    'Enter',
    'Enter',
    13,
    'document.querySelector(".gallery-shell")?.dataset.mode === "detail"',
    'local Detail mode',
    [{ x: 720, y: 450 }],
  );
  await sleep(1500);

  const before = await sampleLocal(client, 'local-detail-switch-before');
  await screenshot(client, '/tmp/local-v54-detail-switch-before.png');

  await key(client, 'ArrowRight', 'ArrowRight', 39);
  await sleep(120);
  const switch120 = await sampleLocal(client, 'local-detail-switch-120ms', before.activeIndex);
  await screenshot(client, '/tmp/local-v54-detail-switch-120ms.png');
  await sleep(530);
  const switch650 = await sampleLocal(client, 'local-detail-switch-650ms', before.activeIndex);
  await screenshot(client, '/tmp/local-v54-detail-switch-650ms.png');
  await sleep(1250);
  const stable = await sampleLocal(client, 'local-detail-switch-stable', before.activeIndex);
  await screenshot(client, '/tmp/local-v54-detail-switch-stable.png');

  return { before, switch120, switch650, stable };
}

async function sampleReference(client, label, previousIndex = -1) {
  return evaluate(client, `(() => {
    const previousIndex = ${Number(previousIndex)};
    const index = window._A?.index ?? -1;
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
    const css = (el) => {
      const s = style(el);
      return s ? {
        animationDelay: s.animationDelay,
        animationDuration: s.animationDuration,
        animationName: s.animationName,
        color: s.color,
        fontFamily: s.fontFamily,
        fontSize: s.fontSize,
        fontWeight: s.fontWeight,
        lineHeight: s.lineHeight,
        opacity: s.opacity,
        transform: s.transform,
      } : null;
    };
    const titleLinesFor = (projectIndex) => [...document.querySelectorAll('.t' + projectIndex)].map((line, lineIndex) => ({
      lineIndex,
      text: line.textContent.trim().replace(/\\s+/g, ' '),
      rect: rect(line),
      style: css(line),
      chars: [...line.children].map((char, charIndex) => ({
        charIndex,
        text: char.textContent.trim(),
        rect: rect(char),
        style: css(char),
      })),
    }));
    const info = (selector, projectIndex) => {
      const el = document.querySelectorAll(selector)[projectIndex];
      return {
        rect: rect(el),
        text: el?.textContent.trim().replace(/\\s+/g, ' ') || '',
        style: css(el),
        childStyles: [...(el?.children || [])].map((child) => ({
          text: child.textContent.trim().replace(/\\s+/g, ' '),
          rect: rect(child),
          style: css(child),
        })),
      };
    };
    const planeFor = (projectIndex) => {
      const current = window._A?.h?.pCurr?.[projectIndex] || null;
      const target = window._A?.h?.pTarg?.[projectIndex] || null;
      const scrollX = window._A?.h?.x?.curr || 0;
      const normalize = (plane) => plane
        ? Object.fromEntries(Object.entries(plane).map(([key, value]) => [key, Number.isFinite(value) ? Number(value.toFixed(2)) : value]))
        : null;
      const screenRect = (plane) => plane ? {
        bottom: Number((plane.y + plane.h).toFixed(2)),
        height: Number(plane.h.toFixed(2)),
        left: Number((plane.x - scrollX).toFixed(2)),
        right: Number((plane.x - scrollX + plane.w).toFixed(2)),
        top: Number(plane.y.toFixed(2)),
        width: Number(plane.w.toFixed(2)),
        x: Number((plane.x - scrollX).toFixed(2)),
        y: Number(plane.y.toFixed(2)),
        w: Number(plane.w.toFixed(2)),
        h: Number(plane.h.toFixed(2)),
      } : null;
      return current ? {
        current: normalize(current),
        currentScreen: screenRect(current),
        target: normalize(target),
        targetScreen: screenRect(target),
      } : null;
    };
    const pgn = document.querySelectorAll('.pgn')[index];
    const explore = document.querySelectorAll('.e')[index];
    return {
      label: ${JSON.stringify(label)},
      mode: window._A?.mode || '',
      modePrev: window._A?.modePrev || '',
      index,
      indexPrev: window._A?.indexPrev ?? -1,
      previousIndex,
      x: Number.isFinite(window._A?.x) ? Number(window._A.x.toFixed(4)) : null,
      scroll: {
        curr: Number.isFinite(window._A?.h?.x?.curr) ? Number(window._A.h.x.curr.toFixed(2)) : null,
        targ: Number.isFinite(window._A?.h?.x?.targ) ? Number(window._A.h.x.targ.toFixed(2)) : null,
        max: Number.isFinite(window._A?.h?.max) ? Number(window._A.h.max.toFixed(2)) : null,
        gapXW: Number.isFinite(window._A?.h?.gapXW) ? Number(window._A.h.gapXW.toFixed(2)) : null,
      },
      latencyX: Number.isFinite(window._A?.latency?.x) ? Number(window._A.latency.x.toFixed(4)) : null,
      path: location.pathname,
      project: { rect: rect(document.querySelector('#p')), style: css(document.querySelector('#p')) },
      visit: { rect: rect(document.querySelector('#v')), style: css(document.querySelector('#v')) },
      explore: { rect: rect(explore), style: css(explore), text: explore?.textContent.trim().replace(/\\s+/g, ' ') || '' },
      pagination: { rect: rect(pgn), text: pgn?.textContent.trim().replace(/\\s+/g, ' ') || '', style: css(pgn) },
      title: {
        active: titleLinesFor(index),
        previous: previousIndex >= 0 ? titleLinesFor(previousIndex) : [],
      },
      info: {
        activeLeft: info('.i-l', index),
        activeRight: info('.i-r', index),
        previousLeft: previousIndex >= 0 ? info('.i-l', previousIndex) : null,
        previousRight: previousIndex >= 0 ? info('.i-r', previousIndex) : null,
      },
      planes: {
        active: planeFor(index),
        previous: previousIndex >= 0 ? planeFor(previousIndex) : null,
      },
    };
  })()`);
}

async function sampleLocal(client, label, previousIndex = -1) {
  return evaluate(client, `(() => {
    const previousIndex = ${Number(previousIndex)};
    const shell = document.querySelector('.gallery-shell');
    const activeIndex = Number(document.querySelector('[data-current]')?.textContent || 0) - 1;
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
    const number = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const planeRect = (prefix) => {
      const bottom = number(data[prefix + 'BottomPx']);
      const height = number(data[prefix + 'HeightPx']);
      const left = number(data[prefix + 'LeftPx']);
      const right = number(data[prefix + 'RightPx']);
      const top = number(data[prefix + 'TopPx']);
      const width = number(data[prefix + 'WidthPx']);
      if ([bottom, height, left, right, top, width].some((value) => value === null)) return null;
      return { bottom, height, left, right, top, width, x: left, y: top, w: width, h: height };
    };
    const css = (el) => {
      const s = style(el);
      return s ? {
        animationDelay: s.animationDelay,
        animationDuration: s.animationDuration,
        animationName: s.animationName,
        color: s.color,
        fontFamily: s.fontFamily,
        fontSize: s.fontSize,
        fontWeight: s.fontWeight,
        lineHeight: s.lineHeight,
        opacity: s.opacity,
        transform: s.transform,
      } : null;
    };
    const titleLinesFor = (root) => [...(root?.querySelectorAll('.title-line') || [])].map((line, lineIndex) => ({
      lineIndex,
      text: line.textContent.trim().replace(/\\s+/g, ' '),
      rect: rect(line),
      style: css(line),
      chars: [...line.querySelectorAll('.title-char')].map((char, charIndex) => ({
        charIndex,
        text: char.textContent.trim(),
        rect: rect(char),
        style: css(char),
      })),
    }));
    const block = (el) => ({
      rect: rect(el),
      text: el?.textContent.trim().replace(/\\s+/g, ' ') || '',
      style: css(el),
      childStyles: [...(el?.children || [])].map((child) => ({
        text: child.textContent.trim().replace(/\\s+/g, ' '),
        rect: rect(child),
        style: css(child),
      })),
    });
    const canvas = document.querySelector('#webgl');
    const data = canvas?.dataset || {};
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      shellClass: shell?.className || '',
      activeIndex,
      previousIndex,
      path: location.pathname,
      currentText: document.querySelector('[data-current]')?.textContent || '',
      totalText: document.querySelector('[data-total]')?.textContent || '',
      project: { rect: rect(document.querySelector('.project-pagination')), style: css(document.querySelector('.project-pagination')) },
      visit: { rect: rect(document.querySelector('.visit-link')), style: css(document.querySelector('.visit-link')) },
      explore: {
        rect: rect(document.querySelector('.visit-link')),
        style: css(document.querySelector('.visit-link')),
        text: document.querySelector('.visit-link')?.textContent.trim().replace(/\\s+/g, ' ') || '',
      },
      pagination: {
        rect: rect(document.querySelector('.project-pagination')),
        text: document.querySelector('.project-pagination')?.textContent.trim().replace(/\\s+/g, ' ') || '',
        style: css(document.querySelector('.project-pagination')),
      },
      title: {
        active: titleLinesFor(document.querySelector('.project-shadow-title-active')),
        previous: titleLinesFor(document.querySelector('.project-shadow-title-prev')),
      },
      info: {
        activeMeta: block(document.querySelector('.project-shadow-meta:not(.project-shadow-meta-prev)')),
        activeCopy: block(document.querySelector('.project-shadow-copy:not(.project-shadow-copy-prev)')),
        previousMeta: block(document.querySelector('.project-shadow-meta-prev')),
        previousCopy: block(document.querySelector('.project-shadow-copy-prev')),
      },
      planes: {
        active: {
          current: planeRect('activePlane'),
          target: planeRect('activePlaneTarget'),
          debug: {
            x: number(data.activePlaneX),
            targetX: number(data.activePlaneTargetX),
            detailScrollOffsetPx: number(data.detailScrollOffsetPx),
          },
        },
        previous: {
          current: planeRect('exitingPlane'),
          target: planeRect('exitingPlaneTarget'),
          debug: {
            x: number(data.exitingPlaneX),
            targetX: number(data.exitingPlaneTargetX),
          },
        },
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

function metricSummary(reference, local) {
  const summarizeReference = (state) => ({
    index: state.index,
    project: rectSummary(state.project?.rect),
    explore: rectSummary(state.explore?.rect),
    title: rectSummary(state.title?.active?.[0]?.rect),
    titleChars: state.title?.active?.[0]?.chars?.map((char) => rectSummary(char.rect)) || [],
    infoLeft: rectSummary(state.info?.activeLeft?.rect),
    infoRight: rectSummary(state.info?.activeRight?.rect),
    planeMetricType: 'reference-screen-current-target-after-scroll-subtract',
    plane: state.planes?.active || null,
  });
  const summarizeLocal = (state) => ({
    index: state.activeIndex,
    project: rectSummary(state.project?.rect),
    explore: rectSummary(state.explore?.rect),
    title: rectSummary(state.title?.active?.[0]?.rect),
    titleChars: state.title?.active?.[0]?.chars?.map((char) => rectSummary(char.rect)) || [],
    infoLeft: rectSummary(state.info?.activeMeta?.rect),
    infoRight: rectSummary(state.info?.activeCopy?.rect),
    planeMetricType: 'local-screen-px-dataset',
    plane: state.planes?.active || null,
  });
  const states = ['before', 'switch120', 'switch650', 'stable'];
  return states.reduce((summary, key) => {
    summary[key] = {
      reference: summarizeReference(reference[key]),
      local: summarizeLocal(local[key]),
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

  await combinePair(
    '/tmp/ref-v54-detail-switch-before.png',
    '/tmp/local-v54-detail-switch-before.png',
    '/tmp/compare-v54-detail-switch-before.jpg',
    'Detail switch before',
  );
  await combinePair(
    '/tmp/ref-v54-detail-switch-120ms.png',
    '/tmp/local-v54-detail-switch-120ms.png',
    '/tmp/compare-v54-detail-switch-120ms.jpg',
    'Detail switch 120ms',
  );
  await combinePair(
    '/tmp/ref-v54-detail-switch-650ms.png',
    '/tmp/local-v54-detail-switch-650ms.png',
    '/tmp/compare-v54-detail-switch-650ms.jpg',
    'Detail switch 650ms',
  );
  await combinePair(
    '/tmp/ref-v54-detail-switch-stable.png',
    '/tmp/local-v54-detail-switch-stable.png',
    '/tmp/compare-v54-detail-switch-stable.jpg',
    'Detail switch stable',
  );

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const report = {
    screenshots: [
      '/tmp/ref-v54-detail-switch-before.png',
      '/tmp/local-v54-detail-switch-before.png',
      '/tmp/compare-v54-detail-switch-before.jpg',
      '/tmp/ref-v54-detail-switch-120ms.png',
      '/tmp/local-v54-detail-switch-120ms.png',
      '/tmp/compare-v54-detail-switch-120ms.jpg',
      '/tmp/ref-v54-detail-switch-650ms.png',
      '/tmp/local-v54-detail-switch-650ms.png',
      '/tmp/compare-v54-detail-switch-650ms.jpg',
      '/tmp/ref-v54-detail-switch-stable.png',
      '/tmp/local-v54-detail-switch-stable.png',
      '/tmp/compare-v54-detail-switch-stable.jpg',
    ],
    reference,
    local,
    metrics: metricSummary(reference, local),
    runtimeExceptions,
  };
  fs.writeFileSync('/tmp/capture-v54-detail-switch-report.json', JSON.stringify(report, null, 2));
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
