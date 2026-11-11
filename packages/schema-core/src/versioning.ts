import { isPlainObject, joinPath } from './path';
import type { Field, FormData, FormSchema } from './types';

// 场景一 Q2：版本间映射。历史提交不批量改写，读取时按 fieldId 懒映射到目标版本。
// 改名：fieldId 不变、key 变化 → 自动跟随；删除：软删除（deprecated）→ 值保留；
// 新增字段：历史数据里没有 → 列入 missingFields，界面显示“历史版本未采集”。

export type MigrationResult = {
  data: FormData;
  /** 目标版本有、来源版本没有的字段路径（例如 v4 新增的 department）。 */
  missingFields: string[];
  /** 发生改名的字段：来源路径 → 目标路径。 */
  renamed: Array<{ from: string; to: string }>;
};

export function migrateData(data: FormData, from: FormSchema, to: FormSchema): MigrationResult {
  const result: MigrationResult = { data: {}, missingFields: [], renamed: [] };
  result.data = migrateFields(data, from.fields, to.fields, '', '', result);
  return result;
}

function migrateFields(
  data: FormData,
  fromFields: Field[],
  toFields: Field[],
  fromPrefix: string,
  toPrefix: string,
  result: MigrationResult,
): FormData {
  const sourceById = new Map(fromFields.map((f) => [f.fieldId, f]));
  const output: FormData = {};
  for (const target of toFields) {
    const toPath = joinPath(toPrefix, target.key);
    const source = sourceById.get(target.fieldId);
    if (!source) {
      if (!target.deprecated) result.missingFields.push(toPath);
      continue;
    }
    const fromPath = joinPath(fromPrefix, source.key);
    if (source.key !== target.key) result.renamed.push({ from: fromPath, to: toPath });

    const value = data[source.key];
    if (value === undefined) continue;

    if (target.type === 'object' && source.type === 'object' && isPlainObject(value)) {
      output[target.key] = migrateFields(
        value,
        source.fields,
        target.fields,
        fromPath,
        toPath,
        result,
      );
    } else if (target.type === 'repeater' && source.type === 'repeater' && Array.isArray(value)) {
      // 每一行结构相同，只按第一行收集改名和缺失信息，避免重复。
      output[target.key] = value.map((row: unknown, index) => {
        const rowResult: MigrationResult =
          index === 0 ? result : { data: {}, missingFields: [], renamed: [] };
        return migrateFields(
          isPlainObject(row) ? row : {},
          source.fields,
          target.fields,
          `${fromPath}[]`,
          `${toPath}[]`,
          rowResult,
        );
      });
    } else {
      output[target.key] = value;
    }
  }
  return output;
}

/** 按 fieldId 找到字段在某个版本里的 key 路径（只穿过 object）；找不到返回 undefined。 */
export function resolveKeyPath(schema: FormSchema, fieldId: string): string[] | undefined {
  const search = (fields: Field[], prefix: string[]): string[] | undefined => {
    for (const field of fields) {
      const path = [...prefix, field.key];
      if (field.fieldId === fieldId) return path;
      if (field.type === 'object') {
        const found = search(field.fields, path);
        if (found) return found;
      }
    }
    return undefined;
  };
  return search(schema.fields, []);
}

// ---- 版本差异：发布说明、并发冲突提示（场景二 Q5）都用它 ----

export type SchemaChange =
  | { kind: 'added'; path: string; label: string }
  | { kind: 'removed'; path: string; label: string }
  | { kind: 'renamed'; from: string; to: string; label: string }
  | { kind: 'deprecated'; path: string; label: string }
  | { kind: 'restored'; path: string; label: string }
  | { kind: 'modified'; path: string; label: string };

export function diffSchemas(before: FormSchema, after: FormSchema): SchemaChange[] {
  const changes: SchemaChange[] = [];
  diffFields(before.fields, after.fields, '', '', changes);
  if (JSON.stringify(before.linkage ?? []) !== JSON.stringify(after.linkage ?? [])) {
    changes.push({ kind: 'modified', path: '(linkage)', label: '联动规则' });
  }
  return changes;
}

function diffFields(
  before: Field[],
  after: Field[],
  beforePrefix: string,
  afterPrefix: string,
  changes: SchemaChange[],
): void {
  const beforeById = new Map(before.map((f) => [f.fieldId, f]));
  const afterIds = new Set(after.map((f) => f.fieldId));

  for (const field of after) {
    const path = joinPath(afterPrefix, field.key);
    const old = beforeById.get(field.fieldId);
    if (old) diffField(old, field, joinPath(beforePrefix, old.key), path, changes);
    else changes.push({ kind: 'added', path, label: field.label });
  }

  for (const field of before) {
    if (!afterIds.has(field.fieldId)) {
      changes.push({
        kind: 'removed',
        path: joinPath(beforePrefix, field.key),
        label: field.label,
      });
    }
  }
}

function diffField(
  old: Field,
  field: Field,
  oldPath: string,
  path: string,
  changes: SchemaChange[],
): void {
  const label = field.label;
  if (old.key !== field.key) changes.push({ kind: 'renamed', from: oldPath, to: path, label });
  if (!old.deprecated && field.deprecated) changes.push({ kind: 'deprecated', path, label });
  if (old.deprecated && !field.deprecated) changes.push({ kind: 'restored', path, label });
  if (stripChildren(old) !== stripChildren(field)) changes.push({ kind: 'modified', path, label });
  if ('fields' in old && 'fields' in field && old.type === field.type) {
    diffFields(old.fields, field.fields, oldPath, path, changes);
  }
}

/** 比较“字段自身的设置”时，忽略 key、deprecated 和子字段（这些单独报告）。 */
function stripChildren(field: Field): string {
  const { key: _key, deprecated: _deprecated, ...rest } = field;
  if ('fields' in rest) {
    const { fields: _fields, ...own } = rest;
    return JSON.stringify(own);
  }
  return JSON.stringify(rest);
}
