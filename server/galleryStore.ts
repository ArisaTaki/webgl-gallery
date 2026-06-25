import crypto from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { and, asc, eq, ne } from 'drizzle-orm';
import { createDatabase } from './db/client.js';
import { galleryGroups, photoAssets, photos as photoRows } from './db/schema.js';
import { buildPhotoDerivatives, ensureGalleryDirs, loadManifest, saveManifest } from './photoPipeline.js';
import { createStorage } from './storage.js';
import {
  DEFAULT_GROUP_ID,
  DEFAULT_GROUP_SLUG,
  defaultGroup,
  makeUniqueSlug,
  normalizePhotoStatus,
  normalizeVisibility,
  nowIso,
  publicPhotoFromRecord,
  slugify,
  toInt,
  toIsoOrNull,
} from './galleryUtils.js';

export function createGalleryStore({ dataDir, manifestPath, mediaDir, originalDir, uploadDir }) {
  const database = createDatabase();
  const storage = createStorage({ mediaDir, originalDir });
  if (database) {
    return new PostgresGalleryStore({ database, storage });
  }
  return new ManifestGalleryStore({ dataDir, manifestPath, mediaDir, originalDir, storage, uploadDir });
}

class ManifestGalleryStore {
  [key: string]: any;

  constructor(config) {
    Object.assign(this, config);
  }

  async init() {
    await ensureGalleryDirs({
      dataDir: this.dataDir,
      mediaDir: this.mediaDir,
      uploadDir: this.uploadDir,
    });
    await mkdir(this.originalDir, { recursive: true });
  }

  async listPublicGallery({ groupSlug }: any = {}) {
    const state = await this.readState();
    return buildGalleryPayload(state, { publicOnly: true, groupSlug });
  }

  async listAdminGallery() {
    return buildGalleryPayload(await this.readState(), { publicOnly: false });
  }

  async createGroup(input) {
    const state = await this.readState();
    const id = `group-${crypto.randomUUID()}`;
    const slug = makeUniqueSlug(input.slug || input.title || id, state.groups.map((group) => group.slug));
    const group = {
      ...defaultGroup({
        id,
        slug,
        title: String(input.title || 'Untitled Group'),
        description: String(input.description || ''),
        sortOrder: toInt(input.sortOrder, state.groups.length),
        visibility: normalizeVisibility(input.visibility),
      }),
    };
    state.groups.push(group);
    await this.writeState(state);
    return group;
  }

  async updateGroup(id, patch) {
    const state = await this.readState();
    const group = state.groups.find((item) => item.id === id || item.slug === id);
    if (!group) throw httpError(404, 'Group not found.');
    const existingSlugs = state.groups.filter((item) => item.id !== group.id).map((item) => item.slug);
    Object.assign(group, {
      title: patch.title === undefined ? group.title : String(patch.title || 'Untitled Group'),
      description: patch.description === undefined ? group.description : String(patch.description || ''),
      coverPhotoId: patch.coverPhotoId === undefined ? group.coverPhotoId : patch.coverPhotoId || null,
      sortOrder: patch.sortOrder === undefined ? group.sortOrder : toInt(patch.sortOrder, group.sortOrder),
      visibility: patch.visibility === undefined ? group.visibility : normalizeVisibility(patch.visibility),
      updatedAt: nowIso(),
    });
    if (patch.slug !== undefined) {
      group.slug = makeUniqueSlug(patch.slug || group.title, existingSlugs);
    }
    await this.writeState(state);
    return group;
  }

  async deleteGroup(id) {
    const state = await this.readState();
    const group = state.groups.find((item) => item.id === id || item.slug === id);
    if (!group) throw httpError(404, 'Group not found.');
    if (group.id === DEFAULT_GROUP_ID) throw httpError(400, 'The default group cannot be deleted.');
    if (state.photos.some((photo) => photo.groupId === group.id && photo.status !== 'deleted')) {
      throw httpError(409, 'Move or delete photos before deleting this group.');
    }
    state.groups = state.groups.filter((item) => item.id !== group.id);
    await this.writeState(state);
    return { ok: true };
  }

