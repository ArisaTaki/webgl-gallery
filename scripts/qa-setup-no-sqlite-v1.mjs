import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ADMIN_PASSWORD = 'json-admin-secret';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gallery-no-sqlite-v1-'));
const dataDir = path.join(tempRoot, 'data');
const mediaDir = path.join(tempRoot, 'media');
const originalDir = path.join(tempRoot, 'originals');
const uploadDir = path.join(tempRoot, 'uploads');
const manifestPath = path.join(dataDir, 'photos.json');
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
      GALLERY_DISABLE_SQLITE: '1',
      GALLERY_MEDIA_DIR: mediaDir,
      GALLERY_ORIGINAL_DIR: originalDir,
      GALLERY_UPLOAD_DIR: uploadDir,
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
  const photosBefore = await fetchJson('/api/photos');
  const sqliteAttempt = await postJson('/api/setup/save', {
    adminPassword: ADMIN_PASSWORD,
    databaseKind: 'sqlite',
    mediaDir,
    originalDir,
    sqlitePath,
    storageKind: 'local',
  });
  const jsonSaved = await postJson('/api/setup/save', {
    adminPassword: ADMIN_PASSWORD,
    databaseKind: 'json',
    manifestPath,
    mediaDir,
    originalDir,
    storageKind: 'local',
  });
  const login = await postJson('/api/admin/login', { password: ADMIN_PASSWORD });
  const config = JSON.parse(await readFile(configPath, 'utf8'));

  const failures = [];
  if (before.configured !== false || before.database.kind !== 'json' || before.database.sqliteAvailable !== false) {
    failures.push(`Expected JSON fallback when SQLite is unavailable, got ${JSON.stringify(before)}.`);
  }
  if (!Array.isArray(photosBefore)) failures.push('/api/photos should work without SQLite.');
  if (sqliteAttempt.status !== 400 || !String(sqliteAttempt.body?.message || '').includes('Local SQLite needs')) {
    failures.push(`Expected SQLite setup to explain unavailable runtime, got ${JSON.stringify(sqliteAttempt)}.`);
  }
  if (jsonSaved.status !== 200 || jsonSaved.body?.configured !== true || jsonSaved.body?.database?.kind !== 'json') {
    failures.push(`Expected JSON setup save to succeed, got ${JSON.stringify(jsonSaved)}.`);
  }
  if (login.status !== 200 || login.body?.authenticated !== true) {
    failures.push(`Expected JSON fallback admin password to work, got ${JSON.stringify(login)}.`);
  }
  if (config.database?.kind !== 'json' || config.database?.manifestPath !== manifestPath) {
    failures.push(`Expected JSON config to persist, got ${JSON.stringify(config)}.`);
  }

  const report = {
    ok: failures.length === 0,
    tempRoot,
    serverUrl,
    serverOutput: output.join('').split('\n').filter(Boolean).slice(-8),
    before,
    sqliteAttempt: {
      status: sqliteAttempt.status,
      message: sqliteAttempt.body?.message,
    },
    jsonSaved: {
      status: jsonSaved.status,
      configured: jsonSaved.body?.configured,
      database: jsonSaved.body?.database,
    },
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

async function fetchJson(pathname) {
  const response = await fetch(`${serverUrl}${pathname}`);
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
  };
}
