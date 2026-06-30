import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createPasswordHash } from './auth.js';
import { getBuiltinDatabaseSync, hasBuiltinSqlite, sqliteUnavailableMessage } from './sqlite.js';
import { hasR2Config, missingR2ConfigFields, verifyStorageConfig } from './storage.js';

export async function loadRuntimeConfig(paths) {
  const configPath = getRuntimeConfigPath(paths);
  const configDir = path.dirname(configPath);
  const sqliteAvailable = await hasBuiltinSqlite();
  const fileConfig = await readConfigFile(configPath);
  const config = mergeConfig(defaultRuntimeConfig({ ...paths, configDir, sqliteAvailable }), fileConfig || {});
  const envOverrides = envRuntimeOverrides();
  const effectiveConfig = mergeConfig(config, envOverrides);
  if (process.env.GALLERY_PORTABLE_PATHS === '1') {
    applyPortablePaths(effectiveConfig, { ...paths, configDir });
  }
  effectiveConfig.database.sqliteAvailable = sqliteAvailable;
  if (effectiveConfig.database.kind === 'sqlite' && !sqliteAvailable) {
    effectiveConfig.setupComplete = false;
    effectiveConfig.database.issue = sqliteUnavailableMessage();
  }
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
  const sqliteAvailable = await hasBuiltinSqlite();
  const nextConfig: any = normalizeSetupInput({
    input,
    currentConfig: currentRuntime?.config || defaultRuntimeConfig({ ...paths, configDir, sqliteAvailable }),
    paths,
    configDir,
  });
  await validateRuntimeConfig(nextConfig, { paths, verifyStorage: input?.skipStorageCheck !== true });
  nextConfig.database.sqliteAvailable = sqliteAvailable;
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
    issue: config.database.issue || '',
    manifestPath: config.database.kind === 'json' ? config.database.manifestPath : '',
    sqlitePath: config.database.kind === 'sqlite' ? config.database.sqlitePath : '',
    sqliteAvailable: Boolean(config.database.sqliteAvailable),
    hasDatabaseUrl: Boolean(config.database.databaseUrl),
  };
  const storage = {
    kind: config.storage.kind,
    configured: isStorageConfigured(config.storage),
    mediaDir: config.storage.kind === 'local' ? config.storage.mediaDir : '',
    originalDir: config.storage.kind === 'local' ? config.storage.originalDir : '',
    accountId: config.storage.kind === 'r2' ? config.storage.r2?.accountId || '' : '',
    publicBucket: config.storage.kind === 'r2' ? config.storage.r2?.publicBucket || '' : '',
    privateBucket: config.storage.kind === 'r2' ? config.storage.r2?.privateBucket || '' : '',
    publicBaseUrl: config.storage.kind === 'r2' ? config.storage.r2?.publicBaseUrl || '' : '',
    hasR2Credentials: hasR2Config(config.storage),
  };
  return {
    ok: true,
    configured: Boolean(config.setupComplete && isDatabaseConfigured(config.database) && isStorageConfigured(config.storage) && hasAdminPassword(config)),
    configPath: runtime.configPath,
    database,
    storage,
    auth: {
      hasAdminPassword: hasAdminPassword(config),
      hasSessionSecret: Boolean(config.auth.sessionSecret || process.env.SESSION_SECRET),
    },
    checks: buildSetupChecks(config),
  };
}