  async addPhotos({ files, groupId = DEFAULT_GROUP_ID, title = '', titlePrefix = 'Gallery', description = '', capturedAt = null }: any) {
    const state = await this.readState();
    const group = resolveGroup(state.groups, groupId);
    const existingSlugs = state.photos.map((photo) => photo.slug);
    const added = [];
    for (const [index, file] of files.entries()) {
      const stem = path.basename(file.originalname, path.extname(file.originalname));
      const photoId = `photo-${Date.now()}-${index}-${slugify(stem, 'upload')}`;
      const photoTitle = title && files.length === 1
        ? String(title)
        : `${titlePrefix} ${String(state.photos.length + index + 1).padStart(3, '0')}`;
      const processed = await buildPhotoDerivatives({
        inputPath: file.path,
        id: photoId,
        sourceName: file.originalname,
        title: photoTitle,
      });
      const storedAssets = await this.storeAssets({ group, photoId, processed });
      const photo = {
        ...processed.photo,
        id: photoId,
        groupId: group.id,
        slug: makeUniqueSlug(photoTitle || stem || photoId, existingSlugs),
        description: String(description || ''),
        capturedAt: toIsoOrNull(capturedAt),
        sortOrder: nextSortOrder(state.photos),
        status: 'active',
        visitUrl: '',
        workMedia: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
        assets: storedAssets,
      };
      Object.assign(photo, publicAssetFields(storedAssets));
      state.photos.push(photo);
      existingSlugs.push(photo.slug);
      added.push(photo);
      await rm(file.path, { force: true }).catch(() => {});
    }
    if (!group.coverPhotoId && added[0]) group.coverPhotoId = added[0].id;
    await this.writeState(state);
    return buildGalleryPayload(state, { publicOnly: false });
  }

  async updatePhoto(id, patch) {
    const state = await this.readState();
    const photo = state.photos.find((item) => item.id === id || item.slug === id);
    if (!photo) throw httpError(404, 'Photo not found.');
    if (patch.groupId !== undefined) {
      photo.groupId = resolveGroup(state.groups, patch.groupId).id;
    }
    if (patch.slug !== undefined) {
      photo.slug = makeUniqueSlug(
        patch.slug || patch.title || photo.title,
        state.photos.filter((item) => item.id !== photo.id).map((item) => item.slug),
      );
    }
    Object.assign(photo, {
      title: patch.title === undefined ? photo.title : String(patch.title || 'Untitled Photo'),
      description: patch.description === undefined ? photo.description : String(patch.description || ''),
      capturedAt: patch.capturedAt === undefined ? photo.capturedAt : toIsoOrNull(patch.capturedAt),
      sortOrder: patch.sortOrder === undefined ? photo.sortOrder : toInt(patch.sortOrder, photo.sortOrder),
      status: patch.status === undefined ? photo.status : normalizePhotoStatus(patch.status),
      visitUrl: patch.visitUrl === undefined ? photo.visitUrl : String(patch.visitUrl || ''),
      updatedAt: nowIso(),
    });
    await this.writeState(state);
    return photo;
  }

  async deletePhoto(id) {
    const state = await this.readState();
    const photo = state.photos.find((item) => item.id === id || item.slug === id);
    if (!photo) throw httpError(404, 'Photo not found.');
    photo.status = 'deleted';
    photo.updatedAt = nowIso();
    await this.writeState(state);
    for (const asset of photo.assets || []) {
      this.storage.deleteAsset(asset).catch(() => {});
    }
    return { ok: true };
  }

