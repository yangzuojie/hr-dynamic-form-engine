import { conditionReads, detectLinkageCycles, effectTarget } from './linkage';
import { findField, joinPath } from './path';
import type { Field, FieldError, FormSchema, LinkageRule, SelectField, UploadField } from './types';

// 发布前检查：保存草稿时只做提示，发布时有错误就拒绝（场景一 Q1 防循环、场景一 Q2 版本规则）。

const FORM_ID_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_UPLOAD_MB = 20;

export function checkSchemaDefinition(schema: FormSchema): FieldError[] {
  const errors: FieldError[] = [];
  if (!FORM_ID_PATTERN.test(schema.formId)) {
    errors.push({
      path: 'formId',
      code: 'format',
      message: 'formId 只能使用小写字母、数字和下划线，以字母开头',
    });
  }
  if (schema.title.trim() === '') {
    errors.push({ path: 'title', code: 'required', message: '表单标题为必填' });
  }
  const fieldIds = new Set<string>();
  checkFields(schema.fields, 'fields', fieldIds, errors);
  checkLinkage(schema.fields, schema.linkage ?? [], 'linkage', errors);

  for (const cycle of detectLinkageCycles(schema)) {
    const where = cycle.scope === '' ? '' : `（作用域 ${cycle.scope}）`;
    errors.push({
      path: 'linkage',
      code: 'linkage_cycle',
      message: `联动规则存在循环依赖${where}：${cycle.path.join(' → ')}`,
    });
  }
  return errors;
}

function checkFields(
  fields: Field[],
  at: string,
  fieldIds: Set<string>,
  errors: FieldError[],
): void {
  const keys = new Set<string>();
  fields.forEach((field, index) => {
    const path = `${at}[${index}]`;
    const push: Push = (code, message) => {
      errors.push({ path, code, message: `${field.label || field.key}：${message}` });
    };
    checkIdentity(field, keys, fieldIds, push);
    checkRegexRules(field, push);
    checkTypeSpecific(field, push);
    if (field.type === 'object' || field.type === 'repeater') {
      checkFields(field.fields, `${path}.fields`, fieldIds, errors);
    }
    if (field.type === 'repeater') {
      checkLinkage(field.fields, field.linkage ?? [], `${path}.linkage`, errors);
    }
  });
}

type Push = (code: string, message: string) => void;

function checkIdentity(field: Field, keys: Set<string>, fieldIds: Set<string>, push: Push): void {
  if (!field.fieldId) push('required', '缺少 fieldId');
  else if (fieldIds.has(field.fieldId)) push('duplicate', `fieldId ${field.fieldId} 重复`);
  fieldIds.add(field.fieldId);

  if (!KEY_PATTERN.test(field.key)) push('format', 'key 只能使用字母、数字和下划线');
  if (keys.has(field.key)) push('duplicate', `key ${field.key} 在同一层级重复`);
  keys.add(field.key);
  if (field.label.trim() === '') push('required', '标签为必填');
}

function checkRegexRules(field: Field, push: Push): void {
  for (const rule of field.rules ?? []) {
    if (rule.type !== 'regex') continue;
    try {
      new RegExp(rule.pattern);
    } catch {
      // 构造失败说明正则写错了，转成配置错误提示给 HR。
      push('invalid_regex', `正则表达式无效：${rule.pattern}`);
    }
  }
}

function checkTypeSpecific(field: Field, push: Push): void {
  switch (field.type) {
    case 'input': {
      const wantsNumber = field.inputKind === 'number';
      if (field.default !== undefined && wantsNumber !== (typeof field.default === 'number')) {
        push('invalid_default', '默认值类型与输入类型不一致');
      }
      return;
    }
    case 'select':
      checkSelect(field, push);
      return;
    case 'upload':
      checkUpload(field, push);
      return;
    case 'repeater':
      if ((field.minItems ?? 0) > (field.maxItems ?? Number.POSITIVE_INFINITY)) {
        push('invalid_value', '最少行数不能大于最多行数');
      }
      return;
    case 'object':
      return;
    default: {
      const unreachable: never = field;
      throw new Error(`未知字段类型：${JSON.stringify(unreachable)}`);
    }
  }
}

