import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
const EXPECTED_SECOND_WORK_MEDIA_INDEX = '3';

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

async function mouseMove(client, x, y) {
  await client.send('Input.dispatchMouseEvent', {
    button: 'none',
    clickCount: 0,
    type: 'mouseMoved',
    x,
    y,
  });
}

async function sample(client, label) {
  return evaluate(client, `(() => {
    const shell = document.querySelector('.gallery-shell');
    const activeLayer = document.querySelector('.work-layer.is-active');
    const activeImg = activeLayer?.querySelector('.work-layer-img');
    const exitingLayer = document.querySelector('.work-layer.is-exiting');
    const activeThumb = document.querySelector('.detail-thumb.is-active');
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      pathname: location.pathname,
      activeThumbIndex: activeThumb?.dataset.index || '',
      activeWorkIndex: activeLayer?.dataset.workIndex || '',
      exitingWorkIndex: exitingLayer?.dataset.workIndex || '',
      aboutHidden: document.querySelector('.about-panel')?.getAttribute('aria-hidden') || '',
      aboutLabel: document.querySelector('[data-about-label]')?.textContent?.trim() || '',
      workLayerY: activeLayer?.style.getPropertyValue('--work-layer-y') || '',
      workLayerOpacity: activeLayer?.style.getPropertyValue('--work-layer-opacity') || '',
      workLayerComputedOpacity: activeImg ? getComputedStyle(activeImg).opacity : '',
    };
  })()`);
}

function expect(condition, message, failures) {
  if (!condition) failures.push(message);
}

const client = createCdpClient(await getPageWebSocket());
try {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
  await client.send('Page.navigate', { url: TARGET_URL });
  await evaluate(client, `
    new Promise((resolve) => {
      const ready = () => document.querySelector('.gallery-shell')?.dataset.mode === 'index';
      if (ready()) resolve(true);
      const started = performance.now();
      const timer = setInterval(() => {
        if (ready() || performance.now() - started > 4500) {
          clearInterval(timer);
          resolve(Boolean(ready()));
        }
      }, 50);
    })
  `);
  await sleep(650);

  await mouseMove(client, 810, 450);
  await sleep(260);
  await key(client, 'Enter', 'Enter', 13);
  await sleep(650);
  const hoverEnter = await sample(client, 'hover-enter');
  await screenshot(client, '/tmp/local-home-detail-keyboard-v13-hover-enter.png');

  await key(client, 'a', 'KeyA', 65);
  await sleep(450);
  const detailAbout = await sample(client, 'detail-about');
  await screenshot(client, '/tmp/local-home-detail-keyboard-v13-about.png');

  await key(client, 'c', 'KeyC', 67);
  await sleep(550);
  const detailReturn = await sample(client, 'detail-return');

  await key(client, 'e', 'KeyE', 69);
  await sleep(900);
  const workStart = await sample(client, 'work-start');

  await key(client, 'ArrowRight', 'ArrowRight', 39);
  await sleep(450);
  const workAfterArrow = await sample(client, 'work-after-arrow');

  await key(client, 'a', 'KeyA', 65);
  await sleep(450);
  const workAbout = await sample(client, 'work-about');

  await key(client, 'Escape', 'Escape', 27);
  await sleep(750);
  const workReturn = await sample(client, 'work-return');
  await screenshot(client, '/tmp/local-home-detail-keyboard-v13-work-return.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);

  const failures = [];
  expect(hoverEnter.mode === 'detail', 'Hover Enter should open detail mode.', failures);
  expect(hoverEnter.pathname === '/nian-nian-002', `Hover Enter should open /nian-nian-002, got ${hoverEnter.pathname}.`, failures);
  expect(detailAbout.mode === 'about' && detailAbout.pathname === '/about', 'Detail key A should open About.', failures);
  expect(detailAbout.aboutHidden === 'false', 'About panel should be visible after key A.', failures);
  expect(detailReturn.mode === 'detail', `About close key C should return to detail, got ${detailReturn.mode}.`, failures);
  expect(detailReturn.pathname === '/nian-nian-002', `Detail return should restore /nian-nian-002, got ${detailReturn.pathname}.`, failures);
  expect(workStart.mode === 'work', `Detail key E should open work mode, got ${workStart.mode}.`, failures);
  expect(
    workAfterArrow.activeWorkIndex === EXPECTED_SECOND_WORK_MEDIA_INDEX,
    `Work ArrowRight should advance to sparse work media index ${EXPECTED_SECOND_WORK_MEDIA_INDEX}, got ${workAfterArrow.activeWorkIndex}.`,
    failures,
  );
  expect(workAbout.mode === 'about' && workAbout.pathname === '/about', 'Work key A should open About.', failures);
  expect(workReturn.mode === 'work', `About Escape should return to work, got ${workReturn.mode}.`, failures);
  expect(
    workReturn.activeWorkIndex === workAfterArrow.activeWorkIndex,
    `Work return should preserve active work index ${workAfterArrow.activeWorkIndex}, got ${workReturn.activeWorkIndex}.`,
    failures,
  );
  expect(runtimeExceptions.length === 0, `Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`, failures);

  const report = {
    screenshots: [
      '/tmp/local-home-detail-keyboard-v13-hover-enter.png',
      '/tmp/local-home-detail-keyboard-v13-about.png',
      '/tmp/local-home-detail-keyboard-v13-work-return.png',
    ],
    hoverEnter,
    detailAbout,
    detailReturn,
    workStart,
    workAfterArrow,
    workAbout,
    workReturn,
    runtimeExceptions,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));

  if (failures.length) {
    throw new Error(failures.join('\n'));
  }
} finally {
  client.close();
}
