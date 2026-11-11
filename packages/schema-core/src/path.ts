import type { Field, FieldPath, FormData } from './types';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读取作用域内的点路径，如 "contact.email"。 */
export function getAt(data: unknown, path: FieldPath): unknown {
  let current: unknown = data;
  for (const segment of path.split('.')) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** 不可变地写入点路径，返回新对象；中间层不存在时自动创建。 */
export function setAt(data: FormData, path: FieldPath, value: unknown): FormData {
  const [head, ...rest] = path.split('.');
  if (head === undefined) return data;
  if (rest.length === 0) return { ...data, [head]: value };
  const child = data[head];
  return { ...data, [head]: setAt(isPlainObject(child) ? child : {}, rest.join('.'), value) };
}

/** 在作用域内按点路径查找字段定义；只穿过 object，不进入 repeater。 */
export function findField(fields: Field[], path: FieldPath): Field | undefined {
  const [head, ...rest] = path.split('.');
  const field = fields.find((f) => f.key === head);
  if (!field || rest.length === 0) return field;
  return field.type === 'object' ? findField(field.fields, rest.join('.')) : undefined;
}

export function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export function joinPath(prefix: string, key: string): string {
  return prefix === '' ? key : `${prefix}.${key}`;
}