  async reprocessPhoto(id) {
    const state = await this.readState();
    const photo = state.photos.find((item) => item.id === id || item.slug === id);
    if (!photo) throw httpError(404, 'Photo not found.');
    const original = (photo.assets || []).find((asset) => asset.kind === 'original');
    if (!original) throw httpError(409, 'Original asset is not available for this photo.');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gallery-reprocess-'));
    const inputPath = path.join(tempDir, photo.sourceName || `${photo.id}.image`);
    try {
      await writeFile(inputPath, await this.storage.getAssetBuffer(original));
      const processed = await buildPhotoDerivatives({
        inputPath,
        id: photo.id,
        sourceName: photo.sourceName,
        title: photo.title,
      });
      const variantAssets = processed.assets.filter((asset) => asset.kind !== 'original');
      const storedVariants = [];
      for (const asset of variantAssets) {
        const stored = await this.storage.putAsset({
          groupSlug: resolveGroup(state.groups, photo.groupId).slug,
          photoId: photo.id,
          kind: asset.kind,
          fileName: asset.fileName,
          buffer: asset.buffer,
          mimeType: asset.mimeType,
        });
        storedVariants.push(toAssetRecord({ asset, stored, photoId: photo.id }));
      }
      photo.assets = [
        original,
        ...storedVariants,
      ];
      Object.assign(photo, processed.photo, publicAssetFields(photo.assets), { updatedAt: nowIso() });
      await this.writeState(state);
      return photo;
    } finally {
      await rm(tempDir, { force: true, recursive: true }).catch(() => {});
    }
  }

  async storeAssets({ group, photoId, processed }) {
    const records = [];
    for (const asset of processed.assets) {
      const stored = await this.storage.putAsset({
        groupSlug: group.slug,
        photoId,
        kind: asset.kind,
        fileName: asset.fileName,
        buffer: asset.buffer,
        mimeType: asset.mimeType,
      });
      records.push(toAssetRecord({ asset, stored, photoId }));
    }
    return records;
  }

  async readState() {
    const manifest = await loadManifest(this.manifestPath);
    const groups = normalizeManifestGroups(manifest.groups);
    const photos = (manifest.photos || []).map((photo, index) => normalizeManifestPhoto(photo, index));
    return { groups, photos };
  }

  async writeState(state) {
    await saveManifest(this.manifestPath, state.photos, state.groups);
  }
}

class PostgresGalleryStore {
  [key: string]: any;

  constructor({ database, storage }) {
    this.database = database;
    this.db = database.db;
    this.storage = storage;
  }

  async init() {}

  async listPublicGallery({ groupSlug }: any = {}) {
    return buildGalleryPayload(await this.readState(), { publicOnly: true, groupSlug });
  }

  async listAdminGallery() {
    return buildGalleryPayload(await this.readState(), { publicOnly: false });
  }

  async createGroup(input) {
    const state = await this.readState();
    const id = `group-${crypto.randomUUID()}`;
    const group = {
      id,
      slug: makeUniqueSlug(input.slug || input.title || id, state.groups.map((item) => item.slug)),
      title: String(input.title || 'Untitled Group'),
      description: String(input.description || ''),
      coverPhotoId: input.coverPhotoId || null,
      sortOrder: toInt(input.sortOrder, state.groups.length),
      visibility: normalizeVisibility(input.visibility),
    };
    const [created] = await this.db.insert(galleryGroups).values(group).returning();
    return dbGroupToRecord(created);
  }

  async updateGroup(id, patch) {
    const state = await this.readState();
    const group = state.groups.find((item) => item.id === id || item.slug === id);
    if (!group) throw httpError(404, 'Group not found.');
    const update: any = {
      updatedAt: new Date(),
    };
    if (patch.title !== undefined) update.title = String(patch.title || 'Untitled Group');
    if (patch.description !== undefined) update.description = String(patch.description || '');
    if (patch.coverPhotoId !== undefined) update.coverPhotoId = patch.coverPhotoId || null;
    if (patch.sortOrder !== undefined) update.sortOrder = toInt(patch.sortOrder, group.sortOrder);
    if (patch.visibility !== undefined) update.visibility = normalizeVisibility(patch.visibility);
    if (patch.slug !== undefined) {
      update.slug = makeUniqueSlug(
        patch.slug || patch.title || group.title,
        state.groups.filter((item) => item.id !== group.id).map((item) => item.slug),
      );
    }
    const [updated] = await this.db
      .update(galleryGroups)
      .set(update)
      .where(eq(galleryGroups.id, group.id))
      .returning();
    return dbGroupToRecord(updated);
  }