export function defaultRuntimeConfig({ configDir, mediaDir, originalDir, manifestPath, sqliteAvailable = true }) {
  return {
    version: 1,
    setupComplete: false,
    database: sqliteAvailable
      ? {
          kind: 'sqlite',
          sqlitePath: path.join(configDir, 'gallery.sqlite'),
          sqliteAvailable,
        }
      : {
          kind: 'json',
          manifestPath,
          sqliteAvailable,
          issue: sqliteUnavailableMessage(),
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
  const sessionSecret = String(currentConfig.auth?.sessionSecret || process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'));
  return {
    version: 1,
    setupComplete: true,
    database: normalizeDatabaseConfig({ body, currentConfig, databaseKind, paths, configDir }),
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

async function validateRuntimeConfig(config, options: any = {}) {
  if (!isDatabaseConfigured(config.database)) {
    throw httpError(400, databaseRequiredMessage(config.database.kind));
  }
  if (!isStorageConfigured(config.storage)) {
    if (config.storage?.kind === 'r2') {
      const missing = ` Missing: ${missingR2ConfigFields(config.storage).join(', ')}.`;
      throw httpError(400, `R2 storage requires account id, access keys, both buckets, and public base URL.${missing}`);
    }
    throw httpError(400, 'Local storage requires public media and legacy original folders.');
  }
  if (!hasAdminPassword(config)) {
    throw httpError(400, 'Admin password is required.');
  }
  if (config.database.kind === 'sqlite') {
    const DatabaseSync = await getBuiltinDatabaseSync();
    if (!DatabaseSync) throw httpError(400, sqliteUnavailableMessage());
    await mkdir(path.dirname(config.database.sqlitePath), { recursive: true });
    const db = new DatabaseSync(config.database.sqlitePath);
    db.exec('PRAGMA user_version');
    db.close();
  }
  if (config.database.kind === 'json') {
    await mkdir(path.dirname(config.database.manifestPath), { recursive: true });
  }
  if (options.verifyStorage !== false) {
    try {
      await verifyStorageConfig(config.storage, { publicDir: options.paths?.publicDir });
    } catch (error: any) {
      throw httpError(400, error.message || 'Storage check failed.');
    }
  }
}

function isDatabaseConfigured(database) {
  if (database?.kind === 'postgres') return Boolean(database.databaseUrl || process.env.DATABASE_URL);
  if (database?.kind === 'sqlite') return Boolean(database?.sqlitePath) && database.sqliteAvailable !== false;
  if (database?.kind === 'json') return Boolean(database?.manifestPath);
  return false;
}

function isStorageConfigured(storage) {
  return storage?.kind === 'r2' ? hasR2Config(storage) : Boolean(storage?.mediaDir && storage?.originalDir);
}

function buildSetupChecks(config) {
  return [
    {
      key: 'database',
      kind: config.database.kind,
      issue: config.database.issue || '',
      label: databaseCheckLabel(config.database.kind),
      ok: isDatabaseConfigured(config.database),
    },
    {
      key: 'storage',
      kind: config.storage.kind,
      label: config.storage.kind === 'r2' ? 'Cloudflare R2 image storage' : 'Local image storage',
      ok: isStorageConfigured(config.storage),
    },
    {
      key: 'admin',
      label: 'Admin password',
      ok: hasAdminPassword(config),
    },
  ];
}

function hasAdminPassword(config) {
  return Boolean(config.auth?.adminPasswordHash || process.env.GALLERY_ADMIN_PASSWORD_HASH);
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
  } else if (process.env.GALLERY_MANIFEST_PATH) {
    overrides.database = {
      kind: 'json',
      manifestPath: path.resolve(process.env.GALLERY_MANIFEST_PATH),
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

function applyPortablePaths(config, paths) {
  if (config.database?.kind === 'sqlite') {
    config.database.sqlitePath = path.join(paths.configDir, 'gallery.sqlite');
  }
  if (config.database?.kind === 'json') {
    config.database.manifestPath = paths.manifestPath;
  }
  if (config.storage?.kind === 'local') {
    config.storage.mediaDir = paths.mediaDir;
    config.storage.originalDir = paths.originalDir;
  }
}

function hasExplicitRuntimeEnv() {
  return Boolean(process.env.DATABASE_URL || process.env.GALLERY_SQLITE_PATH || process.env.GALLERY_MANIFEST_PATH || hasR2Config());
}

function normalizeDatabaseConfig({ body, currentConfig, databaseKind, paths, configDir }) {
  if (databaseKind === 'postgres') {
    return {
      kind: 'postgres',
      databaseUrl: String(body.databaseUrl || currentConfig.database?.databaseUrl || process.env.DATABASE_URL || ''),
    };
  }
  if (databaseKind === 'json') {
    return {
      kind: 'json',
      manifestPath: path.resolve(String(body.manifestPath || currentConfig.database?.manifestPath || paths.manifestPath)),
    };
  }
  return {
    kind: 'sqlite',
    sqlitePath: path.resolve(String(body.sqlitePath || currentConfig.database?.sqlitePath || path.join(configDir, 'gallery.sqlite'))),
  };
}

function databaseRequiredMessage(kind) {
  if (kind === 'postgres') return 'Database URL is required.';
  if (kind === 'json') return 'JSON manifest path is required.';
  return 'SQLite path is required.';
}

function databaseCheckLabel(kind) {
  if (kind === 'postgres') return 'Postgres metadata';
  if (kind === 'json') return 'Local JSON metadata';
  return 'Local SQLite metadata';
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

export function redactRuntimeConfig(config, { keepSecrets = false } = {}) {
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
