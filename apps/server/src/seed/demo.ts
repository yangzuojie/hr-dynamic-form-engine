import {
  type Field,
  type FormData,
  type FormSchema,
  techOnboardingV3,
  techOnboardingV4,
} from '@hr/schema-core';
import type { Db } from '../db/pool';
import { hashPassword } from '../modules/auth/password';
import type { Actor } from '../modules/auth/plugin';
import { FormService } from '../modules/forms/service';
import { registerBuiltinPlugins } from '../modules/hooks/plugins';
import { PluginRegistry } from '../modules/hooks/registry';

// 演示数据（全部虚构）：
// - 账号 hr_a / hr_b / admin；
// - 技术岗入职表 v1～v3，以及 v3 时期的 N 条历史提交（题目场景一 Q2 的“1 万条”）；
// - 再通过正式的发布流程发布 v4（改名、废弃、新增必填），并写入几条 v4 提交；
// - 销售岗入职表（驾驶证信息），体现“不同岗位不同表单”。

export const DEMO_USERS = [
  { username: 'hr_a', displayName: 'HR 小A', role: 'hr' },
  { username: 'hr_b', displayName: 'HR 小B', role: 'hr' },
  { username: 'admin', displayName: '管理员', role: 'admin' },
] as const;

export async function seedUsers(db: Db, password: string): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  for (const user of DEMO_USERS) {
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO users (username, display_name, role, password_hash) VALUES ($1, $2, $3, $4)
       ON CONFLICT (username) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id`,
      [user.username, user.displayName, user.role, await hashPassword(password)],
    );
    const id = rows[0]?.id;
    if (id !== undefined) ids.set(user.username, id);
  }
  return ids;
}

export async function seedDemo(
  db: Db,
  options: { password: string; historicalCount: number },
): Promise<void> {
  const users = await seedUsers(db, options.password);
  const hrA = users.get('hr_a') ?? 1;
  const actor: Actor = { id: hrA, name: 'HR 小A', role: 'hr', ip: '127.0.0.1' };
  const registry = new PluginRegistry();
  registerBuiltinPlugins(registry);
  const forms = new FormService(db, registry);

  // 技术岗：v1、v2 是更早的版本（字段更少），v3 是“已有大量历史数据”的版本。
  const v1: FormSchema = {
    ...techOnboardingV3,
    version: 1,
    linkage: [],
    fields: pick(techOnboardingV3.fields, [
      'f_name',
      'f_nickname',
      'f_email',
      'f_phone',
      'f_fresh',
      'f_experience',
      'f_prev_company',
    ]),
  };
  const v2: FormSchema = {
    ...v1,
    version: 2,
    fields: [...v1.fields, ...pick(techOnboardingV3.fields, ['f_salary', 'f_contact'])],
  };
  await insertPublished(db, [v1, v2, techOnboardingV3], hrA);
  await insertHistorical(db, techOnboardingV3, options.historicalCount);

  // v4 走正式流程：保存草稿（带 If-Match）→ 发布，生成版本差异和审计记录。
  const form = await forms.get('tech_onboarding');
  const { lockVersion } = await forms.saveDraft(
    'tech_onboarding',
    { ...techOnboardingV4, version: 3 },
    form.draftLockVersion,
    actor,
  );
  await forms.publish(
    'tech_onboarding',
    lockVersion,
    'employeeName 改名为 fullName；废弃 nickname；新增必填 department',
    actor,
  );
  await insertSamples(db, techOnboardingV4, 5);

  await insertPublished(db, [salesOnboardingV1], hrA);
  await insertSamples(db, salesOnboardingV1, 20);
}

function pick(fields: Field[], ids: string[]): Field[] {
  return fields.filter((f) => ids.includes(f.fieldId));
}

/** 直接写入已发布版本（模拟系统上线前就存在的历史版本）。 */
async function insertPublished(db: Db, versions: FormSchema[], userId: number): Promise<void> {
  const last = versions.at(-1);
  if (!last) return;
  await db.query(
    `INSERT INTO forms (form_id, title, current_published_version, draft_schema, draft_base_version, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $3, $5, $5)`,
    [last.formId, last.title, last.version, JSON.stringify(last), userId],
  );
  for (const schema of versions) {
    await db.query(
      `INSERT INTO form_versions (form_id, version, schema, change_note, published_by, published_at)
       VALUES ($1, $2, $3, $4, $5, now() - make_interval(days => $6))`,
      [
        schema.formId,
        schema.version,
        JSON.stringify(schema),
        '历史版本（演示数据）',
        userId,
        (last.version - schema.version + 1) * 60,
      ],
    );
  }
}

// ---- 虚构数据生成：固定种子的伪随机数，每次生成的数据相同，便于复现 ----

const SURNAMES =
  '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾萧田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤';
const GIVEN =
  '伟芳娜秀英敏静丽强磊军洋勇艳杰娟涛明超秀兰霞平刚桂英华建国志强海燕晨阳子涵浩然思远雨萱梓轩欣怡宇航俊杰佳琪诗涵博文嘉怡天佑一鸣晓东';
const COMPANIES = [
  '示例科技',
  '星河软件',
  '云帆网络',
  '远山数据',
  '青禾信息',
  '北辰智能',
  '海川互联',
  '同舟物流科技',
];
const TITLES = ['前端工程师', '后端工程师', '测试工程师', '运维工程师', '数据工程师', '产品经理'];
const CITIES = ['贵阳市观山湖区', '贵阳市南明区', '遵义市汇川区', '成都市高新区', '重庆市渝北区'];

/** mulberry32：简单的 32 位伪随机数，分布比线性同余好（线性同余的低位周期很短，生成的姓名、手机号会大量重复）。 */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function personData(rand: () => number, index: number): FormData {
  const at = <T>(list: readonly T[] | string): T | string =>
    list[Math.floor(rand() * list.length)] ?? list[0] ?? '';
  const name = `${at(SURNAMES)}${at(GIVEN)}${rand() < 0.5 ? at(GIVEN) : ''}`;
  const fresh = rand() < 0.2;
  const experience = fresh ? 0 : Math.floor(rand() * 15) + 1;
  const phone = `1${3 + Math.floor(rand() * 7)}${String(Math.floor(rand() * 1e9)).padStart(9, '0')}`;
  const history = fresh
    ? []
    : Array.from({ length: 1 + Math.floor(rand() * 3) }, (_, i) => ({
        company: String(at(COMPANIES)),
        title: String(at(TITLES)),
        startDate: `${2024 - experience + i}-0${1 + Math.floor(rand() * 9)}-01`,
        isCurrent: i === 0,
        ...(i === 0 ? {} : { endDate: `${2025 - experience + i}-06-30` }),
      }));
  return {
    name,
    nickname: rand() < 0.4 ? `小${name.slice(-1)}` : undefined,
    email: `user${index}@example.com`,
    phone,
    githubUrl: rand() < 0.6 ? `https://github.com/demo-user-${index}` : undefined,
    isFreshGraduate: fresh,
    experience,
    previousCompany: fresh ? undefined : String(at(COMPANIES)),
    expectedSalary: 8000 + Math.floor(rand() * 40) * 1000,
    contact: {
      address: String(at(CITIES)),
      emergency: {
        name: `${at(SURNAMES)}${at(GIVEN)}`,
        phone: `139${String(Math.floor(rand() * 1e8)).padStart(8, '0')}`,
      },
    },
    workHistory: history,
  };
}

