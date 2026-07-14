import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);
const MAX_INPUT_PIXELS = 160_000_000;

export const imageExtensions = new Set([
  '.bmp',
  '.avif',
  '.gif',
  '.heic',
  '.heif',
  '.jfif',
  '.jpeg',
  '.jpg',
  '.png',
  '.tif',
  '.tiff',
  '.webp',
]);

export const variants = [
  { key: 'thumb', width: 520, quality: 66 },
  { key: 'medium', width: 1280, quality: 78 },
  { key: 'large', width: 2200, quality: 84 },
];

export async function ensureGalleryDirs({ dataDir, mediaDir, uploadDir }) {
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(mediaDir, { recursive: true }),
    mkdir(uploadDir, { recursive: true }),
  ]);
}

export async function loadManifest(manifestPath) {
  try {
    const raw = await readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    const photos = Array.isArray(parsed.photos) ? parsed.photos : [];
    const groups = Array.isArray(parsed.groups) ? parsed.groups : [];
    return {
      count: photos.length,
      groups,
      photos,
      updatedAt: parsed.updatedAt || null,
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { count: 0, groups: [], photos: [], updatedAt: null };
    }
    throw error;
  }
}

export async function saveManifest(manifestPath, photos, groups = []) {
  const payload = {
    updatedAt: new Date().toISOString(),
    count: photos.length,
    groups,
    photos,
  };
  await mkdir(path.dirname(manifestPath), { recursive: true });
  const tempPath = `${manifestPath}.${process.pid}.${cryptoRandomSuffix()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`);
    await rename(tempPath, manifestPath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
  return payload;
}

