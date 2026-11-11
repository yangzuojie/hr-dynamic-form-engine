import { isPlainObject } from './path';
import type { FieldError, FormSchema } from './types';

// 结构检查：把来自网络的任意 JSON 判定为合法的 FormSchema 结构（类型守卫）。
// 只检查“形状”（字段是否存在、类型是否正确），业务规则由 checkSchemaDefinition 负责。
// 先过这一关，后续代码才可以放心地按 FormSchema 类型访问，不会因为畸形输入抛 TypeError。

const FIELD_TYPES = new Set(['input', 'select', 'upload', 'object', 'repeater']);
const INPUT_KINDS = new Set(['text', 'textarea', 'number', 'email', 'url', 'date']);
const RULE_TYPES = new Set(['regex', 'email', 'min', 'max', 'minLength', 'maxLength']);
const COMPARE_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in'] as const;
const STATE_EFFECTS = ['show', 'hide', 'require', 'unrequire'] as const;

type Errors = FieldError[];

export function checkSchemaShape(input: unknown): Errors {
  const errors: Errors = [];
  if (!isPlainObject(input)) return [shapeError('', '表单 Schema 必须是 JSON 对象')];
  expectString(input, 'formId', '', errors);
  expectString(input, 'title', '', errors);
  if (typeof input.version !== 'number') errors.push(shapeError('version', '必须是数字'));
  checkFieldList(input.fields, 'fields', errors);
  checkLinkageList(input.linkage, 'linkage', errors, true);
  if (input.hooks !== undefined && !isStringArray(input.hooks)) {
    errors.push(shapeError('hooks', '必须是字符串数组'));
  }
  return errors;
}

export function isFormSchema(input: unknown): input is FormSchema {
  return checkSchemaShape(input).length === 0;
}

function checkFieldList(value: unknown, at: string, errors: Errors): void {
  if (!Array.isArray(value)) {
    errors.push(shapeError(at, '必须是数组'));
    return;
  }
  for (const [index, field] of value.entries()) checkField(field, `${at}[${index}]`, errors);
}

function checkField(field: unknown, at: string, errors: Errors): void {
  if (!isPlainObject(field)) {
    errors.push(shapeError(at, '字段定义必须是对象'));
    return;
  }
  for (const key of ['fieldId', 'key', 'label']) expectString(field, key, at, errors);
  for (const key of ['required', 'hidden', 'deprecated', 'sensitive', 'multiple']) {
    if (field[key] !== undefined && typeof field[key] !== 'boolean') {
      errors.push(shapeError(`${at}.${key}`, '必须是布尔值'));
    }
  }
  if (typeof field.type !== 'string' || !FIELD_TYPES.has(field.type)) {
    errors.push(
      shapeError(`${at}.type`, '组件类型必须是 input / select / upload / object / repeater'),
    );
    return;
  }
  if (field.rules !== undefined) checkRules(field.rules, `${at}.rules`, errors);
  checkTypeShape(field, at, errors);
}

function checkTypeShape(field: Record<string, unknown>, at: string, errors: Errors): void {
  switch (field.type) {
    case 'input':
      if (field.inputKind !== undefined && !INPUT_KINDS.has(String(field.inputKind))) {
        errors.push(shapeError(`${at}.inputKind`, '输入类型无效'));
      }
      if (field.default !== undefined && !['string', 'number'].includes(typeof field.default)) {
        errors.push(shapeError(`${at}.default`, '默认值必须是文本或数字'));
      }
      return;
    case 'select':
      checkOptions(field.options, `${at}.options`, errors);
      return;
    case 'upload':
      if (!isStringArray(field.accept)) errors.push(shapeError(`${at}.accept`, '必须是字符串数组'));
      if (typeof field.maxSizeMb !== 'number')
        errors.push(shapeError(`${at}.maxSizeMb`, '必须是数字'));
      return;
    case 'object':
      checkFieldList(field.fields, `${at}.fields`, errors);
      return;
    case 'repeater':
      checkFieldList(field.fields, `${at}.fields`, errors);
      checkLinkageList(field.linkage, `${at}.linkage`, errors, true);
      if (field.default !== undefined && !Array.isArray(field.default)) {
        errors.push(shapeError(`${at}.default`, '必须是数组'));
      }
      return;
    default:
      return;
  }
}

