import type { Field, FieldType } from '@hr/schema-core';

// Form Builder 对字段树的不可变操作。字段位置用“下标路径”表示：[2] 是第 3 个顶层字段，[2, 0] 是它的第 1 个子字段。

export type IndexPath = number[];

type WithChildren = Extract<Field, { fields: Field[] }>;

function hasChildren(field: Field): field is WithChildren {
  return field.type === 'object' || field.type === 'repeater';
}

export function getFieldAt(fields: Field[], path: IndexPath): Field | undefined {
  const [head, ...rest] = path;
  if (head === undefined) return undefined;
  const field = fields[head];
  if (!field || rest.length === 0) return field;
  return hasChildren(field) ? getFieldAt(field.fields, rest) : undefined;
}

/** 对 path 所在的“兄弟列表”做修改（新增、删除、移动都在父级列表上进行）。 */
function updateList(
  fields: Field[],
  parent: IndexPath,
  update: (list: Field[]) => Field[],
): Field[] {
  const [head, ...rest] = parent;
  if (head === undefined) return update(fields);
  return fields.map((field, index) =>
    index === head && hasChildren(field)
      ? { ...field, fields: updateList(field.fields, rest, update) }
      : field,
  );
}

export function updateFieldAt(
  fields: Field[],
  path: IndexPath,
  update: (field: Field) => Field,
): Field[] {
  const index = path.at(-1);
  if (index === undefined) return fields;
  return updateList(fields, path.slice(0, -1), (list) =>
    list.map((f, i) => (i === index ? update(f) : f)),
  );
}

export function removeFieldAt(fields: Field[], path: IndexPath): Field[] {
  const index = path.at(-1);
  return updateList(fields, path.slice(0, -1), (list) => list.filter((_, i) => i !== index));
}

export function moveFieldAt(fields: Field[], path: IndexPath, delta: -1 | 1): Field[] {
  const index = path.at(-1);
  if (index === undefined) return fields;
  return updateList(fields, path.slice(0, -1), (list) => {
    const target = index + delta;
    if (target < 0 || target >= list.length) return list;
    const next = [...list];
    const [moved] = next.splice(index, 1);
    if (moved) next.splice(target, 0, moved);
    return next;
  });
}

/** 在 parent 的子列表末尾追加；parent 为空数组表示顶层。返回新字段的下标路径。 */
export function appendField(
  fields: Field[],
  parent: IndexPath,
  field: Field,
): [Field[], IndexPath] {
  let newIndex = 0;
  const next = updateList(fields, parent, (list) => {
    newIndex = list.length;
    return [...list, field];
  });
  return [next, [...parent, newIndex]];
}

export function createField(type: FieldType, existingKeys: string[]): Field {
  const fieldId = `f_${Math.random().toString(36).slice(2, 10)}`;
  let n = 1;
  while (existingKeys.includes(`${type}${n}`)) n++;
  const base = { fieldId, key: `${type}${n}`, label: `新${TYPE_LABELS[type]}` };
  switch (type) {
    case 'input':
      return { ...base, type };
    case 'select':
      return { ...base, type, options: [{ label: '选项一', value: '选项一' }] };
    case 'upload':
      return { ...base, type, accept: ['application/pdf'], maxSizeMb: 10 };
    case 'object':
      return { ...base, type, fields: [] };
    case 'repeater':
      return { ...base, type, fields: [] };
    default: {
      const unreachable: never = type;
      throw new Error(`未知字段类型：${String(unreachable)}`);
    }
  }
}

export const TYPE_LABELS: Record<FieldType, string> = {
  input: '输入框',
  select: '下拉选择',
  upload: '文件上传',
  object: '分组（嵌套对象）',
  repeater: '可重复列表',
};

/** 收集所有 fieldId（用于判断字段是否在已发布版本里出现过）。 */
export function collectFieldIds(fields: Field[]): Set<string> {
  const ids = new Set<string>();
  const walk = (list: Field[]): void => {
    for (const field of list) {
      ids.add(field.fieldId);
      if (hasChildren(field)) walk(field.fields);
    }
  };
  walk(fields);
  return ids;
}

export { hasChildren };
