import { type Field, type FormData, isPlainObject, type UploadField } from '@hr/schema-core';

/** 按点路径（只含 key，不含下标）找上传字段，可穿过 object 和 repeater，如 "workHistory.certificate"。 */
export function findUploadField(fields: Field[], path: string): UploadField | undefined {
  const [head, ...rest] = path.split('.');
  const field = fields.find((f) => f.key === head && !f.deprecated);
  if (!field) return undefined;
  if (rest.length === 0) return field.type === 'upload' ? field : undefined;
  if (field.type === 'object' || field.type === 'repeater') {
    return findUploadField(field.fields, rest.join('.'));
  }
  return undefined;
}

export type FileUse = { fileId: string; fieldPath: string };

/** 收集提交数据里引用的所有文件 ID 和对应的字段路径，用于把文件绑定到提交（场景二 Q3）。 */
export function collectFileRefs(fields: Field[], data: FormData, prefix = ''): FileUse[] {
  return fields.flatMap((field) => {
    const value = data[field.key];
    const path = prefix ? `${prefix}.${field.key}` : field.key;
    switch (field.type) {
      case 'upload':
        return Array.isArray(value)
          ? value.flatMap((ref) =>
              isPlainObject(ref) && typeof ref.fileId === 'string'
                ? [{ fileId: ref.fileId, fieldPath: path }]
                : [],
            )
          : [];
      case 'object':
        return isPlainObject(value) ? collectFileRefs(field.fields, value, path) : [];
      case 'repeater':
        return Array.isArray(value)
          ? value.flatMap((row) =>
              isPlainObject(row) ? collectFileRefs(field.fields, row, path) : [],
            )
          : [];
      default:
        return [];
    }
  });
}
