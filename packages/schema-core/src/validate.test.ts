import { describe, expect, it } from 'vitest';
import { techOnboardingV3, techOnboardingV4 } from './examples/tech-onboarding';
import { validateSubmission } from './validate';

const validV3 = {
  employeeName: '张三',
  email: 'zhangsan@example.com',
  phone: '13800000000',
  isFreshGraduate: false,
  experience: 5,
  previousCompany: '示例科技',
  contact: { emergency: { name: '李四', phone: '13900000000' } },
  workHistory: [{ company: '示例科技', startDate: '2020-01-01', isCurrent: true }],
};

const codes = (errors: Array<{ path: string; code: string }>): string[] =>
  errors.map((e) => `${e.path}:${e.code}`);

describe('validateSubmission：场景二 Q0', () => {
  it('合法数据通过，并补上默认值', () => {
    const result = validateSubmission(techOnboardingV3, validV3, { rejectUnknown: true });
    expect(result.errors).toEqual([]);
    expect(result.data.workHistory).toEqual([
      { company: '示例科技', startDate: '2020-01-01', isCurrent: true },
    ]);
  });

  it('一次返回所有错误，带完整路径和中文提示', () => {
    const result = validateSubmission(techOnboardingV3, {
      ...validV3,
      email: 'not-an-email',
      phone: '123',
      experience: 99,
      workHistory: [{ startDate: '2020-13-40', isCurrent: false }],
    });
    expect(codes(result.errors)).toEqual([
      'email:format',
      'phone:format',
      'experience:too_big',
      'workHistory[0].company:required',
      'workHistory[0].startDate:format',
      'workHistory[0].endDate:required',
    ]);
    expect(result.errors[0]?.message).toBe('邮箱格式不正确，请填写有效的邮箱');
    expect(result.errors[1]?.message).toBe('手机号须为 11 位数字');
    expect(result.errors[3]?.message).toBe('工作履历第 1 项的公司名称为必填');
  });

  it('嵌套 object 的必填项', () => {
    const result = validateSubmission(techOnboardingV3, { ...validV3, contact: {} });
    expect(codes(result.errors)).toEqual([
      'contact.emergency.name:required',
      'contact.emergency.phone:required',
    ]);
  });

  it('应届生不需要填前公司名称，且填了也不会保存', () => {
    const result = validateSubmission(techOnboardingV3, {
      ...validV3,
      isFreshGraduate: true,
      previousCompany: '应被丢弃',
    });
    expect(result.errors).toEqual([]);
    expect(result.data).not.toHaveProperty('previousCompany');
    expect(result.data.experience).toBe(0);
  });

  it('服务端模式拒绝未知字段和已废弃字段', () => {
    const v4Data = { ...validV3, fullName: '张三', department: '研发' } as Record<string, unknown>;
    delete v4Data.employeeName;
    const result = validateSubmission(
      techOnboardingV4,
      { ...v4Data, nickname: '小张', hacker: 1 },
      { rejectUnknown: true },
    );
    expect(codes(result.errors)).toEqual(['hacker:unknown_field', 'nickname:deprecated_field']);
  });

  it('v4 新增的 department 对新提交是必填', () => {
    const { employeeName: _drop, ...rest } = validV3;
    const result = validateSubmission(techOnboardingV4, { ...rest, fullName: '张三' });
    expect(codes(result.errors)).toEqual(['department:required']);
  });

  it('上传字段只接受文件引用，拒绝内嵌内容（场景二 Q3）', () => {
    const embedded = validateSubmission(techOnboardingV3, {
      ...validV3,
      resume: ['data:application/pdf;base64,AAAA'],
    });
    expect(codes(embedded.errors)).toEqual(['resume:type']);

    const ref = validateSubmission(techOnboardingV3, {
      ...validV3,
      resume: [{ fileId: 'f1', name: 'cv.pdf', size: 1, mimeType: 'application/pdf' }],
    });
    expect(ref.errors).toEqual([]);
  });

  it('下拉框只接受定义过的选项', () => {
    const result = validateSubmission(techOnboardingV3, { ...validV3, isFreshGraduate: 'maybe' });
    expect(codes(result.errors)).toEqual(['isFreshGraduate:invalid_option']);
  });

  it('非对象的提交直接报表单级错误', () => {
    expect(codes(validateSubmission(techOnboardingV3, [1, 2]).errors)).toEqual([
      ':invalid_payload',
    ]);
  });
});
