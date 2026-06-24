import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncSourcePhotos } from '../server/photoPipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const args = new Map();

for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key?.startsWith('--')) {
    args.set(key.slice(2), value);
    index += 1;
  }
}

const sourceDir = args.get('source') || process.env.PHOTO_SOURCE;

if (!sourceDir) {
  console.error('Usage: npm run sync:photos -- --source "/absolute/path/to/photos"');
  process.exit(1);
}

const manifest = await syncSourcePhotos({
  sourceDir,
  dataDir: path.join(root, 'public', 'data'),
  mediaDir: path.join(root, 'public', 'media'),
  uploadDir: path.join(root, '.uploads', 'tmp'),
  manifestPath: path.join(root, 'public', 'data', 'photos.json'),
});

console.log(`Synced ${manifest.count} photos from ${sourceDir}`);
