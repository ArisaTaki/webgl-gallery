import { readFile } from 'node:fs/promises';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9239';
const LOCAL_URL = process.env.LOCAL_URL || 'http://localhost:5279/';

async function staticChecks() {
  const [main, server, pipeline, readme] = await Promise.all([
    readFile(new URL('../src/main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../server/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../server/photoPipeline.ts', import.meta.url), 'utf8'),
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
  ]);
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  const required = [
    ['studio route', main.includes('/studio')],
    ['secret key buffer', main.includes('state.keyBuffer =') && main.includes("endsWith('webgl')")],
    ['studio admin login', main.includes("fetch('/api/admin/login'")],
    ['studio dashboard layout', main.includes('studio-dashboard') && main.includes('data-studio-group-filter')],
    ['studio upload panel', main.includes('studio-upload-panel') && main.includes('studio-inspector')],
    ['single photo inspector', main.includes('studioSelectedPhotoId') && main.includes('data-studio-photo-select')],
    ['photo search', main.includes('data-studio-search') && main.includes('applyStudioPhotoSearch')],
    ['collapsible creation flow', main.includes('studio-toggle-create') && main.includes('studioCreateGroupOpen')],
    ['create album dialog', main.includes('data-studio-create-dialog') && main.includes('showModal')],
    ['bulk photo management', main.includes('studioSelectedPhotoIds') && main.includes('studio-bulk-move') && main.includes('onAdminBulkUpdate')],
    ['photo view controls', main.includes('data-studio-status-filter') && main.includes('data-studio-photo-sort') && main.includes('studio-density-compact')],
    ['Studio scroll routing', main.includes("target.closest('.studio-photo-grid, .studio-sidebar, .studio-inspector, .studio-dashboard')")],
    ['isolated Studio chrome', styles.includes('.gallery-shell.is-studio > .corner')],
    ['explicit legacy upload key', server.includes('verifyLegacyUploadKey') && server.includes("request.headers['x-gallery-key']")],
    ['multer file limit', server.includes("upload.array('photos', 24)")],
    ['webp variants', pipeline.includes("{ key: 'thumb'") && pipeline.includes("{ key: 'large'")],
    ['readme studio docs', readme.includes('http://localhost:5280/studio') && readme.includes('GALLERY_ADMIN_PASSWORD_HASH')],
  ];
  return required.filter(([, ok]) => !ok).map(([name]) => `Missing static studio check: ${name}`);
}

async function createTarget() {
  const created = await fetch(`${CDP_URL}/json/new?about:blank`, { method: 'PUT' })
    .then((response) => response.json())
    .catch(() => null);
  if (created?.id) return created;
  const targets = await fetch(`${CDP_URL}/json`).then((response) => response.json());
  return targets.find((target) => target.type === 'page');
}

async function send(client, method, params = {}) {
  client.id += 1;
  client.socket.send(JSON.stringify({ id: client.id, method, params }));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.pending.delete(client.id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 10000);
    client.pending.set(client.id, { resolve, reject, timeout });
  });
}

async function connect(target) {
  const WebSocket = globalThis.WebSocket;
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const client = { id: 0, pending: new Map(), socket };
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const pending = client.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    client.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  await send(client, 'Page.enable');
  await send(client, 'Runtime.enable');
  return client;
}

