import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gallery-docker-image-install-v1-'));
const installDir = path.join(tempRoot, 'installed');
const composeProject = `webgl-gallery-image-install-qa-${process.pid}-${Date.now()}`.toLowerCase();
const image = `${composeProject}:local`;
const port = await getFreePort();
const url = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  WEBGL_GALLERY_DIR: installDir,
  WEBGL_GALLERY_SOURCE_URL: pathToFileURL(path.join(root, 'dist', 'webgl-gallery.tar.gz')).href,
  WEBGL_GALLERY_PORT: String(port),
  WEBGL_GALLERY_COMPOSE_PROJECT: composeProject,
  WEBGL_GALLERY_IMAGE_MODE: 'prebuilt',
  WEBGL_GALLERY_IMAGE: image,
  CLOUDFLARE_TUNNEL_TOKEN: '',
};

try {
  await run('npm', ['run', 'package:release'], { timeoutMs: 120000 });
  await run('docker', ['build', '-t', image, '.'], { timeoutMs: 480000 });
  const install = await run('sh', [path.join(root, 'dist', 'install.sh')], {
    cwd: tempRoot,
    env,
    timeoutMs: 240000,
  });
  const status = await waitForStatus(url);
  const failures = [];
  const installLines = install.stdout.split('\n').filter(Boolean);
  if (!installLines.some((line) => line.includes('Using prebuilt Docker image'))) {
    failures.push('Expected installer output to use prebuilt Docker image mode.');
  }
  if (status.ok !== true || status.configured !== false) {
    failures.push(`Expected first-run setup status from prebuilt-image install, got ${JSON.stringify(status)}.`);
  }
  if (status.configPath !== '/app/.gallery/config.json') {
    failures.push(`Expected portable config path in container, got ${status.configPath}.`);
  }
  if (status.database?.kind !== 'sqlite' || status.database?.sqlitePath !== '/app/.gallery/gallery.sqlite') {
    failures.push(`Expected portable SQLite path in container, got ${JSON.stringify(status.database)}.`);
  }
  if (status.storage?.kind !== 'local' || status.storage?.mediaDir !== '/app/public/media' || status.storage?.originalDir !== '/app/.uploads/originals') {
    failures.push(`Expected portable local storage paths in container, got ${JSON.stringify(status.storage)}.`);
  }

  const report = {
    ok: failures.length === 0,
    installDir,
    composeProject,
    image,
    url,
    status: {
      configured: status.configured,
      configPath: status.configPath,
      database: status.database,
      storage: status.storage,
    },
    installOutput: installLines.slice(-10),
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  await run('docker', ['compose', '-f', 'docker-compose.image.yml', 'down', '-v', '--remove-orphans'], {
    cwd: installDir,
    env,
    timeoutMs: 120000,
  }).catch(() => {});
  await run('docker', ['rmi', '-f', image], { timeoutMs: 120000 }).catch(() => {});
  if (!process.env.KEEP_DOCKER_IMAGE_INSTALL_QA_TMP) {
    await rm(tempRoot, { force: true, recursive: true }).catch(() => {});
  }
}

async function waitForStatus(baseUrl) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < 60000) {
    try {
      const response = await fetch(`${baseUrl}/api/setup/status`);
      if (response.ok) return response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  const logs = await run('docker', ['compose', '-f', 'docker-compose.image.yml', 'logs', '--no-color'], {
    cwd: installDir,
    env,
  }).catch((error) => ({ stdout: '', stderr: String(error) }));
  throw new Error(`Timed out waiting for prebuilt-image install. Last error: ${lastError?.message || lastError}\n${logs.stdout}\n${logs.stderr}`);
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
    let settled = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          settled = true;
          child.kill('SIGKILL');
          reject(new Error(`${command} ${args.join(' ')} timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs)
      : null;
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      if (timeout) clearTimeout(timeout);
      if (!settled) reject(error);
    });
    child.once('exit', (code, signal) => {
      if (timeout) clearTimeout(timeout);
      if (settled) return;
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} failed with ${signal || code}\n${stdout}\n${stderr}`));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port: chosenPort } = server.address();
      server.close(() => resolve(chosenPort));
    });
  });
}
