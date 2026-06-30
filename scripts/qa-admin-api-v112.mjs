import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const ADMIN_PASSWORD = 'qa-admin-secret';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gallery-admin-v112-'));
const dataDir = path.join(tempRoot, 'data');
const mediaDir = path.join(tempRoot, 'media');
const originalDir = path.join(tempRoot, 'originals');
const uploadDir = path.join(tempRoot, 'uploads');
const inputDir = path.join(tempRoot, 'input');
const inputPath = path.join(inputDir, 'admin sample.png');
const port = await getFreePort();
const serverUrl = `http://127.0.0.1:${port}`;
const root = path.resolve(new URL('..', import.meta.url).pathname);
const tsxBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');

let child;

try {
  await mkdir(inputDir, { recursive: true });
  await sharp({
    create: {
      width: 1800,
      height: 1200,
      channels: 3,
      background: { r: 122, g: 162, b: 184 },
    },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="1800" height="1200" xmlns="http://www.w3.org/2000/svg"><rect x="250" y="220" width="520" height="380" fill="#f6d59b"/><circle cx="1260" cy="720" r="280" fill="#3f6557"/></svg>',
        ),
      },
    ])
    .png()
    .toFile(inputPath);

  child = spawn(tsxBin, ['server/index.ts'], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: '',
      GALLERY_DATA_DIR: dataDir,
      GALLERY_DISABLE_HMR: '1',
      GALLERY_MEDIA_DIR: mediaDir,
      GALLERY_ORIGINAL_DIR: originalDir,
      GALLERY_UPLOAD_DIR: uploadDir,
      GALLERY_UPLOAD_KEY: ADMIN_PASSWORD,
      NODE_ENV: 'production',
      PORT: String(port),
      R2_ACCOUNT_ID: '',
      R2_ACCESS_KEY_ID: '',
      R2_PRIVATE_BUCKET: '',
      R2_PUBLIC_BASE_URL: '',
      R2_PUBLIC_BUCKET: '',
      R2_SECRET_ACCESS_KEY: '',
      SESSION_SECRET: 'qa-session-secret',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  await waitForServer(serverUrl);

  const sessionBefore = await fetchJson('/api/admin/session');
  const wrongLogin = await postJson('/api/admin/login', { password: 'wrong' });
  const rightLogin = await fetch(`${serverUrl}/api/admin/login`, {
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const cookie = rightLogin.headers.get('set-cookie')?.split(';')[0] || '';
  const loginBody = await rightLogin.json();

  const groupCreate = await adminJson(cookie, '/api/admin/groups', {
    body: JSON.stringify({ title: 'Family Days', slug: 'family-days', description: 'Shared album' }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const groupId = groupCreate.group.id;

  const uploadForm = new FormData();
  uploadForm.append('groupId', groupId);
  uploadForm.append('title', 'Morning Light');
  uploadForm.append('description', 'Window and tiny hands');
  uploadForm.append('capturedAt', '2026-06-25');
  uploadForm.append('photos', new Blob([await readFile(inputPath)], { type: 'image/png' }), 'admin sample.png');
  const upload = await adminJson(cookie, '/api/admin/photos', {
    body: uploadForm,
    method: 'POST',
  });
  const photo = upload.photos[0];
  const patch = await adminJson(cookie, `/api/admin/photos/${photo.id}`, {
    body: JSON.stringify({ title: 'Morning Light Edited', description: 'Edited copy', sortOrder: 7 }),
    headers: { 'Content-Type': 'application/json' },
    method: 'PATCH',
  });
  const reprocess = await adminRequest(cookie, `/api/admin/photos/${photo.id}/reprocess`, { method: 'POST' });
  const publicGallery = await fetchJson('/api/gallery?group=family-days');
  const variants = await inspectVariants(publicGallery.photos[0]);
  const deleted = await adminJson(cookie, `/api/admin/photos/${photo.id}`, { method: 'DELETE' });
  const deleteGroup = await adminJson(cookie, `/api/admin/groups/${groupId}`, { method: 'DELETE' });

  const failures = [];
  if (sessionBefore.authenticated !== false) failures.push(`Expected unauthenticated session, got ${JSON.stringify(sessionBefore)}.`);
  if (wrongLogin.status !== 401) failures.push(`Expected wrong login 401, got ${JSON.stringify(wrongLogin)}.`);
  if (!loginBody.ok || !cookie) failures.push(`Expected login cookie, got body=${JSON.stringify(loginBody)} cookie=${cookie}.`);
  if (groupCreate.group.slug !== 'family-days') failures.push(`Expected group slug family-days, got ${JSON.stringify(groupCreate)}.`);
  if (upload.count !== 1 || upload.photos[0]?.group !== 'family-days') failures.push(`Expected uploaded public photo in family-days, got ${JSON.stringify(upload)}.`);
  if (upload.photos[0]?.canReprocess !== false) failures.push(`Expected new uploads to omit original assets, got ${JSON.stringify(upload.photos[0])}.`);
  if (patch.photo.title !== 'Morning Light Edited') failures.push(`Expected patched title, got ${JSON.stringify(patch)}.`);
  if (reprocess.status !== 409 || !String(reprocess.body?.message || '').includes('Original asset is not available')) {
    failures.push(`Expected reprocess without an original asset to return 409, got ${JSON.stringify(reprocess)}.`);
  }
  if (publicGallery.count !== 1 || !publicGallery.groups.some((group) => group.slug === 'family-days')) {
    failures.push(`Expected filtered public gallery count 1 with family-days group, got ${JSON.stringify(publicGallery)}.`);
  }
  for (const [kind, width] of [['thumb', 520], ['medium', 1280], ['large', 1800]]) {
    if (variants[kind]?.width !== width || variants[kind]?.format !== 'webp') {
      failures.push(`Expected ${kind} ${width}px webp, got ${JSON.stringify(variants[kind])}.`);
    }
  }
  if (!deleted.ok || !deleteGroup.ok) failures.push(`Expected delete photo/group ok, got ${JSON.stringify({ deleted, deleteGroup })}.`);

  console.log(JSON.stringify({
    ok: failures.length === 0,
    tempRoot,
    serverUrl,
    serverOutput: output.join('').split('\n').filter(Boolean).slice(-8),
    group: groupCreate.group,
    photo: { id: photo.id, title: photo.title, group: photo.group, description: photo.description },
    variants,
    failures,
  }, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  if (child) {
    child.kill('SIGTERM');
    await sleep(250);
  }
  if (!process.env.KEEP_ADMIN_QA_TMP) {
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
      const response = await fetch(`${url}/api/photos`);
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
  return { status: response.status, body: await response.json() };
}

async function adminJson(cookie, pathname, options = {}) {
  const result = await adminRequest(cookie, pathname, options);
  if (result.status < 200 || result.status >= 300) throw new Error(`${pathname} failed: ${JSON.stringify(result.body)}`);
  return result.body;
}

async function adminRequest(cookie, pathname, options = {}) {
  const response = await fetch(`${serverUrl}${pathname}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Cookie: cookie,
    },
  });
  const body = await response.json();
  return { status: response.status, body };
}

async function inspectVariants(photo) {
  const result = {};
  if (!photo) return result;
  for (const kind of ['thumb', 'medium', 'large']) {
    const mediaPath = path.join(mediaDir, photo[kind].slice('/media/'.length));
    const metadata = await sharp(mediaPath).metadata();
    result[kind] = {
      format: metadata.format,
      height: metadata.height,
      width: metadata.width,
    };
  }
  return result;
}
