import {
  type FilterCondition,
  type FilterScalar,
  type FormSchema,
  resolveKeyPath,
  type SortSpec,
} from '@hr/schema-core';

// 场景二 Q1：把 schema-core 解析好的筛选条件翻译成参数化 SQL。
// - 字段路径和取值全部走 $n 参数，字段只能来自 Schema 白名单，杜绝 SQL 注入；
// - 同一个字段在不同版本里 key 可能不同（v3 employeeName / v4 fullName），按 fieldId 解析每个版本的路径，
//   生成 (schema_version = ANY(...) AND 条件) OR ... ，所以按新字段名筛选也能命中历史数据；
// - 等值筛选用 data @> {...}，可以走 GIN 索引。

export class SqlParams {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

type VersionGroup = { path: string[]; versions: number[] };

/** 按 fieldId 把各版本分组：同一 key 路径的版本合在一起。 */
function groupVersions(
  versions: Map<number, FormSchema>,
  fieldId: string,
): {
  groups: VersionGroup[];
  missing: number[];
} {
  const groups = new Map<string, VersionGroup>();
  const missing: number[] = [];
  for (const [version, schema] of versions) {
    const path = resolveKeyPath(schema, fieldId);
    if (!path) {
      missing.push(version);
      continue;
    }
    const key = path.join('.');
    const group = groups.get(key) ?? { path, versions: [] };
    group.versions.push(version);
    groups.set(key, group);
  }
  return { groups: [...groups.values()], missing };
}

export function buildFilterSql(
  filters: FilterCondition[],
  versions: Map<number, FormSchema>,
  params: SqlParams,
): string[] {
  return filters.map((filter) => {
    const { groups, missing } = groupVersions(versions, filter.fieldId);
    const branches = groups.map(
      (g) =>
        `(schema_version = ANY(${params.add(g.versions)}::int[]) AND ${condition(filter, g.path, params)})`,
    );
    // 某些历史版本根本没有这个字段：只有“为空”的筛选会命中它们。
    if (filter.op === 'empty' && filter.value === true && missing.length > 0) {
      branches.push(`schema_version = ANY(${params.add(missing)}::int[])`);
    }
    return branches.length > 0 ? `(${branches.join(' OR ')})` : 'FALSE';
  });
}

function condition(filter: FilterCondition, path: string[], params: SqlParams): string {
  const { op, value, valueType } = filter;
  // 等值用 JSONB 包含（走 GIN 索引），不需要路径参数。必须在添加路径参数之前返回：
  // 加了却没用到的参数，PostgreSQL 无法推断类型，会报 “could not determine data type of parameter”。
  if (op === 'eq' || op === 'ne') {
    const contains = `data @> ${params.add(JSON.stringify(nest(path, value)))}::jsonb`;
    return op === 'eq' ? contains : `NOT (${contains})`;
  }

  const p = `${params.add(path)}::text[]`;
  const node = `(data #> ${p})`;
  const text = `(data #>> ${p})`;
  const numeric = `(CASE WHEN jsonb_typeof(${node}) = 'number' THEN ${text}::numeric END)`;

  switch (op) {
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const sqlOp = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
      return valueType === 'number'
        ? `${numeric} ${sqlOp} ${params.add(value)}::numeric`
        : `${text} ${sqlOp} ${params.add(value)}`;
    }
    case 'in': {
      const list = Array.isArray(value) ? value : [value];
      return valueType === 'number'
        ? `${numeric} = ANY(${params.add(list)}::numeric[])`
        : `${text} = ANY(${params.add(list.map(String))}::text[])`;
    }
    case 'contains':
      return `${text} ILIKE ${params.add(`%${escapeLike(String(value))}%`)} ESCAPE '\\'`;
    case 'empty': {
      const isEmpty = `(${node} IS NULL OR ${node} = 'null'::jsonb OR ${text} = '' OR ${node} = '[]'::jsonb)`;
      return value === true ? isEmpty : `NOT ${isEmpty}`;
    }
    default: {
      const unreachable: never = op;
      throw new Error(`未知筛选操作符：${String(unreachable)}`);
    }
  }
}

/** ["contact","emergency","name"], "李" → {"contact":{"emergency":{"name":"李"}}} */
function nest(path: string[], value: FilterScalar | FilterScalar[]): unknown {
  return path.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value);
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function buildOrderSql(
  sort: SortSpec,
  versions: Map<number, FormSchema>,
  params: SqlParams,
): string {
  const direction = sort.direction === 'asc' ? 'ASC' : 'DESC';
  if (sort.kind === 'meta') {
    const column = sort.column === 'createdAt' ? 'created_at' : 'updated_at';
    return `${column} ${direction}, id ${direction}`;
  }
  const { groups } = groupVersions(versions, sort.fieldId);
  if (groups.length === 0) return `created_at ${direction}, id ${direction}`;
  const branches = groups.map((g) => {
    const p = `${params.add(g.path)}::text[]`;
    const expr =
      sort.valueType === 'number'
        ? `CASE WHEN jsonb_typeof(data #> ${p}) = 'number' THEN (data #>> ${p})::numeric END`
        : `data #>> ${p}`;
    return `WHEN schema_version = ANY(${params.add(g.versions)}::int[]) THEN ${expr}`;
  });
  const cast = sort.valueType === 'number' ? '::numeric' : '::text';
  return `(CASE ${branches.join(' ')} ELSE NULL${cast} END) ${direction} NULLS LAST, id ${direction}`;
}
