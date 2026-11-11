import { describe, expect, it } from 'vitest';
import { techOnboardingV3, techOnboardingV4 } from './examples/tech-onboarding';
import { checkSchemaShape, isFormSchema } from './shape';

describe('checkSchemaShape', () => {
  it('示例表单结构合法', () => {
    expect(checkSchemaShape(techOnboardingV3)).toEqual([]);
    expect(isFormSchema(techOnboardingV4)).toBe(true);
  });

  it('畸形输入返回带路径的错误，而不是抛异常', () => {
    const inputs: unknown[] = [
      null,
      'x',
      [],
      { formId: 1, title: 't', version: 1, fields: 'no' },
      {
        formId: 'f',
        title: 't',
        version: 1,
        fields: [
          { fieldId: 'a', key: 'a', label: 'A', type: 'slider' },
          { fieldId: 'b', key: 'b', label: 'B', type: 'select', options: [{ value: {} }] },
          { fieldId: 'c', key: 'c', label: 'C', type: 'repeater', fields: [{}] },
        ],
        linkage: [
          { id: 'r', when: { gt: ['a', 'x'] }, actions: [{ explode: true }] },
          { id: 'r2', when: { and: 'nope' }, actions: [] },
          { id: 'r3', when: { eq: ['a', 1], ne: ['a', 2] }, actions: [] },
        ],
      },
    ];
    for (const input of inputs) {
      expect(() => checkSchemaShape(input)).not.toThrow();
      expect(checkSchemaShape(input).length).toBeGreaterThan(0);
    }
    const paths = checkSchemaShape(inputs[4]).map((e) => e.path);
    expect(paths).toEqual([
      'fields[0].type',
      'fields[1].options[0]',
      'fields[2].fields[0].fieldId',
      'fields[2].fields[0].key',
      'fields[2].fields[0].label',
      'fields[2].fields[0].type',
      'linkage[0].when',
      'linkage[0].actions[0]',
      'linkage[1].when',
      'linkage[2].when',
    ]);
  });
});
