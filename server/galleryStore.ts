import crypto from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { and, asc, eq, ne } from 'drizzle-orm';
import { createDatabase } from './db/client.js';
import { galleryGroups, photoAssets, photos as photoRows } from './db/schema.js';
import { buildPhotoDerivatives, ensureGalleryDirs, loadManifest, saveManifest } from './photoPipeline.js';
import { getBuiltinDatabaseSync, sqliteUnavailableMessage } from './sqlite.js';
import { createStorage } from './storage.js';
import {
  DEFAULT_GROUP_ID,
  DEFAULT_GROUP_SLUG,
  defaultGroup,
  makeUniqueSlug,
  normalizeAccentColor,
  normalizePhotoStatus,
  normalizeVisitUrl,
  normalizeVisibility,
  nowIso,
  publicPhotoFromRecord,
  slugify,
  toInt,
  toIsoOrNull,
} from './galleryUtils.js';

export function createGalleryStore({ dataDir, manifestPath, mediaDir, originalDir, uploadDir, runtimeConfig = null }) {
  const databaseConfig = runtimeConfig?.database || {};
  const storageConfig = runtimeConfig?.storage || {};
  const storage = createStorage({ mediaDir, originalDir, storageConfig });
  const activeManifestPath = databaseConfig.manifestPath || manifestPath;
  if (databaseConfig.kind === 'postgres' || process.env.DATABASE_URL) {
    const database = createDatabase(databaseConfig.databaseUrl || process.env.DATABASE_URL);
    return new PostgresGalleryStore({ database, storage });
  }
  if ((databaseConfig.kind === 'sqlite' || process.env.GALLERY_SQLITE_PATH) && databaseConfig.sqliteAvailable !== false) {
    return new SqliteGalleryStore({
      sqlitePath: databaseConfig.sqlitePath || process.env.GALLERY_SQLITE_PATH,
      manifestPath: activeManifestPath,
      storage,
    });
  }
  return new ManifestGalleryStore({ dataDir, manifestPath: activeManifestPath, mediaDir, originalDir, storage, uploadDir });
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

  async migrateStorage(nextStorageConfig) {
    const state = await this.readState();
    const migration = await migrateAssetRecords({
      currentStorage: this.storage,
      nextStorageConfig,
      state,
    });
    const migratedById = new Map(migration.records.map((asset) => [asset.id, asset]));
    for (const photo of state.photos) {
      photo.assets = (photo.assets || []).map((asset) => migratedById.get(asset.id) || asset);
      Object.assign(photo, publicAssetFields(photo.assets));
    }
    await this.writeState(state);
    this.storage = migration.storage;
    return migration.summary;
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
        accentColor: normalizeAccentColor(input.accentColor),
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
      accentColor: patch.accentColor === undefined ? group.accentColor : normalizeAccentColor(patch.accentColor),
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
    const startingPhotoCount = state.photos.length;
    const added = [];
    try {
      for (const [index, file] of files.entries()) {
        const stem = path.basename(file.originalname, path.extname(file.originalname));
        const photoId = `photo-${Date.now()}-${index}-${slugify(stem, 'upload')}`;
        const photoTitle = title && files.length === 1
          ? String(title)
          : `${titlePrefix} ${String(startingPhotoCount + index + 1).padStart(3, '0')}`;
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
      return buildUploadResult(state, added);
    } catch (error) {
      await deleteStoredAssets(this.storage, added.flatMap((photo) => photo.assets || []));
      throw error;
    }
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
      visitUrl: patch.visitUrl === undefined ? photo.visitUrl : normalizeVisitUrl(patch.visitUrl),
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
    return { ok: true, ...(await assetCleanupResult(this.storage, photo.assets)) };
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
    return storeProcessedAssets(this.storage, { group, photoId, processed });
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

class SqliteGalleryStore {
  [key: string]: any;

  constructor({ sqlitePath, manifestPath, storage }) {
    this.sqlitePath = sqlitePath;
    this.manifestPath = manifestPath;
    this.storage = storage;
    this.sqlite = null;
  }

  async init() {
    await mkdir(path.dirname(this.sqlitePath), { recursive: true });
    const DatabaseSync = await getBuiltinDatabaseSync();
    if (!DatabaseSync) throw httpError(503, sqliteUnavailableMessage());
    this.sqlite = new DatabaseSync(this.sqlitePath);
    this.sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        accentColor TEXT NOT NULL DEFAULT '',
        coverPhotoId TEXT,
        sortOrder INTEGER NOT NULL DEFAULT 0,
        visibility TEXT NOT NULL DEFAULT 'public',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS groups_visibility_idx ON groups(visibility);
      CREATE INDEX IF NOT EXISTS groups_sort_idx ON groups(sortOrder);
      CREATE TABLE IF NOT EXISTS photos (
        id TEXT PRIMARY KEY,
        groupId TEXT NOT NULL REFERENCES groups(id),
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        capturedAt TEXT,
        sourceName TEXT NOT NULL DEFAULT '',
        width INTEGER NOT NULL DEFAULT 1,
        height INTEGER NOT NULL DEFAULT 1,
        aspect REAL NOT NULL DEFAULT 1,
        color TEXT NOT NULL DEFAULT 'rgb(188, 148, 57)',
        blurDataUrl TEXT NOT NULL DEFAULT '',
        sortOrder INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        visitUrl TEXT NOT NULL DEFAULT '',
        workMedia TEXT NOT NULL DEFAULT '[]',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS photos_group_idx ON photos(groupId);
      CREATE INDEX IF NOT EXISTS photos_status_idx ON photos(status);
      CREATE INDEX IF NOT EXISTS photos_sort_idx ON photos(sortOrder);
      CREATE TABLE IF NOT EXISTS photo_assets (
        id TEXT PRIMARY KEY,
        photoId TEXT NOT NULL REFERENCES photos(id),
        kind TEXT NOT NULL,
        r2Key TEXT NOT NULL,
        url TEXT NOT NULL DEFAULT '',
        width INTEGER NOT NULL DEFAULT 1,
        height INTEGER NOT NULL DEFAULT 1,
        sizeBytes INTEGER NOT NULL DEFAULT 0,
        mimeType TEXT NOT NULL DEFAULT 'application/octet-stream',
        createdAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS photo_assets_photo_idx ON photo_assets(photoId);
      CREATE INDEX IF NOT EXISTS photo_assets_kind_idx ON photo_assets(kind);
    `);
    const groupColumns = this.sqlite.prepare('PRAGMA table_info(groups)').all();
    if (!groupColumns.some((column) => column.name === 'accentColor')) {
      this.sqlite.exec("ALTER TABLE groups ADD COLUMN accentColor TEXT NOT NULL DEFAULT ''");
    }
    this.ensureDefaultGroup();
    await this.seedFromManifestIfEmpty();
  }

  async close() {
    this.sqlite?.close();
  }

  async migrateStorage(nextStorageConfig) {
    const migration = await migrateAssetRecords({
      currentStorage: this.storage,
      nextStorageConfig,
      state: await this.readState(),
    });
    this.transaction(() => {
      const update = this.sqlite.prepare(`UPDATE photo_assets
        SET r2Key = ?, url = ?, sizeBytes = ?, mimeType = ?
        WHERE id = ?`);
      for (const asset of migration.records) {
        update.run(asset.r2Key, asset.url || '', asset.sizeBytes || 0, asset.mimeType, asset.id);
      }
    });
    this.storage = migration.storage;
    return migration.summary;
  }

  async listPublicGallery({ groupSlug }: any = {}) {
    return buildGalleryPayload(await this.readState(), { publicOnly: true, groupSlug });
  }

  async listAdminGallery() {
    return buildGalleryPayload(await this.readState(), { publicOnly: false });
  }

  async createGroup(input) {
    const state = await this.readState();
    const group = defaultGroup({
      id: `group-${crypto.randomUUID()}`,
      slug: makeUniqueSlug(input.slug || input.title || 'group', state.groups.map((item) => item.slug)),
      title: String(input.title || 'Untitled Group'),
      description: String(input.description || ''),
      accentColor: normalizeAccentColor(input.accentColor),
      sortOrder: toInt(input.sortOrder, state.groups.length),
      visibility: normalizeVisibility(input.visibility),
    });
    this.insertGroup(group);
    return group;
  }

  async updateGroup(id, patch) {
    const state = await this.readState();
    const group = state.groups.find((item) => item.id === id || item.slug === id);
    if (!group) throw httpError(404, 'Group not found.');
    const update: any = {
      updatedAt: nowIso(),
    };
    if (patch.title !== undefined) update.title = String(patch.title || 'Untitled Group');
    if (patch.description !== undefined) update.description = String(patch.description || '');
    if (patch.accentColor !== undefined) update.accentColor = normalizeAccentColor(patch.accentColor);
    if (patch.coverPhotoId !== undefined) update.coverPhotoId = patch.coverPhotoId || null;
    if (patch.sortOrder !== undefined) update.sortOrder = toInt(patch.sortOrder, group.sortOrder);
    if (patch.visibility !== undefined) update.visibility = normalizeVisibility(patch.visibility);
    if (patch.slug !== undefined) {
      update.slug = makeUniqueSlug(
        patch.slug || patch.title || group.title,
        state.groups.filter((item) => item.id !== group.id).map((item) => item.slug),
      );
    }
    this.updateRow('groups', update, group.id);
    return this.getGroup(group.id);
  }

  async deleteGroup(id) {
    const state = await this.readState();
    const group = state.groups.find((item) => item.id === id || item.slug === id);
    if (!group) throw httpError(404, 'Group not found.');
    if (group.id === DEFAULT_GROUP_ID) throw httpError(400, 'The default group cannot be deleted.');
    const activeCount = this.sqlite
      .prepare('SELECT COUNT(*) AS count FROM photos WHERE groupId = ? AND status != ?')
      .get(group.id, 'deleted')?.count || 0;
    if (activeCount) throw httpError(409, 'Move or delete photos before deleting this group.');
    this.sqlite.prepare('UPDATE photos SET groupId = ?, updatedAt = ? WHERE groupId = ?').run(DEFAULT_GROUP_ID, nowIso(), group.id);
    this.sqlite.prepare('DELETE FROM groups WHERE id = ?').run(group.id);
    return { ok: true };
  }

  async addPhotos({ files, groupId = DEFAULT_GROUP_ID, title = '', titlePrefix = 'Gallery', description = '', capturedAt = null }: any) {
    const state = await this.readState();
    const group = resolveGroup(state.groups, groupId);
    const existingSlugs = state.photos.map((photo) => photo.slug);
    const startingPhotoCount = state.photos.length;
    const added = [];
    const originalCoverPhotoId = group.coverPhotoId;
    try {
      for (const [index, file] of files.entries()) {
        const stem = path.basename(file.originalname, path.extname(file.originalname));
        const photoId = `photo-${Date.now()}-${index}-${slugify(stem, 'upload')}`;
        const photoTitle = title && files.length === 1
          ? String(title)
          : `${titlePrefix} ${String(startingPhotoCount + index + 1).padStart(3, '0')}`;
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
          title: photoTitle,
          description: String(description || ''),
          capturedAt: toIsoOrNull(capturedAt),
          sortOrder: nextSortOrder(state.photos),
          status: 'active',
          visitUrl: '',
          workMedia: [],
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        try {
          this.transaction(() => {
            this.insertPhoto(photo);
            this.insertAssets(storedAssets);
            if (!group.coverPhotoId) {
              this.sqlite.prepare('UPDATE groups SET coverPhotoId = ?, updatedAt = ? WHERE id = ?').run(photoId, nowIso(), group.id);
              group.coverPhotoId = photoId;
            }
          });
        } catch (error) {
          await deleteStoredAssets(this.storage, storedAssets);
          throw error;
        }
        state.photos.push(photo);
        existingSlugs.push(photo.slug);
        added.push({ ...photo, assets: storedAssets });
        await rm(file.path, { force: true }).catch(() => {});
      }
      return buildUploadResult(await this.readState(), added);
    } catch (error) {
      if (added.length) {
        this.transaction(() => {
          for (const photo of added) {
            this.sqlite.prepare('DELETE FROM photo_assets WHERE photoId = ?').run(photo.id);
            this.sqlite.prepare('DELETE FROM photos WHERE id = ?').run(photo.id);
          }
          this.sqlite.prepare('UPDATE groups SET coverPhotoId = ?, updatedAt = ? WHERE id = ?')
            .run(originalCoverPhotoId || null, nowIso(), group.id);
        });
        await deleteStoredAssets(this.storage, added.flatMap((photo) => photo.assets || []));
      }
      throw error;
    }
  }

  async updatePhoto(id, patch) {
    const state = await this.readState();
    const photo = state.photos.find((item) => item.id === id || item.slug === id);
    if (!photo) throw httpError(404, 'Photo not found.');
    const update: any = {
      updatedAt: nowIso(),
    };
    if (patch.groupId !== undefined) update.groupId = resolveGroup(state.groups, patch.groupId).id;
    if (patch.title !== undefined) update.title = String(patch.title || 'Untitled Photo');
    if (patch.description !== undefined) update.description = String(patch.description || '');
    if (patch.capturedAt !== undefined) update.capturedAt = toIsoOrNull(patch.capturedAt);
    if (patch.sortOrder !== undefined) update.sortOrder = toInt(patch.sortOrder, photo.sortOrder);
    if (patch.status !== undefined) update.status = normalizePhotoStatus(patch.status);
    if (patch.visitUrl !== undefined) update.visitUrl = normalizeVisitUrl(patch.visitUrl);
    if (patch.slug !== undefined) {
      update.slug = makeUniqueSlug(
        patch.slug || patch.title || photo.title,
        state.photos.filter((item) => item.id !== photo.id).map((item) => item.slug),
      );
    }
    this.updateRow('photos', update, photo.id);
    return this.getPhoto(photo.id);
  }

  async deletePhoto(id) {
    const state = await this.readState();
    const photo = state.photos.find((item) => item.id === id || item.slug === id);
    if (!photo) throw httpError(404, 'Photo not found.');
    this.sqlite.prepare('UPDATE photos SET status = ?, updatedAt = ? WHERE id = ?').run('deleted', nowIso(), photo.id);
    return { ok: true, ...(await assetCleanupResult(this.storage, photo.assets)) };
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
      this.transaction(() => {
        this.sqlite.prepare('DELETE FROM photo_assets WHERE photoId = ? AND kind != ?').run(photo.id, 'original');
        this.insertAssets(storedAssets.filter((asset) => asset.kind !== 'original'));
        this.updateRow('photos', {
          width: processed.photo.width,
          height: processed.photo.height,
          aspect: processed.photo.aspect,
          color: processed.photo.color,
          blurDataUrl: processed.photo.blurDataUrl,
          updatedAt: nowIso(),
        }, photo.id);
      });
      return { ...photo, ...processed.photo, assets: storedAssets, ...publicAssetFields(storedAssets) };
    } finally {
      await rm(tempDir, { force: true, recursive: true }).catch(() => {});
    }
  }

  async storeAssets({ group, photoId, processed }) {
    return storeProcessedAssets(this.storage, { group, photoId, processed });
  }

  async readState() {
    const groups = this.sqlite.prepare('SELECT * FROM groups ORDER BY sortOrder ASC, createdAt ASC').all().map(dbGroupToRecord);
    const photos = this.sqlite.prepare('SELECT * FROM photos ORDER BY sortOrder ASC, createdAt ASC').all().map(dbPhotoToRecord);
    const assetsByPhoto = groupAssets(this.sqlite.prepare('SELECT * FROM photo_assets').all().map(dbAssetToRecord));
    for (const photo of photos) {
      photo.assets = assetsByPhoto.get(photo.id) || [];
      Object.assign(photo, publicAssetFields(photo.assets));
    }
    return {
      groups: groups.length ? groups : [defaultGroup()],
      photos,
    };
  }

  async seedFromManifestIfEmpty() {
    const existingPhotos = this.sqlite.prepare('SELECT COUNT(*) AS count FROM photos').get()?.count || 0;
    if (existingPhotos) return;
    const manifest = await loadManifest(this.manifestPath);
    const groups = normalizeManifestGroups(manifest.groups);
    const photos = (manifest.photos || []).map((photo, index) => normalizeManifestPhoto(photo, index));
    if (!photos.length) return;
    this.transaction(() => {
      for (const group of groups) this.insertGroup(group, { ignore: true });
      for (const photo of photos) {
        this.insertPhoto(photo, { ignore: true });
        this.insertAssets(photo.assets || [], { ignore: true });
      }
    });
  }

  ensureDefaultGroup() {
    this.insertGroup(defaultGroup(), { ignore: true });
  }

  getGroup(id) {
    const row = this.sqlite.prepare('SELECT * FROM groups WHERE id = ?').get(id);
    return row ? dbGroupToRecord(row) : null;
  }

  getPhoto(id) {
    const row = this.sqlite.prepare('SELECT * FROM photos WHERE id = ?').get(id);
    return row ? dbPhotoToRecord(row) : null;
  }

  insertGroup(group, options: any = {}) {
    this.sqlite.prepare(`${options.ignore ? 'INSERT OR IGNORE' : 'INSERT'} INTO groups
      (id, slug, title, description, accentColor, coverPhotoId, sortOrder, visibility, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        group.id,
        group.slug,
        group.title,
        group.description || '',
        normalizeAccentColor(group.accentColor),
        group.coverPhotoId || null,
        toInt(group.sortOrder, 0),
        normalizeVisibility(group.visibility),
        group.createdAt || nowIso(),
        group.updatedAt || nowIso(),
      );
  }

  insertPhoto(photo, options: any = {}) {
    this.sqlite.prepare(`${options.ignore ? 'INSERT OR IGNORE' : 'INSERT'} INTO photos
      (id, groupId, slug, title, description, capturedAt, sourceName, width, height, aspect, color, blurDataUrl, sortOrder, status, visitUrl, workMedia, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        photo.id,
        photo.groupId,
        photo.slug,
        photo.title,
        photo.description || '',
        toIsoOrNull(photo.capturedAt),
        photo.sourceName || '',
        photo.width || 1,
        photo.height || 1,
        photo.aspect || 1,
        photo.color || 'rgb(188, 148, 57)',
        photo.blurDataUrl || '',
        toInt(photo.sortOrder, 0),
        normalizePhotoStatus(photo.status),
        photo.visitUrl || '',
        JSON.stringify(Array.isArray(photo.workMedia) ? photo.workMedia : []),
        photo.createdAt || nowIso(),
        photo.updatedAt || nowIso(),
      );
  }

  insertAssets(assets, options: any = {}) {
    const statement = this.sqlite.prepare(`${options.ignore ? 'INSERT OR IGNORE' : 'INSERT'} INTO photo_assets
      (id, photoId, kind, r2Key, url, width, height, sizeBytes, mimeType, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const asset of assets) {
      statement.run(
        asset.id,
        asset.photoId,
        asset.kind,
        asset.r2Key,
        asset.url || '',
        asset.width || 1,
        asset.height || 1,
        asset.sizeBytes || 0,
        asset.mimeType || 'application/octet-stream',
        asset.createdAt || nowIso(),
      );
    }
  }

  updateRow(table, patch, id) {
    const entries = Object.entries(patch);
    if (!entries.length) return;
    const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
    const values = entries.map(([, value]) => value);
    this.sqlite.prepare(`UPDATE ${table} SET ${assignments} WHERE id = ?`).run(...values, id);
  }

  transaction(callback) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.sqlite.exec('COMMIT');
      return result;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
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

  async migrateStorage(nextStorageConfig) {
    const migration = await migrateAssetRecords({
      currentStorage: this.storage,
      nextStorageConfig,
      state: await this.readState(),
    });
    await this.db.transaction(async (tx) => {
      for (const asset of migration.records) {
        await tx.update(photoAssets).set(dbAssetValues(asset)).where(eq(photoAssets.id, asset.id));
      }
    });
    this.storage = migration.storage;
    return migration.summary;
  }

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
      accentColor: normalizeAccentColor(input.accentColor),
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
    if (patch.accentColor !== undefined) update.accentColor = normalizeAccentColor(patch.accentColor);
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
    await this.db.update(photoRows).set({ groupId: DEFAULT_GROUP_ID, updatedAt: new Date() }).where(eq(photoRows.groupId, group.id));
    await this.db.delete(galleryGroups).where(eq(galleryGroups.id, group.id));
    return { ok: true };
  }

  async addPhotos({ files, groupId = DEFAULT_GROUP_ID, title = '', titlePrefix = 'Gallery', description = '', capturedAt = null }: any) {
    const state = await this.readState();
    const group = resolveGroup(state.groups, groupId);
    const existingSlugs = state.photos.map((photo) => photo.slug);
    const startingPhotoCount = state.photos.length;
    const added = [];
    const originalCoverPhotoId = group.coverPhotoId;
    try {
      for (const [index, file] of files.entries()) {
        const stem = path.basename(file.originalname, path.extname(file.originalname));
        const photoId = `photo-${Date.now()}-${index}-${slugify(stem, 'upload')}`;
        const photoTitle = title && files.length === 1
          ? String(title)
          : `${titlePrefix} ${String(startingPhotoCount + index + 1).padStart(3, '0')}`;
        const processed = await buildPhotoDerivatives({
          inputPath: file.path,
          id: photoId,
          sourceName: file.originalname,
          title: photoTitle,
        });
        const storedAssets = await storeProcessedAssets(this.storage, { group, photoId, processed });
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
        try {
          await this.db.transaction(async (tx) => {
            await tx.insert(photoRows).values(photo);
            await tx.insert(photoAssets).values(storedAssets.map(dbAssetValues));
            if (!group.coverPhotoId) {
              await tx.update(galleryGroups).set({ coverPhotoId: photoId }).where(eq(galleryGroups.id, group.id));
            }
          });
          if (!group.coverPhotoId) group.coverPhotoId = photoId;
        } catch (error) {
          await deleteStoredAssets(this.storage, storedAssets);
          throw error;
        }
        existingSlugs.push(photo.slug);
        const addedPhoto = { ...photo, capturedAt: toIsoOrNull(capturedAt), assets: storedAssets };
        state.photos.push(addedPhoto);
        added.push(addedPhoto);
        await rm(file.path, { force: true }).catch(() => {});
      }
      return buildUploadResult(await this.readState(), added);
    } catch (error) {
      if (added.length) {
        await this.db.transaction(async (tx) => {
          for (const photo of added) {
            await tx.delete(photoAssets).where(eq(photoAssets.photoId, photo.id));
            await tx.delete(photoRows).where(eq(photoRows.id, photo.id));
          }
          await tx.update(galleryGroups)
            .set({ coverPhotoId: originalCoverPhotoId || null, updatedAt: new Date() })
            .where(eq(galleryGroups.id, group.id));
        });
        await deleteStoredAssets(this.storage, added.flatMap((photo) => photo.assets || []));
      }
      throw error;
    }
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
    if (patch.visitUrl !== undefined) update.visitUrl = normalizeVisitUrl(patch.visitUrl);
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
    return { ok: true, ...(await assetCleanupResult(this.storage, photo.assets)) };
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
    accentColor: normalizeAccentColor(group.accentColor),
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
    visitUrl: normalizeVisitUrl(photo.visitUrl || photo.visit),
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
  return `webgl-gallery-${frame}`;
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

function buildUploadResult(state, added) {
  const gallery = buildGalleryPayload(state, { publicOnly: false });
  const addedIds = new Set(added.map((photo) => photo.id));
  return {
    ...gallery,
    uploadedCount: addedIds.size,
    addedPhotos: gallery.photos.filter((photo) => addedIds.has(photo.id)),
  };
}

async function migrateAssetRecords({ currentStorage, nextStorageConfig, state }) {
  const storage = createStorage({
    mediaDir: nextStorageConfig?.mediaDir || '',
    originalDir: nextStorageConfig?.originalDir || '',
    storageConfig: nextStorageConfig,
  });
  const groupsById = new Map<string, any>((state.groups || []).map((group) => [group.id, group]));
  const records = [];
  const failures = [];
  for (const photo of state.photos.filter((item) => item.status !== 'deleted')) {
    const group = groupsById.get(photo.groupId) || defaultGroup();
    for (const asset of photo.assets || []) {
      try {
        const buffer = await currentStorage.getAssetBuffer(asset);
        const stored = await storage.putAsset({
          groupSlug: group.slug,
          photoId: photo.id,
          kind: asset.kind,
          fileName: path.basename(asset.r2Key || asset.key || `${photo.id}-${asset.kind}`),
          buffer,
          mimeType: asset.mimeType,
        });
        records.push({
          ...asset,
          r2Key: stored.key,
          url: stored.url,
          sizeBytes: stored.sizeBytes,
          mimeType: stored.mimeType || asset.mimeType,
        });
      } catch (error: any) {
        failures.push({
          photoId: photo.id,
          kind: asset.kind,
          message: error.message || 'Asset copy failed.',
        });
      }
    }
  }
  return {
    records,
    storage,
    summary: {
      attempted: records.length + failures.length,
      copied: records.length,
      failed: failures.length,
      failures,
    },
  };
}

async function storeProcessedAssets(storage, { group, photoId, processed }) {
  const records = [];
  try {
    for (const asset of processed.assets) {
      const stored = await storage.putAsset({
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
  } catch (error) {
    await deleteStoredAssets(storage, records);
    throw error;
  }
}

async function deleteStoredAssets(storage, assets) {
  await Promise.allSettled((assets || []).map((asset) => storage.deleteAsset(asset)));
}

async function assetCleanupResult(storage, assets = []) {
  const results = await Promise.allSettled((assets || []).map((asset) => storage.deleteAsset(asset)));
  return {
    deletedAssets: results.filter((result) => result.status === 'fulfilled').length,
    cleanupFailed: results.filter((result) => result.status === 'rejected').length,
  };
}

function resolveGroup(groups, idOrSlug) {
  const group = groups.find((item) => item.id === idOrSlug || item.slug === idOrSlug);
  if (!idOrSlug && groups[0]) return groups[0];
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
    accentColor: normalizeAccentColor(group.accentColor),
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
    visitUrl: normalizeVisitUrl(photo.visitUrl),
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
