import type { FastifyInstance } from 'fastify';
import { AppError } from '../../errors';
import { actorOf, requireAuth } from '../auth/plugin';
import type { FileService } from './service';

type UploadQuery = { formId?: string; field?: string };

export function registerFileRoutes(app: FastifyInstance, files: FileService): void {
  // 候选人填表时上传（公开）：POST /api/v1/files?formId=tech_onboarding&field=resume
  app.post<{ Querystring: UploadQuery }>('/api/v1/files', async (request, reply) => {
    const { formId, field } = request.query;
    if (!formId || !field) throw new AppError(400, 'bad_request', '缺少 formId 或 field 参数');
    const part = await request.file();
    if (!part) throw new AppError(400, 'bad_request', '请选择要上传的文件');
    let content: Buffer;
    try {
      content = await part.toBuffer();
    } catch {
      // @fastify/multipart 在超过全局大小上限时抛错，这里转成统一的业务错误。
      throw new AppError(413, 'file_too_large', '文件过大');
    }
    const ref = await files.upload({
      formId,
      fieldPath: field,
      filename: part.filename,
      content,
      actor: actorOf(request),
    });
    return reply.status(201).send(ref);
  });

  app.post<{ Params: { id: string } }>(
    '/api/v1/files/:id/link',
    { preHandler: requireAuth },
    async (request) => files.createLink(request.params.id, actorOf(request)),
  );

  app.get<{ Params: { id: string }; Querystring: { exp?: string; sig?: string } }>(
    '/api/v1/files/:id/content',
    async (request, reply) => {
      const { file, content } = await files.readSigned(
        request.params.id,
        request.query.exp ?? '',
        request.query.sig ?? '',
      );
      return reply
        .header('content-type', file.mimeType)
        .header(
          'content-disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
        )
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, no-store')
        .send(content);
    },
  );
}
