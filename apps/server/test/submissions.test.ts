import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { json, settle, startTestEnv, type TestEnv } from './helpers';

// 场景二 Q0 / Q1 / Q2 / Q5 / Q6 以及场景一 Q2 的端到端测试。

let env: TestEnv;
let cookie: string;

const validV4 = {
  fullName: '  测试用户  ',
  email: 'tester@example.com',
  phone: '13800000000',
  isFreshGraduate: false,
  experience: 6,
  previousCompany: '示例科技',
  expectedSalary: 35000,
  department: '研发',
  contact: { emergency: { name: '联系人', phone: '13900000000' } },
  workHistory: [{ company: '示例科技', startDate: '2020-01-01', isCurrent: true }],
};

beforeAll(async () => {
  env = await startTestEnv({ historicalCount: 200 });
  cookie = await env.login('hr_a');
}, 60_000);

afterAll(async () => {
  await env.close();
});

const post = (formId: string, payload: object) =>
  env.server.inject({ method: 'POST', url: `/api/v1/dynamic-data/${formId}`, payload });

describe('场景二 Q0：通用提交接口', () => {
  it('合法提交返回 201、ETag 和联动提示；trim_strings 之外的插件不影响结果', async () => {
    const res = await post('tech_onboarding', validV4);
    expect(res.statusCode).toBe(201);
    expect(res.headers.etag).toBe('"1"');
    const body = json<{ id: string; schemaVersion: number; messages: Array<{ ruleId: string }> }>(
      res,
    );
    expect(body.schemaVersion).toBe(4);
    expect(body.messages.map((m) => m.ruleId)).toEqual(['high_salary_hrbp']);
  });

  it('校验失败返回 422 和所有字段错误', async () => {
    const res = await post('tech_onboarding', { ...validV4, email: 'bad', department: undefined });
    expect(res.statusCode).toBe(422);
    const body = json<{ errors: Array<{ path: string; message: string }> }>(res);
    expect(body.errors.map((e) => e.path)).toEqual(['email', 'department']);
    expect(body.errors[0]?.message).toBe('邮箱格式不正确，请填写有效的邮箱');
  });

  it('不存在的表单返回 404，非对象请求体返回 422', async () => {
    expect((await post('no_such_form', validV4)).statusCode).toBe(404);
    expect((await post('tech_onboarding', [1, 2])).statusCode).toBe(422);
  });

  it('afterSave 钩子写入 outbox，由后台任务执行', async () => {
    const res = await post('tech_onboarding', validV4);
    const { id } = json<{ id: string }>(res);
    const before = await env.db.query(
      `SELECT hook, status FROM outbox WHERE payload->>'submissionId' = $1 ORDER BY hook`,
      [id],
    );
    expect(before.rows).toEqual([
      { hook: 'attendance_sync', status: 'pending' },
      { hook: 'contract_pdf', status: 'pending' },
      { hook: 'dingtalk_notify', status: 'pending' },
    ]);
    while ((await env.outbox.runOnce()) > 0) {
      // 一直执行到没有到期任务
    }
    const after = await env.db.query(
      `SELECT hook, status, result FROM outbox WHERE payload->>'submissionId' = $1 ORDER BY hook`,
      [id],
    );
    expect(after.rows.map((r) => r.status)).toEqual(['done', 'done', 'done']);
    expect(after.rows[2]?.result).toMatchObject({ simulated: true });
    // PDF 只嵌入用到的字（HarfBuzz 子集化）。如果退回到嵌入整个中文字体，会变成 7MB 以上。
    const pdfSize = Number(after.rows[1]?.result?.size);
    expect(pdfSize).toBeGreaterThan(1000);
    expect(pdfSize).toBeLessThan(100_000);
  });
});

describe('场景二 Q1：通用查询与筛选', () => {
  const list = (query: string) =>
    env.server.inject({
      method: 'GET',
      url: `/api/v1/dynamic-data/tech_onboarding?${query}`,
      headers: { cookie },
    });

  it('未登录不能查询', async () => {
    const res = await env.server.inject({
      method: 'GET',
      url: '/api/v1/dynamic-data/tech_onboarding',
    });
    expect(res.statusCode).toBe(401);
  });

  it('experience > 3 只返回符合条件的记录，分页正确', async () => {
    const res = await list('filter[experience][gt]=3&pageSize=10&sort=-experience');
    expect(res.statusCode).toBe(200);
    const body = json<{ items: Array<{ data: { experience: number } }>; total: number }>(res);
    expect(body.items).toHaveLength(10);
    expect(body.total).toBeGreaterThan(10);
    expect(body.items.every((i) => i.data.experience > 3)).toBe(true);
    const values = body.items.map((i) => i.data.experience);
    expect(values).toEqual([...values].sort((a, b) => b - a));
  });

  it('按 v4 的新字段名 fullName 筛选也能命中 v3 历史数据（employeeName）', async () => {
    const sample = await env.db.query<{ name: string }>(
      `SELECT data->>'employeeName' AS name FROM submissions WHERE schema_version = 3 LIMIT 1`,
    );
    const name = sample.rows[0]?.name ?? '';
    const res = await list(`filter[fullName][eq]=${encodeURIComponent(name)}&view=latest`);
    const body = json<{
      items: Array<{
        schemaVersion: number;
        viewVersion: number;
        data: Record<string, unknown>;
        missingFields: string[];
      }>;
    }>(res);
    const historical = body.items.find((i) => i.schemaVersion === 3);
    expect(historical).toBeDefined();
    expect(historical?.viewVersion).toBe(4);
    expect(historical?.data.fullName).toBe(name);
    expect(historical?.missingFields).toEqual(['department']);
  });

  it('非法筛选返回 400 和原因', async () => {
    const res = await list('filter[salary][gt]=1');
    expect(res.statusCode).toBe(400);
    expect(json<{ errors: Array<{ code: string }> }>(res).errors[0]?.code).toBe('invalid_field');
  });

  it('筛选值里的 SQL 片段只会被当成普通字符串', async () => {
    const res = await list(`filter[email][eq]=${encodeURIComponent("x' OR '1'='1")}`);
    expect(res.statusCode).toBe(200);
    expect(json<{ total: number }>(res).total).toBe(0);
  });
});

