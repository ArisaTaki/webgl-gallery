import { loadRuntimeConfig, publicSetupStatus } from '../server/runtimeConfig.js';
import { projectRootFromImportMeta, resolveRuntimePaths } from '../server/runtimePaths.js';
import { verifyStorageConfig } from '../server/storage.js';

const root = projectRootFromImportMeta(import.meta.url);
const paths = resolveRuntimePaths(root);
const runtime = await loadRuntimeConfig(paths);
const status = publicSetupStatus(runtime);
const failures: string[] = [];
let storageProbe: any = null;

try {
  storageProbe = await verifyStorageConfig(runtime.config.storage, {
    verifyPublicUrl: process.env.GALLERY_DOCTOR_SKIP_PUBLIC_URL !== '1',
  });
} catch (error: any) {
  failures.push(error.message || String(error));
}

if (!status.configured) {
  failures.push('Setup is incomplete. Run npm run setup or open /setup.');
}

const report = {
  ok: failures.length === 0,
  configPath: runtime.configPath,
  configured: status.configured,
  database: status.database,
  storage: status.storage,
  auth: status.auth,
  checks: status.checks,
  storageProbe,
  failures,
};

console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;
