import { resolve } from 'node:path';
import { buildApp } from './app';
import { loadConfig } from './config';
import { migrate } from './db/migrate';
import { createPool } from './db/pool';

const ORPHAN_CLEANUP_MS = 60 * 60 * 1000;

const config = loadConfig();
const db = createPool(config.databaseUrl, config.dbPoolMax);
const applied = await migrate(db, resolve(process.env.MIGRATIONS_DIR ?? './migrations'));
const app = await buildApp(config, db);
if (applied.length > 0) app.server.log.info({ applied }, '已执行数据库迁移');

if (config.backgroundJobs) {
  app.outbox.start();
  const cleanup = setInterval(() => {
    void app.files
      .cleanupOrphans()
      .then((count) => count > 0 && app.server.log.info({ count }, '已清理未引用的上传文件'))
      .catch((err: unknown) => app.server.log.error({ err }, '清理上传文件失败'));
  }, ORPHAN_CLEANUP_MS);
  cleanup.unref();
}

const shutdown = async (): Promise<void> => {
  app.outbox.stop();
  await app.server.close();
  await db.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

await app.server.listen({ port: config.port, host: config.host });
