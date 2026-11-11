import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { LightMyRequestResponse } from 'fastify';
import { type App, buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { migrate } from '../src/db/migrate';
import { createPool, type Db } from '../src/db/pool';
import { seedDemo } from '../src/seed/demo';

// 集成测试环境：内存版 PGlite + 标准 pg 驱动，和生产走同一套 SQL。每个测试文件一个独立数据库。

export const PASSWORD = 'test-password';

export type TestEnv = App & {
  db: Db;
  login: (username: string) => Promise<string>;
  close: () => Promise<void>;
};

export async function startTestEnv(options: { historicalCount?: number } = {}): Promise<TestEnv> {
  const pglite = await PGlite.create();
  const socket = new PGLiteSocketServer({ db: pglite, port: 0, host: '127.0.0.1' });
  await socket.start();
  const uploadDir = await mkdtemp(join(tmpdir(), 'hr-form-test-'));

  const config = {
    ...loadConfig({ NODE_ENV: 'test' }),
    databaseUrl: `postgres://postgres@${socket.getServerConn()}/postgres`,
    dbPoolMax: 1,
    uploadDir,
    fontPath: resolve(import.meta.dirname, '../assets/fonts/NotoSansSC-Regular.otf'),
    backgroundJobs: false,
  };
  const db = createPool(config.databaseUrl, 1);
  await migrate(db, resolve(import.meta.dirname, '../migrations'));
  await seedDemo(db, { password: PASSWORD, historicalCount: options.historicalCount ?? 50 });
  const app = await buildApp(config, db, { logger: process.env.TEST_LOG === '1' });

  return {
    ...app,
    db,
    login: async (username) => {
      const res = await app.server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username, password: PASSWORD },
      });
      const cookie = res.cookies.find((c) => c.name === 'hr_session');
      if (!cookie) throw new Error(`登录失败：${res.body}`);
      return `hr_session=${cookie.value}`;
    },
    close: async () => {
      await app.server.close();
      await db.end();
      await socket.stop();
      await pglite.close();
      await rm(uploadDir, { recursive: true, force: true });
    },
  };
}

/**
 * PGlite 的 socket 服务在一条 SQL 报错后会重置该连接（真实 PostgreSQL 不会）。
 * 测试里故意触发数据库报错后调用它，让连接池先丢弃坏连接，再继续后面的查询。
 */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

export function json<T = Record<string, unknown>>(res: LightMyRequestResponse): T {
  return res.json<T>();
}