  async deleteGroup(id) {
    const group = (await this.readState()).groups.find((item) => item.id === id || item.slug === id);
    if (!group) throw httpError(404, 'Group not found.');
    if (group.id === DEFAULT_GROUP_ID) throw httpError(400, 'The default group cannot be deleted.');
    const activePhotos = await this.db
      .select()
      .from(photoRows)
      .where(and(eq(photoRows.groupId, group.id), ne(photoRows.status, 'deleted')));
    if (activePhotos.length) throw httpError(409, 'Move or delete photos before deleting this group.');
    await this.db.delete(galleryGroups).where(eq(galleryGroups.id, group.id));
    return { ok: true };
  }

  async addPhotos({ files, groupId = DEFAULT_GROUP_ID, title = '', titlePrefix = 'Gallery', description = '', capturedAt = null }: any) {
    const state = await this.readState();
    const group = resolveGroup(state.groups, groupId);
    const existingSlugs = state.photos.map((photo) => photo.slug);
    for (const [index, file] of files.entries()) {
      const stem = path.basename(file.originalname, path.extname(file.originalname));
      const photoId = `photo-${Date.now()}-${index}-${slugify(stem, 'upload')}`;
      const photoTitle = title && files.length === 1
        ? String(title)
        : `${titlePrefix} ${String(state.photos.length + index + 1).padStart(3, '0')}`;
      const processed = await buildPhotoDerivatives({
        inputPath: file.path,
        id: photoId,
        sourceName: file.originalname,
        title: photoTitle,
      });
      const storedAssets = [];
      for (const asset of processed.assets) {
        const stored = await this.storage.putAsset({
          groupSlug: group.slug,
          photoId,
          kind: asset.kind,
          fileName: asset.fileName,
          buffer: asset.buffer,
          mimeType: asset.mimeType,
        });
        storedAssets.push(toAssetRecord({ asset, stored, photoId }));
      }
      const photo = {
        id: photoId,
        groupId: group.id,
        slug: makeUniqueSlug(photoTitle || stem || photoId, existingSlugs),
        title: photoTitle,
        description: String(description || ''),
        capturedAt: capturedAt ? new Date(capturedAt) : null,
        sourceName: file.originalname,
        width: processed.photo.width,
        height: processed.photo.height,
        aspect: processed.photo.aspect,
        color: processed.photo.color,
        blurDataUrl: processed.photo.blurDataUrl,
        sortOrder: nextSortOrder(state.photos),
        status: 'active',
      };
      await this.db.transaction(async (tx) => {
        await tx.insert(photoRows).values(photo);
        await tx.insert(photoAssets).values(storedAssets.map(dbAssetValues));
        if (!group.coverPhotoId) {
          await tx.update(galleryGroups).set({ coverPhotoId: photoId }).where(eq(galleryGroups.id, group.id));
        }
      });
      existingSlugs.push(photo.slug);
      state.photos.push({ ...photo, capturedAt: toIsoOrNull(capturedAt) });
      await rm(file.path, { force: true }).catch(() => {});
    }
    return this.listAdminGallery();
  }

