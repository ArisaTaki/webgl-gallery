import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const archivePath = path.join(root, 'dist', 'webgl-gallery.tar.gz');
const installerPath = path.join(root, 'dist', 'install.sh');

await access(archivePath);
const installer = await stat(installerPath);
assert.ok((installer.mode & 0o111) !== 0, 'dist/install.sh must be executable.');

const archiveList = (await run('tar', ['-tzf', archivePath])).stdout
  .split('\n')
  .filter(Boolean)
  .map((entry) => entry.replace(/^\.\//, ''));
const entries = new Set(archiveList);

const required = [
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.image.yml',
  'install.sh',
  '.env.example',
  '.github/workflows/release.yml',
  'package.json',
  'server/index.ts',
  'server/runtimePaths.ts',
  'scripts/bootstrap.mjs',
  'scripts/gallery-doctor.ts',
  'scripts/qa-docker-install-v1.mjs',
];
for (const entry of required) {
  assert.ok(entries.has(entry), `Release archive is missing ${entry}.`);
}

const forbiddenPatterns = [
  /^\.env$/,
  /^\.gallery(?:\/|$)/,
  /^\.uploads(?:\/|$)/,
  /^node_modules(?:\/|$)/,
  /^dist(?:\/|$)/,
  /^public\/media(?:\/|$)/,
  /^public\/uploads(?:\/|$)/,
  /^public\/data\/photos\.json$/,
];
const forbidden = archiveList.filter((entry) => forbiddenPatterns.some((pattern) => pattern.test(entry)));
assert.deepEqual(forbidden, [], `Release archive contains runtime-only files: ${forbidden.join(', ')}`);

const exampleEnv = await readFile(path.join(root, '.env.example'), 'utf8');
assert.match(exampleEnv, /^WEBGL_GALLERY_PORT=5280$/m);
assert.match(exampleEnv, /^WEBGL_GALLERY_IMAGE_MODE=prebuilt$/m);
assert.match(exampleEnv, /^WEBGL_GALLERY_IMAGE=ghcr\.io\/arisataki\/webgl-gallery:latest$/m);
assert.match(exampleEnv, /^WEBGL_GALLERY_HOSTNAME=gallery\.irop\.one$/m);
assert.match(exampleEnv, /^CLOUDFLARE_TUNNEL_TOKEN=$/m);
assert.match(exampleEnv, /^R2_PUBLIC_BASE_URL=$/m);

console.log(JSON.stringify({
  ok: true,
  archivePath,
  installerPath,
  files: archiveList.length,
  required,
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
