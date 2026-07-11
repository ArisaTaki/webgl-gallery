import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9241';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'studio-ui-qa';
const failures = [];
const checkpoints = [];
let localUrl = process.env.LOCAL_URL || '';

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForServer(url) {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    try {
      const response = await fetch(`${url}/api/setup/status`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error('Timed out waiting for Studio fixture server.');
}

async function createStudioFixture() {
  if (localUrl) return null;
  const root = path.resolve(new URL('..', import.meta.url).pathname);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gallery-studio-ui-v2-'));
  const inputDir = path.join(tempRoot, 'input');
  const port = await getFreePort();
  const serverUrl = `http://127.0.0.1:${port}`;
  await mkdir(inputDir, { recursive: true });
  const child = spawn(path.join(root, 'node_modules/.bin/tsx'), ['server/index.ts'], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: '',
      GALLERY_CONFIG_PATH: path.join(tempRoot, '.gallery/config.json'),
      GALLERY_DATA_DIR: path.join(tempRoot, 'data'),
      GALLERY_DISABLE_HMR: '1',
      GALLERY_MEDIA_DIR: path.join(tempRoot, 'media'),
      GALLERY_ORIGINAL_DIR: path.join(tempRoot, 'originals'),
      GALLERY_SQLITE_PATH: path.join(tempRoot, '.gallery/gallery.sqlite'),
      GALLERY_UPLOAD_DIR: path.join(tempRoot, 'uploads'),
      GALLERY_ADMIN_PASSWORD_HASH: `sha256:${crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex')}`,
      NODE_ENV: 'production',
      PORT: String(port),
      R2_ACCOUNT_ID: '',
      R2_ACCESS_KEY_ID: '',
      R2_PRIVATE_BUCKET: '',
      R2_PUBLIC_BASE_URL: '',
      R2_PUBLIC_BUCKET: '',
      R2_SECRET_ACCESS_KEY: '',
      SESSION_SECRET: 'studio-ui-v2-session-secret',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  await waitForServer(serverUrl);

  const login = await fetch(`${serverUrl}/api/admin/login`, {
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const request = (url, options = {}) => fetch(`${serverUrl}${url}`, {
    ...options,
    headers: { Cookie: cookie, ...(options.headers || {}) },
  });
  const groupIds = [];
  for (const [title, slug, accentColor] of [['城市散步', 'city-walks', '#4b82a8'], ['夏日海岸', 'summer-coast', '#c47755'], ['日常片段', 'daily-scenes', '#778e62']]) {
    const response = await request('/api/admin/groups', {
      body: JSON.stringify({ title, slug, description: `${title}的照片`, accentColor }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    groupIds.push((await response.json()).group.id);
  }

  const dimensions = [
    [1600, 1067], [1000, 1500], [1500, 1000], [1200, 1200],
    [1440, 960], [960, 1440], [1360, 1020], [1020, 1360],
  ];
  for (let groupIndex = 0; groupIndex < groupIds.length; groupIndex += 1) {
    const form = new FormData();
    form.append('groupId', groupIds[groupIndex]);
    form.append('titlePrefix', ['街角光影', '海边记忆', '午后日常'][groupIndex]);
    for (let index = 0; index < dimensions.length; index += 1) {
      const [width, height] = dimensions[index];
      const filePath = path.join(inputDir, `${groupIndex}-${index}.jpg`);
      await sharp({
        create: {
          width,
          height,
          channels: 3,
          background: {
            r: 68 + groupIndex * 44,
            g: 114 + index * 21,
            b: 154 + groupIndex * 18,
          },
        },
      }).jpeg({ quality: 88 }).toFile(filePath);
      form.append('photos', new Blob([await readFile(filePath)], { type: 'image/jpeg' }), `${groupIndex}-${index}.jpg`);
    }
    const upload = await request('/api/admin/photos', { body: form, method: 'POST' });
    if (!upload.ok) throw new Error(`Fixture upload failed: ${await upload.text()}`);
  }
  localUrl = `${serverUrl}/studio`;
  return { child, output, tempRoot };
}

async function send(client, method, params = {}) {
  client.id += 1;
  const id = client.id;
  client.socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 15000);
    client.pending.set(id, { resolve, reject, timeout });
  });
}

async function connect() {
  const targets = await fetch(`${CDP_URL}/json`).then((response) => response.json());
  const target = targets.find((item) => item.type === 'page');
  if (!target) throw new Error('No Chrome page target found.');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const client = { events: [], id: 0, pending: new Map(), socket };
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) {
      if (message.method === 'Runtime.exceptionThrown' || message.method === 'Log.entryAdded') client.events.push(message);
      return;
    }
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
  await send(client, 'Log.enable');
  return client;
}

async function evaluate(client, expression) {
  const result = await send(client, 'Runtime.evaluate', {
    awaitPromise: true,
    expression,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Browser evaluation failed.');
  return result.result.value;
}

async function waitFor(client, expression, label, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(client, `Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function setViewport(client, width, height, deviceScaleFactor = 1) {
  await send(client, 'Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor,
    mobile: width <= 620,
  });
}

async function screenshot(client, path) {
  const result = await send(client, 'Page.captureScreenshot', {
    captureBeyondViewport: false,
    format: 'png',
    fromSurface: true,
  });
  await writeFile(path, Buffer.from(result.data, 'base64'));
}

function assert(condition, message) {
  if (!condition) failures.push(message);
}

const fixture = await createStudioFixture();
const client = await connect();
try {
  await send(client, 'Network.enable');
  await send(client, 'Network.clearBrowserCookies');
  await setViewport(client, 1920, 1080);
  const galleryUrl = new URL('/', localUrl).href;
  await send(client, 'Page.navigate', { url: galleryUrl });
  await waitFor(client, `location.href === ${JSON.stringify(galleryUrl)}`, 'gallery navigation');
  await waitFor(client, 'document.querySelector(".gallery-shell")?.dataset.mode === "index"', 'initial gallery preload', 20000);
  await new Promise((resolve) => setTimeout(resolve, 900));
  const initialPreload = await evaluate(client, `(async () => {
    const gallery = await fetch('/api/gallery').then((response) => response.json());
    const resources = new Set(performance.getEntriesByType('resource').map((entry) => entry.name));
    const groups = gallery.groups
      .map((group) => {
        const photos = gallery.photos.filter((photo) => photo.groupId === group.id || photo.group === group.slug);
        const loadedMedium = photos.filter((photo) => photo.medium && resources.has(new URL(photo.medium, location.href).href)).length;
        return { id: group.id, photos: photos.length, loadedMedium };
      })
      .filter((group) => group.photos > 0);
    return {
      groups,
      loader: [...document.querySelectorAll('[data-loader-digit]')].map((digit) => digit.textContent).join(''),
      initialTotal: Number(document.querySelector('#webgl')?.dataset.initialPreloadTotal || 0),
      initialLoaded: Number(document.querySelector('#webgl')?.dataset.initialPreloadLoaded || 0),
      timedOut: document.querySelector('#webgl')?.dataset.initialPreloadTimedOut === 'true',
      backgroundTotal: Number(document.querySelector('#webgl')?.dataset.backgroundPreloadTotal || 0),
      backgroundLoaded: Number(document.querySelector('#webgl')?.dataset.backgroundPreloadLoaded || 0),
    };
  })()`);
  assert(initialPreload.loader === '100' && !initialPreload.timedOut, `Initial loader should finish real image preloads: ${JSON.stringify(initialPreload)}`);
  assert(initialPreload.initialTotal === 6 && initialPreload.initialLoaded === 6, `Initial preload should include two previews for each fixture album: ${JSON.stringify(initialPreload)}`);
  assert(initialPreload.groups.every((group) => group.loadedMedium >= Math.min(3, group.photos)), `Each album should have its cover and first previews ready: ${JSON.stringify(initialPreload)}`);
  assert(initialPreload.backgroundTotal > 0 && initialPreload.backgroundLoaded > 0, `Background preload should start after the gallery opens: ${JSON.stringify(initialPreload)}`);

  await send(client, 'Page.navigate', { url: localUrl });
  await waitFor(client, `location.href === ${JSON.stringify(localUrl)}`, 'Studio navigation');
  await waitFor(client, 'document.readyState !== "loading"', 'document load');
  await waitFor(client, 'document.querySelector(".gallery-shell")', 'gallery shell');
  await waitFor(client, 'document.querySelector(".studio-login-form") && !document.querySelector(".studio-login-form").hidden', 'Studio login');
  const loginLayout = await evaluate(client, `(() => {
    const form = document.querySelector('.studio-login-form');
    const input = form.querySelector('input[type="password"]');
    const button = form.querySelector('button[type="submit"]');
    const loadingBar = document.querySelector('.studio-loading-mark i');
    return {
      width: form.getBoundingClientRect().width,
      height: form.getBoundingClientRect().height,
      inputHeight: input.getBoundingClientRect().height,
      buttonHeight: button.getBoundingClientRect().height,
      loadingAnimation: getComputedStyle(loadingBar).animationName,
    };
  })()`);
  assert(loginLayout.width <= 430 && loginLayout.height <= 430, `Studio login should stay compact: ${JSON.stringify(loginLayout)}`);
  assert(loginLayout.inputHeight <= 56 && loginLayout.buttonHeight <= 56, `Studio login controls should not stretch: ${JSON.stringify(loginLayout)}`);
  assert(loginLayout.loadingAnimation === 'studio-loading-pulse', `Studio loading indicator should be animated: ${JSON.stringify(loginLayout)}`);
  await evaluate(client, `(() => {
    const form = document.querySelector('.studio-login-form');
    form.querySelector('input[name="password"]').value = ${JSON.stringify(ADMIN_PASSWORD)};
    form.requestSubmit();
  })()`);
  await waitFor(client, '!document.querySelector("[data-studio-admin]")?.hidden && document.querySelector(".studio-photo-tile")', 'authenticated Studio');
  checkpoints.push(await evaluate(client, `({ step: 'login', href: location.href, mode: document.querySelector('.gallery-shell')?.dataset.mode })`));
  await evaluate(client, `Promise.all([...document.images].slice(0, 12).map((image) => image.decode?.().catch(() => {})))`);

  const desktop = await evaluate(client, `(() => {
    const dashboard = document.querySelector('.studio-dashboard');
    const tile = document.querySelector('.studio-photo-tile');
    const grid = document.querySelector('.studio-photo-grid');
    const adminBody = document.querySelector('[data-studio-admin-body]');
    const admin = document.querySelector('[data-studio-admin]');
    const columns = getComputedStyle(dashboard).gridTemplateColumns.split(' ').filter(Boolean);
    return {
      columns: columns.length,
      dashboardOverflow: getComputedStyle(dashboard).overflow,
      gridOverflowY: getComputedStyle(grid).overflowY,
      photoForms: document.querySelectorAll('.studio-photo-form').length,
      tiles: document.querySelectorAll('.studio-photo-tile').length,
      tileRatio: tile.getBoundingClientRect().width / tile.querySelector('.studio-photo-thumb').getBoundingClientRect().height,
      bodyOverflow: document.documentElement.scrollWidth - innerWidth,
      galleryChromeHidden: getComputedStyle(document.querySelector('.about-link')).opacity === '0',
      gridClientHeight: grid.clientHeight,
      gridScrollHeight: grid.scrollHeight,
      dashboardBottomGap: Math.abs(adminBody.getBoundingClientRect().bottom - dashboard.getBoundingClientRect().bottom),
      adminBodyBottomGap: Math.abs(admin.getBoundingClientRect().bottom - adminBody.getBoundingClientRect().bottom),
      coloredAlbumLinks: [...document.querySelectorAll('.studio-album-nav button[style]')].filter((button) => button.style.getPropertyValue('--album-color')).length,
    };
  })()`);
  assert(desktop.columns === 3, `Desktop dashboard should have 3 columns: ${JSON.stringify(desktop)}`);
  assert(desktop.photoForms === 0, `Studio should not render photo forms before selection: ${JSON.stringify(desktop)}`);
  assert(desktop.tiles > 0, `Studio should render photo tiles: ${JSON.stringify(desktop)}`);
  assert(desktop.bodyOverflow <= 1, `Desktop Studio overflows horizontally: ${JSON.stringify(desktop)}`);
  assert(desktop.galleryChromeHidden, `Gallery chrome should be hidden in Studio: ${JSON.stringify(desktop)}`);
  assert(desktop.gridScrollHeight > desktop.gridClientHeight, `Photo grid should be scrollable: ${JSON.stringify(desktop)}`);
  assert(desktop.dashboardBottomGap <= 1 && desktop.adminBodyBottomGap <= 1, `Studio dashboard should fill the available height: ${JSON.stringify(desktop)}`);
  assert(desktop.coloredAlbumLinks >= 3, `Album navigation should reflect album theme colors: ${JSON.stringify(desktop)}`);

  await evaluate(client, `document.querySelector('[data-action="studio-toggle-create"]').click()`);
  await waitFor(client, 'document.querySelector("[data-studio-create-dialog]")?.open', 'create album dialog');
  const dialog = await evaluate(client, `({
    open: document.querySelector('[data-studio-create-dialog]')?.open,
    modalForm: Boolean(document.querySelector('[data-studio-create-dialog] .studio-group-form')),
    sidebarForm: Boolean(document.querySelector('.studio-sidebar .studio-group-form')),
    accentControl: Boolean(document.querySelector('[data-studio-create-dialog] input[name="accentColor"][type="color"]')),
  })`);
  assert(dialog.open && dialog.modalForm && !dialog.sidebarForm && dialog.accentControl, `Create album should use a modal dialog with a theme color control: ${JSON.stringify(dialog)}`);
  await screenshot(client, '/tmp/studio-ui-v3-dialog.png');
  await evaluate(client, `document.querySelector('[data-action="studio-close-create"]').click()`);
  await waitFor(client, '!document.querySelector("[data-studio-create-dialog]")', 'closed create album dialog');

  const wheel = await evaluate(client, `(() => {
    const grid = document.querySelector('.studio-photo-grid');
    const before = grid.scrollTop;
    document.querySelector('.studio-workspace-head').dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 360 }));
    return { before, after: grid.scrollTop };
  })()`);
  assert(wheel.after > wheel.before, `Wheel over Studio toolbar should scroll photos: ${JSON.stringify(wheel)}`);

  await evaluate(client, `document.querySelectorAll('[data-studio-photo-select]')[7].click()`);
  await waitFor(client, 'document.querySelectorAll(".studio-photo-form").length === 1', 'single photo inspector');
  checkpoints.push(await evaluate(client, `({ step: 'select', href: location.href, mode: document.querySelector('.gallery-shell')?.dataset.mode })`));
  const selection = await evaluate(client, `({
    forms: document.querySelectorAll('.studio-photo-form').length,
    selected: document.querySelectorAll('.studio-photo-tile.is-selected').length,
    inspectorVisible: document.querySelector('.studio-inspector-preview')?.getBoundingClientRect().height > 0,
    scrollTop: document.querySelector('.studio-photo-grid').scrollTop,
  })`);
  assert(selection.forms === 1 && selection.selected === 1 && selection.inspectorVisible, `Photo selection failed: ${JSON.stringify(selection)}`);

  await setViewport(client, 1920, 760);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const inspectorScroll = await evaluate(client, `(() => {
    const inspector = document.querySelector('.studio-inspector');
    const before = inspector.scrollTop;
    inspector.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 420 }));
    return {
      before,
      after: inspector.scrollTop,
      clientHeight: inspector.clientHeight,
      scrollHeight: inspector.scrollHeight,
      overflowY: getComputedStyle(inspector).overflowY,
    };
  })()`);
  assert(inspectorScroll.scrollHeight > inspectorScroll.clientHeight && inspectorScroll.after > inspectorScroll.before, `Photo inspector should scroll independently: ${JSON.stringify(inspectorScroll)}`);
  await setViewport(client, 1920, 1080);

  await evaluate(client, `(() => {
    const search = document.querySelector('[data-studio-search]');
    search.value = '__nothing_matches__';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const search = await evaluate(client, `({
    visible: [...document.querySelectorAll('.studio-photo-tile')].filter((tile) => !tile.hidden).length,
    empty: !document.querySelector('[data-studio-search-empty]').hidden,
  })`);
  assert(search.visible === 0 && search.empty, `Photo search empty state failed: ${JSON.stringify(search)}`);
  await evaluate(client, `document.querySelector('[data-action="studio-clear-search"]').click()`);

  await evaluate(client, `(() => {
    const checks = document.querySelectorAll('[data-studio-photo-check]');
    checks[0].click();
    document.querySelectorAll('[data-studio-photo-check]')[1].click();
  })()`);
  await waitFor(client, 'document.querySelectorAll(".studio-photo-tile.is-checked").length === 2', 'multi-selection');
  const batch = await evaluate(client, `({
    checked: document.querySelectorAll('.studio-photo-tile.is-checked').length,
    visible: !document.querySelector('.studio-batch-bar').hidden,
    actions: document.querySelectorAll('.studio-batch-actions button').length,
  })`);
  assert(batch.checked === 2 && batch.visible && batch.actions >= 5, `Batch toolbar failed: ${JSON.stringify(batch)}`);
  await screenshot(client, '/tmp/studio-ui-v2-desktop.png');
  await evaluate(client, `document.querySelector('[data-action="studio-bulk-hide"]').click()`);
  await waitFor(client, 'document.querySelector(".studio-batch-bar")?.hidden', 'batch hide completion', 20000);
  const bulkMutation = await evaluate(client, `fetch('/api/admin/gallery', { cache: 'no-store' }).then((response) => response.json()).then((gallery) => ({ hidden: gallery.photos.filter((photo) => photo.status === 'hidden').length }))`);
  assert(bulkMutation.hidden >= 2, `Batch hide did not persist: ${JSON.stringify(bulkMutation)}`);

  await evaluate(client, `document.querySelector('[data-action="studio-density-compact"]').click()`);
  await waitFor(client, 'document.querySelector(".studio-photo-grid")?.classList.contains("is-compact")', 'compact grid');
  await evaluate(client, `document.querySelector('[data-action="studio-toggle-upload"]').click()`);
  await waitFor(client, '!document.querySelector(".studio-upload-panel")?.hidden', 'upload panel');
  checkpoints.push(await evaluate(client, `({ step: 'upload', href: location.href, mode: document.querySelector('.gallery-shell')?.dataset.mode })`));
  assert(checkpoints.every((item) => item.mode === 'studio' && new URL(item.href).pathname === '/studio'), `Studio navigation changed unexpectedly: ${JSON.stringify(checkpoints)}`);

  await setViewport(client, 390, 844, 2);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const mobile = await evaluate(client, `(() => {
    const header = document.querySelector('.studio-admin-head').getBoundingClientRect();
    const brand = document.querySelector('.studio-brand').getBoundingClientRect();
    const actions = document.querySelector('.studio-admin-actions').getBoundingClientRect();
    const tiles = [...document.querySelectorAll('.studio-photo-tile')].filter((tile) => !tile.hidden);
    return {
      bodyOverflow: document.documentElement.scrollWidth - innerWidth,
      headerOverlap: Math.max(0, brand.right - actions.left),
      tileColumns: new Set(tiles.slice(0, 4).map((tile) => Math.round(tile.getBoundingClientRect().left))).size,
      viewport: [innerWidth, innerHeight],
    };
  })()`);
  assert(mobile.bodyOverflow <= 1, `Mobile Studio overflows horizontally: ${JSON.stringify(mobile)}`);
  assert(mobile.headerOverlap <= 1, `Mobile Studio header overlaps: ${JSON.stringify(mobile)}`);
  assert(mobile.tileColumns <= 2, `Mobile photo grid should use at most 2 columns: ${JSON.stringify(mobile)}`);
  await screenshot(client, '/tmp/studio-ui-v2-mobile.png');

  await setViewport(client, 1920, 1080);
  await evaluate(client, `document.querySelector('[data-action="close-studio"]').click()`);
  await waitFor(client, 'document.querySelector(".gallery-shell")?.dataset.mode === "index"', 'gallery index');
  await evaluate(client, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await waitFor(client, 'document.querySelector(".gallery-shell")?.dataset.mode === "detail"', 'album detail');
  await new Promise((resolve) => setTimeout(resolve, 1800));
  const galleryDetail = await evaluate(client, `({
    date: document.querySelector('[data-meta-date]')?.textContent.trim(),
    count: document.querySelector('[data-meta-count]')?.textContent.trim(),
    access: document.querySelector('[data-meta-access]')?.textContent.trim(),
    description: document.querySelector('[data-shadow-description]')?.textContent.trim(),
    nav: document.querySelector('.project-nav')?.textContent.trim(),
    action: document.querySelector('.visit-label-detail')?.textContent.replace(/\\s+/g, ''),
    paletteMode: document.querySelector('.gallery-shell')?.dataset.paletteMode,
  })`);
  assert(/^\d{4}\.\d{2}\.\d{2}$/.test(galleryDetail.date), `Gallery detail should show a real update date: ${JSON.stringify(galleryDetail)}`);
  assert(/^\d+ PHOTOS$/.test(galleryDetail.count) && galleryDetail.access === 'PUBLIC ALBUM', `Gallery detail should show album facts: ${JSON.stringify(galleryDetail)}`);
  assert(galleryDetail.description && galleryDetail.description !== 'CURATED PHOTO ALBUM' && galleryDetail.nav === 'ALBUMS', `Gallery detail should use album content and navigation labels: ${JSON.stringify(galleryDetail)}`);
  assert(galleryDetail.action === 'VIEWPHOTOS' && galleryDetail.paletteMode === 'detail', `Gallery detail action and palette should be active: ${JSON.stringify(galleryDetail)}`);
  await screenshot(client, '/tmp/gallery-album-detail.png');

  await send(client, 'Network.setBlockedURLs', { urls: ['*large*'] });
  await evaluate(client, `(() => {
    window.__workLoadStartedAt = performance.now();
    document.querySelector('[data-action="next-photo"]').click();
  })()`);
  await waitFor(client, 'document.querySelector(".gallery-shell")?.dataset.mode === "work"', 'work view');
  await waitFor(client, 'document.querySelector(".work-layer.is-active .work-layer-img")?.dataset.loaded === "true"', 'progressive work preview', 1500);
  const workPreview = await evaluate(client, `(() => {
    const image = document.querySelector('.work-layer.is-active .work-layer-img');
    return {
      elapsed: performance.now() - window.__workLoadStartedAt,
      loaded: image?.dataset.loaded,
      quality: image?.dataset.quality,
      hasSource: Boolean(image?.currentSrc && image.currentSrc !== 'data:,'),
    };
  })()`);
  assert(workPreview.loaded === 'true' && workPreview.hasSource && workPreview.quality === 'preview' && workPreview.elapsed < 1500, `Work view should reveal a cached preview when the large image is unavailable: ${JSON.stringify(workPreview)}`);
  await screenshot(client, '/tmp/gallery-work-preview.png');
  await send(client, 'Network.setBlockedURLs', { urls: [] });

  console.log(JSON.stringify({
    ok: failures.length === 0,
    screenshots: ['/tmp/studio-ui-v3-dialog.png', '/tmp/studio-ui-v2-desktop.png', '/tmp/studio-ui-v2-mobile.png', '/tmp/gallery-album-detail.png', '/tmp/gallery-work-preview.png'],
    desktop,
    loginLayout,
    dialog,
    wheel,
    selection,
    inspectorScroll,
    search,
    batch,
    bulkMutation,
    mobile,
    galleryDetail,
    initialPreload,
    workPreview,
    checkpoints,
    failures,
  }, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  client.socket.close();
  if (fixture) {
    fixture.child.kill('SIGTERM');
    await rm(fixture.tempRoot, { force: true, recursive: true });
  }
}
