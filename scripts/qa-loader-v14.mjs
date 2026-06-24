import fs from 'node:fs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const TARGET_URL = process.env.TARGET_URL || `http://localhost:5279/?loader_v14=${Date.now()}`;
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

async function sample(client) {
  return evaluate(client, `(() => {
    const shell = document.querySelector('.gallery-shell');
    const loader = document.querySelector('.loader-counter');
    const loaderText = loader?.textContent?.replace(/\\D/g, '') || '';
    const mediaEntries = performance
      .getEntriesByType('resource')
      .filter((entry) => entry.name.includes('/media/') && entry.initiatorType === 'img');
    return {
      elapsed: Math.round(performance.now()),
      loaderText,
      loaderValue: Number(loaderText || 0),
      mediaEntries: mediaEntries.length,
      mode: shell?.dataset.mode || '',
      opacity: loader ? getComputedStyle(loader).opacity : '',
      pathname: location.pathname,
    };
  })()`);
}

const client = createCdpClient(await getPageWebSocket());
try {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Network.enable');
  await client.send('Network.setCacheDisabled', { cacheDisabled: true });
  await client.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 60,
    downloadThroughput: 640 * 1024,
    uploadThroughput: 640 * 1024,
  });
  await client.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
  await client.send('Page.navigate', { url: TARGET_URL });

  const samples = [];
  let loadingScreenshotTaken = false;
  const started = Date.now();
  while (Date.now() - started < 9000) {
    const current = await sample(client).catch(() => null);
    if (current) {
      samples.push(current);
      if (!loadingScreenshotTaken && current.mode === 'loading') {
        await screenshot(client, '/tmp/local-loader-texture-v14-loading.png');
        loadingScreenshotTaken = true;
      }
      if (current.mode === 'index' && current.loaderValue === 100) break;
    }
    await sleep(80);
  }
  await sleep(350);
  const finalSample = await sample(client);
  await screenshot(client, '/tmp/local-loader-texture-v14-final.png');

  const values = [...new Set(samples.map((entry) => entry.loaderValue).filter(Boolean))];
  const loadingValues = [...new Set(samples
    .filter((entry) => entry.mode === 'loading')
    .map((entry) => entry.loaderValue)
    .filter(Boolean))];
  const nondecreasing = values.every((value, index) => index === 0 || value >= values[index - 1]);
  const runtimeExceptions = client.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params);

  const failures = [];
  if (finalSample.mode !== 'index') failures.push(`Expected final mode index, got ${finalSample.mode}.`);
  if (finalSample.loaderValue !== 100) failures.push(`Expected loader value 100 after release, got ${finalSample.loaderValue}.`);
  if (!loadingValues.length) failures.push('Expected at least one loading-mode sample.');
  if (loadingValues.at(-1) === 100 && finalSample.mode !== 'index') failures.push('Loader reached 100 before releasing index mode.');
  if (!nondecreasing) failures.push(`Loader values should be nondecreasing, got ${values.join(', ')}.`);
  if (runtimeExceptions.length) failures.push(`Runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);

  const report = {
    screenshots: [
      '/tmp/local-loader-texture-v14-loading.png',
      '/tmp/local-loader-texture-v14-final.png',
    ],
    values,
    loadingValues,
    firstSamples: samples.slice(0, 8),
    lastSamples: samples.slice(-8),
    finalSample,
    runtimeExceptions,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));

  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  client.close();
}
