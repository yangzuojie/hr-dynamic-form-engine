import { isPlainObject } from './path';
import type { Field, FormData, RepeaterField } from './types';

// 默认值规则（设计决策第 2 条）：只补 undefined 的字段，用户主动清空（'' 或 null）的不补。

export function applyDefaults(fields: Field[], data: FormData): FormData {
  const result: FormData = { ...data };
  for (const field of fields) {
    if (field.deprecated) continue;
    const current = result[field.key];
    switch (field.type) {
      case 'input':
      case 'select':
        if (current === undefined && field.default !== undefined) {
          result[field.key] = Array.isArray(field.default) ? [...field.default] : field.default;
        }
        break;
      case 'upload':
        break;
      case 'object':
        result[field.key] = applyDefaults(field.fields, isPlainObject(current) ? current : {});
        break;
      case 'repeater': {
        const rows = Array.isArray(current) ? current : (field.default ?? []);
        result[field.key] = rows.map((row: unknown) =>
          applyDefaults(field.fields, isPlainObject(row) ? row : {}),
        );
        break;
      }
      default: {
        const unreachable: never = field;
        throw new Error(`未知字段类型：${JSON.stringify(unreachable)}`);
      }
    }
  }
  return result;
}

/** repeater 新增一行时用子字段默认值初始化。 */
export function createRepeaterRow(field: RepeaterField): FormData {
  return applyDefaults(field.fields, {});
}
