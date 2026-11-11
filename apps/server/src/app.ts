import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config';
import type { Db } from './db/pool';
import { registerErrorHandler } from './errors';
import { registerAuditRoutes } from './modules/audit/routes';
import { registerAuth } from './modules/auth/plugin';
import { registerFileRoutes } from './modules/files/routes';
import { FileService } from './modules/files/service';
import { registerFormRoutes } from './modules/forms/routes';
import { FormService } from './modules/forms/service';
import { VersionCache } from './modules/forms/version-cache';
import { OutboxWorker } from './modules/hooks/outbox-worker';
import { registerBuiltinPlugins } from './modules/hooks/plugins';
import { PluginRegistry } from './modules/hooks/registry';
import { registerHookRoutes } from './modules/hooks/routes';
import { registerSubmissionRoutes } from './modules/submissions/routes';
import { SubmissionService } from './modules/submissions/service';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export type App = {
  server: FastifyInstance;
  outbox: OutboxWorker;
  files: FileService;
};

/** 组装应用。数据库连接由调用方传入，测试时可以连 PGlite。 */
export async function buildApp(
  config: Config,
  db: Db,
  options: { logger?: boolean } = {},
): Promise<App> {
  const server = Fastify({
    logger: options.logger ?? true,
    // 部署在本机 Nginx 后面：只信任来自 127.0.0.1 的 X-Forwarded-For，request.ip 才是真实客户端 IP（审计要用），
    // 又不会被外部请求伪造。
    trustProxy: '127.0.0.1',
    bodyLimit: 1024 * 1024,
  });
  registerErrorHandler(server);
  await server.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
  await registerAuth(server, db, config);

  const registry = new PluginRegistry();
  registerBuiltinPlugins(registry);
  const versions = new VersionCache(db);
  const forms = new FormService(db, registry);
  const submissions = new SubmissionService(db, versions, registry);
  const files = new FileService(db, versions, config);

  server.get('/api/health', async () => {
    await db.query('SELECT 1');
    return { ok: true };
  });
  registerFormRoutes(server, forms);
  registerSubmissionRoutes(server, submissions);
  registerFileRoutes(server, files);
  registerAuditRoutes(server, db, versions);
  registerHookRoutes(server, db, registry);

  const outbox = new OutboxWorker(registry, { db, config }, server.log);
  return { server, outbox, files };
}
