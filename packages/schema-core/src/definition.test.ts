import { describe, expect, it } from 'vitest';
import { applyDefaults, createRepeaterRow } from './defaults';
import { checkSchemaDefinition } from './definition';
import { techOnboardingV3, techOnboardingV4 } from './examples/tech-onboarding';
import { toJsonSchema } from './json-schema';
import type { FormSchema, RepeaterField } from './types';

describe('checkSchemaDefinition', () => {
  it('示例表单 v3、v4 都能通过发布检查', () => {
    expect(checkSchemaDefinition(techOnboardingV3)).toEqual([]);
    expect(checkSchemaDefinition(techOnboardingV4)).toEqual([]);
  });

  it('发现重复 key/fieldId、无效正则、默认值不在选项中、规则引用不存在的字段、循环', () => {
    const bad: FormSchema = {
      formId: 'Bad-Id',
      title: ' ',
      version: 1,
      fields: [
        {
          fieldId: 'x',
          key: 'a',
          label: 'A',
          type: 'input',
          rules: [{ type: 'regex', pattern: '(' }],
        },
        { fieldId: 'x', key: 'a', label: 'A2', type: 'input' },
        {
          fieldId: 's',
          key: 's',
          label: 'S',
          type: 'select',
          options: [{ label: '1', value: 1 }],
          default: 2,
        },
      ],
      linkage: [
        {
          id: 'r1',
          when: { eq: ['ghost', 1] },
          actions: [{ setValue: { field: 'a', value: 'y' } }],
        },
        { id: 'r2', when: { eq: ['a', 'y'] }, actions: [{ setValue: { field: 'a', value: 'z' } }] },
      ],
    };
    expect(checkSchemaDefinition(bad).map((e) => e.code)).toEqual([
      'format',
      'required',
      'invalid_regex',
      'duplicate',
      'duplicate',
      'invalid_default',
      'invalid_reference',
      'linkage_cycle',
    ]);
  });
});

describe('默认值', () => {
  it('只补 undefined，不覆盖用户清空的值；嵌套 object 与 repeater 行都补齐', () => {
    const data = applyDefaults(techOnboardingV3.fields, {
      isFreshGraduate: null,
      workHistory: [{ company: 'A' }],
    });
    expect(data.isFreshGraduate).toBeNull();
    expect(data.contact).toEqual({ emergency: {} });
    expect(data.workHistory).toEqual([{ company: 'A', isCurrent: false }]);
    expect(applyDefaults(techOnboardingV3.fields, {}).isFreshGraduate).toBe(false);
  });

  it('repeater 新增行用子字段默认值初始化', () => {
    const repeater = techOnboardingV3.fields.find((f): f is RepeaterField => f.type === 'repeater');
    expect(repeater && createRepeaterRow(repeater)).toEqual({ isCurrent: false });
  });
});

describe('toJsonSchema', () => {
  it('导出标准 JSON Schema：废弃字段不导出，规则映射到关键字', () => {
    const json = toJsonSchema(techOnboardingV4) as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
    };
    expect(json.properties).not.toHaveProperty('nickname');
    expect(json.properties.email).toMatchObject({ type: 'string', format: 'email' });
    expect(json.properties.experience).toMatchObject({ type: 'number', minimum: 0, maximum: 50 });
    expect(json.required).toContain('department');
  });
});
