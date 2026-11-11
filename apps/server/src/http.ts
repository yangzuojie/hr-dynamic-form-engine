import type { FastifyRequest } from 'fastify';
import { AppError } from './errors';

// 场景二 Q5：乐观锁通过 HTTP 标准头表达。读取时返回 ETag: "<版本号>"，修改时必须带 If-Match。

export const etag = (lockVersion: number): string => `"${lockVersion}"`;

/** 读取 If-Match；缺失时返回 428，提醒客户端必须带版本号，避免“盲写”覆盖别人的修改。 */
export function requireIfMatch(request: FastifyRequest): number {
  const header = request.headers['if-match'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) {
    throw new AppError(428, 'precondition_required', '缺少 If-Match 头：请带上读取时拿到的版本号');
  }
  const value = Number(raw.replace(/^W\//, '').replaceAll('"', ''));
  if (!Number.isInteger(value) || value < 1) {
    throw new AppError(400, 'bad_request', 'If-Match 格式不正确');
  }
  return value;
}

export function parsePage(query: { page?: string; pageSize?: string }): {
  page: number;
  pageSize: number;
} {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(query.pageSize ?? '20', 10) || 20));
  return { page, pageSize };
}
