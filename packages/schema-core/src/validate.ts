import { applyDefaults } from './defaults';
import { evaluateLinkage, type FieldState, type LinkageMessage } from './linkage';
import { isEmptyValue, isPlainObject } from './path';
import type {
  Field,
  FieldError,
  FormData,
  FormSchema,
  InputField,
  SelectField,
  UploadField,
  ValidationRule,
} from './types';

// 场景二 Q0：通用提交校验。前端和后端调用同一个函数，保证两边规则一致。

export type ValidationResult = {
  /** 规范化后的数据：补了默认值、执行了 setValue、去掉了被隐藏字段的值。 */
  data: FormData;
  errors: FieldError[];
  fieldStates: Record<string, FieldState>;
  messages: LinkageMessage[];
};

export type ValidateOptions = {
  /** 遇到 Schema 里没有的字段时是否报错。服务端为 true，防止塞入任意数据。 */
  rejectUnknown?: boolean;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function validateSubmission(
  schema: FormSchema,
  input: unknown,
  options: ValidateOptions = {},
): ValidationResult {
  if (!isPlainObject(input)) {
    return {
      data: {},
      errors: [{ path: '', code: 'invalid_payload', message: '提交内容必须是 JSON 对象' }],
      fieldStates: {},
      messages: [],
    };
  }
  const withDefaults = applyDefaults(schema.fields, input);
  const linkage = evaluateLinkage(schema, withDefaults);
  const context: Context = {
    states: linkage.fieldStates,
    errors: [...linkage.errors],
    rejectUnknown: options.rejectUnknown ?? false,
  };
  const data = validateFields(schema.fields, linkage.data, '', '', context);
  return {
    data,
    errors: context.errors,
    fieldStates: linkage.fieldStates,
    messages: linkage.messages,
  };
}

type Context = {
  states: Record<string, FieldState>;
  errors: FieldError[];
  rejectUnknown: boolean;
};

function validateFields(
  fields: Field[],
  data: FormData,
  pathPrefix: string,
  labelPrefix: string,
  context: Context,
): FormData {
  if (context.rejectUnknown) {
    const known = new Set(fields.map((f) => f.key));
    for (const key of Object.keys(data)) {
      if (known.has(key)) continue;
      context.errors.push({
        path: joinDataPath(pathPrefix, key),
        code: 'unknown_field',
        message: `表单中不存在字段 ${key}`,
      });
    }
  }

  const output: FormData = {};
  for (const field of fields) {
    const checked = validateField(field, data[field.key], pathPrefix, labelPrefix, context);
    if (checked !== undefined) output[field.key] = checked;
  }
  return output;
}

/** 返回要保存的值；undefined 表示这个字段不写入结果。 */
function validateField(
  field: Field,
  value: unknown,
  pathPrefix: string,
  labelPrefix: string,
  context: Context,
): unknown {
  const path = joinDataPath(pathPrefix, field.key);
  const label = `${labelPrefix}${field.label}`;

  if (field.deprecated) {
    if (value !== undefined && context.rejectUnknown) {
      context.errors.push({
        path,
        code: 'deprecated_field',
        message: `${label}已废弃，不能再提交`,
      });
    }
    return undefined;
  }

  const state = context.states[path] ?? { visible: !field.hidden, required: !!field.required };
  // 场景二 Q2：被隐藏的字段不校验，也不保存（例如应届生的“前公司名称”）。
  if (!state.visible) return undefined;

  if (!isEmptyValue(value)) return validateValue(field, value, path, label, context);

  if (state.required) context.errors.push({ path, code: 'required', message: `${label}为必填` });
  return field.type === 'repeater' && Array.isArray(value) ? [] : undefined;
}

function validateValue(
  field: Field,
  value: unknown,
  path: string,
  label: string,
  context: Context,
): unknown {
  const push = (code: string, message: string): undefined => {
    context.errors.push({ path, code, message });
    return undefined;
  };

  switch (field.type) {
    case 'input':
      return validateInput(field, value, label, push);
    case 'select':
      return validateSelect(field, value, label, push);
    case 'upload':
      return validateUpload(field, value, label, push);
    case 'object':
      if (!isPlainObject(value)) return push('type', `${label}格式不正确`);
      return validateFields(field.fields, value, path, `${label}的`, context);
    case 'repeater': {
      if (!Array.isArray(value)) return push('type', `${label}必须是列表`);
      if (field.minItems !== undefined && value.length < field.minItems) {
        push('min_items', `${label}至少需要 ${field.minItems} 项`);
      }
      if (field.maxItems !== undefined && value.length > field.maxItems) {
        push('max_items', `${label}最多 ${field.maxItems} 项`);
      }
      return value.map((row: unknown, index) => {
        const rowPath = `${path}[${index}]`;
        const rowLabel = `${label}第 ${index + 1} 项的`;
        if (!isPlainObject(row)) {
          context.errors.push({ path: rowPath, code: 'type', message: `${rowLabel}格式不正确` });
          return {};
        }
        return validateFields(field.fields, row, rowPath, rowLabel, context);
      });
    }
    default: {
      const unreachable: never = field;
      throw new Error(`未知字段类型：${JSON.stringify(unreachable)}`);
    }
  }
}

type Push = (code: string, message: string) => undefined;

function validateInput(field: InputField, value: unknown, label: string, push: Push): unknown {
  const kind = field.inputKind ?? 'text';
  if (kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value))
      return push('type', `${label}必须是数字`);
  } else if (typeof value !== 'string') {
    return push('type', `${label}必须是文本`);
  }

  if (kind === 'email' && typeof value === 'string' && !EMAIL_PATTERN.test(value)) {
    return push('format', `${label}格式不正确，请填写有效的邮箱`);
  }
  if (kind === 'url' && typeof value === 'string' && !isHttpUrl(value)) {
    return push('format', `${label}格式不正确，请填写以 http(s):// 开头的链接`);
  }
  if (kind === 'date' && typeof value === 'string' && !isValidDate(value)) {
    return push('format', `${label}格式不正确，请使用 YYYY-MM-DD`);
  }

  for (const rule of field.rules ?? []) {
    const message = checkRule(rule, value, label);
    if (message) return push(ruleCode(rule), message);
  }
  return value;
}

