import { spawn } from 'node:child_process';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const outDir = path.join(root, 'dist');
const archivePath = path.join(outDir, 'nian-gallery.tar.gz');
const installerPath = path.join(outDir, 'install.sh');

await mkdir(outDir, { recursive: true });
await copyFile(path.join(root, 'install.sh'), installerPath);
await run('tar', [
  '-czf',
  archivePath,
  '--exclude',
  '.git',
  '--exclude',
  'node_modules',
  '--exclude',
  '.gallery',
  '--exclude',
  '.uploads',
  '--exclude',
  'dist',
  '--exclude',
  '.env',
  '--exclude',
  'public/media',
  '--exclude',
  'public/uploads',
  '--exclude',
  'public/data/photos.json',
  '-C',
  root,
  '.',
]);

const archive = await stat(archivePath);
console.log(JSON.stringify({
  ok: true,
  archivePath,
  installerPath,
  archiveSizeBytes: archive.size,
  example: 'curl -fsSL https://your-domain.example/install.sh | NIAN_GALLERY_SOURCE_URL=https://your-domain.example/nian-gallery.tar.gz sh',
}, null, 2));

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} failed with ${signal || code}\n${stdout}\n${stderr}`));
    });
  });
}
