import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { json, startTestEnv, type TestEnv } from './helpers';

// 场景二 Q3：敏感文件上传。

let env: TestEnv;
let cookie: string;

// 最小的合法 PDF / PNG 文件头
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

beforeAll(async () => {
  env = await startTestEnv({ historicalCount: 5 });
  cookie = await env.login('hr_a');
}, 60_000);

afterAll(async () => {
  await env.close();
});

function multipart(filename: string, content: Buffer, mime: string) {
  const boundary = '----hrformtest';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

const upload = (field: string, filename: string, content: Buffer, mime: string) => {
  const { body, contentType } = multipart(filename, content, mime);
  return env.server.inject({
    method: 'POST',
    url: `/api/v1/files?formId=tech_onboarding&field=${field}`,
    headers: { 'content-type': contentType },
    payload: body,
  });
};

const baseSubmission = {
  fullName: '上传测试',
  email: 'upload@example.com',
  phone: '13800000000',
  isFreshGraduate: true,
  department: '研发',
  contact: { emergency: { name: '联系人', phone: '13900000000' } },
};

describe('场景二 Q3：文件上传', () => {
  it('按文件头识别类型：伪装成 PDF 的图片被拒绝', async () => {
    const res = await upload('resume', 'cv.pdf', PNG, 'application/pdf');
    expect(res.statusCode).toBe(415);
    expect(json<{ message: string }>(res).message).toContain('image/png');
  });

  it('不是上传字段、超过大小都被拒绝', async () => {
    expect((await upload('email', 'a.pdf', PDF, 'application/pdf')).statusCode).toBe(400);
    const big = Buffer.concat([PDF, Buffer.alloc(11 * 1024 * 1024)]);
    expect((await upload('resume', 'big.pdf', big, 'application/pdf')).statusCode).toBe(413);
  });

  it('上传 → 提交只带 fileId → 绑定；同一个文件不能被第二条提交冒用', async () => {
    const uploaded = await upload('resume', '../../etc/简历.pdf', PDF, 'application/pdf');
    expect(uploaded.statusCode).toBe(201);
    const ref = json<{ fileId: string; name: string; mimeType: string }>(uploaded);
    expect(ref).toMatchObject({ name: '简历.pdf', mimeType: 'application/pdf' });

    const first = await env.server.inject({
      method: 'POST',
      url: '/api/v1/dynamic-data/tech_onboarding',
      payload: { ...baseSubmission, resume: [ref] },
    });
    expect(first.statusCode).toBe(201);
    const { rows } = await env.db.query('SELECT submission_id FROM files WHERE id = $1', [
      ref.fileId,
    ]);
    expect(rows[0]?.submission_id).toBe(json<{ id: string }>(first).id);

    const second = await env.server.inject({
      method: 'POST',
      url: '/api/v1/dynamic-data/tech_onboarding',
      payload: { ...baseSubmission, email: 'other@example.com', resume: [ref] },
    });
    expect(second.statusCode).toBe(422);
    expect(json<{ errors: Array<{ code: string }> }>(second).errors[0]?.code).toBe('invalid_file');
  });

  it('文件放到其他字段里也会被拒绝', async () => {
    const res = await upload('resume', 'cv.pdf', PDF, 'application/pdf');
    const ref = json<{ fileId: string }>(res);
    const wrongField = await env.server.inject({
      method: 'POST',
      url: '/api/v1/dynamic-data/tech_onboarding',
      payload: {
        ...baseSubmission,
        idCard: [{ ...ref, name: 'x.png', size: 1, mimeType: 'image/png' }],
      },
    });
    expect(wrongField.statusCode).toBe(422);
  });

  it('下载：需要登录换签名链接；链接被篡改或过期都返回 403', async () => {
    const res = await upload('idCard', 'id.png', PNG, 'image/png');
    const { fileId } = json<{ fileId: string }>(res);

    const anon = await env.server.inject({ method: 'POST', url: `/api/v1/files/${fileId}/link` });
    expect(anon.statusCode).toBe(401);

    const link = await env.server.inject({
      method: 'POST',
      url: `/api/v1/files/${fileId}/link`,
      headers: { cookie },
    });
    const { url } = json<{ url: string }>(link);
    const download = await env.server.inject({ method: 'GET', url });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe('image/png');
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect(download.rawPayload.equals(PNG)).toBe(true);

    const tampered = url.replace(/sig=./, 'sig=X');
    expect((await env.server.inject({ method: 'GET', url: tampered })).statusCode).toBe(403);
    const expired = url.replace(/exp=\d+/, 'exp=1000');
    expect((await env.server.inject({ method: 'GET', url: expired })).statusCode).toBe(403);

    // 身份证属于敏感文件，取链接要记审计
    const audit = await env.db.query(
      `SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY id`,
      [fileId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['file.upload', 'file.access']);
  });

  it('提交 JSON 里不允许直接塞文件内容', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: '/api/v1/dynamic-data/tech_onboarding',
      payload: {
        ...baseSubmission,
        resume: [`data:application/pdf;base64,${PDF.toString('base64')}`],
      },
    });
    expect(res.statusCode).toBe(422);
  });
});
