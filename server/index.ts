import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { createServer as createViteServer } from 'vite';
import {
  clearAdminSessionCookie,
  createAdminSessionCookie,
  isAdminRequest,
  requireAdmin,
  verifyAdminPassword,
  verifyLegacyUploadKey,
} from './auth.js';
import { createGalleryStore } from './galleryStore.js';
import { ensureGalleryDirs, imageExtensions } from './photoPipeline.js';
import { loadRuntimeConfig, publicSetupStatus, saveRuntimeConfig } from './runtimeConfig.js';
import { projectRootFromImportMeta, resolveRuntimePaths } from './runtimePaths.js';

const runtimePaths = resolveRuntimePaths(projectRootFromImportMeta(import.meta.url));
const { root, publicDir, dataDir, mediaDir, uploadDir, originalDir, manifestPath } = runtimePaths;
const distDir = path.join(root, 'dist');
const port = Number(process.env.PORT || 5279);
const isProduction = process.env.NODE_ENV === 'production';
const disableHmr = process.env.GALLERY_DISABLE_HMR === '1';

await ensureGalleryDirs({ dataDir, mediaDir, uploadDir });
await mkdir(originalDir, { recursive: true });
let runtime = await loadRuntimeConfig(runtimePaths);
let galleryStore = createGalleryStore({
  dataDir,
  manifestPath,
  mediaDir,
  originalDir,
  uploadDir,
  runtimeConfig: runtime.config,
});
await galleryStore.init();
let galleryMutationTail = Promise.resolve();
const loginFailures = new Map();
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 12;

const app = express();
app.disable('x-powered-by');
const upload = multer({
  dest: uploadDir,
  fileFilter: (_request, file, callback) => {
    if (!imageExtensions.has(path.extname(file.originalname).toLowerCase())) {
      const error: any = new Error('Unsupported image format.');
      error.status = 415;
      callback(error);
      return;
    }
    callback(null, true);
  },
  limits: {
    fileSize: 120 * 1024 * 1024,
    files: 24,
  },
});