function toVersionData(person: FormData, schema: FormSchema): FormData {
  const { name, ...rest } = person;
  const keyed: FormData =
    schema.version >= 4
      ? { ...rest, fullName: name, department: '研发' }
      : { ...rest, employeeName: name };
  if (schema.version >= 4) delete keyed.nickname;
  return JSON.parse(JSON.stringify(keyed)) as FormData; // 去掉 undefined 字段
}

async function insertHistorical(db: Db, schema: FormSchema, count: number): Promise<void> {
  const rand = random(20261111);
  const batchSize = 500;
  for (let start = 0; start < count; start += batchSize) {
    const rows = Array.from({ length: Math.min(batchSize, count - start) }, (_, i) => {
      const index = start + i;
      return {
        data: toVersionData(personData(rand, index), schema),
        daysAgo: Math.floor(rand() * 59) + 1,
      };
    });
    await db.query(
      `INSERT INTO submissions (form_id, schema_version, data, created_at, updated_at, submitter_ip)
       SELECT $1, $2, r.data, now() - make_interval(days => r.days_ago), now() - make_interval(days => r.days_ago), '127.0.0.1'
         FROM jsonb_to_recordset($3::jsonb) AS r(data jsonb, days_ago int)`,
      [
        schema.formId,
        schema.version,
        JSON.stringify(rows.map((r) => ({ data: r.data, days_ago: r.daysAgo }))),
      ],
    );
  }
}