describe('场景一 Q2 + 场景二 Q5 / Q6：修改、乐观锁、审计', () => {
  it('HR 修改 v3 历史记录：升级到 v4，审计记录字段级变化', async () => {
    const { rows } = await env.db.query<{ id: string }>(
      `SELECT id FROM submissions WHERE schema_version = 3 AND (data->>'isFreshGraduate')::boolean = false LIMIT 1`,
    );
    const id = rows[0]?.id ?? '';
    const url = `/api/v1/dynamic-data/tech_onboarding/${id}`;
    const current = await env.server.inject({
      method: 'GET',
      url: `${url}?view=latest`,
      headers: { cookie },
    });
    const etag = current.headers.etag ?? '';
    const view = json<{ data: Record<string, unknown> }>(current);
    const { nickname: _deprecated, ...latestData } = view.data;

    const update = await env.server.inject({
      method: 'PUT',
      url,
      headers: { cookie, 'if-match': etag },
      payload: { ...latestData, department: '测试', expectedSalary: 35000 },
    });
    expect(update.statusCode).toBe(200);
    expect(json<{ schemaVersion: number }>(update).schemaVersion).toBe(4);

    // 另一个 HR 拿着旧的 ETag 再提交：409，不会覆盖
    const stale = await env.server.inject({
      method: 'PUT',
      url,
      headers: { cookie: await env.login('hr_b'), 'if-match': etag },
      payload: { ...latestData, department: '运维' },
    });
    expect(stale.statusCode).toBe(409);
    expect(json<{ code: string }>(stale).code).toBe('version_conflict');

    // 不带 If-Match：428
    const blind = await env.server.inject({
      method: 'PUT',
      url,
      headers: { cookie },
      payload: latestData,
    });
    expect(blind.statusCode).toBe(428);

    const audit = await env.server.inject({
      method: 'GET',
      url: `/api/v1/audit-logs?entityType=submission&entityId=${id}`,
      headers: { cookie: await env.login('admin') },
    });
    const entry = json<{
      items: Array<{
        action: string;
        actorName: string;
        changes: Array<{ path: string; before: unknown; after: unknown }>;
        meta: Record<string, unknown>;
      }>;
    }>(audit).items[0];
    expect(entry?.action).toBe('submission.update');
    expect(entry?.actorName).toBe('HR 小A');
    expect(entry?.meta).toMatchObject({ upgradedFrom: 3, schemaVersion: 4 });
    expect(entry?.changes).toContainEqual({ path: 'department', before: null, after: '测试' });
    expect(entry?.changes.find((c) => c.path === 'expectedSalary')?.after).toBe(35000);
  });

  it('普通 HR 看到的审计记录里，敏感字段被脱敏', async () => {
    const res = await env.server.inject({
      method: 'GET',
      url: '/api/v1/audit-logs?entityType=submission',
      headers: { cookie },
    });
    const changes = json<{ items: Array<{ changes: Array<{ path: string; after: unknown }> }> }>(
      res,
    ).items.flatMap((i) => i.changes);
    const salary = changes.find((c) => c.path === 'expectedSalary');
    expect(salary?.after).toBe('3***0');
  });

  it('审计日志不允许修改和删除（数据库触发器）', async () => {
    await expect(env.db.query('UPDATE audit_logs SET actor_name = $1', ['x'])).rejects.toThrow(
      '只允许追加',
    );
    await settle();
    await expect(env.db.query('DELETE FROM audit_logs')).rejects.toThrow('只允许追加');
    await settle();
  });

  it('已发布的 Schema 不允许修改（数据库触发器）', async () => {
    await expect(
      env.db.query(`UPDATE form_versions SET schema = '{}' WHERE form_id = 'tech_onboarding'`),
    ).rejects.toThrow('已发布的 Schema 不允许修改');
    await settle();
  });
});
