import { describe, expect, it } from 'vitest';
import { techOnboardingV3 } from './examples/tech-onboarding';
import { detectLinkageCycles, evaluateCondition, evaluateLinkage } from './linkage';
import type { FormSchema } from './types';

describe('evaluateCondition', () => {
  const data = { a: 5, b: 'x', c: '', nested: { d: true } };

  it('支持比较、in、empty 和逻辑组合', () => {
    expect(evaluateCondition({ gt: ['a', 3] }, data)).toBe(true);
    expect(evaluateCondition({ lte: ['a', 4] }, data)).toBe(false);
    expect(evaluateCondition({ in: ['b', ['x', 'y']] }, data)).toBe(true);
    expect(evaluateCondition({ empty: 'c' }, data)).toBe(true);
    expect(evaluateCondition({ eq: ['nested.d', true] }, data)).toBe(true);
    expect(evaluateCondition({ and: [{ gt: ['a', 1] }, { not: { eq: ['b', 'z'] } }] }, data)).toBe(
      true,
    );
    expect(evaluateCondition({ or: [{ empty: 'b' }, { lt: ['a', 0] }] }, data)).toBe(false);
  });

  it('数值比较遇到非数字时为 false，不抛异常', () => {
    expect(evaluateCondition({ gt: ['b', 1] }, data)).toBe(false);
    expect(evaluateCondition({ gt: ['missing', 1] }, data)).toBe(false);
  });
});

describe('evaluateLinkage：场景二 Q2', () => {
  it('应届生：隐藏前公司名称并取消必填，工作年限自动设为 0', () => {
    const result = evaluateLinkage(techOnboardingV3, { isFreshGraduate: true, experience: 3 });
    expect(result.fieldStates.previousCompany).toEqual({ visible: false, required: false });
    expect(result.data.experience).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('非应届生：前公司名称显示且必填', () => {
    const result = evaluateLinkage(techOnboardingV3, { isFreshGraduate: false });
    expect(result.fieldStates.previousCompany).toEqual({ visible: true, required: true });
  });

  it('期望薪资大于 30000 时给出 HRBP 审批提示', () => {
    const high = evaluateLinkage(techOnboardingV3, { expectedSalary: 35000 });
    expect(high.messages).toMatchObject([{ ruleId: 'high_salary_hrbp', level: 'warning' }]);
    expect(evaluateLinkage(techOnboardingV3, { expectedSalary: 30000 }).messages).toEqual([]);
  });

  it('repeater 每一行分别求值：至今在职的行隐藏结束日期', () => {
    const result = evaluateLinkage(techOnboardingV3, {
      workHistory: [{ isCurrent: true }, { isCurrent: false }],
    });
    expect(result.fieldStates['workHistory[0].endDate']?.visible).toBe(false);
    expect(result.fieldStates['workHistory[1].endDate']?.visible).toBe(true);
  });

  it('父级隐藏时子字段也隐藏且不必填', () => {
    const schema: FormSchema = {
      formId: 'nested',
      title: '嵌套',
      version: 1,
      fields: [
        {
          fieldId: 'o',
          key: 'box',
          label: '盒子',
          type: 'object',
          hidden: true,
          fields: [{ fieldId: 'i', key: 'inner', label: '内', type: 'input', required: true }],
        },
      ],
    };
    expect(evaluateLinkage(schema, {}).fieldStates['box.inner']).toEqual({
      visible: false,
      required: false,
    });
  });
});

describe('防止无限循环：场景一 Q1 进阶', () => {
  // A 改 B、B 改 C、C 又改 A，且每次写入的值都会让下一条规则重新成立。
  const cyclic: FormSchema = {
    formId: 'cyclic',
    title: '循环',
    version: 1,
    fields: ['a', 'b', 'c'].map((key) => ({
      fieldId: key,
      key,
      label: key,
      type: 'input' as const,
      inputKind: 'number' as const,
    })),
    linkage: [
      { id: 'r1', when: { gte: ['a', 1] }, actions: [{ setValue: { field: 'b', value: 1 } }] },
      { id: 'r2', when: { gte: ['b', 1] }, actions: [{ setValue: { field: 'c', value: 1 } }] },
      { id: 'r3', when: { gte: ['c', 1] }, actions: [{ setValue: { field: 'a', value: 2 } }] },
      { id: 'r4', when: { eq: ['a', 2] }, actions: [{ setValue: { field: 'b', value: 3 } }] },
    ],
  };

  it('发布时静态检测出 A→B→C→A 的环', () => {
    const cycles = detectLinkageCycles(cyclic);
    expect(cycles.map((c) => c.path)).toContainEqual(['a', 'b', 'c', 'a']);
  });

  it('运行时兜底：同一字段被反复改写时停止并报表单级错误，不会死循环', () => {
    const result = evaluateLinkage(cyclic, { a: 1 });
    expect(result.errors).toMatchObject([{ path: '', code: 'linkage_cycle' }]);
  });

  it('没有 setValue 链的正常表单不会误报', () => {
    expect(detectLinkageCycles(techOnboardingV3)).toEqual([]);
  });
});
