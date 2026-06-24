import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertSourcePort() {
  const source = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const checks = [
    'const planeMode = getPlaneSourceMode();',
    'const planeDetailTarget = planeMode === VIEW.detail || planeMode === VIEW.work ? 1 : 0;',
    'const planeWorkTarget = planeMode === VIEW.work ? 1 : 0;',
    'const t = planeDetailTarget;',
    'const workT = planeWorkTarget;',
    'canvas.dataset.activePlaneDetailTarget',
    'canvas.dataset.activePlaneWorkTarget',
  ];
  const missing = checks.filter((check) => !source.includes(check));
  if (missing.length) {
    throw new Error(`Missing reference target-state port checks: ${missing.join(', ')}`);
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
    const visiblePgn = [...document.querySelectorAll('.pgn')]
      .filter((item) => getComputedStyle(item).opacity !== '0' && item.classList.contains('is-visible'))
      .map((item) => item.textContent.trim().replace(/\\s+/g, ' '));
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      path: location.pathname,
      activePlaneX: number(data.activePlaneX),
      activePlaneTargetX: number(data.activePlaneTargetX),
      detailMix: number(data.activePlaneDetailMix),
      detailTarget: number(data.activePlaneDetailTarget),
      frame: document.querySelector('[data-shadow-frame]')?.textContent?.trim() || '',
      visiblePgn,
      workMix: number(data.activePlaneWorkMix),
      workTarget: number(data.activePlaneWorkTarget),
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
  await waitForMode(client, 'index');
  await sleep(1300);

  const home = await sample(client, 'home-stable');
  await screenshot(client, '/tmp/local-plane-target-snap-v30-home.png');

  await key(client, 'Enter', 'Enter', 13);
  await waitForMode(client, 'detail');
  await sleep(80);
  const detailEarly = await sample(client, 'detail-80ms');
  await screenshot(client, '/tmp/local-plane-target-snap-v30-detail-80ms.png');

  await sleep(1000);
  const detailStable = await sample(client, 'detail-stable');
  await screenshot(client, '/tmp/local-plane-target-snap-v30-detail-stable.png');

  await key(client, 'e', 'KeyE', 69);
  await waitForMode(client, 'work');
  await sleep(80);
  const workEarly = await sample(client, 'work-80ms');
  await screenshot(client, '/tmp/local-plane-target-snap-v30-work-80ms.png');

  await key(client, 'Escape', 'Escape', 27);
  await waitForMode(client, 'detail');
  await sleep(80);
  const detailReturnEarly = await sample(client, 'detail-return-80ms');
  await screenshot(client, '/tmp/local-plane-target-snap-v30-detail-return-80ms.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];

  if (home.mode !== 'index' || home.detailTarget !== 0 || home.workTarget !== 0) {
    failures.push(`Expected stable Home plane targets to be off, got ${JSON.stringify(home)}.`);
  }
  if (detailEarly.mode !== 'detail' || detailEarly.detailTarget !== 1 || detailEarly.workTarget !== 0) {
    failures.push(`Expected early Detail target snap to Detail, got ${JSON.stringify(detailEarly)}.`);
  }
  if ((detailEarly.detailMix ?? 1) >= 0.75) {
    failures.push(`Expected Detail mix to still be chasing at 80ms, got ${detailEarly.detailMix}.`);
  }
  if (!detailStable.visiblePgn.length || detailStable.detailTarget !== 1) {
    failures.push(`Expected stable Detail pgn and Detail target, got ${JSON.stringify(detailStable)}.`);
  }
  if (workEarly.mode !== 'work' || workEarly.detailTarget !== 1 || workEarly.workTarget !== 1) {
    failures.push(`Expected early Work target snap to Work, got ${JSON.stringify(workEarly)}.`);
  }
  if ((workEarly.workMix ?? 1) >= 0.75) {
    failures.push(`Expected Work mix to still be chasing at 80ms, got ${workEarly.workMix}.`);
  }
  if (detailReturnEarly.mode !== 'detail' || detailReturnEarly.workTarget !== 0) {
    failures.push(`Expected early return target to leave Work immediately, got ${JSON.stringify(detailReturnEarly)}.`);
  }
  if ((detailReturnEarly.workMix ?? 0) <= 0.01) {
    failures.push(`Expected Work mix to still be decaying during early return, got ${detailReturnEarly.workMix}.`);
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: [
      '/tmp/local-plane-target-snap-v30-home.png',
      '/tmp/local-plane-target-snap-v30-detail-80ms.png',
      '/tmp/local-plane-target-snap-v30-detail-stable.png',
      '/tmp/local-plane-target-snap-v30-work-80ms.png',
      '/tmp/local-plane-target-snap-v30-detail-return-80ms.png',
    ],
    home,
    detailEarly,
    detailStable,
    workEarly,
    detailReturnEarly,
    runtimeExceptions,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  client.close();
}
