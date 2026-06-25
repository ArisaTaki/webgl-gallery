import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { clearAdminSessionCookie, createAdminSessionCookie, isAdminRequest, requireAdmin, verifyAdminPassword } from './auth.js';
import { createGalleryStore } from './galleryStore.js';
import { ensureGalleryDirs } from './photoPipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const distDir = path.join(root, 'dist');
const dataDir = path.resolve(process.env.GALLERY_DATA_DIR || path.join(publicDir, 'data'));
const mediaDir = path.resolve(process.env.GALLERY_MEDIA_DIR || path.join(publicDir, 'media'));
const uploadDir = path.resolve(process.env.GALLERY_UPLOAD_DIR || path.join(root, '.uploads', 'tmp'));
const originalDir = path.resolve(process.env.GALLERY_ORIGINAL_DIR || path.join(root, '.uploads', 'originals'));
const manifestPath = path.resolve(process.env.GALLERY_MANIFEST_PATH || path.join(dataDir, 'photos.json'));
const port = Number(process.env.PORT || 5279);
const uploadKey = process.env.GALLERY_UPLOAD_KEY || '13209';
const isProduction = process.env.NODE_ENV === 'production';
const disableHmr = process.env.GALLERY_DISABLE_HMR === '1';

await ensureGalleryDirs({ dataDir, mediaDir, uploadDir });
await mkdir(originalDir, { recursive: true });
const galleryStore = createGalleryStore({ dataDir, manifestPath, mediaDir, originalDir, uploadDir });
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
app.use('/media', express.static(mediaDir, { maxAge: isProduction ? '30d' : 0 }));
app.use('/data', express.static(dataDir, { maxAge: 0 }));

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
  response.setHeader('Set-Cookie', createAdminSessionCookie());
  response.json({ ok: true, authenticated: true });
});

app.post('/api/admin/logout', (_request, response) => {
  response.setHeader('Set-Cookie', clearAdminSessionCookie());
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
      titlePrefix: request.body?.titlePrefix || '念念',
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
  console.log(`Nian gallery is running at http://localhost:${port}`);
  console.log(`Hidden upload room: http://localhost:${port}/studio`);
});

async function cleanupTempFiles(files) {
  if (!Array.isArray(files)) return;
  await Promise.all(files.map((file) => unlink(file.path).catch(() => {})));
}