app.use(express.json());
app.use((_request, response, next) => {
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(['/api/admin', '/api/setup'], (_request, response, next) => {
  response.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/media', (request, response, next) => {
  express.static(publicMediaDir(), { maxAge: isProduction ? '30d' : 0 })(request, response, next);
});
app.use('/media', (_request, response) => {
  response.status(404).type('text/plain').send('Media not found.');
});
app.use('/data', express.static(dataDir, { maxAge: 0 }));

app.get('/api/setup/status', (request, response) => {
  response.json(setupStatusForRequest(request));
});

app.post('/api/setup/save', requireSetupAccess, serializeGalleryMutation, async (request, response, next) => {
  try {
    const input = request.body || {};
    assertDatabaseTargetUnchanged(input);
    const previousStorage = storageTarget(runtime.config.storage);
    const nextRuntime = await saveRuntimeConfig(runtimePaths, runtime, input);
    const nextStorage = storageTarget(nextRuntime.config.storage);
    const storageMigration = previousStorage === nextStorage
      ? null
      : await galleryStore.migrateStorage(nextRuntime.config.storage);
    runtime = nextRuntime;
    await reloadGalleryStore();
    response.json({
      ...publicSetupStatus(runtime),
      ...(storageMigration ? { storageMigration } : {}),
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/photos', async (_request, response, next) => {
  try {
    const gallery = await galleryStore.listPublicGallery();
    response.json(gallery.photos);
  } catch (error) {
    next(error);
  }
});

app.get('/api/gallery', async (request, response, next) => {
  try {
    response.json(await galleryStore.listPublicGallery({ groupSlug: request.query.group }));
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/session', (request, response) => {
  response.json({ ok: true, authenticated: isAdminRequest(request) });
});

app.post('/api/admin/login', (request, response) => {
  const loginKey = loginClientKey(request);
  const blockedFor = loginBlockedFor(loginKey);
  if (blockedFor > 0) {
    response.setHeader('Retry-After', String(Math.ceil(blockedFor / 1000)));
    response.status(429).json({ ok: false, message: 'Too many login attempts. Try again later.' });
    return;
  }
  if (!verifyAdminPassword(request.body?.password || request.body?.key)) {
    recordLoginFailure(loginKey);
    response.status(401).json({ ok: false, message: 'Invalid password.' });
    return;
  }
  loginFailures.delete(loginKey);
  response.setHeader('Set-Cookie', createAdminSessionCookie(request));
  response.json({ ok: true, authenticated: true });
});

app.post('/api/admin/logout', (request, response) => {
  response.setHeader('Set-Cookie', clearAdminSessionCookie(request));
  response.json({ ok: true, authenticated: false });
});

app.get('/api/admin/gallery', requireAdmin, async (_request, response, next) => {
  try {
    response.json(await galleryStore.listAdminGallery());
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/groups', requireAdmin, async (_request, response, next) => {
  try {
    const gallery = await galleryStore.listAdminGallery();
    response.json({ ok: true, groups: gallery.groups });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/groups', requireAdmin, serializeGalleryMutation, async (request, response, next) => {
  try {
    response.status(201).json({ ok: true, group: await galleryStore.createGroup(request.body || {}) });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/admin/groups/:id', requireAdmin, serializeGalleryMutation, async (request, response, next) => {
  try {
    response.json({ ok: true, group: await galleryStore.updateGroup(request.params.id, request.body || {}) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/admin/groups/:id', requireAdmin, serializeGalleryMutation, async (request, response, next) => {
  try {
    response.json(await galleryStore.deleteGroup(request.params.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/photos', requireAdmin, serializeGalleryMutation, upload.array('photos', 24), async (request, response, next) => {
  try {
    const files = Array.isArray(request.files) ? request.files : [];
    if (!files.length) {
      response.status(400).json({ ok: false, message: 'No photos received.' });
      return;
    }
    response.status(201).json({
      ok: true,
      ...(await galleryStore.addPhotos({
        files,
        groupId: request.body?.groupId,
        title: request.body?.title,
        titlePrefix: request.body?.titlePrefix || 'Gallery',
        description: request.body?.description,
        capturedAt: request.body?.capturedAt,
      })),
    });
  } catch (error) {
    await cleanupTempFiles(request.files);
    next(error);
  }
});

app.patch('/api/admin/photos/:id', requireAdmin, serializeGalleryMutation, async (request, response, next) => {
  try {
    response.json({ ok: true, photo: await galleryStore.updatePhoto(request.params.id, request.body || {}) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/admin/photos/:id', requireAdmin, serializeGalleryMutation, async (request, response, next) => {
  try {
    response.json(await galleryStore.deletePhoto(request.params.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/photos/:id/reprocess', requireAdmin, serializeGalleryMutation, async (request, response, next) => {
  try {
    response.json({ ok: true, photo: await galleryStore.reprocessPhoto(request.params.id) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/upload', requireLegacyUploadAccess, serializeGalleryMutation, upload.array('photos', 24), async (request, response, next) => {
  try {
    const files = Array.isArray(request.files) ? request.files : [];
    if (!files.length) {
      await cleanupTempFiles(request.files);
      response.status(400).json({ ok: false, message: 'No photos received.' });
      return;
    }

    const manifest = await galleryStore.addPhotos({
      files,
      titlePrefix: request.body?.titlePrefix || 'Gallery',
    });
    response.json({ ok: true, count: manifest.count, photos: manifest.photos });
  } catch (error) {
    await cleanupTempFiles(request.files);
    next(error);
  }
});

if (isProduction) {
  app.use(express.static(distDir));
  app.use((_request, response) => {
    response.sendFile(path.join(distDir, 'index.html'));
  });
} else {
  const vite = await createViteServer({
    appType: 'spa',
    root,
    server: {
      hmr: disableHmr ? false : undefined,
      middlewareMode: true,
    },
  });
  app.use(vite.middlewares);
  app.use(async (request, response, next) => {
    try {
      let html = await vite.transformIndexHtml(
        request.originalUrl,
        await readFile(path.join(root, 'index.html'), 'utf8'),
      );
      response.status(200).set({ 'Content-Type': 'text/html' }).end(html);
    } catch (error) {
      vite.ssrFixStacktrace(error);
      next(error);
    }
  });
}

app.use(async (error, request, response, _next) => {
  await cleanupTempFiles(request.files);
  console.error(error);
  const status = error instanceof multer.MulterError
    ? (error.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
    : error.status || 500;
  response.status(status).json({
    ok: false,
    message: error.message || 'Unexpected server error.',
  });
});

app.listen(port, () => {
  console.log(`WebGL Gallery is running at http://localhost:${port}`);
  console.log(`First-run setup: http://localhost:${port}/setup`);
  console.log(`Hidden upload room: http://localhost:${port}/studio`);
});

async function cleanupTempFiles(files) {
  if (!Array.isArray(files)) return;
  await Promise.all(files.map((file) => unlink(file.path).catch(() => {})));
}

async function reloadGalleryStore() {
  await galleryStore.close?.();
  galleryStore = createGalleryStore({
    dataDir,
    manifestPath,
    mediaDir,
    originalDir,
    uploadDir,
    runtimeConfig: runtime.config,
  });
  await galleryStore.init();
}

function publicMediaDir() {
  return runtime.config.storage?.kind === 'local' && runtime.config.storage.mediaDir
    ? runtime.config.storage.mediaDir
    : mediaDir;
}

function setupStatusForRequest(request) {
  const status = publicSetupStatus(runtime);
  if (!status.configured || isAdminRequest(request)) return status;
  return {
    ok: status.ok,
    configured: true,
    locked: true,
    database: {
      configured: status.database?.configured !== false,
      issue: '',
      kind: status.database?.kind || '',
    },
    storage: {
      configured: status.storage?.configured !== false,
      kind: status.storage?.kind || '',
    },
    auth: {
      hasAdminPassword: status.auth?.hasAdminPassword !== false,
      hasSessionSecret: status.auth?.hasSessionSecret !== false,
    },
    checks: (status.checks || []).map((check) => ({
      key: check.key,
      kind: check.kind,
      label: check.label,
      ok: check.ok,
    })),
  };
}

function requireSetupAccess(request, response, next) {
  if (!publicSetupStatus(runtime).configured || isAdminRequest(request)) {
    next();
    return;
  }
  response.status(401).json({ ok: false, message: 'Admin login required before changing setup.' });
}

function requireLegacyUploadAccess(request, response, next) {
  if (isAdminRequest(request) || verifyLegacyUploadKey(request.headers['x-gallery-key'])) {
    next();
    return;
  }
  const configured = Boolean(process.env.GALLERY_UPLOAD_KEY);
  response.status(configured ? 401 : 404).json({
    ok: false,
    message: configured ? 'Invalid upload key.' : 'Legacy upload endpoint is disabled.',
  });
}

function assertDatabaseTargetUnchanged(input) {
  if (!publicSetupStatus(runtime).configured) return;
  const current = runtime.config.database || {};
  const requestedKind = String(input.databaseKind || current.kind || 'sqlite');
  let requestedTarget = requestedKind;
  if (requestedKind === 'sqlite') requestedTarget += `:${path.resolve(String(input.sqlitePath || current.sqlitePath || ''))}`;
  if (requestedKind === 'json') requestedTarget += `:${path.resolve(String(input.manifestPath || current.manifestPath || ''))}`;
  if (requestedKind === 'postgres') requestedTarget += `:${String(input.databaseUrl || current.databaseUrl || process.env.DATABASE_URL || '')}`;
  let currentTarget = String(current.kind || 'sqlite');
  if (current.kind === 'sqlite') currentTarget += `:${path.resolve(String(current.sqlitePath || ''))}`;
  if (current.kind === 'json') currentTarget += `:${path.resolve(String(current.manifestPath || ''))}`;
  if (current.kind === 'postgres') currentTarget += `:${String(current.databaseUrl || process.env.DATABASE_URL || '')}`;
  if (requestedTarget !== currentTarget) {
    const error: any = new Error('Changing the database backend in Setup is blocked to prevent an empty gallery. Migrate metadata explicitly first.');
    error.status = 409;
    throw error;
  }
}

function storageTarget(storage) {
  if (storage?.kind === 'r2') {
    return JSON.stringify({
      kind: 'r2',
      accountId: storage.r2?.accountId || '',
      publicBucket: storage.r2?.publicBucket || '',
      privateBucket: storage.r2?.privateBucket || '',
      publicBaseUrl: storage.r2?.publicBaseUrl || '',
    });
  }
  return JSON.stringify({
    kind: 'local',
    mediaDir: path.resolve(String(storage?.mediaDir || mediaDir)),
    originalDir: path.resolve(String(storage?.originalDir || originalDir)),
  });
}

function loginClientKey(request) {
  const cloudflareIp = request.headers['cf-ray'] ? request.headers['cf-connecting-ip'] : '';
  return String(cloudflareIp || request.socket?.remoteAddress || 'unknown');
}

function loginBlockedFor(key) {
  const entry = loginFailures.get(key);
  if (!entry) return 0;
  if (Date.now() - entry.startedAt >= LOGIN_FAILURE_WINDOW_MS) {
    loginFailures.delete(key);
    return 0;
  }
  return entry.count >= LOGIN_MAX_FAILURES
    ? LOGIN_FAILURE_WINDOW_MS - (Date.now() - entry.startedAt)
    : 0;
}

function recordLoginFailure(key) {
  const now = Date.now();
  if (loginFailures.size > 1000) {
    for (const [entryKey, entry] of loginFailures) {
      if (now - entry.startedAt >= LOGIN_FAILURE_WINDOW_MS) loginFailures.delete(entryKey);
    }
    if (loginFailures.size > 1000) loginFailures.delete(loginFailures.keys().next().value);
  }
  const current = loginFailures.get(key);
  if (!current || now - current.startedAt >= LOGIN_FAILURE_WINDOW_MS) {
    loginFailures.set(key, { count: 1, startedAt: now });
    return;
  }
  current.count += 1;
}

function serializeGalleryMutation(_request, response, next) {
  let release: () => void = () => {};
  let active = false;
  let released = false;
  let clientClosed = false;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const finish = () => {
    if (!active || released) return;
    released = true;
    release();
  };
  response.once('close', () => {
    clientClosed = true;
    finish();
  });
  const previous = galleryMutationTail.catch(() => {});
  galleryMutationTail = previous.then(() => current);
  previous.then(() => {
    active = true;
    if (clientClosed) {
      finish();
      return;
    }
    response.once('finish', finish);
    next();
  });
}
