import { resolve } from 'node:path';
import { loadConfig } from '../src/config';
import { migrate } from '../src/db/migrate';
import { createPool } from '../src/db/pool';
import { seedDemo } from '../src/seed/demo';

// 写入演示数据。已有数据时拒绝执行，加 --reset 会先清空所有业务表（演示环境专用）。
// 用法：pnpm --filter @hr/server seed [--reset]
// 演示账号密码取 SEED_PASSWORD，未设置时为 demo1234。

const config = loadConfig();
const db = createPool(config.databaseUrl, config.dbPoolMax);
await migrate(db, resolve(process.env.MIGRATIONS_DIR ?? './migrations'));

const { rows } = await db.query<{ count: string }>('SELECT count(*) FROM forms');
if (Number(rows[0]?.count) > 0) {
  if (!process.argv.includes('--reset')) {
    console.error('数据库里已有表单数据。如确认要清空并重建演示数据，请加 --reset');
    process.exit(1);
  }
  // TRUNCATE 不触发行级触发器，所以审计表的“只追加”保护不会拦住演示环境的重置。
  await db.query(
    'TRUNCATE outbox, audit_logs, files, submissions, form_versions, forms, users RESTART IDENTITY CASCADE',
  );
}

const historicalCount = Number(process.env.SEED_HISTORICAL ?? 10000);
const started = Date.now();
await seedDemo(db, { password: process.env.SEED_PASSWORD ?? 'demo1234', historicalCount });
console.log(`演示数据已写入：${historicalCount} 条 v3 历史提交，用时 ${Date.now() - started}ms`);
await db.end();
