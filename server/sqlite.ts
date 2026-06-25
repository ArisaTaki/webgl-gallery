let cachedDatabaseSync: any = undefined;

export async function getBuiltinDatabaseSync() {
  if (process.env.GALLERY_DISABLE_SQLITE === '1') return null;
  if (cachedDatabaseSync !== undefined) return cachedDatabaseSync;
  try {
    cachedDatabaseSync = (await import('node:sqlite')).DatabaseSync;
  } catch {
    cachedDatabaseSync = null;
  }
  return cachedDatabaseSync;
}

export async function hasBuiltinSqlite() {
  return Boolean(await getBuiltinDatabaseSync());
}

export function sqliteUnavailableMessage() {
  return 'Local SQLite needs a Node.js runtime with node:sqlite support. Upgrade to Node 24+, choose Local JSON, or use Postgres.';
}
