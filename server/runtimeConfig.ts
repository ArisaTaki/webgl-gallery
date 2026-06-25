import crypto from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createPasswordHash } from './auth.js';
import { hasR2Config } from './storage.js';

export async function loadRuntimeConfig(paths) {
  const configPath = getRuntimeConfigPath(paths);
  const configDir = path.dirname(configPath);
  const fileConfig = await readConfigFile(configPath);
  const config = mergeConfig(defaultRuntimeConfig({ ...paths, configDir }), fileConfig || {});
  const envOverrides = envRuntimeOverrides();
  const effectiveConfig = mergeConfig(config, envOverrides);
  if (!fileConfig && hasExplicitRuntimeEnv()) {
    effectiveConfig.setupComplete = true;
  }
  applyRuntimeConfigToEnv(effectiveConfig);
  return {
    config: effectiveConfig,
    configPath,
    hasConfigFile: Boolean(fileConfig),
  };
}

export async function saveRuntimeConfig(paths, currentRuntime, input) {
  const configPath = getRuntimeConfigPath(paths);
  const configDir = path.dirname(configPath);
  const nextConfig = normalizeSetupInput({
    input,
    currentConfig: currentRuntime?.config || defaultRuntimeConfig({ ...paths, configDir }),
    paths,
    configDir,
  });
  await validateRuntimeConfig(nextConfig);
  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(redactRuntimeConfig(nextConfig, { keepSecrets: true }), null, 2)}\n`);
  applyRuntimeConfigToEnv(nextConfig);
  return {
    config: nextConfig,
    configPath,
    hasConfigFile: true,
  };
}

export function publicSetupStatus(runtime) {
  const config = runtime.config;
  const database = {
    kind: config.database.kind,
    configured: isDatabaseConfigured(config.database),
    sqlitePath: config.database.kind === 'sqlite' ? config.database.sqlitePath : '',
    hasDatabaseUrl: Boolean(config.database.databaseUrl),
  };
  const storage = {
    kind: config.storage.kind,
    configured: isStorageConfigured(config.storage),
    mediaDir: config.storage.kind === 'local' ? config.storage.mediaDir : '',
    originalDir: config.storage.kind === 'local' ? config.storage.originalDir : '',
    publicBaseUrl: config.storage.kind === 'r2' ? config.storage.r2?.publicBaseUrl || '' : '',
    hasR2Credentials: hasR2Config(config.storage),
  };
  return {
    ok: true,
    configured: Boolean(config.setupComplete),
    configPath: runtime.configPath,
    database,
    storage,
    auth: {
      hasAdminPassword: Boolean(config.auth.adminPasswordHash || process.env.GALLERY_ADMIN_PASSWORD_HASH),
      hasSessionSecret: Boolean(config.auth.sessionSecret || process.env.SESSION_SECRET),
    },
    checks: buildSetupChecks(config),
  };
}

export function defaultRuntimeConfig({ configDir, mediaDir, originalDir }) {
  return {
    version: 1,
    setupComplete: false,
    database: {
      kind: 'sqlite',
      sqlitePath: path.join(configDir, 'gallery.sqlite'),
    },
    storage: {
      kind: 'local',
      mediaDir,
      originalDir,
    },
    auth: {
      adminPasswordHash: process.env.GALLERY_ADMIN_PASSWORD_HASH || '',
      sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    },
  };
}

export function applyRuntimeConfigToEnv(config) {
  if (config.auth?.adminPasswordHash) process.env.GALLERY_ADMIN_PASSWORD_HASH = config.auth.adminPasswordHash;
  if (config.auth?.sessionSecret) process.env.SESSION_SECRET = config.auth.sessionSecret;
}

function normalizeSetupInput({ input, currentConfig, paths, configDir }) {
  const body = input || {};
  const databaseKind = String(body.databaseKind || currentConfig.database?.kind || 'sqlite');
  const storageKind = String(body.storageKind || currentConfig.storage?.kind || 'local');
  const adminPassword = String(body.adminPassword || '');
  const adminPasswordHash = adminPassword
    ? createPasswordHash(adminPassword)
    : currentConfig.auth?.adminPasswordHash || process.env.GALLERY_ADMIN_PASSWORD_HASH || '';
  const sessionSecret = String(body.sessionSecret || currentConfig.auth?.sessionSecret || process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'));
  return {
    version: 1,
    setupComplete: true,
    database: databaseKind === 'postgres'
      ? {
          kind: 'postgres',
          databaseUrl: String(body.databaseUrl || currentConfig.database?.databaseUrl || process.env.DATABASE_URL || ''),
        }
      : {
          kind: 'sqlite',
          sqlitePath: path.resolve(String(body.sqlitePath || currentConfig.database?.sqlitePath || path.join(configDir, 'gallery.sqlite'))),
        },
    storage: storageKind === 'r2'
      ? {
          kind: 'r2',
          r2: {
            accountId: String(body.r2AccountId || currentConfig.storage?.r2?.accountId || process.env.R2_ACCOUNT_ID || ''),
            accessKeyId: String(body.r2AccessKeyId || currentConfig.storage?.r2?.accessKeyId || process.env.R2_ACCESS_KEY_ID || ''),
            secretAccessKey: String(body.r2SecretAccessKey || currentConfig.storage?.r2?.secretAccessKey || process.env.R2_SECRET_ACCESS_KEY || ''),
            publicBucket: String(body.r2PublicBucket || currentConfig.storage?.r2?.publicBucket || process.env.R2_PUBLIC_BUCKET || ''),
            privateBucket: String(body.r2PrivateBucket || currentConfig.storage?.r2?.privateBucket || process.env.R2_PRIVATE_BUCKET || ''),
            publicBaseUrl: String(body.r2PublicBaseUrl || currentConfig.storage?.r2?.publicBaseUrl || process.env.R2_PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
          },
        }
      : {
          kind: 'local',
          mediaDir: path.resolve(String(body.mediaDir || currentConfig.storage?.mediaDir || paths.mediaDir)),
          originalDir: path.resolve(String(body.originalDir || currentConfig.storage?.originalDir || paths.originalDir)),
        },
    auth: {
      adminPasswordHash,
      sessionSecret,
    },
  };
}

async function validateRuntimeConfig(config) {
  if (!isDatabaseConfigured(config.database)) {
    throw httpError(400, config.database.kind === 'postgres' ? 'Database URL is required.' : 'SQLite path is required.');
  }
  if (!isStorageConfigured(config.storage)) {
    throw httpError(400, 'R2 storage requires account id, access keys, both buckets, and public base URL.');
  }
  if (config.database.kind === 'sqlite') {
    await mkdir(path.dirname(config.database.sqlitePath), { recursive: true });
    const db = new DatabaseSync(config.database.sqlitePath);
    db.exec('PRAGMA user_version');
    db.close();
  }
  if (config.storage.kind === 'local') {
    await mkdir(config.storage.mediaDir, { recursive: true });
    await mkdir(config.storage.originalDir, { recursive: true });
    await access(config.storage.mediaDir, constants.W_OK);
    await access(config.storage.originalDir, constants.W_OK);
  }
}

function isDatabaseConfigured(database) {
  return database?.kind === 'postgres'
    ? Boolean(database.databaseUrl || process.env.DATABASE_URL)
    : Boolean(database?.sqlitePath);
}

function isStorageConfigured(storage) {
  return storage?.kind === 'r2' ? hasR2Config(storage) : Boolean(storage?.mediaDir && storage?.originalDir);
}

function buildSetupChecks(config) {
  return [
    {
      key: 'database',
      label: config.database.kind === 'postgres' ? 'Postgres metadata' : 'Local SQLite metadata',
      ok: isDatabaseConfigured(config.database),
    },
    {
      key: 'storage',
      label: config.storage.kind === 'r2' ? 'Cloudflare R2 image storage' : 'Local image storage',
      ok: isStorageConfigured(config.storage),
    },
    {
      key: 'admin',
      label: 'Admin password',
      ok: Boolean(config.auth.adminPasswordHash || process.env.GALLERY_ADMIN_PASSWORD_HASH),
    },
  ];
}

function envRuntimeOverrides() {
  const overrides: any = {};
  if (process.env.DATABASE_URL) {
    overrides.database = {
      kind: 'postgres',
      databaseUrl: process.env.DATABASE_URL,
    };
  } else if (process.env.GALLERY_SQLITE_PATH) {
    overrides.database = {
      kind: 'sqlite',
      sqlitePath: path.resolve(process.env.GALLERY_SQLITE_PATH),
    };
  }
  if (hasR2Config()) {
    overrides.storage = {
      kind: 'r2',
      r2: {
        accountId: process.env.R2_ACCOUNT_ID,
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        publicBucket: process.env.R2_PUBLIC_BUCKET,
        privateBucket: process.env.R2_PRIVATE_BUCKET,
        publicBaseUrl: process.env.R2_PUBLIC_BASE_URL,
      },
    };
  }
  if (process.env.GALLERY_ADMIN_PASSWORD_HASH || process.env.SESSION_SECRET) {
    overrides.auth = {
      adminPasswordHash: process.env.GALLERY_ADMIN_PASSWORD_HASH || '',
      sessionSecret: process.env.SESSION_SECRET || '',
    };
  }
  return overrides;
}

function hasExplicitRuntimeEnv() {
  return Boolean(process.env.DATABASE_URL || process.env.GALLERY_SQLITE_PATH || hasR2Config());
}

async function readConfigFile(configPath) {
  try {
    return JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error: any) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function mergeConfig(base, override) {
  return {
    ...base,
    ...override,
    database: {
      ...base.database,
      ...(override.database || {}),
    },
    storage: {
      ...base.storage,
      ...(override.storage || {}),
      r2: {
        ...(base.storage?.r2 || {}),
        ...(override.storage?.r2 || {}),
      },
    },
    auth: {
      ...base.auth,
      ...(override.auth || {}),
    },
  };
}

function redactRuntimeConfig(config, { keepSecrets = false } = {}) {
  if (keepSecrets) return config;
  return {
    ...config,
    database: {
      ...config.database,
      databaseUrl: config.database?.databaseUrl ? 'configured' : '',
    },
    storage: {
      ...config.storage,
      r2: config.storage?.r2
        ? {
            ...config.storage.r2,
            accessKeyId: config.storage.r2.accessKeyId ? 'configured' : '',
            secretAccessKey: config.storage.r2.secretAccessKey ? 'configured' : '',
          }
        : undefined,
    },
    auth: {
      hasAdminPassword: Boolean(config.auth?.adminPasswordHash),
      hasSessionSecret: Boolean(config.auth?.sessionSecret),
    },
  };
}

function getRuntimeConfigPath(paths) {
  if (process.env.GALLERY_CONFIG_PATH) return path.resolve(process.env.GALLERY_CONFIG_PATH);
  if (process.env.GALLERY_CONFIG_DIR) return path.resolve(process.env.GALLERY_CONFIG_DIR, 'config.json');
  if (process.env.GALLERY_DATA_DIR) return path.resolve(path.dirname(paths.dataDir), '.gallery', 'config.json');
  return path.resolve(path.join(paths.root, '.gallery', 'config.json'));
}

function httpError(status, message) {
  const error: any = new Error(message);
  error.status = status;
  return error;
}
