import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertSourcePort() {
  const source = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const checks = [
    'function setHomeScrollTargetIndex(index)',
    'setHomeScrollTargetIndex(state.activeIndex + 7);',
    'setHomeScrollTargetIndex(state.activeIndex - 7);',
    'if (state.mode === VIEW.index) {',
    'setHomeScrollTargetIndex(state.paginationHoverIndex);',
  ];
  const missing = checks.filter((check) => !source.includes(check));
  if (missing.length) {
    throw new Error(`Missing Home target-lag source checks: ${missing.join(', ')}`);
  }
  const stale = [
    'setActive(state.activeIndex + 7, true);',
    'setActive(state.activeIndex - 7, true);',
  ].filter((check) => source.includes(check));
  if (stale.length) {
    throw new Error(`Home key handlers still update active index immediately: ${stale.join(', ')}`);
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
    return {
      label: ${JSON.stringify(label)},
      current: document.querySelector('[data-current]')?.textContent?.trim() || '',
      frame: document.querySelector('[data-shadow-frame]')?.textContent?.trim() || '',
      mode: shell?.dataset.mode || '',
      path: location.pathname,
      scrollPx: number(data.scrollPx),
      targetScrollPx: number(data.targetScrollPx),
    };
  })()`);
}

async function dispatchSequence(client, sequence) {
  return evaluate(client, `(() => {
    const number = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const read = (label) => {
      const shell = document.querySelector('.gallery-shell');
      const data = document.querySelector('#webgl')?.dataset || {};
      return {
        label,
        current: document.querySelector('[data-current]')?.textContent?.trim() || '',
        frame: document.querySelector('[data-shadow-frame]')?.textContent?.trim() || '',
        mode: shell?.dataset.mode || '',
        path: location.pathname,
        scrollPx: number(data.scrollPx),
        targetScrollPx: number(data.targetScrollPx),
      };
    };
    const dispatchKey = (key, code) => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code,
        key,
      }));
    };
    const samples = [read('before')];
    for (const item of ${JSON.stringify(sequence)}) {
      dispatchKey(item.key, item.code);
      samples.push(read(item.label));
    }
    return samples;
  })()`);
}

function near(value, expected, tolerance = 5) {
  return Math.abs((value ?? Number.NaN) - expected) <= tolerance;
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

  const afterRightSequence = await dispatchSequence(client, [
    { key: 'ArrowRight', code: 'ArrowRight', label: 'after-arrow-right-sync' },
  ]);
  await screenshot(client, '/tmp/local-home-target-lag-v42-after-key.png');

  await client.send('Page.navigate', { url: TARGET_URL });
  await waitForMode(client, 'index');
  await sleep(1300);

  const fastEnterSequence = await dispatchSequence(client, [
    { key: 'ArrowRight', code: 'ArrowRight', label: 'after-arrow-right-sync' },
    { key: 'Enter', code: 'Enter', label: 'after-enter-sync' },
  ]);
  await waitForMode(client, 'detail');
  await sleep(650);
  const detailSettled = await sample(client, 'detail-settled');
  await screenshot(client, '/tmp/local-home-target-lag-v42-immediate-enter.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];
  const afterRight = afterRightSequence.at(-1);
  const beforeFast = fastEnterSequence[0];
  const afterRightFast = fastEnterSequence[1];
  const afterEnterFast = fastEnterSequence[2];

  if (afterRight.mode !== 'index' || afterRight.path !== '/') {
    failures.push(`Expected ArrowRight to stay on Home, got ${JSON.stringify(afterRight)}.`);
  }
  if (afterRight.current !== '001') {
    failures.push(`Expected ArrowRight sync sample to keep current 001, got ${JSON.stringify(afterRight)}.`);
  }
  if (!near(afterRight.targetScrollPx, 630, 8)) {
    failures.push(`Expected ArrowRight target near 630px, got ${JSON.stringify(afterRight)}.`);
  }
  if (!near(afterRight.scrollPx, 0, 3)) {
    failures.push(`Expected ArrowRight sync sample to leave scroll near 0px, got ${JSON.stringify(afterRight)}.`);
  }
  if (beforeFast.current !== '001' || beforeFast.mode !== 'index') {
    failures.push(`Expected fast sequence to start on Home 001, got ${JSON.stringify(beforeFast)}.`);
  }
  if (afterRightFast.current !== '001' || afterRightFast.mode !== 'index') {
    failures.push(`Expected fast ArrowRight to keep current 001 before Enter, got ${JSON.stringify(afterRightFast)}.`);
  }
  if (afterEnterFast.mode !== 'detail' || afterEnterFast.path !== '/nian-nian-001') {
    failures.push(`Expected immediate Enter after ArrowRight to open /nian-nian-001, got ${JSON.stringify(afterEnterFast)}.`);
  }
  if (detailSettled.mode !== 'detail' || detailSettled.path !== '/nian-nian-001') {
    failures.push(`Expected settled Detail to remain /nian-nian-001, got ${JSON.stringify(detailSettled)}.`);
  }
  if (runtimeExceptions.length) {
    failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);
  }

  const report = {
    screenshots: [
      '/tmp/local-home-target-lag-v42-after-key.png',
      '/tmp/local-home-target-lag-v42-immediate-enter.png',
    ],
    afterRightSequence,
    fastEnterSequence,
    detailSettled,
    runtimeExceptions,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  client.close();
}