async function insertSamples(db: Db, schema: FormSchema, count: number): Promise<void> {
  const rand = random(schema.version * 7919);
  for (let i = 0; i < count; i++) {
    const data =
      schema.formId === 'sales_onboarding'
        ? salesData(rand, i)
        : toVersionData(personData(rand, 100000 + i), schema);
    await db.query(
      `INSERT INTO submissions (form_id, schema_version, data, submitter_ip) VALUES ($1, $2, $3, '127.0.0.1')`,
      [schema.formId, schema.version, JSON.stringify(data)],
    );
  }
}

function salesData(rand: () => number, index: number): FormData {
  const person = personData(rand, 200000 + index);
  const hasLicense = rand() < 0.8;
  return {
    fullName: person.name,
    phone: person.phone,
    region: ['华南', '华东', '西南', '华北'][Math.floor(rand() * 4)] ?? '西南',
    hasDriverLicense: hasLicense,
    ...(hasLicense
      ? {
          driverLicense: {
            number: `5201${String(Math.floor(rand() * 1e14)).padStart(14, '0')}`,
            licenseClass: 'C1',
            validUntil: '2032-06-30',
          },
        }
      : {}),
  };
}

export const salesOnboardingV1: FormSchema = {
  formId: 'sales_onboarding',
  title: '销售岗入职信息表',
  description: '销售岗位新员工入职信息采集（含驾驶证信息）',
  version: 1,
  hooks: ['trim_strings', 'dingtalk_notify'],
  fields: [
    { fieldId: 's_name', key: 'fullName', label: '姓名', type: 'input', required: true },
    {
      fieldId: 's_phone',
      key: 'phone',
      label: '手机号',
      type: 'input',
      required: true,
      sensitive: true,
      rules: [{ type: 'regex', pattern: '^1\\d{10}$', message: '手机号须为 11 位数字' }],
    },
    {
      fieldId: 's_region',
      key: 'region',
      label: '负责区域',
      type: 'select',
      required: true,
      options: ['华南', '华东', '西南', '华北'].map((v) => ({ label: v, value: v })),
    },
    {
      fieldId: 's_has_license',
      key: 'hasDriverLicense',
      label: '是否有驾驶证',
      type: 'select',
      required: true,
      default: true,
      options: [
        { label: '有', value: true },
        { label: '没有', value: false },
      ],
    },
    {
      fieldId: 's_license',
      key: 'driverLicense',
      label: '驾驶证信息',
      type: 'object',
      fields: [
        {
          fieldId: 's_license_no',
          key: 'number',
          label: '驾驶证号',
          type: 'input',
          required: true,
          sensitive: true,
          rules: [
            { type: 'regex', pattern: '^\\d{17}[\\dXx]$|^\\d{18}$', message: '驾驶证号为 18 位' },
          ],
        },
        {
          fieldId: 's_license_class',
          key: 'licenseClass',
          label: '准驾车型',
          type: 'select',
          required: true,
          options: ['C1', 'C2', 'B1', 'B2', 'A1'].map((v) => ({ label: v, value: v })),
        },
        {
          fieldId: 's_license_valid',
          key: 'validUntil',
          label: '有效期至',
          type: 'input',
          inputKind: 'date',
          required: true,
        },
        {
          fieldId: 's_license_photo',
          key: 'photo',
          label: '驾驶证照片',
          type: 'upload',
          accept: ['image/jpeg', 'image/png'],
          maxSizeMb: 5,
          category: 'other',
          sensitive: true,
        },
      ],
    },
  ],
  linkage: [
    {
      id: 'no_license_hide_details',
      description: '没有驾驶证时隐藏驾驶证信息',
      when: { eq: ['hasDriverLicense', false] },
      actions: [{ hide: 'driverLicense' }],
    },
  ],
};
