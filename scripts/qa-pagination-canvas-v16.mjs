import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const HOME_URL = process.env.HOME_URL || 'http://localhost:5279/';
const DETAIL_URL = process.env.DETAIL_URL || 'http://localhost:5279/webgl-gallery-002';
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

async function moveMouse(client, x, y) {
  await client.send('Input.dispatchMouseEvent', {
    button: 'none',
    buttons: 0,
    type: 'mouseMoved',
    x,
    y,
  });
  await evaluate(client, `
    window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      clientX: ${x},
      clientY: ${y},
      pointerId: 1,
      pointerType: 'mouse',
    }));
  `);
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
    const canvas = document.querySelector('.pagination-canvas');
    const ctx = canvas?.getContext('2d');
    const dpr = canvas ? canvas.width / window.innerWidth : 1;
    const pData = canvas?.dataset || {};
    const number = (value, fallback = 0) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const count = number(pData.paginationCount, 30);
    const left = number(pData.paginationLeft, 600);
    const step = number(pData.paginationStep, 8.5);
    const region = {
      x: Math.max(0, left - 24),
      y: 0,
      w: Math.min(window.innerWidth - Math.max(0, left - 24), count * step + 72),
      h: 82,
    };
    let alphaPixels = 0;
    let alphaSum = 0;
    if (ctx) {
      const image = ctx.getImageData(
        Math.round(region.x * dpr),
        Math.round(region.y * dpr),
        Math.round(region.w * dpr),
        Math.round(region.h * dpr),
      );
      for (let index = 3; index < image.data.length; index += 4) {
        const alpha = image.data[index];
        if (alpha > 8) alphaPixels += 1;
        alphaSum += alpha;
      }
    }
    const allEntries = [...document.querySelectorAll('.pgn')].map((item, index) => {
      const a = item.querySelector('.pgn-a > div');
      const b = item.querySelector('.pgn-b > div');
      const rootVisible = item.style.opacity !== '0';
      return {
        index,
        className: item.className,
        itemOpacity: item.style.opacity,
        rootVisible,
        visible: item.className.includes('is-visible') || item.className.includes('is-leaving'),
        aText: a?.textContent || '',
        bText: b?.textContent || '',
      };
    });
    const entries = allEntries.filter((entry) => entry.visible);
    const active = document.querySelector('.pgn.is-visible');
    const aRect = active?.querySelector('.pgn-a')?.getBoundingClientRect();
    const bRect = active?.querySelector('.pgn-b')?.getBoundingClientRect();
    const hoverPoint = aRect && bRect
      ? { x: Math.round((aRect.right + bRect.left) / 2), y: Math.round(aRect.top + aRect.height / 2) }
      : { x: Math.round(left + count * step * 0.5), y: 56 };
    return {
      label: ${JSON.stringify(label)},
      mode: shell?.dataset.mode || '',
      pathname: location.pathname,
      canvasOpacity: canvas ? getComputedStyle(canvas).opacity : '',
      alphaPixels,
      alphaSum,
      region,
      pgnRootCount: allEntries.filter((entry) => entry.rootVisible).length,
      pgnCount: entries.length,
      pgnEntries: entries,
      hoverPoint,
    };
  })()`);
}

const client = createCdpClient(await getPageWebSocket());
try {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Emulation.setDeviceMetricsOverride', VIEWPORT);

  await client.send('Page.navigate', { url: HOME_URL });
  await waitForMode(client, 'index');
  await sleep(900);
  const home = await sample(client, 'home-stable');
  await screenshot(client, '/tmp/local-pagination-canvas-v16-home.png');

  await client.send('Page.navigate', { url: DETAIL_URL });
  await waitForMode(client, 'detail');
  await sleep(1600);
  const detail = await sample(client, 'detail-stable');
  await screenshot(client, '/tmp/local-pagination-canvas-v16-detail.png');

  await moveMouse(client, detail.hoverPoint.x, detail.hoverPoint.y);
  await sleep(350);
  const detailHover = await sample(client, 'detail-hover');
  await screenshot(client, '/tmp/local-pagination-canvas-v16-detail-hover.png');

  await key(client, 'e', 'KeyE', 69);
  await waitForMode(client, 'work');
  await sleep(900);
  const work = await sample(client, 'work-stable');
  await screenshot(client, '/tmp/local-pagination-canvas-v16-work.png');

  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);
  const failures = [];

  if (home.mode !== 'index' || home.alphaPixels < 20) {
    failures.push(`Expected visible home canvas ticks, got ${JSON.stringify(home)}.`);
  }
  if (detail.mode !== 'detail' || detail.pgnRootCount !== 30 || detail.pgnCount !== 1 || detail.pgnEntries[0]?.index !== 2) {
    failures.push(`Expected 30 root-visible slots and one detail pgn digit at visual slot 2, got ${JSON.stringify(detail)}.`);
  }
  if (detail.canvasOpacity !== '1') {
    failures.push(`Expected detail canvas CSS opacity to stay drawable at 1, got ${detail.canvasOpacity}.`);
  }
  if (detail.alphaSum >= home.alphaSum * 0.28) {
    failures.push(`Expected stable detail canvas marks to fade below home, home=${home.alphaSum}, detail=${detail.alphaSum}.`);
  }
  if (detailHover.alphaSum <= detail.alphaSum + 200) {
    failures.push(`Expected detail hover to revive the canvas rail, stable=${detail.alphaSum}, hover=${detailHover.alphaSum}.`);
  }
  if (work.mode !== 'work' || work.pgnRootCount !== 30 || work.pgnCount !== 1 || work.pgnEntries[0]?.index !== 2) {
    failures.push(`Expected Work to keep 30 root-visible slots and one pgn digit at visual slot 2, got ${JSON.stringify(work)}.`);
  }
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: [
      '/tmp/local-pagination-canvas-v16-home.png',
      '/tmp/local-pagination-canvas-v16-detail.png',
      '/tmp/local-pagination-canvas-v16-detail-hover.png',
      '/tmp/local-pagination-canvas-v16-work.png',
    ],
    home,
    detail,
    detailHover,
    work,
    runtimeExceptions,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  client.close();
}
