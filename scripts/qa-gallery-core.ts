import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  defaultGroup,
  makeR2Key,
  makeUniqueSlug,
  publicPhotoFromRecord,
  slugify,
} from '../server/galleryUtils.js';
import { buildPhotoDerivatives } from '../server/photoPipeline.js';
import { publicSetupStatus } from '../server/runtimeConfig.js';
import { missingR2ConfigFields, resolveR2Config, verifyLocalStorageConfig, verifyR2StorageConfig } from '../server/storage.js';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gallery-core-'));

try {
  assert.equal(slugify(' 小小 Gallery 01! '), 'gallery-01');
  assert.equal(makeUniqueSlug('photo', ['photo', 'photo-2']), 'photo-3');
  assert.equal(
    makeR2Key({ groupSlug: 'Family Days', photoId: 'Photo 01', kind: 'thumb', fileName: 'Kid 01.webp' }),
    'thumb/family-days/photo-01/kid-01.webp',
  );

  const group = defaultGroup({ title: 'Family' });
  const publicPhoto = publicPhotoFromRecord({
    group,
    photo: {
      id: 'p1',
      groupId: group.id,
      slug: 'first-day',
      title: 'First Day',
      description: 'Tiny hands',
      width: 1200,
      height: 800,
      aspect: 1.5,
      color: 'rgb(10, 20, 30)',
      sortOrder: 1,
      status: 'active',
      blurDataUrl: 'data:image/webp;base64,abc',
    },
    assets: [
      { kind: 'thumb', url: 'https://cdn.example/thumb.webp' },
      { kind: 'medium', url: 'https://cdn.example/medium.webp' },
      { kind: 'large', url: 'https://cdn.example/large.webp' },
    ],
  });
  assert.equal(publicPhoto.group, 'default');
  assert.equal(publicPhoto.description, 'Tiny hands');
  assert.equal(publicPhoto.thumb, 'https://cdn.example/thumb.webp');
  assert.equal(publicPhoto.canReprocess, false);

  const inputPath = path.join(tempRoot, 'sample.svg');
  await writeFile(
    inputPath,
    '<svg width="2400" height="1600" xmlns="http://www.w3.org/2000/svg"><rect width="2400" height="1600" fill="#8eaabc"/><circle cx="1200" cy="800" r="420" fill="#f1d59f"/></svg>',
  );
  const processed = await buildPhotoDerivatives({
    id: 'core-sample',
    inputPath,
    sourceName: 'sample.svg',
    title: 'Core Sample',
  });
  assert.equal(processed.photo.width, 2400);
  assert.equal(processed.photo.height, 1600);
  assert.deepEqual(processed.assets.map((asset) => asset.kind).sort(), ['large', 'medium', 'thumb']);
  assert.equal(processed.assets.find((asset) => asset.kind === 'thumb')?.width, 520);
  assert.equal(processed.assets.find((asset) => asset.kind === 'medium')?.width, 1280);
  assert.equal(processed.assets.find((asset) => asset.kind === 'large')?.width, 2200);
  assert.ok(processed.photo.blurDataUrl.startsWith('data:image/webp;base64,'));

  const localProbe = await verifyLocalStorageConfig({
    kind: 'local',
    mediaDir: path.join(tempRoot, 'media'),
    originalDir: path.join(tempRoot, 'originals'),
  });
  assert.equal(localProbe.ok, true);
  assert.equal(localProbe.kind, 'local');
  await assert.rejects(
    () => verifyLocalStorageConfig({
      kind: 'local',
      mediaDir: path.join(tempRoot, 'public-media'),
      originalDir: path.join(tempRoot, 'public-media', 'originals'),
    }),
    /outside the public media folder/,
  );
  await assert.rejects(
    () => verifyLocalStorageConfig({
      kind: 'local',
      mediaDir: path.join(tempRoot, 'media-safe'),
      originalDir: path.join(tempRoot, 'public', 'originals'),
    }, { publicDir: path.join(tempRoot, 'public') }),
    /must not be inside the public directory/,
  );

  const r2 = resolveR2Config({
    kind: 'r2',
    r2: {
      accountId: 'account',
      accessKeyId: 'access',
      secretAccessKey: 'secret',
      publicBucket: 'public',
      privateBucket: 'private',
      publicBaseUrl: 'https://cdn.example.com///',
    },
  });
  assert.equal(r2.publicBaseUrl, 'https://cdn.example.com');
  await assert.rejects(
    () => verifyR2StorageConfig({
      kind: 'r2',
      r2: {
        accountId: 'account',
        accessKeyId: 'access',
        secretAccessKey: 'secret',
        publicBucket: 'same-bucket',
        privateBucket: 'same-bucket',
        publicBaseUrl: 'https://cdn.example.com',
      },
    }, { verifyPublicUrl: false }),
    /must be different/,
  );
  const previousR2Env = saveEnv([
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_PUBLIC_BUCKET',
    'R2_PRIVATE_BUCKET',
    'R2_PUBLIC_BASE_URL',
  ]);
  try {
    for (const key of Object.keys(previousR2Env)) delete process.env[key];
    assert.deepEqual(missingR2ConfigFields({ kind: 'r2', r2: { accountId: 'account' } }), [
      'accessKeyId',
      'secretAccessKey',
      'publicBucket',
      'privateBucket',
      'publicBaseUrl',
    ]);
  } finally {
    restoreEnv(previousR2Env);
  }

  const previousAdminHash = process.env.GALLERY_ADMIN_PASSWORD_HASH;
  delete process.env.GALLERY_ADMIN_PASSWORD_HASH;
  try {
    const setupStatus = publicSetupStatus({
      configPath: path.join(tempRoot, 'config.json'),
      config: {
        setupComplete: true,
        database: { kind: 'json', manifestPath: path.join(tempRoot, 'photos.json') },
        storage: { kind: 'local', mediaDir: path.join(tempRoot, 'media'), originalDir: path.join(tempRoot, 'originals') },
        auth: {},
      },
    });
    assert.equal(setupStatus.configured, false);
    assert.equal(setupStatus.auth.hasAdminPassword, false);
  } finally {
    if (previousAdminHash === undefined) {
      delete process.env.GALLERY_ADMIN_PASSWORD_HASH;
    } else {
      process.env.GALLERY_ADMIN_PASSWORD_HASH = previousAdminHash;
    }
  }

  console.log(JSON.stringify({ ok: true, tests: 20 }, null, 2));
} finally {
  await rm(tempRoot, { force: true, recursive: true }).catch(() => {});
}

function saveEnv(keys): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
