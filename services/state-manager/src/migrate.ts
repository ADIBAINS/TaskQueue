import { Pool, type PoolClient } from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createLogger } from '@taskqueue/shared';

const log = createLogger('migrate');

interface MigrationRow {
  id: number;
  name: string;
  applied_at: string;
}

/**
 * Simple SQL migration runner.
 * Reads .sql files from a migrations/ directory and applies them in order.
 * Tracks applied migrations in a `migrations` table.
 */
export class MigrationRunner {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 1 });
  }

  /**
   * Run all pending migrations.
   * Creates the migrations tracking table if it doesn't exist.
   */
  async run(migrationsDir: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await this.ensureMigrationsTable(client);

      const applied = await this.getAppliedMigrations(client);
      const files = this.getMigrationFiles(migrationsDir);

      for (const file of files) {
        const name = basename(file);
        if (applied.has(name)) {
          log.info({ name }, 'Migration already applied, skipping');
          continue;
        }

        log.info({ name }, 'Applying migration...');
        const sql = readFileSync(file, 'utf-8');

        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO migrations (name) VALUES ($1)', [name]);
          await client.query('COMMIT');
          log.info({ name }, 'Migration applied successfully');
        } catch (err) {
          await client.query('ROLLBACK');
          log.error({ err, name }, 'Migration failed, rolled back');
          throw err;
        }
      }

      log.info('All migrations applied');
    } finally {
      client.release();
      await this.pool.end();
    }
  }

  private async ensureMigrationsTable(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  private async getAppliedMigrations(client: PoolClient): Promise<Set<string>> {
    const result = await client.query<MigrationRow>('SELECT name FROM migrations ORDER BY id');
    return new Set(result.rows.map((r) => r.name));
  }

  private getMigrationFiles(migrationsDir: string): string[] {
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => join(migrationsDir, f));

    if (files.length === 0) {
      throw new Error(`No migration files found in ${migrationsDir}`);
    }

    return files;
  }
}
