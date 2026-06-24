import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/nian-nian-001';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertSourcePort() {
  const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const checks = [
    ['live-reference Work switch reveal delay', 'const WORK_SWITCH_REVEAL_DELAY = 220;'],
    ['Work switch layer start lerp', 'const WORK_SWITCH_LAYER_LERP = 0.077;'],
    ['Work switch frame start lerp', 'const WORK_SWITCH_FRAME_LERP = 0.13;'],
    ['decode-gated Work layer reveal', 'motion.revealAt = performance.now() + delay;'],
    ['per-layer Work background opacity', '--work-layer-bg-opacity'],
    ['switch uses Work reveal delay', 'requestWorkLayerImageLoad(index, motion, WORK_SWITCH_REVEAL_DELAY);'],
    ['reference-like Work entry delay', 'const WORK_ENTRY_REVEAL_DELAY = 100;'],
  ];
  const cssChecks = [
    ['reference-like Work layer bg fade', 'transition: opacity 100ms linear 1000ms;'],
    ['reference-like Work image opacity transition', 'transition: opacity var(--work-layer-fade-duration, 1000ms) cubic-bezier(0.39, 0.575, 0.565, 1);'],
  ];
  const missing = [
    ...checks.filter(([, needle]) => !main.includes(needle)),
    ...cssChecks.filter(([, needle]) => !css.includes(needle)),
  ];
  if (missing.length) {
    throw new Error(`Missing Work layer fx source checks: ${missing.map(([label]) => label).join(', ')}`);
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
    const switchStartedAt = Number(window.__workSwitchStartedAt || 0);
    const shell = document.querySelector('.gallery-shell');
    const active = document.querySelector('.work-layer.is-active');
    const exiting = document.querySelector('.work-layer.is-exiting');
    const activeImg = active?.querySelector('.work-layer-img');
    const activeBg = active?.querySelector('.work-layer-bg');
    const exitingImg = exiting?.querySelector('.work-layer-img');
    const exitingBg = exiting?.querySelector('.work-layer-bg');
    const layerInfo = (layer, img, bg) => ({
      tag: layer?.tagName || '',
      index: layer ? Number(layer.dataset.workIndex) : -1,
      y: parseFloat(layer?.style.getPropertyValue('--work-layer-y') || '0'),
      styleImageOpacity: parseFloat(layer?.style.getPropertyValue('--work-layer-opacity') || '0'),
      styleBgOpacity: parseFloat(layer?.style.getPropertyValue('--work-layer-bg-opacity') || '1'),
      wrapperOpacity: layer ? getComputedStyle(layer).opacity : '',
      wrapperTransform: layer ? getComputedStyle(layer).transform : '',
      imgTag: img?.tagName || '',
      imgOpacity: img ? getComputedStyle(img).opacity : '',
      computedImageOpacity: img ? Number(getComputedStyle(img).opacity) : -1,
      imageTransitionDuration: img ? getComputedStyle(img).transitionDuration : '',
      bgOpacity: bg ? getComputedStyle(bg).opacity : '',
    });
    return {
      label: ${JSON.stringify(label)},
      sampleMs: switchStartedAt ? Number((performance.now() - switchStartedAt).toFixed(2)) : null,
      mode: shell?.dataset.mode || '',
      shellClass: shell?.className || '',
      active: layerInfo(active, activeImg, activeBg),
      exiting: layerInfo(exiting, exitingImg, exitingBg),
    };
  })()`);
}

assertSourcePort();

const client = createCdpClient(await getPageWebSocket());
try {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Network.enable');
  await client.send('Network.setCacheDisabled', { cacheDisabled: true });
  await client.send('Page.bringToFront');
  await client.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
  await client.send('Page.navigate', { url: TARGET_URL });
  await waitForMode(client, 'detail');
  await sleep(700);

  await key(client, 'e', 'KeyE', 69);
  await waitForMode(client, 'work');
  await sleep(1400);
  const before = await sample(client, 'work-stable-index-0');

  await key(client, 'ArrowRight', 'ArrowRight', 39);
  const switchStartedAt = await evaluate(client, 'performance.now()');
  await evaluate(client, `window.__workSwitchStartedAt = ${Number(switchStartedAt)}`);
  await waitUntilPageElapsed(client, switchStartedAt, 120);
  const switch120 = await sample(client, 'switch-120ms');
  await screenshot(client, '/tmp/local-work-layer-fx-v19-120ms.png');

  await waitUntilPageElapsed(client, switchStartedAt, 300);
  const switch300 = await sample(client, 'switch-300ms');
  await screenshot(client, '/tmp/local-work-layer-fx-v19-300ms.png');

  await waitUntilPageElapsed(client, switchStartedAt, 1600);
  const stable = await sample(client, 'work-stable-index-2');
  await screenshot(client, '/tmp/local-work-layer-fx-v19-stable.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];

  if (before.mode !== 'work' || before.active.index !== 0) {
    failures.push(`Expected stable Work index 0 before switch, got ${JSON.stringify(before)}.`);
  }
  if (switch120.active.tag !== 'DIV' || switch120.active.imgTag !== 'IMG') {
    failures.push(`Expected active Work layer wrapper DIV with child IMG, got ${JSON.stringify(switch120.active)}.`);
  }
  if (Number(switch120.active.wrapperOpacity) < 0.99 || Number(switch300.active.wrapperOpacity) < 0.99) {
    failures.push(`Expected wrapper opacity to remain 1 during image fx, got ${JSON.stringify({ switch120, switch300 })}.`);
  }
  if (switch120.active.computedImageOpacity < 0 || switch120.active.computedImageOpacity > 0.14) {
    failures.push(`Expected active image computed opacity still near reference early fade at 120ms, got ${JSON.stringify(switch120.active)}.`);
  }
  if (switch300.active.computedImageOpacity < 0.03 || switch300.active.computedImageOpacity > 0.16) {
    failures.push(`Expected active image to be in the true-300ms live-reference fade band, got ${JSON.stringify({ switch120: switch120.active, switch300: switch300.active })}.`);
  }
  if (Number(switch120.active.bgOpacity) < 0.9 || Number(switch300.active.bgOpacity) < 0.9) {
    failures.push(`Expected active moving layer background to be visible during early image fx, got ${JSON.stringify({ switch120, switch300 })}.`);
  }
  if (switch120.exiting.index === 0 && Number(switch120.exiting.bgOpacity) > 0.2) {
    failures.push(`Expected already-loaded exiting layer background to stay faded like reference .w-l-bg.fx, got ${JSON.stringify(switch120.exiting)}.`);
  }
  if (switch300.exiting.index === 0 && Number(switch300.exiting.bgOpacity) > 0.2) {
    failures.push(`Expected already-loaded exiting layer background to stay faded during switch, got ${JSON.stringify(switch300.exiting)}.`);
  }
  if (switch300.exiting.index !== 0 || Number(switch300.exiting.wrapperOpacity) < 0.99) {
    failures.push(`Expected exiting wrapper to remain visible while translating out, got ${JSON.stringify(switch300.exiting)}.`);
  }
  if (stable.active.index !== 2 || stable.active.styleImageOpacity < 0.98 || stable.active.computedImageOpacity < 0.95) {
    failures.push(`Expected stable Work index 2 image to be near the live-reference full opacity, got ${JSON.stringify(stable.active)}.`);
  }
  if (Number(stable.active.bgOpacity) > 0.05) {
    failures.push(`Expected stable active moving layer background to fade out, got ${stable.active.bgOpacity}.`);
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: [
      '/tmp/local-work-layer-fx-v19-120ms.png',
      '/tmp/local-work-layer-fx-v19-300ms.png',
      '/tmp/local-work-layer-fx-v19-stable.png',
    ],
    before,
    switch120,
    switch300,
    stable,
    runtimeExceptions,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  client.close();
}
