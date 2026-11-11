import type { RawQuery } from '@hr/schema-core';
import type { FastifyInstance } from 'fastify';
import { etag, requireIfMatch } from '../../http';
import { actorOf, requireAuth } from '../auth/plugin';
import type { SubmissionService } from './service';

type Params = { formId: string };
type ItemParams = Params & { id: string };

export function registerSubmissionRoutes(
  app: FastifyInstance,
  submissions: SubmissionService,
): void {
  // 场景二 Q0：通用提交接口。候选人匿名提交，不需要登录。
  app.post<{ Params: Params; Body: unknown }>(
    '/api/v1/dynamic-data/:formId',
    async (request, reply) => {
      const result = await submissions.create(
        request.params.formId,
        request.body,
        actorOf(request),
      );
      reply.status(201).header('etag', etag(result.lockVersion));
      return result;
    },
  );

  app.register(async (admin) => {
    admin.addHook('preHandler', requireAuth);

    // 场景二 Q1：通用查询、筛选、分页。
    admin.get<{ Params: Params; Querystring: RawQuery }>(
      '/api/v1/dynamic-data/:formId',
      async (request) => submissions.list(request.params.formId, request.query),
    );

    admin.get<{ Params: ItemParams; Querystring: { view?: string } }>(
      '/api/v1/dynamic-data/:formId/:id',
      async (request, reply) => {
        const view = request.query.view === 'latest' ? 'latest' : 'raw';
        const item = await submissions.get(request.params.formId, request.params.id, view);
        reply.header('etag', etag(item.lockVersion));
        return item;
      },
    );

    // 场景二 Q5：修改必须带 If-Match，版本不一致返回 409。
    admin.put<{ Params: ItemParams; Body: unknown }>(
      '/api/v1/dynamic-data/:formId/:id',
      async (request, reply) => {
        const result = await submissions.update(
          request.params.formId,
          request.params.id,
          request.body,
          requireIfMatch(request),
          actorOf(request),
        );
        reply.header('etag', etag(result.lockVersion));
        return result;
      },
    );

    admin.delete<{ Params: ItemParams }>(
      '/api/v1/dynamic-data/:formId/:id',
      async (request, reply) => {
        await submissions.remove(
          request.params.formId,
          request.params.id,
          requireIfMatch(request),
          actorOf(request),
        );
        return reply.status(204).send();
      },
    );
  });
}
