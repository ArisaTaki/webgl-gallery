import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gallery-installer-v1-'));
const root = path.resolve(new URL('..', import.meta.url).pathname);
const archivePath = path.join(tempRoot, 'webgl-gallery.tar.gz');
const installDir = path.join(tempRoot, 'installed');
const r2InstallDir = path.join(tempRoot, 'installed-r2');

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
  const firstEnv = await readFile(path.join(installDir, '.env'), 'utf8');
  if (!firstEnv.includes('WEBGL_GALLERY_STORAGE_MODE=local')) throw new Error('Installer did not default to local storage mode.');
  if (firstEnv.includes('R2_ACCOUNT_ID=')) throw new Error('Local install should remove blank R2 placeholders.');

  const r2Install = await run('sh', [path.join(root, 'install.sh')], {
    cwd: tempRoot,
    env: {
      ...process.env,
      WEBGL_GALLERY_DIR: r2InstallDir,
      WEBGL_GALLERY_INSTALL_MODE: 'node',
      WEBGL_GALLERY_SKIP_INSTALL: '1',
      WEBGL_GALLERY_SKIP_SETUP: '1',
      WEBGL_GALLERY_SKIP_START: '1',
      WEBGL_GALLERY_SOURCE_URL: pathToFileURL(archivePath).href,
      WEBGL_GALLERY_STORAGE_MODE: 'r2',
      R2_ACCOUNT_ID: 'account-id',
      R2_ACCESS_KEY_ID: 'access-key-id',
      R2_SECRET_ACCESS_KEY: 'secret-access-key',
      R2_PUBLIC_BUCKET: 'public-bucket',
      R2_PRIVATE_BUCKET: 'private-bucket',
      R2_PUBLIC_BASE_URL: 'https://media.example.com',
    },
  });
  const r2Env = await readFile(path.join(r2InstallDir, '.env'), 'utf8');
  for (const expected of [
    'WEBGL_GALLERY_STORAGE_MODE=r2',
    'R2_ACCOUNT_ID=account-id',
    'R2_ACCESS_KEY_ID=access-key-id',
    'R2_SECRET_ACCESS_KEY=secret-access-key',
    'R2_PUBLIC_BUCKET=public-bucket',
    'R2_PRIVATE_BUCKET=private-bucket',
    'R2_PUBLIC_BASE_URL=https://media.example.com',
  ]) {
    if (!r2Env.includes(expected)) throw new Error(`R2 install did not write ${expected}.`);
  }
  await writeFile(path.join(r2InstallDir, '.env'), r2Env.replace(/^WEBGL_GALLERY_STORAGE_MODE=r2\n/m, ''));
  const legacyR2Update = await run('sh', [path.join(root, 'install.sh')], {
    cwd: tempRoot,
    env: {
      ...process.env,
      WEBGL_GALLERY_ACTION: 'update',
      WEBGL_GALLERY_DIR: r2InstallDir,
      WEBGL_GALLERY_INSTALL_MODE: 'node',
      WEBGL_GALLERY_SKIP_INSTALL: '1',
      WEBGL_GALLERY_SKIP_SETUP: '1',
      WEBGL_GALLERY_SKIP_START: '1',
      WEBGL_GALLERY_SOURCE_URL: pathToFileURL(archivePath).href,
    },
  });
  const legacyR2Env = await readFile(path.join(r2InstallDir, '.env'), 'utf8');
  if (!legacyR2Env.includes('WEBGL_GALLERY_STORAGE_MODE=r2')) throw new Error('Installer update did not infer legacy R2 storage mode.');
  if (!legacyR2Env.includes('R2_ACCOUNT_ID=account-id')) throw new Error('Installer update cleared legacy R2 config.');

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
    r2InstallDir,
    output: install.stdout.split('\n').filter(Boolean).slice(-8),
    r2Output: r2Install.stdout.split('\n').filter(Boolean).slice(-8),
    legacyR2UpdateOutput: legacyR2Update.stdout.split('\n').filter(Boolean).slice(-8),
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
