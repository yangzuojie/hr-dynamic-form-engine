import { type FormData, isPlainObject } from '@hr/schema-core';

// 具体数据路径与 schema-core 的错误路径、字段状态键一致：如 "contact.emergency.name"、"workHistory[1].company"。

export type PathSegment = string | number;

export function parsePath(path: string): PathSegment[] {
  const segments: PathSegment[] = [];
  for (const part of path.split('.')) {
    const match = /^([^[\]]+)((?:\[\d+\])*)$/.exec(part);
    if (!match) continue;
    segments.push(match[1] ?? '');
    for (const index of (match[2] ?? '').matchAll(/\[(\d+)\]/g)) segments.push(Number(index[1]));
  }
  return segments;
}

export function getIn(data: unknown, path: string): unknown {
  let current = data;
  for (const segment of parsePath(path)) {
    if (typeof segment === 'number')
      current = Array.isArray(current) ? current[segment] : undefined;
    else current = isPlainObject(current) ? current[segment] : undefined;
  }
  return current;
}

/** 不可变地写入；只复制路径上经过的对象和数组，其余引用保持不变，未变化的字段组件不会重渲染。 */
export function setIn(data: FormData, path: string, value: unknown): FormData {
  const result = setSegments(data, parsePath(path), value);
  return isPlainObject(result) ? result : data;
}

function setSegments(node: unknown, segments: PathSegment[], value: unknown): unknown {
  const [head, ...rest] = segments;
  if (head === undefined) return value;
  if (typeof head === 'number') {
    const list = Array.isArray(node) ? [...node] : [];
    list[head] = setSegments(list[head], rest, value);
    return list;
  }
  const record = isPlainObject(node) ? { ...node } : {};
  record[head] = setSegments(record[head], rest, value);
  return record;
}

export function joinPath(prefix: string, key: string): string {
  return prefix === '' ? key : `${prefix}.${key}`;
}

/** 去掉下标，得到上传接口需要的字段路径：workHistory[0].certificate → workHistory.certificate */
export function stripIndexes(path: string): string {
  return path.replace(/\[\d+\]/g, '');
}

/** path 是否等于 prefix 或在其之下（用于清除某个字段及其子字段的服务端错误）。 */
export function isWithin(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`);
}
