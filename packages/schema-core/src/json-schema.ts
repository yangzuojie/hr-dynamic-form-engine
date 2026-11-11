import type { Field, FormSchema, InputField, InputKind, ValidationRule } from './types';

// 把表单 Schema 导出成标准 JSON Schema（draft 2020-12），方便和外部系统对接。
// 联动规则无法用静态 JSON Schema 表达，放在扩展字段 x-linkage 中原样带出。

type JsonSchema = Record<string, unknown>;

export function toJsonSchema(schema: FormSchema): JsonSchema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `urn:form:${schema.formId}:v${schema.version}`,
    title: schema.title,
    ...objectSchema(schema.fields),
    ...(schema.linkage?.length ? { 'x-linkage': schema.linkage } : {}),
  };
}

function objectSchema(fields: Field[]): JsonSchema {
  const active = fields.filter((f) => !f.deprecated);
  return {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(active.map((f) => [f.key, fieldSchema(f)])),
    required: active.filter((f) => f.required && !f.hidden).map((f) => f.key),
  };
}

const KIND_FORMAT: Partial<Record<InputKind, string>> = {
  email: 'email',
  url: 'uri',
  date: 'date',
};

const RULE_KEYWORD: Record<Exclude<ValidationRule['type'], 'regex' | 'email'>, string> = {
  min: 'minimum',
  max: 'maximum',
  minLength: 'minLength',
  maxLength: 'maxLength',
};

function inputSchema(field: InputField, base: JsonSchema): JsonSchema {
  const kind = field.inputKind ?? 'text';
  const schema: JsonSchema = { ...base, type: kind === 'number' ? 'number' : 'string' };
  const format = KIND_FORMAT[kind];
  if (format) schema.format = format;
  for (const rule of field.rules ?? []) {
    if (rule.type === 'regex') schema.pattern = rule.pattern;
    else if (rule.type === 'email') schema.format = 'email';
    else schema[RULE_KEYWORD[rule.type]] = rule.value;
  }
  if (field.default !== undefined) schema.default = field.default;
  return schema;
}

function fieldSchema(field: Field): JsonSchema {
  const base: JsonSchema = { title: field.label };
  if (field.description) base.description = field.description;
  switch (field.type) {
    case 'input':
      return inputSchema(field, base);
    case 'select': {
      const values = field.options.map((o) => o.value);
      const schema: JsonSchema = field.multiple
        ? { ...base, type: 'array', items: { enum: values }, uniqueItems: true }
        : { ...base, enum: values };
      if (field.default !== undefined) schema.default = field.default;
      return schema;
    }
    case 'upload':
      return {
        ...base,
        type: 'array',
        maxItems: field.maxFiles ?? 1,
        items: {
          type: 'object',
          required: ['fileId'],
          properties: {
            fileId: { type: 'string' },
            name: { type: 'string' },
            size: { type: 'integer' },
            mimeType: { enum: field.accept },
          },
        },
      };
    case 'object':
      return { ...base, ...objectSchema(field.fields) };
    case 'repeater': {
      const schema: JsonSchema = { ...base, type: 'array', items: objectSchema(field.fields) };
      if (field.minItems !== undefined) schema.minItems = field.minItems;
      if (field.maxItems !== undefined) schema.maxItems = field.maxItems;
      return schema;
    }
    default: {
      const unreachable: never = field;
      throw new Error(`未知字段类型：${JSON.stringify(unreachable)}`);
    }
  }
}
