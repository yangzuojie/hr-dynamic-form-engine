import { describe, expect, it } from 'vitest';
import { techOnboardingV4 } from './examples/tech-onboarding';
import { parseListQuery } from './query';

describe('parseListQuery：场景二 Q1', () => {
  it('experience > 3：按字段类型把值转成数字', () => {
    const { query, errors } = parseListQuery(techOnboardingV4, { 'filter[experience][gt]': '3' });
    expect(errors).toEqual([]);
    expect(query.filters).toEqual([
      { fieldId: 'f_experience', keyPath: ['experience'], op: 'gt', valueType: 'number', value: 3 },
    ]);
  });

  it('支持 in、嵌套路径、布尔下拉框和默认 eq', () => {
    const { query, errors } = parseListQuery(techOnboardingV4, {
      'filter[department][in]': '研发,测试',
      'filter[contact.emergency.name][contains]': '李',
      'filter[isFreshGraduate]': 'true',
    });
    expect(errors).toEqual([]);
    expect(query.filters.map((f) => [f.keyPath.join('.'), f.op, f.value])).toEqual([
      ['department', 'in', ['研发', '测试']],
      ['contact.emergency.name', 'contains', '李'],
      ['isFreshGraduate', 'eq', true],
    ]);
  });

  it('拒绝不存在的字段、非标量字段、错误的操作符和取值', () => {
    const { query, errors } = parseListQuery(techOnboardingV4, {
      'filter[salary][gt]': '1',
      'filter[workHistory][eq]': 'x',
      'filter[experience][like]': '1',
      'filter[experience][gt]': 'abc',
      'filter[isFreshGraduate][gt]': 'true',
    });
    expect(query.filters).toEqual([]);
    expect(errors.map((e) => e.code)).toEqual([
      'invalid_field',
      'invalid_field',
      'invalid_operator',
      'invalid_value',
      'invalid_value',
    ]);
  });

  it('分页和排序：默认值、上限和字段排序', () => {
    const defaults = parseListQuery(techOnboardingV4, {}).query;
    expect(defaults).toMatchObject({ page: 1, pageSize: 20, view: 'raw' });
    expect(defaults.sort).toEqual({ kind: 'meta', column: 'createdAt', direction: 'desc' });

    const custom = parseListQuery(techOnboardingV4, {
      page: '3',
      pageSize: '1000',
      sort: '-expectedSalary',
      view: 'latest',
    }).query;
    expect(custom).toMatchObject({ page: 3, pageSize: 100, view: 'latest' });
    expect(custom.sort).toMatchObject({ kind: 'field', fieldId: 'f_salary', direction: 'desc' });
  });
});