function checkSelect(field: SelectField, push: Push): void {
  if (field.options.length === 0) push('required', '下拉选项不能为空');
  const values = field.options.map((o) => o.value);
  if (new Set(values).size !== values.length) push('duplicate', '下拉选项的值重复');
  const defaults = field.default === undefined ? [] : [field.default].flat();
  if (defaults.some((d) => !values.includes(d))) push('invalid_default', '默认值不在选项中');
}

function checkUpload(field: UploadField, push: Push): void {
  if (field.accept.length === 0) push('required', '需要指定允许的文件类型');
  if (field.maxSizeMb <= 0 || field.maxSizeMb > MAX_UPLOAD_MB) {
    push('invalid_value', `单个文件大小上限需在 0～${MAX_UPLOAD_MB}MB 之间`);
  }
}

function checkLinkage(
  fields: Field[],
  rules: LinkageRule[],
  at: string,
  errors: FieldError[],
): void {
  const ids = new Set<string>();
  rules.forEach((rule, index) => {
    const path = `${at}[${index}]`;
    if (ids.has(rule.id)) {
      errors.push({ path, code: 'duplicate', message: `规则 ID ${rule.id} 重复` });
    }
    ids.add(rule.id);
    for (const message of ruleReferenceProblems(fields, rule)) {
      errors.push({ path, code: 'invalid_reference', message });
    }
  });
}

function ruleReferenceProblems(fields: Field[], rule: LinkageRule): string[] {
  const problems: string[] = [];
  const isActive = (path: string): Field | undefined => {
    const field = findField(fields, path);
    return field && !field.deprecated ? field : undefined;
  };
  for (const read of conditionReads(rule.when)) {
    if (!isActive(read)) problems.push(`规则 ${rule.id} 的条件引用了不存在的字段 ${read}`);
  }
  for (const effect of rule.actions) {
    const target = effectTarget(effect);
    if (target === undefined) continue;
    const field = isActive(target);
    if (!field) {
      problems.push(`规则 ${rule.id} 作用于不存在的字段 ${target}`);
    } else if ('setValue' in effect && field.type !== 'input' && field.type !== 'select') {
      problems.push(`规则 ${rule.id} 只能给输入框或下拉框赋值`);
    }
  }
  return problems;
}

/**
 * 场景一 Q2：新版本相对上一个已发布版本的约束。
 * - 字段不能直接删除，只能标记废弃，否则历史数据无法解释；
 * - 同一个 fieldId 不能改类型，否则历史值的含义会变。
 */
export function checkVersionCompatibility(previous: FormSchema, next: FormSchema): FieldError[] {
  const errors: FieldError[] = [];
  compareFields(previous.fields, next.fields, '', errors);
  return errors;
}

function compareFields(
  previous: Field[],
  next: Field[],
  prefix: string,
  errors: FieldError[],
): void {
  const nextById = new Map(next.map((f) => [f.fieldId, f]));
  for (const old of previous) {
    const path = joinPath(prefix, old.key);
    const current = nextById.get(old.fieldId);
    if (!current) {
      errors.push({
        path,
        code: 'field_removed',
        message: `字段 ${old.label}（${path}）不能直接删除，请改为“废弃”，以保留历史数据`,
      });
      continue;
    }
    if (current.type !== old.type) {
      errors.push({
        path,
        code: 'type_changed',
        message: `字段 ${old.label} 不能从 ${old.type} 改为 ${current.type}；如需新类型，请新增字段并废弃旧字段`,
      });
      continue;
    }
    if (
      (old.type === 'object' || old.type === 'repeater') &&
      (current.type === 'object' || current.type === 'repeater')
    ) {
      compareFields(old.fields, current.fields, joinPath(prefix, current.key), errors);
    }
  }
}
