import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/webgl-gallery-001';
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
    const stage = document.querySelector('.work-stage');
    const active = document.querySelector('.work-layer.is-active');
    const activeImg = active?.querySelector('.work-layer-img');
    const before = getComputedStyle(shell, '::before');
    return {
      label: ${JSON.stringify(label)},
      sampleMs: switchStartedAt ? Number((performance.now() - switchStartedAt).toFixed(2)) : null,
      mode: shell?.dataset.mode || '',
      activeIndex: active ? Number(active.dataset.workIndex) : -1,
      activeY: parseFloat(active?.style.getPropertyValue('--work-layer-y') || '0'),
      imageOpacity: parseFloat(active?.style.getPropertyValue('--work-layer-opacity') || '0'),
      computedImageOpacity: activeImg ? Number(getComputedStyle(activeImg).opacity) : -1,
      stageOpacity: stage ? Number(getComputedStyle(stage).opacity) : -1,
      stageTransform: stage ? getComputedStyle(stage).transform : '',
      stageTransitionDuration: stage ? getComputedStyle(stage).transitionDuration : '',
      stageTransition: stage ? getComputedStyle(stage).transitionProperty : '',
      shellBeforeContent: before.content,
    };
  })()`);
}

const client = createCdpClient(await getPageWebSocket());
try {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
  await client.send('Page.navigate', { url: TARGET_URL });
  await waitForMode(client, 'detail');
  await sleep(700);

  await key(client, 'e', 'KeyE', 69);
  await waitForMode(client, 'work');
  await sleep(1400);
  const stable0 = await sample(client, 'stable-index-0');

  await key(client, 'ArrowRight', 'ArrowRight', 39);
  const firstSwitchStartedAt = await evaluate(client, 'performance.now()');
  await evaluate(client, `window.__workSwitchStartedAt = ${Number(firstSwitchStartedAt)}`);
  await waitUntilPageElapsed(client, firstSwitchStartedAt, 120);
  const firstSwitch120 = await sample(client, 'first-switch-index-2-120ms');
  await screenshot(client, '/tmp/local-work-loaded-return-v22-first-switch.png');

  await sleep(1300);
  const stable1 = await sample(client, 'stable-index-2');

  await key(client, 'ArrowLeft', 'ArrowLeft', 37);
  const returnSwitchStartedAt = await evaluate(client, 'performance.now()');
  await evaluate(client, `window.__workSwitchStartedAt = ${Number(returnSwitchStartedAt)}`);
  await waitUntilPageElapsed(client, returnSwitchStartedAt, 120);
  const return120 = await sample(client, 'return-index-0-120ms');
  await screenshot(client, '/tmp/local-work-loaded-return-v22-return.png');

  await sleep(1300);
  const returnStable = await sample(client, 'return-index-0-stable');
  await screenshot(client, '/tmp/local-work-loaded-return-v22-stable.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];

  if (stable0.activeIndex !== 0 || stable0.imageOpacity < 0.98 || stable0.computedImageOpacity < 0.98) {
    failures.push(`Expected initial Work index 0 image to be visible, got ${JSON.stringify(stable0)}.`);
  }
  if (
    firstSwitch120.activeIndex !== 2 ||
    firstSwitch120.computedImageOpacity < 0 ||
    firstSwitch120.computedImageOpacity > 0.14
  ) {
    failures.push(`Expected first visit to index 2 to stay near reference early fade at 120ms, got ${JSON.stringify(firstSwitch120)}.`);
  }
  if (stable1.activeIndex !== 2 || stable1.imageOpacity < 0.98 || stable1.computedImageOpacity < 0.5) {
    failures.push(`Expected Work index 2 to reach the live-reference late fade band, got ${JSON.stringify(stable1)}.`);
  }
  if (return120.activeIndex !== 0 || return120.imageOpacity < 0.98 || return120.computedImageOpacity < 0.98) {
    failures.push(`Expected return to already-visible index 0 to skip image fade, got ${JSON.stringify(return120)}.`);
  }
  if (returnStable.activeIndex !== 0 || returnStable.imageOpacity < 0.98 || returnStable.computedImageOpacity < 0.98) {
    failures.push(`Expected returned index 0 to remain visible, got ${JSON.stringify(returnStable)}.`);
  }
  if (stable0.stageOpacity !== 1 || !stable0.stageTransform.includes('matrix')) {
    failures.push(`Expected Work stage to stay as a static centered container, got ${JSON.stringify(stable0)}.`);
  }
  if (stable0.stageTransitionDuration !== '0s') {
    failures.push(`Expected no Work stage transition duration, got ${stable0.stageTransitionDuration}.`);
  }
  if (stable0.shellBeforeContent !== 'none') {
    failures.push(`Expected no non-reference shell ::before overlay, got ${stable0.shellBeforeContent}.`);
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: [
      '/tmp/local-work-loaded-return-v22-first-switch.png',
      '/tmp/local-work-loaded-return-v22-return.png',
      '/tmp/local-work-loaded-return-v22-stable.png',
    ],
    stable0,
    firstSwitch120,
    stable1,
    return120,
    returnStable,
    runtimeExceptions,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  client.close();
}
