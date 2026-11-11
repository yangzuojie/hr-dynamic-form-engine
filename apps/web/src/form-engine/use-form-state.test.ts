import { type RepeaterField, techOnboardingV4 } from '@hr/schema-core';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import { getIn, parsePath, setIn } from './paths';
import { useFormState } from './use-form-state';

describe('paths', () => {
  it('解析并不可变地写入嵌套路径', () => {
    expect(parsePath('workHistory[1].company')).toEqual(['workHistory', 1, 'company']);
    const data = { workHistory: [{ company: 'A' }, { company: 'B' }], other: { x: 1 } };
    const next = setIn(data, 'workHistory[1].company', 'C');
    expect(getIn(next, 'workHistory[1].company')).toBe('C');
    expect(data.workHistory[1]?.company).toBe('B');
    // 没改到的分支保持同一引用，未变化的控件不会重渲染
    expect(next.other).toBe(data.other);
    expect((next.workHistory as unknown[])[0]).toBe(data.workHistory[0]);
  });
});

const repeater = techOnboardingV4.fields.find((f): f is RepeaterField => f.type === 'repeater');

describe('useFormState：场景一 Q1', () => {
  it('默认值、dirty 状态、字段级错误只在碰过字段或提交后显示', async () => {
    const { result } = renderHook(() =>
      useFormState(techOnboardingV4, { onSubmit: async () => undefined }),
    );
    expect(result.current[0].values.isFreshGraduate).toBe(false);
    expect(result.current[0].dirty).toBe(false);
    expect(result.current[0].fieldErrors).toEqual({});

    act(() => result.current[1].setField('email', 'bad'));
    expect(result.current[0].dirty).toBe(true);
    expect(result.current[0].fieldErrors.email).toBe('邮箱格式不正确，请填写有效的邮箱');
    expect(result.current[0].fieldErrors.fullName).toBeUndefined();

    await act(async () => {
      expect(await result.current[1].submit()).toBe(false);
    });
    expect(result.current[0].fieldErrors.fullName).toBe('姓名为必填');
  });

  it('联动：选择应届生后隐藏前公司名称，工作年限显示为 0；薪资超过 30000 出现提示', () => {
    const { result } = renderHook(() =>
      useFormState(techOnboardingV4, { onSubmit: async () => undefined }),
    );
    act(() => result.current[1].setField('isFreshGraduate', true));
    expect(result.current[0].fieldStates.previousCompany?.visible).toBe(false);
    expect(result.current[0].display.experience).toBe(0);
    act(() => result.current[1].setField('expectedSalary', 40000));
    expect(result.current[0].messages.map((m) => m.ruleId)).toEqual(['high_salary_hrbp']);
  });

  it('repeater 动态增删行，新行带默认值', () => {
    if (!repeater) throw new Error('示例表单缺少 repeater');
    const { result } = renderHook(() =>
      useFormState(techOnboardingV4, { onSubmit: async () => undefined }),
    );
    act(() => result.current[1].addRow('workHistory', repeater));
    act(() => result.current[1].addRow('workHistory', repeater));
    act(() => result.current[1].setField('workHistory[1].company', '第二家'));
    expect(result.current[0].values.workHistory).toEqual([
      { isCurrent: false },
      { isCurrent: false, company: '第二家' },
    ]);
    act(() => result.current[1].removeRow('workHistory', 0));
    expect(result.current[0].values.workHistory).toEqual([{ isCurrent: false, company: '第二家' }]);
  });

  it('服务端 422 错误挂到对应字段；修改该字段后错误消失；提交期间 submitting 为 true', async () => {
    let release: () => void = () => undefined;
    const { result } = renderHook(() =>
      useFormState(techOnboardingV4, {
        initial: {
          fullName: '张三',
          email: 'a@example.com',
          phone: '13800000000',
          isFreshGraduate: true,
          department: '研发',
          contact: { emergency: { name: '李四', phone: '13900000000' } },
        },
        onSubmit: () =>
          new Promise((_, reject) => {
            release = () =>
              reject(
                new ApiError(422, 'validation_failed', '提交数据校验未通过', [
                  { path: 'email', code: 'taken', message: '该邮箱已提交过' },
                ]),
              );
          }),
      }),
    );
    let pending: Promise<boolean> = Promise.resolve(true);
    act(() => {
      pending = result.current[1].submit();
    });
    expect(result.current[0].submitting).toBe(true);
    await act(async () => {
      release();
      expect(await pending).toBe(false);
    });
    expect(result.current[0].submitting).toBe(false);
    expect(result.current[0].fieldErrors.email).toBe('该邮箱已提交过');
    expect(result.current[0].formErrors).toContain('提交数据校验未通过');

    act(() => result.current[1].setField('email', 'b@example.com'));
    expect(result.current[0].fieldErrors.email).toBeUndefined();
  });
});
