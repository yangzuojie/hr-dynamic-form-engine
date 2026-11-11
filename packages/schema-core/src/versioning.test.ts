import { describe, expect, it } from 'vitest';
import { checkVersionCompatibility } from './definition';
import { techOnboardingV3, techOnboardingV4 } from './examples/tech-onboarding';
import type { FormSchema } from './types';
import { diffSchemas, migrateData, resolveKeyPath } from './versioning';

describe('场景一 Q2：v3 → v4 历史数据懒映射', () => {
  const historical = {
    employeeName: '王五',
    nickname: '小王',
    email: 'wangwu@example.com',
    contact: { emergency: { name: '赵六' } },
    workHistory: [{ company: 'A' }, { company: 'B' }],
  };

  it('改名字段跟随 fieldId，废弃字段保留，新增字段标记为缺失', () => {
    const result = migrateData(historical, techOnboardingV3, techOnboardingV4);
    expect(result.data.fullName).toBe('王五');
    expect(result.data).not.toHaveProperty('employeeName');
    expect(result.data.nickname).toBe('小王');
    expect(result.data.contact).toEqual({ emergency: { name: '赵六' } });
    expect(result.data.workHistory).toEqual([{ company: 'A' }, { company: 'B' }]);
    expect(result.renamed).toEqual([{ from: 'employeeName', to: 'fullName' }]);
    expect(result.missingFields).toEqual(['department']);
  });

  it('映射不修改原始数据', () => {
    const copy = JSON.parse(JSON.stringify(historical)) as typeof historical;
    migrateData(historical, techOnboardingV3, techOnboardingV4);
    expect(historical).toEqual(copy);
  });

  it('按 fieldId 解析各版本中的 key 路径（用于跨版本筛选）', () => {
    expect(resolveKeyPath(techOnboardingV3, 'f_name')).toEqual(['employeeName']);
    expect(resolveKeyPath(techOnboardingV4, 'f_name')).toEqual(['fullName']);
    expect(resolveKeyPath(techOnboardingV4, 'f_em_name')).toEqual(['contact', 'emergency', 'name']);
    expect(resolveKeyPath(techOnboardingV3, 'f_department')).toBeUndefined();
  });
});

describe('diffSchemas', () => {
  it('列出改名、废弃、新增', () => {
    expect(diffSchemas(techOnboardingV3, techOnboardingV4)).toEqual([
      { kind: 'renamed', from: 'employeeName', to: 'fullName', label: '姓名' },
      { kind: 'deprecated', path: 'nickname', label: '昵称' },
      { kind: 'added', path: 'department', label: '所属部门' },
    ]);
  });
});

describe('checkVersionCompatibility', () => {
  it('v3 → v4 的改动是合规的', () => {
    expect(checkVersionCompatibility(techOnboardingV3, techOnboardingV4)).toEqual([]);
  });

  it('直接删除字段或修改字段类型会被拒绝', () => {
    const broken: FormSchema = {
      ...techOnboardingV4,
      fields: techOnboardingV4.fields
        .filter((f) => f.fieldId !== 'f_nickname')
        .map((f) =>
          f.fieldId === 'f_email'
            ? { fieldId: 'f_email', key: 'email', label: '邮箱', type: 'select', options: [] }
            : f,
        ),
    };
    expect(checkVersionCompatibility(techOnboardingV3, broken).map((e) => e.code)).toEqual([
      'field_removed',
      'type_changed',
    ]);
  });
});
