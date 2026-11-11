import { findField } from './path';
import type { Field, FieldError, FormSchema } from './types';

// 场景二 Q1：通用列表查询。
// 语法：?filter[experience][gt]=3&filter[department][in]=研发,测试&sort=-createdAt&page=1&pageSize=20
// 只允许筛选 Schema 中存在的标量字段（input / select，可穿过 object），取值按字段类型转换。
// 解析结果只含 fieldId 和已转换的值，后端据此生成参数化 SQL，用户输入永远不会拼进 SQL。

export type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'empty';
export type FilterScalar = string | number | boolean;
export type FilterValueType = 'string' | 'number' | 'boolean';

export type FilterCondition = {
  fieldId: string;
  /** 在当前 Schema 版本中的 key 路径。查历史版本时，后端再按 fieldId 解析各版本的路径。 */
  keyPath: string[];
  op: FilterOp;
  valueType: FilterValueType;
  value: FilterScalar | FilterScalar[];
};

export type SortSpec =
  | { kind: 'meta'; column: 'createdAt' | 'updatedAt'; direction: 'asc' | 'desc' }
  | {
      kind: 'field';
      fieldId: string;
      keyPath: string[];
      valueType: FilterValueType;
      direction: 'asc' | 'desc';
    };

export type ListQuery = {
  filters: FilterCondition[];
  sort: SortSpec;
  page: number;
  pageSize: number;
  /** raw：返回原始数据；latest：按 fieldId 映射到最新版本后返回。 */
  view: 'raw' | 'latest';
};

export type RawQuery = Record<string, string | string[] | undefined>;

const FILTER_KEY = /^filter\[([A-Za-z0-9_.]+)\](?:\[([a-z]+)\])?$/;
const OPS: readonly FilterOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'empty'];
export const MAX_PAGE_SIZE = 100;

export function parseListQuery(
  schema: FormSchema,
  raw: RawQuery,
): { query: ListQuery; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const filters: FilterCondition[] = [];

  for (const [key, rawValue] of Object.entries(raw)) {
    const match = FILTER_KEY.exec(key);
    if (!match) continue;
    const path = match[1] ?? '';
    const op = parseOp(match[2] ?? 'eq');
    const text = Array.isArray(rawValue) ? rawValue.at(-1) : rawValue;
    if (!op) {
      errors.push({
        path: key,
        code: 'invalid_operator',
        message: `不支持的筛选操作符：${match[2]}`,
      });
      continue;
    }
    const target = resolveScalar(schema.fields, path);
    if (!target) {
      errors.push({ path: key, code: 'invalid_field', message: `字段 ${path} 不存在或不支持筛选` });
      continue;
    }
    const parsed = parseFilterValue(target.field, target.valueType, op, text ?? '');
    if (typeof parsed === 'string') {
      errors.push({ path: key, code: 'invalid_value', message: parsed });
      continue;
    }
    filters.push({
      fieldId: target.field.fieldId,
      keyPath: path.split('.'),
      op,
      valueType: op === 'empty' ? 'boolean' : target.valueType,
      value: parsed.value,
    });
  }

  const sort = parseSort(schema, single(raw.sort), errors);
  const page = parsePositiveInt(single(raw.page), 1, 'page', errors);
  const pageSize = Math.min(
    parsePositiveInt(single(raw.pageSize), 20, 'pageSize', errors),
    MAX_PAGE_SIZE,
  );
  const view = single(raw.view) === 'latest' ? 'latest' : 'raw';
  return { query: { filters, sort, page, pageSize, view }, errors };
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.at(-1) : value;
}

function parseOp(text: string): FilterOp | undefined {
  return OPS.find((op) => op === text);
}

type ScalarTarget = { field: Field; valueType: FilterValueType };

function resolveScalar(fields: Field[], path: string): ScalarTarget | undefined {
  const field = findField(fields, path);
  if (!field) return undefined;
  if (field.type === 'input') {
    return { field, valueType: field.inputKind === 'number' ? 'number' : 'string' };
  }
  if (field.type === 'select') {
    const first = field.options[0]?.value;
    const valueType: FilterValueType =
      typeof first === 'number' ? 'number' : typeof first === 'boolean' ? 'boolean' : 'string';
    return { field, valueType };
  }
  return undefined;
}

function parseFilterValue(
  field: Field,
  valueType: FilterValueType,
  op: FilterOp,
  text: string,
): { value: FilterScalar | FilterScalar[] } | string {
  if (op === 'empty') {
    if (text !== 'true' && text !== 'false') return 'empty 的取值只能是 true 或 false';
    return { value: text === 'true' };
  }
  if (op === 'contains' && valueType !== 'string')
    return `${field.label}不是文本字段，不能用 contains`;
  if (['gt', 'gte', 'lt', 'lte'].includes(op) && valueType === 'boolean') {
    return `${field.label}不能做大小比较`;
  }
  if (op === 'in') {
    const items = text.split(',').map((item) => coerce(item.trim(), valueType));
    if (items.includes(undefined)) return `${field.label}的取值不正确`;
    return { value: items.filter((item): item is FilterScalar => item !== undefined) };
  }
  const value = coerce(text, valueType);
  return value === undefined ? `${field.label}的取值不正确` : { value };
}

function coerce(text: string, valueType: FilterValueType): FilterScalar | undefined {
  if (valueType === 'number') {
    if (text.trim() === '') return undefined;
    const value = Number(text);
    return Number.isFinite(value) ? value : undefined;
  }
  if (valueType === 'boolean') {
    if (text === 'true') return true;
    if (text === 'false') return false;
    return undefined;
  }
  return text;
}

function parseSort(schema: FormSchema, text: string | undefined, errors: FieldError[]): SortSpec {
  const fallback: SortSpec = { kind: 'meta', column: 'createdAt', direction: 'desc' };
  if (!text) return fallback;
  const direction = text.startsWith('-') ? 'desc' : 'asc';
  const name = text.replace(/^[-+]/, '');
  if (name === 'createdAt' || name === 'updatedAt')
    return { kind: 'meta', column: name, direction };
  const target = resolveScalar(schema.fields, name);
  if (!target) {
    errors.push({ path: 'sort', code: 'invalid_field', message: `不能按 ${name} 排序` });
    return fallback;
  }
  return {
    kind: 'field',
    fieldId: target.field.fieldId,
    keyPath: name.split('.'),
    valueType: target.valueType,
    direction,
  };
}

function parsePositiveInt(
  text: string | undefined,
  fallback: number,
  name: string,
  errors: FieldError[],
): number {
  if (text === undefined || text === '') return fallback;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) {
    errors.push({ path: name, code: 'invalid_value', message: `${name} 必须是正整数` });
    return fallback;
  }
  return value;
}
