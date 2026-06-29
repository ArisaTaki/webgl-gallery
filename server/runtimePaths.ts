import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function projectRootFromImportMeta(importMetaUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), '..');
}

export function resolveRuntimePaths(root = projectRootFromImportMeta()) {
  const publicDir = path.join(root, 'public');
  const dataDir = path.resolve(process.env.GALLERY_DATA_DIR || path.join(publicDir, 'data'));
  const mediaDir = path.resolve(process.env.GALLERY_MEDIA_DIR || path.join(publicDir, 'media'));
  const uploadDir = path.resolve(process.env.GALLERY_UPLOAD_DIR || path.join(root, '.uploads', 'tmp'));
  const originalDir = path.resolve(process.env.GALLERY_ORIGINAL_DIR || path.join(root, '.uploads', 'originals'));
  const manifestPath = path.resolve(process.env.GALLERY_MANIFEST_PATH || path.join(dataDir, 'photos.json'));
  return {
    root,
    publicDir,
    dataDir,
    mediaDir,
    uploadDir,
    originalDir,
    manifestPath,
  };
}