  async updatePhoto(id, patch) {
    const state = await this.readState();
    const photo = state.photos.find((item) => item.id === id || item.slug === id);
    if (!photo) throw httpError(404, 'Photo not found.');
    const update: any = {
      updatedAt: new Date(),
    };
    if (patch.groupId !== undefined) update.groupId = resolveGroup(state.groups, patch.groupId).id;
    if (patch.title !== undefined) update.title = String(patch.title || 'Untitled Photo');
    if (patch.description !== undefined) update.description = String(patch.description || '');
    if (patch.capturedAt !== undefined) update.capturedAt = patch.capturedAt ? new Date(patch.capturedAt) : null;
    if (patch.sortOrder !== undefined) update.sortOrder = toInt(patch.sortOrder, photo.sortOrder);
    if (patch.status !== undefined) update.status = normalizePhotoStatus(patch.status);
    if (patch.visitUrl !== undefined) update.visitUrl = String(patch.visitUrl || '');
    if (patch.slug !== undefined) {
      update.slug = makeUniqueSlug(
        patch.slug || patch.title || photo.title,
        state.photos.filter((item) => item.id !== photo.id).map((item) => item.slug),
      );
    }
    const [updated] = await this.db
      .update(photoRows)
      .set(update)
      .where(eq(photoRows.id, photo.id))
      .returning();
    return dbPhotoToRecord(updated);
  }

  async deletePhoto(id) {
    const state = await this.readState();
    const photo = state.photos.find((item) => item.id === id || item.slug === id);
    if (!photo) throw httpError(404, 'Photo not found.');
    await this.db.update(photoRows).set({ status: 'deleted', updatedAt: new Date() }).where(eq(photoRows.id, photo.id));
    for (const asset of photo.assets || []) {
      this.storage.deleteAsset(asset).catch(() => {});
    }
    return { ok: true };
  }

  async reprocessPhoto(id) {
    const state = await this.readState();
    const photo = state.photos.find((item) => item.id === id || item.slug === id);
    if (!photo) throw httpError(404, 'Photo not found.');
    const group = resolveGroup(state.groups, photo.groupId);
    const original = (photo.assets || []).find((asset) => asset.kind === 'original');
    if (!original) throw httpError(409, 'Original asset is not available for this photo.');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gallery-reprocess-'));
    const inputPath = path.join(tempDir, photo.sourceName || `${photo.id}.image`);
    try {
      await writeFile(inputPath, await this.storage.getAssetBuffer(original));
      const processed = await buildPhotoDerivatives({
        inputPath,
        id: photo.id,
        sourceName: photo.sourceName,
        title: photo.title,
      });
      const storedAssets = [original];
      for (const asset of processed.assets.filter((item) => item.kind !== 'original')) {
        const stored = await this.storage.putAsset({
          groupSlug: group.slug,
          photoId: photo.id,
          kind: asset.kind,
          fileName: asset.fileName,
          buffer: asset.buffer,
          mimeType: asset.mimeType,
        });
        storedAssets.push(toAssetRecord({ asset, stored, photoId: photo.id }));
      }
      await this.db.transaction(async (tx) => {
        await tx.delete(photoAssets).where(and(eq(photoAssets.photoId, photo.id), ne(photoAssets.kind, 'original')));
        await tx.insert(photoAssets).values(storedAssets.filter((asset) => asset.kind !== 'original').map(dbAssetValues));
        await tx.update(photoRows).set({
          width: processed.photo.width,
          height: processed.photo.height,
          aspect: processed.photo.aspect,
          color: processed.photo.color,
          blurDataUrl: processed.photo.blurDataUrl,
          updatedAt: new Date(),
        }).where(eq(photoRows.id, photo.id));
      });
      return { ...photo, ...processed.photo, assets: storedAssets, ...publicAssetFields(storedAssets) };
    } finally {
      await rm(tempDir, { force: true, recursive: true }).catch(() => {});
    }
  }

  async readState() {
    const [groups, photoList, assets] = await Promise.all([
      this.db.select().from(galleryGroups).orderBy(asc(galleryGroups.sortOrder), asc(galleryGroups.createdAt)),
      this.db.select().from(photoRows).orderBy(asc(photoRows.sortOrder), asc(photoRows.createdAt)),
      this.db.select().from(photoAssets),
    ]);
    const normalizedGroups = groups.map(dbGroupToRecord);
    const assetsByPhoto = groupAssets(assets.map(dbAssetToRecord));
    const normalizedPhotos = photoList.map((photo) => {
      const record: any = dbPhotoToRecord(photo);
      record.assets = assetsByPhoto.get(record.id) || [];
      Object.assign(record, publicAssetFields(record.assets));
      return record;
    });
    return {
      groups: normalizedGroups.length ? normalizedGroups : [defaultGroup()],
      photos: normalizedPhotos,
    };
  }
}

