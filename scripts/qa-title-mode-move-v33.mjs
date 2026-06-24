import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5279/nian-nian-002';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertSourcePort() {
  const main = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const checks = [
    ['title move timer', 'let titleModeTimer = 0'],
    ['title mode pulse', 'function pulseTitleModeMove()'],
    ['title settled class', 'is-title-mode-settled'],
    ['detail work title pulse', 'previousMode === VIEW.detail && mode === VIEW.work'],
    ['work detail title pulse', 'previousMode === VIEW.work && mode === VIEW.detail'],
    ['css mode moving', '.gallery-shell.is-title-mode-moving:not(.is-project-switching) .project-shadow-title .title-char span'],
  ];
  const missing = checks.filter(([, needle]) => !(main.includes(needle) || css.includes(needle)));
  if (missing.length) {
    throw new Error(`Missing title mode-move source checks: ${missing.map(([label]) => label).join(', ')}`);
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
        if (ready() || performance.now() - started > 10000) {
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
    const chars = [...document.querySelectorAll('.project-shadow-title-active .title-line:first-child .title-char')].slice(0, 4);
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      shellClass: shell?.className || '',
      animationNames: chars.map((char) => getComputedStyle(char.querySelector('span')).animationName),
      spanTransforms: chars.map((char) => getComputedStyle(char.querySelector('span')).transform),
      charLefts: chars.map((char) => Math.round(char.getBoundingClientRect().left * 100) / 100),
      lineTransforms: [...document.querySelectorAll('.project-shadow-title-active .title-line')].map((line) => getComputedStyle(line).transform),
      lineTops: [...document.querySelectorAll('.project-shadow-title-active .title-line')].map((line) => Math.round(line.getBoundingClientRect().top * 100) / 100),
    };
  })()`);
}

function enoughMovement(a, b) {
  if (!a?.charLefts?.length || !b?.charLefts?.length) return false;
  return a.charLefts.some((left, index) => Math.abs(left - b.charLefts[index]) > 8);
}

assertSourcePort();

const client = createCdpClient(await getPageWebSocket());
try {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
  await client.send('Page.navigate', { url: TARGET_URL });
  await waitForMode(client, 'detail');
  await sleep(1500);
  const detailStable = await sample(client, 'detail-stable');
  await screenshot(client, '/tmp/local-title-mode-move-v33-detail.png');

  await key(client, 'e', 'KeyE', 69);
  await waitForMode(client, 'work');
  await sleep(300);
  const work300 = await sample(client, 'work-300ms');
  await screenshot(client, '/tmp/local-title-mode-move-v33-work-300ms.png');
  await sleep(1200);
  const workStable = await sample(client, 'work-stable');
  await screenshot(client, '/tmp/local-title-mode-move-v33-work-stable.png');

  await key(client, 'Escape', 'Escape', 27);
  await waitForMode(client, 'detail');
  await sleep(300);
  const detailReturn300 = await sample(client, 'detail-return-300ms');
  await screenshot(client, '/tmp/local-title-mode-move-v33-detail-return-300ms.png');
  await sleep(1100);
  const detailReturnStable = await sample(client, 'detail-return-stable');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];

  if (detailStable.mode !== 'detail') failures.push(`Expected initial Detail mode, got ${detailStable.mode}.`);
  if (!work300.shellClass.includes('is-title-mode-moving')) {
    failures.push(`Expected Work transition to carry is-title-mode-moving, got ${work300.shellClass}.`);
  }
  if (work300.shellClass.includes('is-project-switching')) {
    failures.push(`Detail to Work should not be a project switch, got ${work300.shellClass}.`);
  }
  if (!work300.animationNames.every((name) => name === 'none')) {
    failures.push(`Expected no title reveal animation during Detail->Work mode move, got ${work300.animationNames.join(',')}.`);
  }
  if (!work300.spanTransforms.every((transform) => transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)')) {
    failures.push(`Expected title spans to stay visibly unmasked during mode move, got ${work300.spanTransforms.join(',')}.`);
  }
  if (!enoughMovement(detailStable, work300)) {
    failures.push(`Expected title glyph x positions to move toward Work layout, detail=${detailStable.charLefts}, work300=${work300.charLefts}.`);
  }
  if (workStable.shellClass.includes('is-title-mode-moving')) {
    failures.push(`Expected title mode-moving class to clear in stable Work, got ${workStable.shellClass}.`);
  }
  if (!workStable.shellClass.includes('is-title-mode-settled')) {
    failures.push(`Expected stable Work to keep is-title-mode-settled, got ${workStable.shellClass}.`);
  }
  if (!workStable.animationNames.every((name) => name === 'none')) {
    failures.push(`Expected stable Work not to restart title reveal, got ${workStable.animationNames.join(',')}.`);
  }
  if (!workStable.spanTransforms.every((transform) => transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)')) {
    failures.push(`Expected stable Work title spans to remain visible, got ${workStable.spanTransforms.join(',')}.`);
  }
  if (!detailReturn300.shellClass.includes('is-title-mode-moving')) {
    failures.push(`Expected Work->Detail transition to carry is-title-mode-moving, got ${detailReturn300.shellClass}.`);
  }
  if (!detailReturn300.animationNames.every((name) => name === 'none')) {
    failures.push(`Expected no title reveal animation during Work->Detail mode move, got ${detailReturn300.animationNames.join(',')}.`);
  }
  if (detailReturnStable.shellClass.includes('is-title-mode-moving')) {
    failures.push(`Expected title mode-moving class to clear after returning to Detail, got ${detailReturnStable.shellClass}.`);
  }
  if (!detailReturnStable.shellClass.includes('is-title-mode-settled')) {
    failures.push(`Expected returned Detail to keep is-title-mode-settled, got ${detailReturnStable.shellClass}.`);
  }
  if (!detailReturnStable.animationNames.every((name) => name === 'none')) {
    failures.push(`Expected returned stable Detail not to restart title reveal, got ${detailReturnStable.animationNames.join(',')}.`);
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: [
      '/tmp/local-title-mode-move-v33-detail.png',
      '/tmp/local-title-mode-move-v33-work-300ms.png',
      '/tmp/local-title-mode-move-v33-work-stable.png',
      '/tmp/local-title-mode-move-v33-detail-return-300ms.png',
    ],
    detailStable,
    work300,
    workStable,
    detailReturn300,
    detailReturnStable,
    runtimeExceptions,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exit(1);
} finally {
  client.close();
}