function checkOptions(value: unknown, at: string, errors: Errors): void {
  if (!Array.isArray(value)) {
    errors.push(shapeError(at, '必须是数组'));
    return;
  }
  value.forEach((option, index) => {
    const ok =
      isPlainObject(option) &&
      typeof option.label === 'string' &&
      ['string', 'number', 'boolean'].includes(typeof option.value);
    if (!ok) errors.push(shapeError(`${at}[${index}]`, '选项须为 { label, value }'));
  });
}

function checkRules(value: unknown, at: string, errors: Errors): void {
  if (!Array.isArray(value)) {
    errors.push(shapeError(at, '必须是数组'));
    return;
  }
  value.forEach((rule, index) => {
    const path = `${at}[${index}]`;
    if (!isPlainObject(rule) || !RULE_TYPES.has(String(rule.type))) {
      errors.push(shapeError(path, '校验规则类型无效'));
      return;
    }
    if (rule.type === 'regex' && typeof rule.pattern !== 'string') {
      errors.push(shapeError(`${path}.pattern`, '必须是字符串'));
    }
    if (rule.type !== 'regex' && rule.type !== 'email' && typeof rule.value !== 'number') {
      errors.push(shapeError(`${path}.value`, '必须是数字'));
    }
  });
}

function checkLinkageList(value: unknown, at: string, errors: Errors, optional: boolean): void {
  if (value === undefined && optional) return;
  if (!Array.isArray(value)) {
    errors.push(shapeError(at, '必须是数组'));
    return;
  }
  value.forEach((rule, index) => {
    const path = `${at}[${index}]`;
    if (!isPlainObject(rule)) {
      errors.push(shapeError(path, '联动规则必须是对象'));
      return;
    }
    expectString(rule, 'id', path, errors);
    checkCondition(rule.when, `${path}.when`, errors);
    if (!Array.isArray(rule.actions)) {
      errors.push(shapeError(`${path}.actions`, '必须是数组'));
      return;
    }
    for (const [i, effect] of rule.actions.entries()) {
      checkEffect(effect, `${path}.actions[${i}]`, errors);
    }
  });
}

function checkCondition(value: unknown, at: string, errors: Errors): void {
  if (!isPlainObject(value) || Object.keys(value).length !== 1) {
    errors.push(shapeError(at, '条件必须是只有一个操作符的对象'));
    return;
  }
  const list = 'and' in value ? value.and : value.or;
  if ('and' in value || 'or' in value) {
    if (!Array.isArray(list)) {
      errors.push(shapeError(at, 'and / or 需要条件数组'));
      return;
    }
    for (const [i, c] of list.entries()) checkCondition(c, `${at}[${i}]`, errors);
    return;
  }
  if ('not' in value) {
    checkCondition(value.not, `${at}.not`, errors);
    return;
  }
  if ('empty' in value) {
    if (typeof value.empty !== 'string') errors.push(shapeError(at, 'empty 需要字段路径'));
    return;
  }
  const problem = compareProblem(value);
  if (problem) errors.push(shapeError(at, problem));
}

/** 比较类条件 { op: [字段路径, 值] } 的格式问题；没问题返回 undefined。 */
function compareProblem(value: Record<string, unknown>): string | undefined {
  const op = COMPARE_OPS.find((o) => o in value);
  const operands = op ? value[op] : undefined;
  if (!op || !Array.isArray(operands) || operands.length !== 2 || typeof operands[0] !== 'string') {
    return '条件格式应为 { 操作符: [字段路径, 值] }';
  }
  const expectsNumber = op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte';
  if (expectsNumber && typeof operands[1] !== 'number') return `${op} 的比较值必须是数字`;
  if (op === 'in' && !Array.isArray(operands[1])) return 'in 的比较值必须是数组';
  return undefined;
}

function checkEffect(value: unknown, at: string, errors: Errors): void {
  if (!isPlainObject(value)) {
    errors.push(shapeError(at, '效果必须是对象'));
    return;
  }
  if (STATE_EFFECTS.some((key) => typeof value[key] === 'string')) return;
  const setValue = value.setValue;
  if (isPlainObject(setValue) && typeof setValue.field === 'string' && 'value' in setValue) return;
  const message = value.message;
  if (isPlainObject(message) && typeof message.text === 'string') return;
  errors.push(shapeError(at, '效果只能是 show / hide / require / unrequire / setValue / message'));
}

function expectString(obj: Record<string, unknown>, key: string, at: string, errors: Errors): void {
  if (typeof obj[key] !== 'string') {
    errors.push(shapeError(at ? `${at}.${key}` : key, '必须是字符串'));
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function shapeError(path: string, message: string): FieldError {
  return { path, code: 'invalid_schema', message: path ? `${path}：${message}` : message };
}