function normalizeManifestGroups(groups) {
  const normalized = (groups || []).map((group, index) => ({
    ...defaultGroup(),
    ...group,
    id: group.id || (group.slug ? `group-${group.slug}` : `group-${index + 1}`),
    slug: slugify(group.slug || group.title || `group-${index + 1}`),
    title: group.title || 'Default Gallery',
    description: group.description || '',
    coverPhotoId: group.coverPhotoId || null,
    sortOrder: toInt(group.sortOrder, index),
    visibility: normalizeVisibility(group.visibility),
  }));
  return normalized.length ? normalized : [defaultGroup()];
}

function normalizeManifestPhoto(photo, index) {
  const id = photo.id || `photo-${index + 1}`;
  const assets = normalizeManifestAssets(photo, id);
  return {
    ...photo,
    id,
    groupId: photo.groupId || DEFAULT_GROUP_ID,
    slug: photo.slug || legacyPhotoSlug(photo, index),
    title: photo.title || `Photo ${String(index + 1).padStart(3, '0')}`,
    description: photo.description || '',
    capturedAt: photo.capturedAt || null,
    sourceName: photo.sourceName || '',
    width: photo.width || 1,
    height: photo.height || 1,
    aspect: photo.aspect || 1,
    color: photo.color || 'rgb(188, 148, 57)',
    blurDataUrl: photo.blurDataUrl || '',
    sortOrder: toInt(photo.sortOrder, photo.index || index + 1),
    status: normalizePhotoStatus(photo.status),
    visitUrl: photo.visitUrl || photo.visit || '',
    workMedia: Array.isArray(photo.workMedia) ? photo.workMedia : [],
    createdAt: photo.createdAt || nowIso(),
    updatedAt: photo.updatedAt || nowIso(),
    assets,
  };
}

function normalizeManifestAssets(photo, id) {
  if (Array.isArray(photo.assets) && photo.assets.length) return photo.assets;
  return ['original', 'thumb', 'medium', 'large']
    .map((kind) => {
      const url = kind === 'original' ? photo.original || '' : photo[kind] || '';
      if (!url) return null;
      return {
        id: `${id}-${kind}`,
        photoId: id,
        kind,
        r2Key: url.startsWith('/media/') ? url.slice('/media/'.length) : url,
        url: kind === 'original' ? '' : url,
        width: photo.width || 1,
        height: photo.height || 1,
        sizeBytes: 0,
        mimeType: kind === 'original' ? 'application/octet-stream' : 'image/webp',
      };
    })
    .filter(Boolean);
}

function legacyPhotoSlug(photo, index) {
  const frame = String(photo.index || index + 1).padStart(3, '0');
  return `nian-nian-${frame}`;
}

function buildGalleryPayload(state, { publicOnly, groupSlug }: any = {}) {
  const groups = state.groups
    .filter((group) => !publicOnly || group.visibility === 'public')
    .sort(bySortOrder);
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  let photos = state.photos
    .filter((photo) => photo.status !== 'deleted')
    .filter((photo) => !publicOnly || photo.status === 'active')
    .filter((photo) => groupsById.has(photo.groupId))
    .sort(bySortOrder);
  if (groupSlug) {
    const group = groups.find((item) => item.slug === groupSlug || item.id === groupSlug);
    photos = group ? photos.filter((photo) => photo.groupId === group.id) : [];
  }
  const publicPhotos = photos.map((photo, index) => ({
    ...publicPhotoFromRecord({
      photo: { ...photo, index: index + 1 },
      assets: photo.assets || [],
      group: groupsById.get(photo.groupId),
    }),
    index: index + 1,
  }));
  return {
    count: publicPhotos.length,
    groups,
    photos: publicPhotos,
    updatedAt: nowIso(),
  };
}

