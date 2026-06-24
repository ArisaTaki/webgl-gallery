import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const UPLOAD_KEY = 'qa-secret-13209';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'nian-upload-v106-'));
const dataDir = path.join(tempRoot, 'data');
const mediaDir = path.join(tempRoot, 'media');
const uploadDir = path.join(tempRoot, 'uploads');
const inputDir = path.join(tempRoot, 'input');
const inputPath = path.join(inputDir, 'upload sample.png');
const port = await getFreePort();
const serverUrl = `http://127.0.0.1:${port}`;

let child;

try {
  await mkdir(inputDir, { recursive: true });
  await sharp({
    create: {
      width: 3000,
      height: 2000,
      channels: 3,
      background: { r: 142, g: 171, b: 188 },
    },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="3000" height="2000" xmlns="http://www.w3.org/2000/svg"><rect x="340" y="260" width="620" height="420" fill="#f3d6a0"/><circle cx="2060" cy="1040" r="440" fill="#5a796b"/><rect x="1030" y="1260" width="1100" height="260" fill="#29384a"/></svg>',
        ),
      },
    ])
    .png()
    .toFile(inputPath);

  child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.resolve(new URL('..', import.meta.url).pathname),
    env: {
      ...process.env,
      GALLERY_DATA_DIR: dataDir,
      GALLERY_DISABLE_HMR: '1',
      GALLERY_MEDIA_DIR: mediaDir,
      GALLERY_UPLOAD_DIR: uploadDir,
      GALLERY_UPLOAD_KEY: UPLOAD_KEY,
      NODE_ENV: 'production',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));

  await waitForServer(serverUrl);

  const emptyManifest = await fetchJson(`${serverUrl}/api/photos`);
  const wrongKey = await uploadPhoto({ key: 'wrong-key', titlePrefix: 'QA Kid' });
  const tempAfterWrongKey = await readdir(uploadDir).catch(() => []);
  const rightKey = await uploadPhoto({ key: UPLOAD_KEY, titlePrefix: 'QA Kid' });
  const manifest = await fetchJson(`${serverUrl}/api/photos`);
  const tempAfterRightKey = await readdir(uploadDir).catch(() => []);

  const photo = manifest.photos?.[0];
  const variants = await inspectVariants(photo);
  const failures = [];

  if (emptyManifest.count !== 0) failures.push(`Expected isolated manifest to start empty, got ${JSON.stringify(emptyManifest)}.`);
  if (wrongKey.status !== 401 || wrongKey.body?.ok !== false) {
    failures.push(`Expected wrong upload key to return 401 false, got ${JSON.stringify(wrongKey)}.`);
  }
  if (tempAfterWrongKey.length) failures.push(`Expected wrong-key temp upload cleanup, got ${tempAfterWrongKey.join(', ')}.`);
  if (rightKey.status !== 200 || rightKey.body?.ok !== true || rightKey.body?.count !== 1) {
    failures.push(`Expected successful upload count 1, got ${JSON.stringify(rightKey)}.`);
  }
  if (manifest.count !== 1 || manifest.photos?.length !== 1) {
    failures.push(`Expected persisted upload manifest count 1, got ${JSON.stringify(manifest)}.`);
  }
  if (photo?.group !== 'upload' || photo?.index !== 1 || photo?.title !== 'QA Kid 001') {
    failures.push(`Expected upload metadata group/index/title, got ${JSON.stringify(photo)}`);
  }
  if (!photo?.blurDataUrl?.startsWith('data:image/webp;base64,')) {
    failures.push(`Expected webp blurDataUrl, got ${photo?.blurDataUrl?.slice(0, 32)}`);
  }
  for (const variant of [
    ['thumb', 520],
    ['medium', 1280],
    ['large', 2200],
  ]) {
    const [key, expectedWidth] = variant;
    if (variants[key]?.width !== expectedWidth) {
      failures.push(`Expected ${key} width ${expectedWidth}, got ${JSON.stringify(variants[key])}.`);
    }
    if (variants[key]?.format !== 'webp') {
      failures.push(`Expected ${key} webp output, got ${JSON.stringify(variants[key])}.`);
    }
  }
  if (tempAfterRightKey.length) failures.push(`Expected successful upload temp cleanup, got ${tempAfterRightKey.join(', ')}.`);

  const report = {
    ok: failures.length === 0,
    tempRoot,
    serverUrl,
    serverOutput: output.join('').split('\n').filter(Boolean).slice(-8),
    emptyManifest,
    wrongKey,
    rightKey: {
      status: rightKey.status,
      ok: rightKey.body?.ok,
      count: rightKey.body?.count,
      photos: rightKey.body?.photos?.length,
    },
    manifest: {
      count: manifest.count,
      first: {
        id: photo?.id,
        group: photo?.group,
        index: photo?.index,
        sourceName: photo?.sourceName,
        title: photo?.title,
        width: photo?.width,
        height: photo?.height,
        aspect: Number(photo?.aspect?.toFixed?.(4) || 0),
      },
    },
    variants,
    tempCleanup: {
      afterWrongKey: tempAfterWrongKey,
      afterRightKey: tempAfterRightKey,
    },
    failures,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  if (child) {
    child.kill('SIGTERM');
    await sleep(250);
  }
  if (!process.env.KEEP_UPLOAD_QA_TMP) {
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
    } catch {
      // keep polling while Vite middleware starts
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for isolated server at ${url}.`);
}

async function fetchJson(url) {
  const response = await fetch(url);
  return response.json();
}

async function uploadPhoto({ key, titlePrefix }) {
  const form = new FormData();
  form.append('key', key);
  form.append('titlePrefix', titlePrefix);
  const bytes = await readFile(inputPath);
  form.append('photos', new Blob([bytes], { type: 'image/png' }), 'upload sample.png');
  const response = await fetch(`${serverUrl}/api/upload`, {
    body: form,
    method: 'POST',
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function inspectVariants(photo) {
  const result = {};
  if (!photo) return result;
  for (const key of ['thumb', 'medium', 'large']) {
    const mediaPath = path.join(mediaDir, path.basename(photo[key] || ''));
    const metadata = await sharp(mediaPath).metadata();
    result[key] = {
      format: metadata.format,
      height: metadata.height,
      width: metadata.width,
    };
  }
  return result;
}
