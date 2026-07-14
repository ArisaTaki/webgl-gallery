import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
      GALLERY_ADMIN_PASSWORD_HASH: createPasswordHash(ADMIN_PASSWORD),
      GALLERY_UPLOAD_KEY: '',
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
  const removedDefaultLogin = await postJson('/api/admin/login', { password: '13209' });
  const legacyUploadDisabledResponse = await fetch(`${serverUrl}/api/upload`, {
    headers: { 'X-Gallery-Key': '13209' },
    method: 'POST',
  });
  const legacyUploadDisabled = { status: legacyUploadDisabledResponse.status, body: await legacyUploadDisabledResponse.json() };
  const rightLogin = await fetch(`${serverUrl}/api/admin/login`, {
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const loginSetCookie = rightLogin.headers.get('set-cookie') || '';
  const cookie = loginSetCookie.split(';')[0] || '';
  const loginBody = await rightLogin.json();
  const proxiedLogin = await fetch(`${serverUrl}/api/admin/login`, {
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-Proto': 'https',
    },
    method: 'POST',
  });
  const proxiedSetCookie = proxiedLogin.headers.get('set-cookie') || '';
  await proxiedLogin.json();

  const groupCreate = await adminJson(cookie, '/api/admin/groups', {
    body: JSON.stringify({ title: 'Family Days', slug: 'family-days', description: 'Shared album', accentColor: '#4466aa' }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const groupId = groupCreate.group.id;

  const failedBatchForm = new FormData();
  failedBatchForm.append('groupId', groupId);
  failedBatchForm.append('photos', new Blob([await readFile(inputPath)], { type: 'image/png' }), 'valid.png');
  failedBatchForm.append('photos', new Blob([Buffer.from('not an image')], { type: 'image/png' }), 'broken.png');
  const failedBatch = await adminRequest(cookie, '/api/admin/photos', { body: failedBatchForm, method: 'POST' });
  const galleryAfterFailedBatch = await adminJson(cookie, '/api/admin/gallery');
  const mediaAfterFailedBatch = await readdir(mediaDir, { recursive: true }).catch(() => []);

  const uploadForm = new FormData();
  uploadForm.append('groupId', groupId);
  uploadForm.append('titlePrefix', 'Morning Light');
  uploadForm.append('description', 'Window and tiny hands');
  uploadForm.append('capturedAt', '2026-06-25');
  uploadForm.append('photos', new Blob([await readFile(inputPath)], { type: 'image/png' }), 'admin sample.png');
  uploadForm.append('photos', new Blob([await readFile(inputPath)], { type: 'image/png' }), 'admin sample 2.png');
  const upload = await adminJson(cookie, '/api/admin/photos', {
    body: uploadForm,
    method: 'POST',
  });
  const photo = upload.addedPhotos[0];
  const archiveGroup = await adminJson(cookie, '/api/admin/groups', {
    body: JSON.stringify({ title: 'Archive', slug: 'archive', accentColor: '#778899' }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const archiveForm = new FormData();
  archiveForm.append('groupId', archiveGroup.group.id);
  archiveForm.append('titlePrefix', 'Archive');
  archiveForm.append('photos', new Blob([await readFile(inputPath)], { type: 'image/png' }), 'archive sample.png');
  const archiveUpload = await adminJson(cookie, '/api/admin/photos', {
    body: archiveForm,
    method: 'POST',
  });
  const continuedForm = new FormData();
  continuedForm.append('groupId', groupId);
  continuedForm.append('titlePrefix', 'Morning Light');
  continuedForm.append('photos', new Blob([await readFile(inputPath)], { type: 'image/png' }), 'continued sample.png');
  const continuedUpload = await adminJson(cookie, '/api/admin/photos', {
    body: continuedForm,
    method: 'POST',
  });
  await adminJson(cookie, `/api/admin/photos/${continuedUpload.addedPhotos[0].id}`, { method: 'DELETE' });
  const patch = await adminJson(cookie, `/api/admin/photos/${photo.id}`, {
    body: JSON.stringify({ title: 'Morning Light Edited', description: 'Edited copy', sortOrder: 7, visitUrl: 'javascript:alert(1)' }),
    headers: { 'Content-Type': 'application/json' },
    method: 'PATCH',
  });
  const reprocess = await adminRequest(cookie, `/api/admin/photos/${photo.id}/reprocess`, { method: 'POST' });
  const publicGallery = await fetchJson('/api/gallery?group=family-days');
  const variants = await inspectVariants(publicGallery.photos[0]);
  const missingMedia = await fetch(`${serverUrl}/media/does-not-exist.webp`);
  const deleted = [];
  for (const uploadedPhoto of upload.addedPhotos) {
    deleted.push(await adminJson(cookie, `/api/admin/photos/${uploadedPhoto.id}`, { method: 'DELETE' }));
  }
  await adminJson(cookie, `/api/admin/photos/${archiveUpload.addedPhotos[0].id}`, { method: 'DELETE' });
  const deleteArchiveGroup = await adminJson(cookie, `/api/admin/groups/${archiveGroup.group.id}`, { method: 'DELETE' });
  const deleteGroup = await adminJson(cookie, `/api/admin/groups/${groupId}`, { method: 'DELETE' });

  const failures = [];
  if (sessionBefore.authenticated !== false) failures.push(`Expected unauthenticated session, got ${JSON.stringify(sessionBefore)}.`);
  if (wrongLogin.status !== 401) failures.push(`Expected wrong login 401, got ${JSON.stringify(wrongLogin)}.`);
  if (removedDefaultLogin.status !== 401) failures.push(`Expected removed default password to return 401, got ${JSON.stringify(removedDefaultLogin)}.`);
  if (legacyUploadDisabled.status !== 404) failures.push(`Expected unconfigured legacy upload to return 404, got ${JSON.stringify(legacyUploadDisabled)}.`);
  if (!loginBody.ok || !cookie) failures.push(`Expected login cookie, got body=${JSON.stringify(loginBody)} cookie=${cookie}.`);
  if (/;\s*Secure/i.test(loginSetCookie)) failures.push(`Expected direct HTTP login cookie to omit Secure, got ${loginSetCookie}.`);
  if (!/;\s*Secure/i.test(proxiedSetCookie)) failures.push(`Expected HTTPS-proxied login cookie to include Secure, got ${proxiedSetCookie}.`);
  if (groupCreate.group.slug !== 'family-days' || groupCreate.group.accentColor !== '#4466aa') {
    failures.push(`Expected group slug and accent color to persist, got ${JSON.stringify(groupCreate)}.`);
  }
  if (failedBatch.status !== 415 || galleryAfterFailedBatch.photos.length !== 0 || mediaAfterFailedBatch.some((item) => item.endsWith('.webp'))) {
    failures.push(`Expected failed mixed batch to roll back metadata and assets, got ${JSON.stringify({ failedBatch, galleryAfterFailedBatch, mediaAfterFailedBatch })}.`);
  }
  if (upload.count !== 2 || upload.uploadedCount !== 2 || upload.addedPhotos?.length !== 2) failures.push(`Expected two newly uploaded photos, got ${JSON.stringify(upload)}.`);
  if (upload.addedPhotos?.map((item) => item.title).join('|') !== 'Morning Light 001|Morning Light 002') {
    failures.push(`Expected continuous batch numbering, got ${JSON.stringify(upload.addedPhotos?.map((item) => item.title))}.`);
  }
  if (archiveUpload.addedPhotos?.[0]?.title !== 'Archive 001') {
    failures.push(`Expected title numbering to restart in a different album, got ${JSON.stringify(archiveUpload.addedPhotos?.[0])}.`);
  }
  if (continuedUpload.addedPhotos?.[0]?.title !== 'Morning Light 003') {
    failures.push(`Expected repeated prefixes to continue within the same album, got ${JSON.stringify(continuedUpload.addedPhotos?.[0])}.`);
  }
  if (upload.addedPhotos[0]?.group !== 'family-days' || upload.addedPhotos[0]?.canReprocess !== false) {
    failures.push(`Expected uploaded public photo in family-days without an original asset, got ${JSON.stringify(upload.addedPhotos[0])}.`);
  }
  if (patch.photo.title !== 'Morning Light Edited' || patch.photo.visitUrl !== '') failures.push(`Expected patched title and rejected unsafe URL, got ${JSON.stringify(patch)}.`);
  if (reprocess.status !== 409 || !String(reprocess.body?.message || '').includes('Original asset is not available')) {
    failures.push(`Expected reprocess without an original asset to return 409, got ${JSON.stringify(reprocess)}.`);
  }
  if (publicGallery.count !== 2 || !publicGallery.groups.some((group) => group.slug === 'family-days' && group.accentColor === '#4466aa')) {
    failures.push(`Expected filtered public gallery count 2 with family-days group, got ${JSON.stringify(publicGallery)}.`);
  }
  if (missingMedia.status !== 404 || String(missingMedia.headers.get('content-type')).includes('text/html')) {
    failures.push(`Expected missing media to return a non-HTML 404, got ${missingMedia.status} ${missingMedia.headers.get('content-type')}.`);
  }
  for (const [kind, width] of [['thumb', 520], ['medium', 1280], ['large', 1800]]) {
    if (variants[kind]?.width !== width || variants[kind]?.format !== 'webp') {
      failures.push(`Expected ${kind} ${width}px webp, got ${JSON.stringify(variants[kind])}.`);
    }
  }
  if (!deleted.every((item) => item.ok) || !deleteArchiveGroup.ok || !deleteGroup.ok) {
    failures.push(`Expected delete photos/groups ok, got ${JSON.stringify({ deleted, deleteArchiveGroup, deleteGroup })}.`);
  }

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

function createPasswordHash(password) {
  const salt = 'qa-admin-api-v112';
  return `scrypt:${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}