function resolveGroup(groups, idOrSlug) {
  const group = groups.find((item) => item.id === idOrSlug || item.slug === idOrSlug) || groups[0];
  if (!group) throw httpError(404, 'Group not found.');
  return group;
}

function publicAssetFields(assets) {
  return Object.fromEntries(
    ['thumb', 'medium', 'large']
      .map((kind) => [kind, assets.find((asset) => asset.kind === kind)?.url || ''])
      .filter(([, url]) => url),
  );
}

function toAssetRecord({ asset, stored, photoId }) {
  return {
    id: `${photoId}-${asset.kind}`,
    photoId,
    kind: asset.kind,
    r2Key: stored.key,
    url: stored.url,
    width: asset.width,
    height: asset.height,
    sizeBytes: stored.sizeBytes,
    mimeType: stored.mimeType || asset.mimeType,
  };
}

function dbAssetValues(asset) {
  return {
    id: asset.id,
    photoId: asset.photoId,
    kind: asset.kind,
    r2Key: asset.r2Key,
    url: asset.url || '',
    width: asset.width || 1,
    height: asset.height || 1,
    sizeBytes: asset.sizeBytes || 0,
    mimeType: asset.mimeType || 'application/octet-stream',
  };
}

function dbGroupToRecord(group) {
  return {
    id: group.id,
    slug: group.slug,
    title: group.title,
    description: group.description || '',
    coverPhotoId: group.coverPhotoId || null,
    sortOrder: group.sortOrder || 0,
    visibility: normalizeVisibility(group.visibility),
    createdAt: group.createdAt?.toISOString?.() || group.createdAt || nowIso(),
    updatedAt: group.updatedAt?.toISOString?.() || group.updatedAt || nowIso(),
  };
}

function dbPhotoToRecord(photo) {
  return {
    id: photo.id,
    groupId: photo.groupId,
    slug: photo.slug,
    title: photo.title,
    description: photo.description || '',
    capturedAt: photo.capturedAt?.toISOString?.() || photo.capturedAt || null,
    sourceName: photo.sourceName || '',
    width: photo.width || 1,
    height: photo.height || 1,
    aspect: photo.aspect || 1,
    color: photo.color || 'rgb(188, 148, 57)',
    blurDataUrl: photo.blurDataUrl || '',
    sortOrder: photo.sortOrder || 0,
    status: normalizePhotoStatus(photo.status),
    visitUrl: photo.visitUrl || '',
    workMedia: safeJsonArray(photo.workMedia),
    createdAt: photo.createdAt?.toISOString?.() || photo.createdAt || nowIso(),
    updatedAt: photo.updatedAt?.toISOString?.() || photo.updatedAt || nowIso(),
  };
}

function dbAssetToRecord(asset) {
  return {
    id: asset.id,
    photoId: asset.photoId,
    kind: asset.kind,
    r2Key: asset.r2Key,
    url: asset.url || '',
    width: asset.width || 1,
    height: asset.height || 1,
    sizeBytes: asset.sizeBytes || 0,
    mimeType: asset.mimeType || 'application/octet-stream',
  };
}

function groupAssets(assets) {
  const byPhoto = new Map();
  for (const asset of assets) {
    if (!byPhoto.has(asset.photoId)) byPhoto.set(asset.photoId, []);
    byPhoto.get(asset.photoId).push(asset);
  }
  return byPhoto;
}

function safeJsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function nextSortOrder(photos) {
  return photos.reduce((max, photo) => Math.max(max, Number(photo.sortOrder) || 0), 0) + 1;
}

function bySortOrder(a, b) {
  return (a.sortOrder || 0) - (b.sortOrder || 0) || String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
}

function httpError(status, message) {
  const error: any = new Error(message);
  error.status = status;
  return error;
}
