import type { FormSchema } from '../types';

// 题目示例：技术岗入职信息表。v3 是“已有 1 万条历史提交”的版本，
// v4 演示场景一 Q2 的改动：employeeName 改名为 fullName、废弃 nickname、新增必填 department。

export const techOnboardingV3: FormSchema = {
  formId: 'tech_onboarding',
  title: '技术岗入职信息表',
  description: '技术岗位新员工入职信息采集',
  version: 3,
  hooks: ['dingtalk_notify', 'contract_pdf', 'attendance_sync'],
  fields: [
    {
      fieldId: 'f_name',
      key: 'employeeName',
      label: '姓名',
      type: 'input',
      required: true,
      rules: [{ type: 'maxLength', value: 50 }],
    },
    { fieldId: 'f_nickname', key: 'nickname', label: '昵称', type: 'input' },
    {
      fieldId: 'f_email',
      key: 'email',
      label: '邮箱',
      type: 'input',
      inputKind: 'email',
      required: true,
    },
    {
      fieldId: 'f_phone',
      key: 'phone',
      label: '手机号',
      type: 'input',
      required: true,
      sensitive: true,
      rules: [{ type: 'regex', pattern: '^1\\d{10}$', message: '手机号须为 11 位数字' }],
    },
    {
      fieldId: 'f_github',
      key: 'githubUrl',
      label: 'GitHub 链接',
      type: 'input',
      inputKind: 'url',
    },
    {
      fieldId: 'f_fresh',
      key: 'isFreshGraduate',
      label: '是否应届生',
      type: 'select',
      required: true,
      default: false,
      options: [
        { label: '是', value: true },
        { label: '否', value: false },
      ],
    },
    {
      fieldId: 'f_experience',
      key: 'experience',
      label: '工作年限',
      type: 'input',
      inputKind: 'number',
      required: true,
      rules: [
        { type: 'min', value: 0 },
        { type: 'max', value: 50 },
      ],
    },
    {
      fieldId: 'f_prev_company',
      key: 'previousCompany',
      label: '前公司名称',
      type: 'input',
      required: true,
    },
    {
      fieldId: 'f_salary',
      key: 'expectedSalary',
      label: '期望薪资（元/月）',
      type: 'input',
      inputKind: 'number',
      sensitive: true,
      rules: [{ type: 'min', value: 0 }],
    },
    {
      fieldId: 'f_contact',
      key: 'contact',
      label: '联系信息',
      type: 'object',
      fields: [
        { fieldId: 'f_address', key: 'address', label: '现住址', type: 'input' },
        {
          fieldId: 'f_emergency',
          key: 'emergency',
          label: '紧急联系人',
          type: 'object',
          fields: [
            { fieldId: 'f_em_name', key: 'name', label: '姓名', type: 'input', required: true },
            {
              fieldId: 'f_em_phone',
              key: 'phone',
              label: '电话',
              type: 'input',
              required: true,
              sensitive: true,
            },
          ],
        },
      ],
    },
    {
      fieldId: 'f_work_history',
      key: 'workHistory',
      label: '工作履历',
      type: 'repeater',
      maxItems: 10,
      fields: [
        {
          fieldId: 'f_wh_company',
          key: 'company',
          label: '公司名称',
          type: 'input',
          required: true,
        },
        { fieldId: 'f_wh_title', key: 'title', label: '职位', type: 'input' },
        {
          fieldId: 'f_wh_start',
          key: 'startDate',
          label: '开始日期',
          type: 'input',
          inputKind: 'date',
          required: true,
        },
        {
          fieldId: 'f_wh_current',
          key: 'isCurrent',
          label: '至今在职',
          type: 'select',
          default: false,
          options: [
            { label: '是', value: true },
            { label: '否', value: false },
          ],
        },
        {
          fieldId: 'f_wh_end',
          key: 'endDate',
          label: '结束日期',
          type: 'input',
          inputKind: 'date',
          required: true,
        },
      ],
      linkage: [
        {
          id: 'current_job_no_end_date',
          description: '至今在职时隐藏结束日期',
          when: { eq: ['isCurrent', true] },
          actions: [{ hide: 'endDate' }],
        },
      ],
    },
    {
      fieldId: 'f_resume',
      key: 'resume',
      label: '简历',
      type: 'upload',
      accept: ['application/pdf'],
      maxSizeMb: 10,
      category: 'resume',
    },
    {
      fieldId: 'f_id_card',
      key: 'idCard',
      label: '身份证照片',
      type: 'upload',
      accept: ['image/jpeg', 'image/png'],
      maxSizeMb: 5,
      maxFiles: 2,
      category: 'id_card',
      sensitive: true,
    },
  ],
  linkage: [
    {
      id: 'fresh_graduate_no_prev_company',
      description: '场景二 Q2：应届生隐藏“前公司名称”，并取消必填',
      when: { eq: ['isFreshGraduate', true] },
      actions: [{ hide: 'previousCompany' }, { unrequire: 'previousCompany' }],
    },
    {
      id: 'fresh_graduate_zero_experience',
      description: '应届生的工作年限自动设为 0',
      when: { eq: ['isFreshGraduate', true] },
      actions: [{ setValue: { field: 'experience', value: 0 } }],
    },
    {
      id: 'high_salary_hrbp',
      description: '场景二 Q2：期望薪资大于 30000 时提示需要 HRBP 特别审批',
      when: { gt: ['expectedSalary', 30000] },
      actions: [{ message: { text: '期望薪资超过 30000，需要 HRBP 特别审批', level: 'warning' } }],
    },
  ],
};

export const techOnboardingV4: FormSchema = {
  ...techOnboardingV3,
  version: 4,
  fields: [
    ...techOnboardingV3.fields.map((field) => {
      if (field.fieldId === 'f_name') return { ...field, key: 'fullName' };
      if (field.fieldId === 'f_nickname') return { ...field, deprecated: true };
      return field;
    }),
    {
      fieldId: 'f_department',
      key: 'department',
      label: '所属部门',
      type: 'select',
      required: true,
      options: [
        { label: '研发', value: '研发' },
        { label: '测试', value: '测试' },
        { label: '运维', value: '运维' },
        { label: '产品', value: '产品' },
      ],
    },
  ],
};
