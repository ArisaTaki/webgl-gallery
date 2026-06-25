import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

const { Pool } = pg;

export function createDatabase(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) return null;
  const pool = new Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX || 8),
  });
  return {
    db: drizzle(pool, { schema }),
    pool,
  };
}
