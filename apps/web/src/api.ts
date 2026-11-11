import type { FieldError } from '@hr/schema-core';

// 后端统一错误格式：{ message, code, errors?, ...details }。前端统一抛 ApiError，页面按 status/code 处理。

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly errors: FieldError[] = [],
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export type ApiResult<T> = { data: T; etag: string | undefined };

type RequestOptions = { body?: unknown; ifMatch?: string | undefined; form?: FormData };

export async function request<T>(
  method: string,
  url: string,
  options: RequestOptions = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.ifMatch) headers['if-match'] = options.ifMatch;
  const response = await fetch(url, {
    method,
    headers,
    credentials: 'same-origin',
    body: options.form ?? (options.body === undefined ? null : JSON.stringify(options.body)),
  });
  const etag = response.headers.get('etag') ?? undefined;
  if (response.status === 204) return { data: undefined as T, etag }; // 204 没有响应体，调用方声明的 T 为 void
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw toApiError(response.status, payload);
  return { data: payload as T, etag }; // 后端接口的响应结构由各调用处声明
}

function toApiError(status: number, payload: unknown): ApiError {
  const body =
    typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  const { message, code, errors, ...details } = body;
  return new ApiError(
    status,
    typeof code === 'string' ? code : 'error',
    typeof message === 'string' ? message : `请求失败（HTTP ${status}）`,
    Array.isArray(errors) ? (errors as FieldError[]) : [],
    details,
  );
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown, ifMatch?: string) =>
    request<T>('POST', url, { body: body ?? {}, ifMatch }),
  put: <T>(url: string, body: unknown, ifMatch?: string) =>
    request<T>('PUT', url, { body, ifMatch }),
  delete: (url: string, ifMatch?: string) => request<void>('DELETE', url, { ifMatch }),
  upload: <T>(url: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<T>('POST', url, { form });
  },
};
