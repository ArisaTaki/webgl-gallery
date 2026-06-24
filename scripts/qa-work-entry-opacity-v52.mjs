import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const LOCAL_URL = process.env.LOCAL_URL || 'http://localhost:5279/nian-nian-001';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
const WORK_ENTRY_OPACITY_MIN = 0.04;
const WORK_ENTRY_OPACITY_MAX = 0.38;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getPageTarget() {
  const created = await fetch(`${CDP_URL}/json/new?about:blank`, { method: 'PUT' })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  if (created?.webSocketDebuggerUrl) return created;

  const targets = await fetch(`${CDP_URL}/json`).then((response) => response.json());
  const page = targets.find((target) => target.type === 'page') || targets[0];
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

async function waitForModeChange(client, mode, timeout = 4000) {
  return evaluate(client, `
    new Promise((resolve) => {
      const shell = document.querySelector(".gallery-shell");
      const started = performance.now();
      let timer = 0;
      const observer = new MutationObserver(done);
      const cleanup = () => {
        observer.disconnect();
        clearInterval(timer);
      };
      function done() {
        if (shell?.dataset.mode === ${JSON.stringify(mode)}) {
          cleanup();
          resolve(true);
        } else if (performance.now() - started > ${timeout}) {
          cleanup();
          resolve(false);
        }
      }
      if (shell) observer.observe(shell, { attributes: true, attributeFilter: ["data-mode"] });
      timer = setInterval(done, 20);
      done();
    })
  `);
}

async function waitPageMs(client, ms) {
  await evaluate(client, `new Promise((resolve) => setTimeout(resolve, ${ms}))`);
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

async function screenshot(client, path) {
  const result = await client.send('Page.captureScreenshot', {
    captureBeyondViewport: false,
    format: 'png',
    fromSurface: true,
  });
  fs.writeFileSync(path, Buffer.from(result.data, 'base64'));
}

async function sample(client, label) {
  return evaluate(client, `(() => {
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
    const layer = document.querySelector('.work-layer.is-active');
    const img = layer?.querySelector('.work-layer-img');
    const frame = document.querySelector('.detail-rail-active');
    return {
      label: ${JSON.stringify(label)},
      mode: document.querySelector('.gallery-shell')?.dataset.mode || '',
      activeIndex: Number(document.querySelector('.work-layer.is-active')?.dataset.workIndex ?? -1),
      frame: {
        rect: rect(frame),
        opacity: Number(style(frame)?.opacity || 0),
        transform: style(frame)?.transform || '',
      },
      layer: {
        rect: rect(layer),
        transform: style(layer)?.transform || '',
        styleOpacity: Number(img?.style.getPropertyValue('--work-layer-opacity') || 0),
        imgOpacity: Number(style(img)?.opacity || 0),
        loaded: img?.dataset.loaded || '',
      },
    };
  })()`);
}

const target = await getPageTarget();
const client = createCdpClient(target.webSocketDebuggerUrl);
const runtimeExceptions = [];
const failures = [];

try {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Network.enable');
  await client.send('Network.setCacheDisabled', { cacheDisabled: true });
  await client.send('Page.bringToFront');
  await client.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
  client.events.length = 0;

  await client.send('Page.navigate', { url: LOCAL_URL });
  await waitFor(client, 'document.readyState === "complete"', 'local document ready');
  await waitFor(client, 'document.querySelector(".gallery-shell")?.dataset.mode === "detail"', 'local Detail mode');
  await sleep(1300);

  const workModeReady = waitForModeChange(client, 'work');
  await key(client, 'e', 'KeyE', 69);
  if (!(await workModeReady)) throw new Error('Timed out waiting for local Work mode.');
  await waitPageMs(client, 300);
  const work300 = await sample(client, 'work-entry-300ms');
  await screenshot(client, '/tmp/local-work-entry-opacity-v52-300ms.png');
  await sleep(1300);
  const stable = await sample(client, 'work-entry-stable');

  runtimeExceptions.push(
    ...client.events.filter((event) => event.method === 'Runtime.exceptionThrown'),
  );

  if (work300.mode !== 'work') failures.push(`expected work mode at 300ms, got ${work300.mode}`);
  if (work300.layer.loaded !== 'true') failures.push('active Work image was not loaded by 300ms');
  if (work300.layer.imgOpacity < WORK_ENTRY_OPACITY_MIN || work300.layer.imgOpacity > WORK_ENTRY_OPACITY_MAX) {
    failures.push(
      `300ms active image opacity ${work300.layer.imgOpacity} outside live-reference band ${WORK_ENTRY_OPACITY_MIN}..${WORK_ENTRY_OPACITY_MAX}`,
    );
  }
  const frameEntryDelta = work300.frame.rect.top - stable.frame.rect.top;
  if (Math.abs(frameEntryDelta - 158.8) > 35) {
    failures.push(`300ms active frame entry delta ${frameEntryDelta.toFixed(2)} drifted from reference-local target`);
  }
  if (Math.abs(work300.layer.rect.top - 356) > 28) {
    failures.push(`300ms active layer top ${work300.layer.rect.top} drifted from reference-local target`);
  }
  if (stable.layer.imgOpacity !== 1) failures.push(`stable image opacity expected 1, got ${stable.layer.imgOpacity}`);
  if (runtimeExceptions.length) failures.push(`${runtimeExceptions.length} runtime exception(s)`);

  console.log(JSON.stringify({
    screenshots: ['/tmp/local-work-entry-opacity-v52-300ms.png'],
    work300,
    stable,
    runtimeExceptions,
    failures,
  }, null, 2));

  if (failures.length) process.exitCode = 1;
} finally {
  client.close();
  if (target.id) {
    await fetch(`${CDP_URL}/json/close/${target.id}`).catch(() => {});
  }
}
