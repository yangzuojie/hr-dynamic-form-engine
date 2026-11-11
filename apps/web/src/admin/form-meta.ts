import type { Field, FormSchema } from '@hr/schema-core';
import { api } from '../api';

/** 读取表单当前发布版本的 Schema（后台使用，已停用的表单也能读）。 */
export async function loadPublishedSchema(formId: string): Promise<FormSchema> {
  const { data } = await api.get<{ currentPublishedVersion: number | null }>(
    `/api/v1/forms/${formId}`,
  );
  if (!data.currentPublishedVersion) throw new Error('该表单尚未发布');
  const version = await api.get<{ schema: FormSchema }>(
    `/api/v1/forms/${formId}/versions/${data.currentPublishedVersion}`,
  );
  return version.data.schema;
}

export type ScalarField = { path: string; label: string; field: Field; numeric: boolean };

/** 可以筛选/展示的标量字段（input、select，可穿过 object），包括已废弃字段（历史数据仍可查）。 */
export function scalarFields(fields: Field[], prefix = '', labelPrefix = ''): ScalarField[] {
  return fields.flatMap((field) => {
    const path = prefix ? `${prefix}.${field.key}` : field.key;
    const label = `${labelPrefix}${field.label}${field.deprecated ? '（已废弃）' : ''}`;
    if (field.type === 'object') return scalarFields(field.fields, path, `${label} / `);
    if (field.type === 'input')
      return [{ path, label, field, numeric: field.inputKind === 'number' }];
    if (field.type === 'select') {
      return [{ path, label, field, numeric: typeof field.options[0]?.value === 'number' }];
    }
    return [];
  });
}
