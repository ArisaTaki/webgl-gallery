import fs from 'node:fs';
import sharp from 'sharp';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const REF_URL = process.env.REF_URL || 'https://aristidebenoist.com/';
const LOCAL_URL = process.env.LOCAL_URL || 'http://localhost:5279/';
const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertSourcePort() {
  const main = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const checks = [
    ['mobile fallback markup', 'class="mobile-fallback"'],
    ['desktop prompt', 'VISIT ON A DESKTOP FOR A FULL GALLERY'],
    ['studio link', 'href="/studio"'],
    ['mobile fallback CSS', '.gallery-shell:not(.is-studio) .mobile-fallback'],
    ['studio exemption', '.gallery-shell:not(.is-studio) > :not(.mobile-fallback)'],
  ];
  const missing = checks.filter(([, needle]) => !(main.includes(needle) || css.includes(needle)));
  if (missing.length) {
    throw new Error(`Missing mobile reference fallback source checks: ${missing.map(([label]) => label).join(', ')}`);
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

async function waitFor(client, expression, label, timeout = 18000) {
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

async function compare(leftPath, rightPath, outPath) {
  const left = await sharp(leftPath).metadata();
  const right = await sharp(rightPath).metadata();
  const width = Math.max(left.width || 0, right.width || 0);
  const height = Math.max(left.height || 0, right.height || 0);
  await sharp({
    create: {
      width: width * 2,
      height,
      channels: 3,
      background: '#111110',
    },
  })
    .composite([
      { input: leftPath, left: 0, top: 0 },
      { input: rightPath, left: width, top: 0 },
    ])
    .jpeg({ quality: 88 })
    .toFile(outPath);
}

async function sample(client, label, isReference) {
  return evaluate(client, `(() => {
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        top: Number(r.top.toFixed(2)),
        left: Number(r.left.toFixed(2)),
        width: Number(r.width.toFixed(2)),
        height: Number(r.height.toFixed(2)),
        bottom: Number(r.bottom.toFixed(2)),
        right: Number(r.right.toFixed(2)),
      };
    };
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && r.width > 0 && r.height > 0;
    };
    const shell = document.querySelector('.gallery-shell');
    const fallback = document.querySelector('.mobile-fallback');
    const studio = document.querySelector('.studio-panel');
    const title = document.querySelector(${JSON.stringify(isReference ? '.t' : '.mobile-fallback h1')}) ||
      document.querySelector('.project-shadow-title-active');
    const canvases = [...document.querySelectorAll('canvas')];
    return {
      label: ${JSON.stringify(label)},
      href: location.href,
      inner: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      refMode: window._A?.mode || '',
      localMode: shell?.dataset.mode || '',
      canvasCount: canvases.length,
      visibleCanvasCount: canvases.filter(visible).length,
      title: rect(title),
      titleText: title?.textContent?.trim().replace(/\\s+/g, ' ') || '',
      fallbackVisible: visible(fallback),
      fallbackText: fallback?.textContent?.trim().replace(/\\s+/g, ' ') || '',
      studioVisible: visible(studio),
      bodyText: (document.body.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 220),
    };
  })()`);
}

async function collectReference(client) {
  await client.send('Page.navigate', { url: REF_URL });
  await waitFor(client, 'document.readyState === "complete"', 'reference mobile ready');
  await sleep(2200);
  const home = await sample(client, 'reference-mobile-home', true);
  await screenshot(client, '/tmp/ref-v66-mobile-home.png');
  await key(client, 'Enter', 'Enter', 13);
  await sleep(1500);
  if (!(await evaluate(client, 'window._A && _A.mode === "in"'))) {
    await click(client, 195, 422);
    await sleep(1200);
  }
  const afterEnter = await sample(client, 'reference-mobile-after-enter', true);
  await screenshot(client, '/tmp/ref-v66-mobile-after-enter.png');
  return { home, afterEnter };
}

async function collectLocal(client) {
  await client.send('Page.navigate', { url: LOCAL_URL });
  await waitFor(client, 'document.querySelector(".gallery-shell")?.dataset.mode === "index"', 'local mobile home');
  await sleep(1200);
  const home = await sample(client, 'local-mobile-home', false);
  await screenshot(client, '/tmp/local-v66-mobile-home.png');

  await key(client, 'Enter', 'Enter', 13);
  await waitFor(client, 'document.querySelector(".gallery-shell")?.dataset.mode === "detail"', 'local mobile detail');
  await sleep(1200);
  const detail = await sample(client, 'local-mobile-detail', false);
  await screenshot(client, '/tmp/local-v66-mobile-detail.png');

  await client.send('Page.navigate', { url: new URL('/studio', LOCAL_URL).href });
  await waitFor(client, 'document.querySelector(".gallery-shell")?.dataset.mode === "studio"', 'local mobile studio');
  await sleep(500);
  const studio = await sample(client, 'local-mobile-studio', false);
  await screenshot(client, '/tmp/local-v66-mobile-studio.png');
  return { home, detail, studio };
}

assertSourcePort();

const client = createCdpClient(await getPageWebSocket());
try {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
  await client.send('Emulation.setUserAgentOverride', { userAgent: MOBILE_UA });

  const reference = await collectReference(client);
  const local = await collectLocal(client);

  await compare('/tmp/ref-v66-mobile-home.png', '/tmp/local-v66-mobile-home.png', '/tmp/compare-v66-mobile-home.jpg');
  await compare(
    '/tmp/ref-v66-mobile-after-enter.png',
    '/tmp/local-v66-mobile-detail.png',
    '/tmp/compare-v66-mobile-detail.jpg',
  );

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];

  if (!reference.home.bodyText.includes('VISIT ON A DESKTOP')) {
    failures.push(`Expected reference mobile fallback copy, got ${reference.home.bodyText}.`);
  }
  if (reference.home.canvasCount !== 0 || reference.afterEnter.canvasCount !== 0) {
    failures.push(`Expected reference mobile to expose no WebGL canvases, got ${JSON.stringify(reference)}.`);
  }
  if (!local.home.fallbackVisible || !local.home.fallbackText.includes('VISIT ON A DESKTOP')) {
    failures.push(`Expected local mobile fallback on Home, got ${JSON.stringify(local.home)}.`);
  }
  if (local.home.visibleCanvasCount !== 0 || local.detail.visibleCanvasCount !== 0) {
    failures.push(`Expected local mobile gallery canvases hidden, got ${JSON.stringify({ home: local.home, detail: local.detail })}.`);
  }
  if (!local.detail.fallbackVisible) {
    failures.push(`Expected local mobile fallback to remain visible on Detail, got ${JSON.stringify(local.detail)}.`);
  }
  if (local.studio.fallbackVisible || !local.studio.studioVisible) {
    failures.push(`Expected /studio to bypass mobile fallback, got ${JSON.stringify(local.studio)}.`);
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    viewport: VIEWPORT,
    screenshots: [
      '/tmp/compare-v66-mobile-home.jpg',
      '/tmp/compare-v66-mobile-detail.jpg',
      '/tmp/local-v66-mobile-studio.png',
    ],
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
