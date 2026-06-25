import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../server/db/client.js';
import { galleryGroups, photoAssets, photos } from '../server/db/schema.js';
import { DEFAULT_GROUP_ID, DEFAULT_GROUP_SLUG, makeUniqueSlug, slugify } from '../server/galleryUtils.js';
import { loadManifest } from '../server/photoPipeline.js';
import { createStorage } from '../server/storage.js';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const args = new Map(
  process.argv.slice(2).flatMap((arg, index, all) => {
    if (!arg.startsWith('--')) return [];
    const [key, inlineValue] = arg.slice(2).split('=');
    return [[key, inlineValue ?? all[index + 1] ?? 'true']];
  }),
);

const manifestPath = path.resolve(String(args.get('manifest') || process.env.GALLERY_MANIFEST_PATH || path.join(root, 'public', 'data', 'photos.json')));
const mediaDir = path.resolve(String(args.get('media') || process.env.GALLERY_MEDIA_DIR || path.join(root, 'public', 'media')));
const sourceDir = args.has('source') ? path.resolve(String(args.get('source'))) : '';
const originalDir = path.resolve(String(args.get('originals') || process.env.GALLERY_ORIGINAL_DIR || path.join(root, '.uploads', 'originals')));
const dryRun = args.get('dry-run') === 'true';

const database = createDatabase();
if (!database) {
  throw new Error('DATABASE_URL is required for migrate:manifest.');
}

const manifest = await loadManifest(manifestPath);
const backupDir = path.join(root, '.migration-backups');
await mkdir(backupDir, { recursive: true });
const backupPath = path.join(backupDir, `manifest-${Date.now()}.json`);
await writeFile(backupPath, `${JSON.stringify(manifest, null, 2)}\n`);

const storage = createStorage({ mediaDir, originalDir });
const group = {
  id: DEFAULT_GROUP_ID,
  slug: DEFAULT_GROUP_SLUG,
  title: 'Imported Gallery',
  description: '',
  coverPhotoId: null,
  sortOrder: 0,
  visibility: 'public',
};

const existingSlugs = new Set<string>();
const plannedPhotos = [];
const plannedAssets = [];

for (const [index, photo] of manifest.photos.entries()) {
  const photoId = photo.id || `import-${String(index + 1).padStart(4, '0')}`;
  const title = photo.title || `Photo ${String(index + 1).padStart(3, '0')}`;
  const slug = makeUniqueSlug(photo.slug || title || photoId, [...existingSlugs]);
  existingSlugs.add(slug);

  plannedPhotos.push({
    id: photoId,
    groupId: group.id,
    slug,
    title,
    description: photo.description || '',
    capturedAt: photo.capturedAt ? new Date(photo.capturedAt) : null,
    sourceName: photo.sourceName || '',
    width: photo.width || 1,
    height: photo.height || 1,
    aspect: photo.aspect || 1,
    color: photo.color || 'rgb(188, 148, 57)',
    blurDataUrl: photo.blurDataUrl || '',
    sortOrder: photo.sortOrder || index + 1,
    status: photo.status || 'active',
    visitUrl: photo.visitUrl || '',
    workMedia: JSON.stringify(photo.workMedia || []),
  });

  for (const kind of ['thumb', 'medium', 'large']) {
    const url = photo[kind];
    if (!url) continue;
    const localPath = url.startsWith('/media/')
      ? path.join(mediaDir, url.slice('/media/'.length))
      : path.join(mediaDir, path.basename(url));
    const buffer = await readFile(localPath);
    const stored = dryRun
      ? { key: `dry-run/${group.slug}/${photoId}/${path.basename(localPath)}`, url, sizeBytes: buffer.byteLength }
      : await storage.putAsset({
          groupSlug: group.slug,
          photoId,
          kind,
          fileName: path.basename(localPath),
          buffer,
          mimeType: 'image/webp',
        });
    plannedAssets.push(assetRow({ photoId, kind, stored, width: photo.width, height: photo.height, sizeBytes: buffer.byteLength, mimeType: 'image/webp' }));
  }

  if (sourceDir && photo.sourceName) {
    const originalPath = path.join(sourceDir, photo.sourceName);
    const buffer = await readFile(originalPath).catch(() => null);
    if (buffer) {
      const stored = dryRun
        ? { key: `dry-run/${group.slug}/${photoId}/${photo.sourceName}`, url: '', sizeBytes: buffer.byteLength }
        : await storage.putAsset({
            groupSlug: group.slug,
            photoId,
            kind: 'original',
            fileName: photo.sourceName,
            buffer,
            mimeType: 'application/octet-stream',
          });
      plannedAssets.push(assetRow({ photoId, kind: 'original', stored, width: photo.width, height: photo.height, sizeBytes: buffer.byteLength, mimeType: 'application/octet-stream' }));
    }
  }
}

if (!dryRun) {
  await database.db.transaction(async (tx) => {
    await tx.insert(galleryGroups).values(group).onConflictDoNothing();
    for (const photo of plannedPhotos) {
      await tx.insert(photos).values(photo).onConflictDoNothing();
    }
    for (const asset of plannedAssets) {
      await tx.insert(photoAssets).values(asset).onConflictDoNothing();
    }
    const firstPhoto = plannedPhotos[0];
    if (firstPhoto) {
      await tx.update(galleryGroups).set({ coverPhotoId: firstPhoto.id }).where(eq(galleryGroups.id, group.id));
    }
  });
}

console.log(JSON.stringify({
  ok: true,
  dryRun,
  backupPath,
  manifestPath,
  photos: plannedPhotos.length,
  assets: plannedAssets.length,
  group: group.slug,
}, null, 2));

function assetRow({ photoId, kind, stored, width, height, sizeBytes, mimeType }) {
  return {
    id: `${photoId}-${slugify(kind)}`,
    photoId,
    kind,
    r2Key: stored.key,
    url: stored.url || '',
    width: width || 1,
    height: height || 1,
    sizeBytes: sizeBytes || stored.sizeBytes || 0,
    mimeType,
  };
}
