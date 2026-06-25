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
  assert.equal(processed.assets.find((asset) => asset.kind === 'thumb')?.width, 520);
  assert.equal(processed.assets.find((asset) => asset.kind === 'medium')?.width, 1280);
  assert.equal(processed.assets.find((asset) => asset.kind === 'large')?.width, 2200);
  assert.ok(processed.photo.blurDataUrl.startsWith('data:image/webp;base64,'));

  console.log(JSON.stringify({ ok: true, tests: 8 }, null, 2));
} finally {
  await rm(tempRoot, { force: true, recursive: true }).catch(() => {});
}