export async function collectSourceImages(sourceDir) {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => imageExtensions.has(path.extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

  const byStem = new Map();
  for (const fileName of candidates) {
    const extension = path.extname(fileName).toLowerCase();
    const stem = fileName.slice(0, -path.extname(fileName).length);
    const previous = byStem.get(stem);
    if (!previous || sourcePreference(extension) > sourcePreference(previous.extension)) {
      byStem.set(stem, {
        extension,
        fileName,
        inputPath: path.join(sourceDir, fileName),
        stem,
      });
    }
  }

  return [...byStem.values()].sort((a, b) =>
    a.stem.localeCompare(b.stem, 'en', { numeric: true }),
  );
}

export async function processImage({ inputPath, mediaDir, id, sourceName, title }) {
  await mkdir(mediaDir, { recursive: true });
  const processed = await buildPhotoDerivatives({ inputPath, id, sourceName, title });

  const outputs = {};
  for (const asset of processed.assets) {
    if (asset.kind === 'original') continue;
    await writeFile(path.join(mediaDir, asset.fileName), asset.buffer);
    outputs[asset.kind] = `/media/${asset.fileName}`;
  }

  return {
    ...processed.photo,
    ...outputs,
  };
}

export async function buildPhotoDerivatives({ inputPath, id, sourceName, title }) {
  const prepared = await prepareSharpInput(inputPath);
  try {
    const source = sharp(prepared.inputPath, { limitInputPixels: MAX_INPUT_PIXELS }).rotate();
    const metadata = await source.metadata();
    const blur = await source
      .clone()
      .resize({ width: 36, withoutEnlargement: true })
      .webp({ quality: 36 })
      .toBuffer();
    const color = await sampleColor(source);

    const assets: any[] = [];

    for (const variant of variants) {
      const fileName = `${id}-${variant.key}.webp`;
      const { data, info } = await source
        .clone()
        .resize({ width: variant.width, withoutEnlargement: true })
        .webp({ quality: variant.quality, effort: 5 })
        .toBuffer({ resolveWithObject: true });
      assets.push({
        kind: variant.key,
        fileName,
        buffer: data,
        width: info.width,
        height: info.height,
        sizeBytes: data.byteLength,
        mimeType: 'image/webp',
      });
    }

    const swapsOrientation = [5, 6, 7, 8].includes(Number(metadata.orientation));
    const displayWidth = swapsOrientation ? metadata.height : metadata.width;
    const displayHeight = swapsOrientation ? metadata.width : metadata.height;
    return {
      assets,
      photo: {
        id,
        title,
        sourceName,
        width: displayWidth || 1,
        height: displayHeight || 1,
        aspect: (displayWidth || 1) / (displayHeight || 1),
        color,
        blurDataUrl: `data:image/webp;base64,${blur.toString('base64')}`,
      },
    };
  } catch (error) {
    if ((error as any)?.status) throw error;
    throw unsupportedImageError(error);
  } finally {
    await prepared.cleanup();
  }
}

export async function syncSourcePhotos({
  dataDir,
  manifestPath,
  mediaDir,
  sourceDir,
  uploadDir,
}) {
  await ensureGalleryDirs({ dataDir, mediaDir, uploadDir });
  const current = await loadManifest(manifestPath);
  const uploaded = current.photos.filter((photo) => photo.group === 'upload');
  const sources = await collectSourceImages(sourceDir);
  const processed = [];

  for (const [index, source] of sources.entries()) {
    const id = `source-${source.stem.replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}`;
    processed.push(
      await processImage({
        inputPath: source.inputPath,
        mediaDir,
        id,
        sourceName: source.fileName,
        title: `Gallery ${String(index + 1).padStart(3, '0')}`,
      }),
    );
  }

  const photos = [
    ...processed.map((photo, index) => ({
      ...photo,
      group: 'source',
      index: index + 1,
    })),
    ...uploaded.map((photo, index) => ({
      ...photo,
      index: processed.length + index + 1,
    })),
  ];

  return saveManifest(manifestPath, photos);
}

export async function addUploadedPhotos({
  files,
  manifestPath,
  mediaDir,
  titlePrefix = 'Gallery',
}) {
  const current = await loadManifest(manifestPath);
  const nextPhotos = [...current.photos];
  const normalizedTitlePrefix = String(titlePrefix || 'Gallery').trim() || 'Gallery';
  const titleMarker = `${normalizedTitlePrefix} `;
  const startingTitleNumber = nextPhotos.reduce((current, photo) => {
    if (photo.group !== 'upload' || !String(photo.title || '').startsWith(titleMarker)) return current;
    const suffix = String(photo.title).slice(titleMarker.length);
    if (!/^\d+$/.test(suffix)) return current;
    return Math.max(current, Number(suffix));
  }, 0) + 1;

  for (const [index, file] of files.entries()) {
    const stem = path.basename(file.originalname, path.extname(file.originalname));
    const safeStem = stem.replace(/[^a-z0-9_-]/gi, '-').toLowerCase() || 'photo';
    const id = `upload-${Date.now()}-${index}-${safeStem}`;
    const title = `${normalizedTitlePrefix} ${String(startingTitleNumber + index).padStart(3, '0')}`;
    try {
      const processed = await processImage({
        inputPath: file.path,
        mediaDir,
        id,
        sourceName: file.originalname,
        title,
      });
      nextPhotos.push({
        ...processed,
        group: 'upload',
        index: nextPhotos.length + 1,
        uploadedAt: new Date().toISOString(),
      });
    } finally {
      await unlink(file.path).catch(() => {});
    }
  }

  return saveManifest(manifestPath, nextPhotos);
}

async function sampleColor(source) {
  const pixel = await source
    .clone()
    .resize(1, 1, { fit: 'cover' })
    .removeAlpha()
    .raw()
    .toBuffer();
  const [r = 20, g = 20, b = 20] = pixel;
  return `rgb(${r}, ${g}, ${b})`;
}

function sourcePreference(extension) {
  if (extension === '.bmp' || extension === '.tif' || extension === '.tiff') {
    return 3;
  }
  if (extension === '.png' || extension === '.webp') {
    return 2;
  }
  return 1;
}

async function prepareSharpInput(inputPath) {
  try {
    await sharp(inputPath, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    return {
      inputPath,
      cleanup: async () => {},
    };
  } catch (sharpError) {
    if (process.platform !== 'darwin') throw unsupportedImageError(sharpError);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'webgl-gallery-'));
    const convertedPath = path.join(tempDir, `${path.basename(inputPath)}.png`);
    try {
      await execFileAsync('sips', ['-s', 'format', 'png', inputPath, '--out', convertedPath]);
      await sharp(convertedPath, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
      return {
        inputPath: convertedPath,
        cleanup: async () => {
          await rm(tempDir, { force: true, recursive: true }).catch(() => {});
        },
      };
    } catch (conversionError) {
      await rm(tempDir, { force: true, recursive: true }).catch(() => {});
      throw unsupportedImageError(conversionError);
    }
  }
}

function unsupportedImageError(cause) {
  const error: any = new Error('The uploaded file is not a supported or valid image.');
  error.status = 415;
  error.cause = cause;
  return error;
}

function cryptoRandomSuffix() {
  return crypto.randomUUID();
}
