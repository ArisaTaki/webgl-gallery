import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || `http://localhost:5279/?loader_nav_v49=${Date.now()}`;
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertSourcePort() {
  const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const checks = [
    ['loader starts from reference x offset', 'transform: translate3d(-110%, 0, 0);'],
    ['loader exit uses reference 500ms hide', 'animation: digit-exit 500ms cubic-bezier(0.55, 0.055, 0.675, 0.19) both;'],
    ['loader exits horizontally to the right', 'transform: translate3d(110%, 0, 0);'],
    ['loader container no longer fades upward', '.gallery-shell:not(.is-loading) .loader-counter {\n  opacity: 1;\n  transform: none;'],
    ['nav chars use reference-long show duration', 'animation: split-char-in 1600ms cubic-bezier(0.19, 1, 0.22, 1) both;'],
    ['nav chars use reference-like small stagger', 'animation-delay: calc(var(--char-index, 0) * 20ms + 200ms);'],
  ];
  const missing = checks.filter(([, needle]) => !css.includes(needle));
  if (missing.length) {
    throw new Error(`Missing loader/nav source checks: ${missing.map(([label]) => label).join(', ')}`);
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
    const loader = document.querySelector('.loader-counter');
    const loaderDigit = document.querySelector('.loader-counter span span');
    const wordmarkChar = document.querySelector('.wordmark .split-char');
    const aboutChar = document.querySelector('.about-link .split-char');
    const loaderStyle = loader ? getComputedStyle(loader) : null;
    const digitStyle = loaderDigit ? getComputedStyle(loaderDigit) : null;
    const wordmarkStyle = wordmarkChar ? getComputedStyle(wordmarkChar) : null;
    const aboutStyle = aboutChar ? getComputedStyle(aboutChar) : null;
    const matrix = new DOMMatrixReadOnly(digitStyle?.transform === 'none' ? undefined : digitStyle?.transform);
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      loaderOpacity: loaderStyle ? Number(loaderStyle.opacity) : -1,
      loaderTransform: loaderStyle?.transform || '',
      digitAnimationName: digitStyle?.animationName || '',
      digitAnimationDuration: digitStyle?.animationDuration || '',
      digitAnimationDelay: digitStyle?.animationDelay || '',
      digitTransform: digitStyle?.transform || '',
      digitTranslateX: matrix.m41,
      digitTranslateY: matrix.m42,
      wordmarkAnimationName: wordmarkStyle?.animationName || '',
      wordmarkAnimationDuration: wordmarkStyle?.animationDuration || '',
      wordmarkAnimationDelay: wordmarkStyle?.animationDelay || '',
      aboutAnimationDuration: aboutStyle?.animationDuration || '',
      aboutAnimationDelay: aboutStyle?.animationDelay || '',
    };
  })()`);
}

assertSourcePort();

const client = createCdpClient(await getPageWebSocket());
try {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
  await client.send('Page.navigate', { url: TARGET_URL });

  await sleep(120);
  const early = await sample(client, 'early-loading');
  await screenshot(client, '/tmp/local-loader-nav-v49-loading.png');

  await waitForMode(client, 'index');
  await sleep(720);
  const stable = await sample(client, 'index-after-loader-exit');
  await screenshot(client, '/tmp/local-loader-nav-v49-index.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];

  if (early.digitTranslateY !== 0) {
    failures.push(`Expected loading digit to move on X only, got ${JSON.stringify(early)}.`);
  }
  if (stable.mode !== 'index') {
    failures.push(`Expected final mode index, got ${JSON.stringify(stable)}.`);
  }
  if (stable.loaderOpacity !== 1 || stable.loaderTransform !== 'none') {
    failures.push(`Expected loader container to remain non-fading/non-translated like reference #load, got ${JSON.stringify(stable)}.`);
  }
  if (stable.digitAnimationName !== 'digit-exit' || stable.digitAnimationDuration !== '0.5s') {
    failures.push(`Expected loader digits to use 500ms digit-exit, got ${JSON.stringify(stable)}.`);
  }
  if (stable.digitTranslateX <= 0 || Math.abs(stable.digitTranslateY) > 0.01) {
    failures.push(`Expected loader digit to exit horizontally right with no Y motion, got ${JSON.stringify(stable)}.`);
  }
  if (stable.wordmarkAnimationDuration !== '1.6s' || stable.aboutAnimationDuration !== '1.6s') {
    failures.push(`Expected nav characters to use 1600ms intro, got ${JSON.stringify(stable)}.`);
  }
  if (runtimeExceptions.length) {
    failures.push(`Runtime exceptions were thrown: ${JSON.stringify(runtimeExceptions.slice(0, 2))}`);
  }
  if (failures.length) {
    throw new Error(failures.join('\n'));
  }

  console.log(JSON.stringify({
    ok: true,
    screenshots: [
      '/tmp/local-loader-nav-v49-loading.png',
      '/tmp/local-loader-nav-v49-index.png',
    ],
    early,
    stable,
  }, null, 2));
} finally {
  client.close();
}
