import type { FormSchema } from '@hr/schema-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { json, startTestEnv, type TestEnv } from './helpers';

// 场景一 Q2（Schema 生命周期）与场景二 Q5（两个 HR 同时编辑）。

let env: TestEnv;
let hrA: string;
let hrB: string;

beforeAll(async () => {
  env = await startTestEnv({ historicalCount: 10 });
  hrA = await env.login('hr_a');
  hrB = await env.login('hr_b');
}, 60_000);

afterAll(async () => {
  await env.close();
});

type Detail = {
  draftSchema: FormSchema;
  currentPublishedVersion: number;
  draftLockVersion: number;
  versions: Array<{ version: number }>;
};

const getForm = async (cookie: string) => {
  const res = await env.server.inject({
    method: 'GET',
    url: '/api/v1/forms/tech_onboarding',
    headers: { cookie },
  });
  return { etag: res.headers.etag ?? '', body: json<Detail>(res) };
};

const saveDraft = (cookie: string, etag: string, schema: FormSchema) =>
  env.server.inject({
    method: 'PUT',
    url: '/api/v1/forms/tech_onboarding/draft',
    headers: { cookie, 'if-match': etag },
    payload: schema,
  });

const publish = (cookie: string, etag: string, changeNote?: string) =>
  env.server.inject({
    method: 'POST',
    url: '/api/v1/forms/tech_onboarding/publish',
    headers: { cookie, 'if-match': etag },
    payload: { changeNote },
  });

describe('场景二 Q5：两个 HR 同时编辑同一个表单', () => {
  it('A 先保存并发布 v5，B 基于旧版本保存时得到 409 和差异，不会覆盖 A', async () => {
    const a = await getForm(hrA);
    const b = await getForm(hrB);
    expect(a.body.currentPublishedVersion).toBe(4);
    expect(a.etag).toBe(b.etag);

    const withGithubRequired: FormSchema = {
      ...a.body.draftSchema,
      fields: a.body.draftSchema.fields.map((f) =>
        f.key === 'githubUrl' ? { ...f, required: true } : f,
      ),
    };
    const savedA = await saveDraft(hrA, a.etag, withGithubRequired);
    expect(savedA.statusCode).toBe(200);
    const published = await publish(hrA, savedA.headers.etag ?? '', 'GitHub 链接改为必填');
    expect(published.statusCode).toBe(201);
    expect(json<{ version: number }>(published).version).toBe(5);

    const changedByB: FormSchema = { ...b.body.draftSchema, title: 'B 改的标题' };
    const conflict = await saveDraft(hrB, b.etag, changedByB);
    expect(conflict.statusCode).toBe(409);
    expect(json(conflict)).toMatchObject({
      code: 'version_conflict',
      current: { updatedBy: 'HR 小A', currentPublishedVersion: 5 },
    });
    const yourChanges = json<{ yourChanges: Array<{ kind: string; path: string }> }>(
      conflict,
    ).yourChanges;
    // B 的草稿相对最新草稿：B 没有 A 刚加的“GitHub 必填”，会显示为对 githubUrl 的修改
    expect(yourChanges).toContainEqual(
      expect.objectContaining({ kind: 'modified', path: 'githubUrl' }),
    );

    const latest = await getForm(hrA);
    expect(latest.body.draftSchema.title).toBe('技术岗入职信息表');
    expect(latest.body.versions.map((v) => v.version)).toEqual([5, 4, 3, 2, 1]);
  });

  it('发布时 If-Match 过期也返回 409', async () => {
    const res = await publish(hrB, '"1"');
    expect(res.statusCode).toBe(409);
  });

  it('没有 If-Match 返回 428', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: '/api/v1/forms/tech_onboarding/publish',
      headers: { cookie: hrA },
      payload: {},
    });
    expect(res.statusCode).toBe(428);
  });
});

describe('场景一 Q2：发布规则', () => {
  it('直接删除字段会被拒绝（应改为废弃），草稿本身可以保存', async () => {
    const { etag, body } = await getForm(hrA);
    const removed: FormSchema = {
      ...body.draftSchema,
      fields: body.draftSchema.fields.filter((f) => f.key !== 'githubUrl'),
    };
    const saved = await saveDraft(hrA, etag, removed);
    expect(saved.statusCode).toBe(200);
    const res = await publish(hrA, saved.headers.etag ?? '');
    expect(res.statusCode).toBe(422);
    expect(json<{ errors: Array<{ code: string }> }>(res).errors[0]?.code).toBe('field_removed');
  });

  it('联动规则有环时拒绝发布', async () => {
    const { etag, body } = await getForm(hrA);
    const fields = body.draftSchema.fields.some((f) => f.key === 'githubUrl')
      ? body.draftSchema.fields
      : [
          ...body.draftSchema.fields,
          {
            fieldId: 'f_github',
            key: 'githubUrl',
            label: 'GitHub 链接',
            type: 'input' as const,
            inputKind: 'url' as const,
          },
        ];
    const cyclic: FormSchema = {
      ...body.draftSchema,
      fields,
      linkage: [
        ...(body.draftSchema.linkage ?? []),
        {
          id: 'loop',
          when: { eq: ['experience', 0] },
          actions: [{ setValue: { field: 'isFreshGraduate', value: true } }],
        },
      ],
    };
    const saved = await saveDraft(hrA, etag, cyclic);
    expect(
      json<{ draftIssues: Array<{ code: string }> }>(saved).draftIssues.map((e) => e.code),
    ).toContain('linkage_cycle');
    const res = await publish(hrA, saved.headers.etag ?? '');
    expect(res.statusCode).toBe(422);
    expect(json<{ errors: Array<{ message: string }> }>(res).errors[0]?.message).toContain(
      'isFreshGraduate → experience → isFreshGraduate',
    );
  });

  it('结构畸形的 Schema 保存时就被拒绝，不会 500', async () => {
    const { etag } = await getForm(hrA);
    const res = await saveDraft(hrA, etag, {
      formId: 'tech_onboarding',
      fields: 'oops',
    } as unknown as FormSchema);
    expect(res.statusCode).toBe(422);
    expect(json<{ code: string }>(res).code).toBe('validation_failed');
  });

  it('历史提交保留原版本号；新提交使用最新发布版本', async () => {
    const { rows } = await env.db.query<{ v: number; n: string }>(
      'SELECT schema_version AS v, count(*) AS n FROM submissions WHERE form_id = $1 GROUP BY 1 ORDER BY 1',
      ['tech_onboarding'],
    );
    expect(rows.map((r) => r.v)).toEqual([3, 4]);
  });

  it('导出标准 JSON Schema', async () => {
    const res = await env.server.inject({
      method: 'GET',
      url: '/api/v1/forms/tech_onboarding/versions/4/json-schema',
      headers: { cookie: hrA },
    });
    expect(json(res)).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: '技术岗入职信息表',
    });
  });
});

describe('登录', () => {
  it('错误密码返回 401；未登录访问后台返回 401', async () => {
    const bad = await env.server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'hr_a', password: 'x' },
    });
    expect(bad.statusCode).toBe(401);
    const anon = await env.server.inject({ method: 'GET', url: '/api/v1/forms' });
    expect(anon.statusCode).toBe(401);
  });
});
