import { MigrationRunner } from './migrate.js';

async function main() {
  const databaseUrl = process.env.DATABASE_URL || 'postgresql://taskqueue:taskqueue@localhost:5432/taskqueue';
  const migrationsDir = process.env.MIGRATIONS_DIR || './migrations';

  const runner = new MigrationRunner(databaseUrl);
  await runner.run(migrationsDir);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
