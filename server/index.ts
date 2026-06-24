import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { readFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import {
  addUploadedPhotos,
  ensureGalleryDirs,
  loadManifest,
} from './photoPipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const distDir = path.join(root, 'dist');
const dataDir = path.resolve(process.env.GALLERY_DATA_DIR || path.join(publicDir, 'data'));
const mediaDir = path.resolve(process.env.GALLERY_MEDIA_DIR || path.join(publicDir, 'media'));
const uploadDir = path.resolve(process.env.GALLERY_UPLOAD_DIR || path.join(root, '.uploads', 'tmp'));
const manifestPath = path.resolve(process.env.GALLERY_MANIFEST_PATH || path.join(dataDir, 'photos.json'));
const port = Number(process.env.PORT || 5279);
const uploadKey = process.env.GALLERY_UPLOAD_KEY || '13209';
const isProduction = process.env.NODE_ENV === 'production';
const disableHmr = process.env.GALLERY_DISABLE_HMR === '1';

await ensureGalleryDirs({ dataDir, mediaDir, uploadDir });

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
    response.json(await loadManifest(manifestPath));
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

    const manifest = await addUploadedPhotos({
      files,
      manifestPath,
      mediaDir,
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
  response.status(500).json({
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
