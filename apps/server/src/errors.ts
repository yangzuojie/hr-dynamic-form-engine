import type { FieldError } from '@hr/schema-core';
import type { FastifyError, FastifyInstance } from 'fastify';

// 统一错误格式（设计决策第 20 条）：{ message, code, errors?: [{ path, code, message }] }。
// 业务代码只抛 AppError，由全局处理器转成响应，路由里不散落 reply.code(...)。

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly errors?: FieldError[],
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFound = (what: string): AppError => new AppError(404, 'not_found', `${what}不存在`);

export const validationFailed = (errors: FieldError[], message = '提交数据校验未通过'): AppError =>
  new AppError(422, 'validation_failed', message, errors);

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        message: error.message,
        code: error.code,
        ...(error.errors ? { errors: error.errors } : {}),
        ...error.details,
      });
    }
    // Fastify 自身的请求错误（JSON 解析失败、请求体过大等）带有 4xx 状态码。
    const status = error.statusCode ?? 500;
    if (status < 500) {
      return reply
        .status(status)
        .send({ message: error.message, code: error.code ?? 'bad_request' });
    }
    request.log.error({ err: error }, '未处理的服务器错误');
    return reply.status(500).send({ message: '服务器内部错误', code: 'internal_error' });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ message: '接口不存在', code: 'not_found' }),
  );
}