async function evaluate(client, expression) {
  const result = await send(client, 'Runtime.evaluate', {
    awaitPromise: true,
    expression,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Runtime.evaluate exception');
  }
  return result.result.value;
}

async function waitFor(client, expression, label, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(client, `Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function navigate(client, url) {
  await send(client, 'Page.navigate', { url });
  await waitFor(client, 'document.readyState !== "loading"', `load ${url}`);
}

async function key(client, keyName, code, keyCode) {
  const params = {
    code,
    key: keyName,
    nativeVirtualKeyCode: keyCode,
    windowsVirtualKeyCode: keyCode,
  };
  await send(client, 'Input.dispatchKeyEvent', { ...params, type: 'keyDown' });
  await send(client, 'Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
}

async function screenshot(client, path) {
  const result = await send(client, 'Page.captureScreenshot', { format: 'png', fromSurface: true });
  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile(path, Buffer.from(result.data, 'base64')),
  );
}

async function sample(client, label) {
  return evaluate(
    client,
    `(() => {
      const panel = document.querySelector('.studio-panel');
      const form = document.querySelector('.studio-form');
      const style = panel ? getComputedStyle(panel) : null;
      const visible = Boolean(panel && panel.getBoundingClientRect().width > 0 && panel.getBoundingClientRect().height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0');
      return {
        label: ${JSON.stringify(label)},
        mode: document.querySelector('.gallery-shell')?.dataset.mode || '',
        path: location.pathname,
        visible,
        ariaHidden: panel?.getAttribute('aria-hidden') || '',
        inert: panel?.hasAttribute('inert') || false,
        hasPasswordInput: Boolean(form?.querySelector('input[name="password"][type="password"]')),
        hasAdminPanel: Boolean(document.querySelector('[data-studio-admin]')),
        submitText: form?.querySelector('[data-studio-submit]')?.textContent?.trim() || '',
      };
    })()`,
  );
}

async function manifestSample(client) {
  return evaluate(
    client,
    `fetch('/api/photos', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => ({
        isArray: Array.isArray(data),
        count: Array.isArray(data) ? data.length : data.count,
        photos: (Array.isArray(data) ? data : data.photos || []).length,
        first: (Array.isArray(data) ? data : data.photos || [])[0]?.id || '',
        last: (Array.isArray(data) ? data : data.photos || []).at(-1)?.id || '',
      }))`,
  );
}

async function run() {
  const failures = await staticChecks();
  const target = await createTarget();
  const client = await connect(target);
  const diagnostics = [];
  await send(client, 'Log.enable');

  try {
    await navigate(client, LOCAL_URL);
    await waitFor(client, 'document.querySelector(".gallery-shell") && document.querySelector(".studio-panel")', 'home shell');
    for (const item of [
      ['w', 'KeyW', 87],
      ['e', 'KeyE', 69],
      ['b', 'KeyB', 66],
      ['g', 'KeyG', 71],
      ['l', 'KeyL', 76],
    ]) {
      await key(client, ...item);
    }
    await waitFor(client, 'document.querySelector(".gallery-shell")?.dataset.mode === "studio"', 'secret studio mode');
    await waitFor(client, 'Number(getComputedStyle(document.querySelector(".studio-panel")).opacity) > 0.95', 'secret studio panel fade-in');
    const secret = await sample(client, 'secret-keyword');
    await screenshot(client, '/tmp/local-studio-v99-secret.png');

    await navigate(client, new URL('/studio', LOCAL_URL).href);
    await waitFor(client, 'document.querySelector(".gallery-shell")?.dataset.mode === "studio"', 'direct studio route');
    await waitFor(client, 'Number(getComputedStyle(document.querySelector(".studio-panel")).opacity) > 0.95', 'direct studio panel fade-in');
    const direct = await sample(client, 'direct-route');
    const manifest = await manifestSample(client);
    await screenshot(client, '/tmp/local-studio-v99-direct.png');

    for (const state of [secret, direct]) {
      if (state.mode !== 'studio' || !state.visible || state.ariaHidden !== 'false' || state.inert) {
        failures.push(`Studio panel not visible/interactive for ${state.label}: ${JSON.stringify(state)}`);
      }
      if (!state.hasPasswordInput || !state.hasAdminPanel || state.submitText !== 'Login') {
        failures.push(`Studio login shell missing expected controls for ${state.label}: ${JSON.stringify(state)}`);
      }
    }

    if (!manifest.isArray || manifest.count !== 17 || manifest.photos !== 17 || manifest.first !== 'source-000001') {
      failures.push(`Unexpected /api/photos manifest sample: ${JSON.stringify(manifest)}`);
    }

    const result = {
      ok: failures.length === 0,
      screenshots: ['/tmp/local-studio-v99-secret.png', '/tmp/local-studio-v99-direct.png'],
      secret,
      direct,
      manifest,
      diagnostics,
      failures,
    };
    console.log(JSON.stringify(result, null, 2));
    if (failures.length) process.exitCode = 1;
  } finally {
    client.socket.close();
    if (target?.id) await fetch(`${CDP_URL}/json/close/${target.id}`).catch(() => {});
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
