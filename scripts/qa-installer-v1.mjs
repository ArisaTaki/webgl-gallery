import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gallery-installer-v1-'));
const root = path.resolve(new URL('..', import.meta.url).pathname);
const archivePath = path.join(tempRoot, 'webgl-gallery.tar.gz');
const installDir = path.join(tempRoot, 'installed');

try {
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
    '.env',
    '--exclude',
    'dist',
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

  const install = await run('sh', [path.join(root, 'install.sh')], {
    cwd: tempRoot,
    env: {
      ...process.env,
      WEBGL_GALLERY_DIR: installDir,
      WEBGL_GALLERY_INSTALL_MODE: 'node',
      WEBGL_GALLERY_SKIP_INSTALL: '1',
      WEBGL_GALLERY_SKIP_SETUP: '1',
      WEBGL_GALLERY_SKIP_START: '1',
      WEBGL_GALLERY_SOURCE_URL: pathToFileURL(archivePath).href,
    },
  });

  await access(path.join(installDir, 'package.json'));
  await access(path.join(installDir, 'scripts', 'bootstrap.mjs'));
  await access(path.join(installDir, 'install.sh'));
  await mkdir(path.join(installDir, '.gallery'), { recursive: true });
  await writeFile(path.join(installDir, '.gallery', 'config.json'), '{"setupComplete":true}\n');
  await writeFile(path.join(installDir, '.env'), 'WEBGL_GALLERY_IMAGE_MODE=prebuilt\nCLOUDFLARE_TUNNEL_TOKEN=test-token\n');
  await writeFile(path.join(installDir, 'README.md'), 'stale local file\n');

  const update = await run('sh', [path.join(root, 'install.sh')], {
    cwd: tempRoot,
    env: {
      ...process.env,
      WEBGL_GALLERY_ACTION: 'update',
      WEBGL_GALLERY_DIR: installDir,
      WEBGL_GALLERY_INSTALL_MODE: 'node',
      WEBGL_GALLERY_SKIP_INSTALL: '1',
      WEBGL_GALLERY_SKIP_SETUP: '1',
      WEBGL_GALLERY_SKIP_START: '1',
      WEBGL_GALLERY_SOURCE_URL: pathToFileURL(archivePath).href,
    },
  });
  const refreshedReadme = await readFile(path.join(installDir, 'README.md'), 'utf8');
  const preservedEnv = await readFile(path.join(installDir, '.env'), 'utf8');
  const preservedConfig = await readFile(path.join(installDir, '.gallery', 'config.json'), 'utf8');
  if (!refreshedReadme.startsWith('# WebGL Gallery')) throw new Error('Installer update did not refresh project files.');
  if (!preservedEnv.includes('CLOUDFLARE_TUNNEL_TOKEN=test-token')) throw new Error('Installer update did not preserve .env.');
  if (!preservedConfig.includes('"setupComplete":true')) throw new Error('Installer update did not preserve .gallery config.');

  console.log(JSON.stringify({
    ok: true,
    installDir,
    output: install.stdout.split('\n').filter(Boolean).slice(-8),
    updateOutput: update.stdout.split('\n').filter(Boolean).slice(-8),
  }, null, 2));
} finally {
  if (!process.env.KEEP_INSTALLER_QA_TMP) {
    await rm(tempRoot, { force: true, recursive: true }).catch(() => {});
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || root,
      env: options.env || process.env,
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
