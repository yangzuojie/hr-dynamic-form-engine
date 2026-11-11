import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

// 本地开发数据库：PGlite（WASM 版 PostgreSQL），数据存在 ./.pglite，监听 127.0.0.1:5433。
// 用法：pnpm --filter @hr/server dev:db，然后另开终端 pnpm --filter @hr/server dev
// 注意：PGlite 是单连接数据库，开发环境的连接池固定 1 个连接（DB_POOL_MAX 默认 1）。

const port = Number(process.env.DEV_DB_PORT ?? 5433);
const db = await PGlite.create(process.env.DEV_DB_DIR ?? './.pglite');
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
await server.start();
console.log(`开发数据库已启动：postgres://postgres@127.0.0.1:${port}/postgres`);

const stop = async (): Promise<void> => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
