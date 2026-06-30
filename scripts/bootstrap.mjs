import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (process.env.WEBGL_GALLERY_SKIP_INSTALL === '1') {
  console.log('\nSkipping npm install because WEBGL_GALLERY_SKIP_INSTALL=1.');
} else if (!(await exists(path.join(root, 'node_modules')))) {
  await run(npm, ['install']);
}

if (process.env.WEBGL_GALLERY_SKIP_SETUP === '1') {
  console.log('\nSkipping setup because WEBGL_GALLERY_SKIP_SETUP=1.');
} else {
  await run(npm, ['run', 'setup']);
}

if (process.env.WEBGL_GALLERY_SKIP_START === '1') {
  console.log('\nSetup finished. Start later with: npm start');
} else {
  await run(npm, ['start']);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    console.log(`\n> ${[command, ...args].join(' ')}`);
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} failed with ${signal || code}`));
    });
  });
}
