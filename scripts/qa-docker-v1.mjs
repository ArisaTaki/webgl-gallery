import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gallery-docker-v1-'));
const image = `webgl-gallery:qa-${Date.now()}`;
const container = `webgl-gallery-qa-${process.pid}`;
const port = await getFreePort();
const url = `http://127.0.0.1:${port}`;

try {
  await mkdir(path.join(tempRoot, '.gallery'), { recursive: true });
  await mkdir(path.join(tempRoot, '.uploads'), { recursive: true });
  await mkdir(path.join(tempRoot, 'data'), { recursive: true });
  await mkdir(path.join(tempRoot, 'media'), { recursive: true });

  await run('docker', ['build', '-t', image, '.'], { timeoutMs: 480000 });
  await run('docker', [
    'run',
    '-d',
    '--name',
    container,
    '-p',
    `127.0.0.1:${port}:5279`,
    '-v',
    `${path.join(tempRoot, '.gallery')}:/app/.gallery`,
    '-v',
    `${path.join(tempRoot, '.uploads')}:/app/.uploads`,
    '-v',
    `${path.join(tempRoot, 'data')}:/app/public/data`,
    '-v',
    `${path.join(tempRoot, 'media')}:/app/public/media`,
    image,
  ]);

  const status = await waitForStatus(url);
  const failures = [];
  if (status.ok !== true || status.configured !== false) {
    failures.push(`Expected first-run setup status from Docker container, got ${JSON.stringify(status)}.`);
  }

  const report = {
    ok: failures.length === 0,
    image,
    container,
    url,
    status: {
      configured: status.configured,
      database: status.database,
      storage: status.storage,
    },
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  await run('docker', ['rm', '-f', container]).catch(() => {});
  await run('docker', ['rmi', '-f', image]).catch(() => {});
  if (!process.env.KEEP_DOCKER_QA_TMP) {
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
  const logs = await run('docker', ['logs', container]).catch((error) => ({ stdout: '', stderr: String(error) }));
  throw new Error(`Timed out waiting for Docker container. Last error: ${lastError?.message || lastError}\n${logs.stdout}\n${logs.stderr}`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = options.timeoutMs
      ? setTimeout(() => {
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
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (timeout) clearTimeout(timeout);
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