function checkRule(rule: ValidationRule, value: unknown, label: string): string | undefined {
  return ruleFails(rule, value) ? (rule.message ?? defaultRuleMessage(rule, label)) : undefined;
}

function ruleFails(rule: ValidationRule, value: unknown): boolean {
  const text = typeof value === 'string' ? value : undefined;
  const num = typeof value === 'number' ? value : undefined;
  switch (rule.type) {
    case 'regex':
      return text !== undefined && !new RegExp(rule.pattern).test(text);
    case 'email':
      return text !== undefined && !EMAIL_PATTERN.test(text);
    case 'min':
      return num !== undefined && num < rule.value;
    case 'max':
      return num !== undefined && num > rule.value;
    case 'minLength':
      return text !== undefined && text.length < rule.value;
    case 'maxLength':
      return text !== undefined && text.length > rule.value;
    default: {
      const unreachable: never = rule;
      throw new Error(`未知校验规则：${JSON.stringify(unreachable)}`);
    }
  }
}

function defaultRuleMessage(rule: ValidationRule, label: string): string {
  switch (rule.type) {
    case 'regex':
      return `${label}格式不正确`;
    case 'email':
      return `${label}格式不正确，请填写有效的邮箱`;
    case 'min':
      return `${label}不能小于 ${rule.value}`;
    case 'max':
      return `${label}不能大于 ${rule.value}`;
    case 'minLength':
      return `${label}至少 ${rule.value} 个字符`;
    case 'maxLength':
      return `${label}最多 ${rule.value} 个字符`;
    default: {
      const unreachable: never = rule;
      throw new Error(`未知校验规则：${JSON.stringify(unreachable)}`);
    }
  }
}

function ruleCode(rule: ValidationRule): string {
  switch (rule.type) {
    case 'regex':
    case 'email':
      return 'format';
    case 'min':
    case 'minLength':
      return 'too_small';
    case 'max':
    case 'maxLength':
      return 'too_big';
    default: {
      const unreachable: never = rule;
      throw new Error(`未知校验规则：${JSON.stringify(unreachable)}`);
    }
  }
}

function validateSelect(field: SelectField, value: unknown, label: string, push: Push): unknown {
  const values = field.multiple ? value : [value];
  if (!Array.isArray(values)) return push('type', `${label}必须是列表`);
  for (const item of values) {
    if (!field.options.some((option) => option.value === item)) {
      return push('invalid_option', `${label}的选项无效`);
    }
  }
  return value;
}

function validateUpload(field: UploadField, value: unknown, label: string, push: Push): unknown {
  if (!Array.isArray(value)) return push('type', `${label}格式不正确`);
  const maxFiles = field.maxFiles ?? 1;
  if (value.length > maxFiles) return push('max_items', `${label}最多上传 ${maxFiles} 个文件`);
  for (const item of value) {
    // 场景二 Q3：只接受文件引用，不接受内嵌的文件内容。
    if (!isPlainObject(item) || typeof item.fileId !== 'string') {
      return push('type', `${label}只能包含已上传文件的引用`);
    }
  }
  return value;
}

// schema-core 不依赖浏览器或 Node 的全局 API（如 URL），所以用正则判断。
const HTTP_URL_PATTERN = /^https?:\/\/[^\s/?#]+\.[^\s/?#]+(?:[/?#]\S*)?$/i;

function isHttpUrl(value: string): boolean {
  return HTTP_URL_PATTERN.test(value);
}

function isValidDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function joinDataPath(prefix: string, key: string): string {
  return prefix === '' ? key : `${prefix}.${key}`;
}
