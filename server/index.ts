import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { createServer as createViteServer } from 'vite';
import { clearAdminSessionCookie, createAdminSessionCookie, isAdminRequest, requireAdmin, verifyAdminPassword } from './auth.js';
import { createGalleryStore } from './galleryStore.js';
import { ensureGalleryDirs } from './photoPipeline.js';
import { loadRuntimeConfig, publicSetupStatus, saveRuntimeConfig } from './runtimeConfig.js';
import { projectRootFromImportMeta, resolveRuntimePaths } from './runtimePaths.js';

const runtimePaths = resolveRuntimePaths(projectRootFromImportMeta(import.meta.url));
const { root, publicDir, dataDir, mediaDir, uploadDir, originalDir, manifestPath } = runtimePaths;
const distDir = path.join(root, 'dist');
const port = Number(process.env.PORT || 5279);
const uploadKey = process.env.GALLERY_UPLOAD_KEY || '13209';
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

const app = express();
const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: 120 * 1024 * 1024,
    files: 24,
  },
});

app.use(express.json());
app.use('/media', (request, response, next) => {
  express.static(publicMediaDir(), { maxAge: isProduction ? '30d' : 0 })(request, response, next);
});
app.use('/data', express.static(dataDir, { maxAge: 0 }));

app.get('/api/setup/status', (request, response) => {
  response.json(setupStatusForRequest(request));
});

app.post('/api/setup/save', requireSetupAccess, async (request, response, next) => {
  try {
    runtime = await saveRuntimeConfig(runtimePaths, runtime, request.body || {});
    await reloadGalleryStore();
    response.json(publicSetupStatus(runtime));
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
  if (!verifyAdminPassword(request.body?.password || request.body?.key)) {
    response.status(401).json({ ok: false, message: 'Invalid password.' });
    return;
  }
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

app.post('/api/admin/groups', requireAdmin, async (request, response, next) => {
  try {
    response.status(201).json({ ok: true, group: await galleryStore.createGroup(request.body || {}) });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/admin/groups/:id', requireAdmin, async (request, response, next) => {
  try {
    response.json({ ok: true, group: await galleryStore.updateGroup(request.params.id, request.body || {}) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/admin/groups/:id', requireAdmin, async (request, response, next) => {
  try {
    response.json(await galleryStore.deleteGroup(request.params.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/photos', requireAdmin, upload.array('photos', 24), async (request, response, next) => {
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

app.patch('/api/admin/photos/:id', requireAdmin, async (request, response, next) => {
  try {
    response.json({ ok: true, photo: await galleryStore.updatePhoto(request.params.id, request.body || {}) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/admin/photos/:id', requireAdmin, async (request, response, next) => {
  try {
    response.json(await galleryStore.deletePhoto(request.params.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/photos/:id/reprocess', requireAdmin, async (request, response, next) => {
  try {
    response.json({ ok: true, photo: await galleryStore.reprocessPhoto(request.params.id) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/upload', upload.array('photos', 24), async (request, response, next) => {
  try {
    const suppliedKey = request.body?.key || request.headers['x-gallery-key'];
    if (suppliedKey !== uploadKey) {
      await cleanupTempFiles(request.files);
      response.status(401).json({ ok: false, message: 'Invalid key.' });
      return;
    }

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

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(error.status || 500).json({
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
