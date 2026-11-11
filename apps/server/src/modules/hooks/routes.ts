import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/pool';
import { notFound } from '../../errors';
import { parsePage } from '../../http';
import { requireAuth } from '../auth/plugin';
import type { PluginRegistry } from './registry';

// 后台查看钩子执行情况，失败的任务可以手动重试。

export function registerHookRoutes(app: FastifyInstance, db: Db, registry: PluginRegistry): void {
  app.register(async (admin) => {
    admin.addHook('preHandler', requireAuth);

    admin.get('/api/v1/plugins', async () => ({ items: registry.list() }));

    admin.get<{
      Querystring: { formId?: string; submissionId?: string; page?: string; pageSize?: string };
    }>('/api/v1/hook-jobs', async (request) => {
      const { page, pageSize } = parsePage(request.query);
      const { rows } = await db.query(
        `SELECT id, hook, event, payload, status, attempts, last_error AS "lastError", result,
                  created_at AS "createdAt", done_at AS "doneAt", next_run_at AS "nextRunAt",
                  count(*) OVER () AS total
             FROM outbox
            WHERE ($1::text IS NULL OR payload->>'formId' = $1)
              AND ($2::text IS NULL OR payload->>'submissionId' = $2)
            ORDER BY id DESC LIMIT $3 OFFSET $4`,
        [
          request.query.formId ?? null,
          request.query.submissionId ?? null,
          pageSize,
          (page - 1) * pageSize,
        ],
      );
      const total = Number(rows[0]?.total ?? 0);
      return { items: rows.map(({ total: _t, ...row }) => row), total, page, pageSize };
    });

    admin.post<{ Params: { id: string } }>('/api/v1/hook-jobs/:id/retry', async (request) => {
      const result = await db.query(
        `UPDATE outbox SET status = 'pending', attempts = 0, next_run_at = now()
          WHERE id = $1 AND status = 'failed'`,
        [Number(request.params.id) || 0],
      );
      if (result.rowCount !== 1) throw notFound('失败的任务');
      return { ok: true };
    });
  });
}
