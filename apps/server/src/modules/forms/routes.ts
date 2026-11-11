import { toJsonSchema } from '@hr/schema-core';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../errors';
import { etag, requireIfMatch } from '../../http';
import { actorOf, requireAuth } from '../auth/plugin';
import type { FormService } from './service';

type FormParams = { formId: string };
type VersionParams = FormParams & { version: string };

export function registerFormRoutes(app: FastifyInstance, forms: FormService): void {
  // ---- HR 后台（需要登录） ----
  app.register(async (admin) => {
    admin.addHook('preHandler', requireAuth);

    admin.get('/api/v1/forms', async () => ({ items: await forms.list() }));

    admin.post<{ Body: { formId?: unknown; title?: unknown } }>(
      '/api/v1/forms',
      async (request, reply) => {
        const body = request.body ?? {};
        const form = await forms.create(
          { formId: body.formId, title: body.title },
          actorOf(request),
        );
        reply.status(201).header('etag', etag(form.draftLockVersion));
        return form;
      },
    );

    admin.get<{ Params: FormParams }>('/api/v1/forms/:formId', async (request, reply) => {
      const detail = await forms.get(request.params.formId);
      reply.header('etag', etag(detail.draftLockVersion));
      return detail;
    });

    admin.put<{ Params: FormParams; Body: unknown }>(
      '/api/v1/forms/:formId/draft',
      async (request, reply) => {
        const result = await forms.saveDraft(
          request.params.formId,
          request.body,
          requireIfMatch(request),
          actorOf(request),
        );
        reply.header('etag', etag(result.lockVersion));
        return result;
      },
    );

    admin.post<{ Params: FormParams; Body: { changeNote?: unknown } }>(
      '/api/v1/forms/:formId/publish',
      async (request, reply) => {
        const note = request.body?.changeNote;
        const result = await forms.publish(
          request.params.formId,
          requireIfMatch(request),
          typeof note === 'string' && note.trim() !== '' ? note.trim() : null,
          actorOf(request),
        );
        reply.status(201).header('etag', etag(result.lockVersion));
        return result;
      },
    );

    admin.post<{ Params: FormParams }>('/api/v1/forms/:formId/archive', async (request) => {
      await forms.setStatus(request.params.formId, 'archived', actorOf(request));
      return { ok: true };
    });

    admin.post<{ Params: FormParams }>('/api/v1/forms/:formId/activate', async (request) => {
      await forms.setStatus(request.params.formId, 'active', actorOf(request));
      return { ok: true };
    });

    admin.get<{ Params: VersionParams }>(
      '/api/v1/forms/:formId/versions/:version',
      async (request) =>
        forms.getVersion(request.params.formId, parseVersion(request.params.version)),
    );

    admin.get<{ Params: VersionParams }>(
      '/api/v1/forms/:formId/versions/:version/json-schema',
      async (request) => {
        const row = await forms.getVersion(
          request.params.formId,
          parseVersion(request.params.version),
        );
        return toJsonSchema(row.schema);
      },
    );
  });

  // ---- 候选人填写页（公开） ----
  app.get<{ Params: FormParams }>('/api/v1/public/forms/:formId', async (request) =>
    forms.getPublishedSchema(request.params.formId),
  );
}

function parseVersion(text: string): number {
  const version = Number(text);
  if (!Number.isInteger(version) || version < 1) {
    throw new AppError(400, 'bad_request', '版本号必须是正整数');
  }
  return version;
}
