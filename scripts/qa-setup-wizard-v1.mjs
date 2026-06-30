import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ADMIN_PASSWORD = 'setup-admin-secret';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gallery-setup-v1-'));
const dataDir = path.join(tempRoot, 'data');
const mediaDir = path.join(tempRoot, 'media');
const originalDir = path.join(tempRoot, 'originals');
const uploadDir = path.join(tempRoot, 'uploads');
const sqlitePath = path.join(tempRoot, '.gallery', 'gallery.sqlite');
const configPath = path.join(tempRoot, '.gallery', 'config.json');
const port = await getFreePort();
const serverUrl = `http://127.0.0.1:${port}`;
const root = path.resolve(new URL('..', import.meta.url).pathname);
const tsxBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');

let child;

try {
  await mkdir(dataDir, { recursive: true });
  child = spawn(tsxBin, ['server/index.ts'], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: '',
      GALLERY_CONFIG_PATH: configPath,
      GALLERY_DATA_DIR: dataDir,
      GALLERY_DISABLE_HMR: '1',
      GALLERY_MEDIA_DIR: mediaDir,
      GALLERY_ORIGINAL_DIR: originalDir,
      GALLERY_UPLOAD_DIR: uploadDir,
      GALLERY_UPLOAD_KEY: 'old-key',
      NODE_ENV: 'production',
      PORT: String(port),
      R2_ACCOUNT_ID: '',
      R2_ACCESS_KEY_ID: '',
      R2_PRIVATE_BUCKET: '',
      R2_PUBLIC_BASE_URL: '',
      R2_PUBLIC_BUCKET: '',
      R2_SECRET_ACCESS_KEY: '',
      SESSION_SECRET: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));

  await waitForServer(serverUrl);

  const before = await fetchJson('/api/setup/status');
  const saved = await postJson('/api/setup/save', {
    adminPassword: ADMIN_PASSWORD,
    databaseKind: 'sqlite',
    mediaDir,
    originalDir,
    sqlitePath,
    storageKind: 'local',
  });
  const after = await fetchJson('/api/setup/status');
  const blockedSave = await postJson('/api/setup/save', { storageKind: 'local' });
  const login = await loginJson('/api/admin/login', { password: ADMIN_PASSWORD });
  const unlockedStatus = await fetchJson('/api/setup/status', { Cookie: login.cookie });
  const photos = await fetchJson('/api/photos');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  await access(sqlitePath);

  const failures = [];
  if (before.configured !== false || before.database.kind !== 'sqlite' || before.storage.kind !== 'local') {
    failures.push(`Expected first-run local setup status, got ${JSON.stringify(before)}.`);
  }
  if (saved.configured !== true || saved.database.kind !== 'sqlite' || saved.storage.kind !== 'local') {
    failures.push(`Expected saved local setup status, got ${JSON.stringify(saved)}.`);
  }
  if (after.configured !== true || after.locked !== true || after.auth.hasAdminPassword !== true) {
    failures.push(`Expected persisted setup status to be locked for guests, got ${JSON.stringify(after)}.`);
  }
  if (after.storage?.mediaDir || after.storage?.originalDir || after.database?.sqlitePath) {
    failures.push(`Expected locked setup status to redact local paths, got ${JSON.stringify(after)}.`);
  }
  if (blockedSave.status !== 401) {
    failures.push(`Expected configured setup save to require admin login, got ${JSON.stringify(blockedSave)}.`);
  }
  if (login.status !== 200 || login.body?.authenticated !== true) {
    failures.push(`Expected new admin password to work, got ${JSON.stringify(login)}.`);
  }
  if (unlockedStatus.locked || unlockedStatus.storage?.mediaDir !== mediaDir || unlockedStatus.database?.sqlitePath !== sqlitePath) {
    failures.push(`Expected admin setup status to include full config, got ${JSON.stringify(unlockedStatus)}.`);
  }
  if (!Array.isArray(photos)) failures.push('/api/photos should stay a flat array after setup.');
  if (config.database?.kind !== 'sqlite' || config.storage?.kind !== 'local' || !config.auth?.adminPasswordHash) {
    failures.push(`Expected config file to persist local sqlite setup, got ${JSON.stringify(config)}.`);
  }

  const report = {
    ok: failures.length === 0,
    tempRoot,
    serverUrl,
    serverOutput: output.join('').split('\n').filter(Boolean).slice(-8),
    before,
    saved: {
      configured: saved.configured,
      database: saved.database,
      storage: saved.storage,
      auth: saved.auth,
    },
    after,
    unlockedStatus: {
      configured: unlockedStatus.configured,
      locked: unlockedStatus.locked || false,
      database: unlockedStatus.database,
      storage: unlockedStatus.storage,
    },
    photos: photos.length,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  child?.kill();
  if (!process.env.KEEP_SETUP_QA_TMP) {
    await rm(tempRoot, { force: true, recursive: true }).catch(() => {});
  }
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port: chosenPort } = server.address();
      server.close(() => resolve(chosenPort));
    });
  });
}

async function waitForServer(url) {
  const started = Date.now();
  while (Date.now() - started < 18000) {
    try {
      const response = await fetch(`${url}/api/setup/status`);
      if (response.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`Timed out waiting for isolated server at ${url}.`);
}

async function fetchJson(pathname, headers = {}) {
  const response = await fetch(`${serverUrl}${pathname}`, { headers });
  return response.json();
}

async function postJson(pathname, payload) {
  const response = await fetch(`${serverUrl}${pathname}`, {
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  return {
    body: await response.json(),
    status: response.status,
    get ok() {
      return this.body?.ok;
    },
    get configured() {
      return this.body?.configured;
    },
    get database() {
      return this.body?.database;
    },
    get storage() {
      return this.body?.storage;
    },
    get auth() {
      return this.body?.auth;
    },
  };
}

async function loginJson(pathname, payload) {
  const response = await fetch(`${serverUrl}${pathname}`, {
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  return {
    body: await response.json(),
    cookie: response.headers.get('set-cookie')?.split(';')[0] || '',
    status: response.status,
  };
}
