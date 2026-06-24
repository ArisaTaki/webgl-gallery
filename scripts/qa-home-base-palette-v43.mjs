import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
const BASE_SURFACE = '20, 20, 20';
const BASE_TEXT = '186, 196, 184';
const BASE_WORK = '214, 216, 210';
const REFERENCE_SECOND_TEXT = '30, 30, 30';
const REFERENCE_SECOND_WORK = '168, 168, 168';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertSourcePort() {
  const source = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const checks = [
    'const BASE_SURFACE_RGB = [20, 20, 20];',
    'const BASE_TEXT_RGB = [186, 196, 184];',
    'const BASE_WORK_RGB = [214, 216, 210];',
    'const REFERENCE_PROJECT_COLORS = [',
    '{ bg: [190, 190, 190], text: [30, 30, 30], work: [168, 168, 168] }',
    'const usesProjectPalette = state.mode === VIEW.detail || state.mode === VIEW.work;',
    'state.surfaceRgbTarget = (usesProjectPalette ? palette.surface : BASE_SURFACE_RGB).slice();',
    'state.textRgbTarget = (usesProjectPalette ? palette.text : BASE_TEXT_RGB).slice();',
    'state.textRgb = state.textRgbTarget.slice();',
    "galleryEls.shell.dataset.paletteMode = usesProjectPalette ? state.mode : 'base';",
  ];
  const missing = checks.filter((check) => !source.includes(check));
  if (missing.length) {
    throw new Error(`Missing reference base-palette source checks: ${missing.join(', ')}`);
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

async function waitForCurrent(client, current) {
  const ok = await evaluate(client, `
    new Promise((resolve) => {
      const ready = () => document.querySelector('[data-current]')?.textContent?.trim() === ${JSON.stringify(current)};
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
  if (!ok) throw new Error(`Timed out waiting for current ${current}.`);
}

async function sample(client, label) {
  return evaluate(client, `(() => {
    const shell = document.querySelector('.gallery-shell');
    const style = shell ? getComputedStyle(shell) : null;
    const data = document.querySelector('#webgl')?.dataset || {};
    const value = (name) => style?.getPropertyValue(name).trim() || '';
    return {
      label: ${JSON.stringify(label)},
      current: document.querySelector('[data-current]')?.textContent?.trim() || '',
      frame: document.querySelector('[data-shadow-frame]')?.textContent?.trim() || '',
      mode: shell?.dataset.mode || '',
      paletteMode: shell?.dataset.paletteMode || '',
      path: location.pathname,
      scrollPx: data.scrollPx || '',
      surfaceVar: value('--surface-rgb'),
      textVar: value('--text-rgb'),
      workVar: value('--work-rgb'),
    };
  })()`);
}

function expect(condition, message, failures) {
  if (!condition) failures.push(message);
}

function rgbClose(actual, expected, tolerance = 1) {
  const toNumbers = (value) => String(value).split(',').map((item) => Number(item.trim()));
  const actualRgb = toNumbers(actual);
  const expectedRgb = toNumbers(expected);
  return (
    actualRgb.length === expectedRgb.length
    && actualRgb.every((value, index) => Math.abs(value - expectedRgb[index]) <= tolerance)
  );
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

  const home = await sample(client, 'home-base');
  await screenshot(client, '/tmp/local-home-base-palette-v43-home.png');

  await key(client, 'ArrowRight', 'ArrowRight', 39);
  await waitForCurrent(client, '008');
  await sleep(900);
  const homeScrolled = await sample(client, 'home-scrolled-base');
  await screenshot(client, '/tmp/local-home-base-palette-v43-home-scrolled.png');

  await client.send('Page.navigate', { url: 'http://localhost:5279/nian-nian-001' });
  await waitForMode(client, 'detail');
  await sleep(1100);

  await key(client, 'ArrowRight', 'ArrowRight', 39);
  await waitForCurrent(client, '002');
  await sleep(120);
  const detailSwitch = await sample(client, 'detail-project-text-snap');
  await screenshot(client, '/tmp/local-home-base-palette-v43-detail-switch.png');

  await sleep(1000);
  const detail = await sample(client, 'detail-project');
  await screenshot(client, '/tmp/local-home-base-palette-v43-detail.png');

  await key(client, 'e', 'KeyE', 69);
  await waitForMode(client, 'work');
  await sleep(1500);
  const work = await sample(client, 'work-project');
  await screenshot(client, '/tmp/local-home-base-palette-v43-work.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];

  for (const state of [home, homeScrolled]) {
    expect(state.mode === 'index', `Expected ${state.label} in Home mode, got ${JSON.stringify(state)}.`, failures);
    expect(state.paletteMode === 'base', `Expected ${state.label} paletteMode base, got ${JSON.stringify(state)}.`, failures);
    expect(state.surfaceVar === BASE_SURFACE, `Expected ${state.label} base surface ${BASE_SURFACE}, got ${state.surfaceVar}.`, failures);
    expect(state.textVar === BASE_TEXT, `Expected ${state.label} base text ${BASE_TEXT}, got ${state.textVar}.`, failures);
    expect(state.workVar === BASE_WORK, `Expected ${state.label} base work ${BASE_WORK}, got ${state.workVar}.`, failures);
  }
  expect(home.current === '001', `Expected rest Home current 001, got ${JSON.stringify(home)}.`, failures);
  expect(homeScrolled.current === '008', `Expected scrolled Home current 008 after target move, got ${JSON.stringify(homeScrolled)}.`, failures);
  expect(detailSwitch.mode === 'detail' && detailSwitch.current === '002', `Expected Detail switch to current 002, got ${JSON.stringify(detailSwitch)}.`, failures);
  expect(detailSwitch.textVar === REFERENCE_SECOND_TEXT, `Expected Detail switch text to snap to reference second project ${REFERENCE_SECOND_TEXT}, got ${detailSwitch.textVar}.`, failures);
  expect(detail.mode === 'detail' && detail.paletteMode === 'detail', `Expected Detail project palette, got ${JSON.stringify(detail)}.`, failures);
  expect(detail.surfaceVar !== BASE_SURFACE, `Expected Detail surface to leave base palette, got ${JSON.stringify(detail)}.`, failures);
  expect(detail.textVar !== BASE_TEXT, `Expected Detail text to leave base palette, got ${JSON.stringify(detail)}.`, failures);
  expect(work.mode === 'work' && work.paletteMode === 'work', `Expected Work project palette, got ${JSON.stringify(work)}.`, failures);
  expect(work.workVar !== BASE_WORK, `Expected Work color to leave base palette, got ${JSON.stringify(work)}.`, failures);
  expect(rgbClose(work.workVar, REFERENCE_SECOND_WORK), `Expected Work color to use reference second project ${REFERENCE_SECOND_WORK} within 1 channel, got ${work.workVar}.`, failures);
  expect(runtimeExceptions.length === 0, `Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`, failures);

  const report = {
    screenshots: [
      '/tmp/local-home-base-palette-v43-home.png',
      '/tmp/local-home-base-palette-v43-home-scrolled.png',
      '/tmp/local-home-base-palette-v43-detail-switch.png',
      '/tmp/local-home-base-palette-v43-detail.png',
      '/tmp/local-home-base-palette-v43-work.png',
    ],
    home,
    homeScrolled,
    detailSwitch,
    detail,
    work,
    runtimeExceptions,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  client.close();
}
