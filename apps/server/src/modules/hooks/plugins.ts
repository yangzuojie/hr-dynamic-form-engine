import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type FormData, type FormSchema, isPlainObject } from '@hr/schema-core';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb } from 'pdf-lib';
import subsetFont from 'subset-font';
import type { PluginRegistry } from './registry';
import type { AfterSaveJob, PluginDeps, SubmissionPlugin } from './types';

// 内置插件示例（场景二 Q4）。新增插件只需实现 SubmissionPlugin 并在这里注册，通用接口无需改动。

/** beforeValidate 示例：去掉所有文本首尾空格，避免“ 张三 ”和“张三”被当成不同的值。 */
const trimStrings: SubmissionPlugin = {
  id: 'trim_strings',
  name: '文本去空格',
  description: '提交前去掉所有文本字段的首尾空格',
  beforeValidate: ({ data }) => trimDeep(data),
};

function trimDeep(data: FormData): FormData {
  const trim = (value: unknown): unknown => {
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value)) return value.map(trim);
    if (isPlainObject(value)) return trimDeep(value);
    return value;
  };
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, trim(value)]));
}

/** afterSave 示例 1：钉钉群通知。配置了 DINGTALK_WEBHOOK 就真实发送，否则只记录将要发送的内容。 */
const dingtalkNotify: SubmissionPlugin = {
  id: 'dingtalk_notify',
  name: '钉钉通知',
  description: '新的入职信息提交后通知 HR 群',
  afterSave: async (job, { db, config }) => {
    const { schema, data } = await loadSubmission(db, job);
    const text = `### 新的${schema.title}\n- 姓名：${displayName(data)}\n- 记录：${job.submissionId}\n- 事件：${job.event}`;
    if (!config.dingtalkWebhook) return { simulated: true, text };
    const response = await fetch(config.dingtalkWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { title: schema.title, text } }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`钉钉返回 HTTP ${response.status}`);
    return { simulated: false, status: response.status };
  },
};

/** afterSave 示例 2：生成 PDF 入职确认书，作为文件挂到这条提交下，HR 可在后台下载。 */
const contractPdf: SubmissionPlugin = {
  id: 'contract_pdf',
  name: '生成 PDF 合同',
  description: '根据提交内容生成入职确认书 PDF',
  afterSave: async (job, { db, config }) => {
    if (job.event !== 'submission.created') return { skipped: '只在首次提交时生成' };
    if (!existsSync(config.fontPath)) {
      throw new Error('缺少中文字体，请先执行 pnpm --filter @hr/server fetch-font');
    }
    const { schema, data } = await loadSubmission(db, job);
    const bytes = await renderContract(schema, data, job, config.fontPath);

    const id = randomUUID();
    const storageKey = `contracts/${id}`;
    const target = join(config.uploadDir, storageKey);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { mode: 0o600 });
    await db.query(
      `INSERT INTO files (id, form_id, field_key, original_name, mime_type, size_bytes, sha256, storage_key,
                          category, sensitive, submission_id)
       VALUES ($1, $2, '__contract', $3, 'application/pdf', $4, '', $5, 'contract', true, $6)`,
      [
        id,
        job.formId,
        `入职确认书-${displayName(data)}.pdf`,
        bytes.length,
        storageKey,
        job.submissionId,
      ],
    );
    return { fileId: id, size: bytes.length };
  },
};

async function renderContract(
  schema: FormSchema,
  data: FormData,
  job: AfterSaveJob,
  fontPath: string,
): Promise<Uint8Array> {
  const lines: Array<[text: string, size: number]> = [
    ['入职确认书（演示）', 20],
    [`表单：${schema.title}（v${job.schemaVersion}）`, 12],
    [`记录编号：${job.submissionId}`, 12],
    [`姓名：${displayName(data)}`, 12],
  ];
  for (const field of schema.fields) {
    const value = data[field.key];
    // 姓名已在上面单独一行；敏感字段（手机号、薪资）不写进合同演示文件
    if (
      NAME_KEYS.includes(field.key) ||
      field.sensitive ||
      field.type !== 'input' ||
      value === undefined
    ) {
      continue;
    }
    lines.push([`${field.label}：${String(value)}`, 12]);
  }
  lines.push([`生成时间：${new Date().toISOString()}`, 10]);

  // 中文字体约 8MB。先用 HarfBuzz 只保留用到的字（几 KB），再整体嵌入。
  // 不用 pdf-lib 自带的 subset：它对 CFF 字形的 OTF 字体子集化有缺陷，中文会变成方框。
  const glyphs = await subsetFont(await readFile(fontPath), lines.map(([text]) => text).join(''), {
    targetFormat: 'sfnt',
  });
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(glyphs, { subset: false });
  const page = pdf.addPage([595, 842]);
  let y = 780;
  for (const [text, size] of lines) {
    page.drawText(text, { x: 60, y, size, font, color: rgb(0.1, 0.1, 0.1) });
    y -= size * 2;
  }
  return pdf.save();
}

/** afterSave 示例 3：同步到第三方考勤系统（模拟，只返回将要同步的内容）。 */
const attendanceSync: SubmissionPlugin = {
  id: 'attendance_sync',
  name: '同步考勤系统',
  description: '把新员工同步到考勤系统（演示环境为模拟）',
  afterSave: async (job, { db }) => {
    const { data } = await loadSubmission(db, job);
    return {
      simulated: true,
      employee: displayName(data),
      externalId: `ATT-${job.submissionId.slice(0, 8)}`,
    };
  },
};

async function loadSubmission(db: PluginDeps['db'], job: AfterSaveJob) {
  const { rows } = await db.query<{ data: FormData; schema: FormSchema }>(
    `SELECT s.data, v.schema FROM submissions s
       JOIN form_versions v ON v.form_id = s.form_id AND v.version = s.schema_version
      WHERE s.id = $1`,
    [job.submissionId],
  );
  const row = rows[0];
  if (!row) throw new Error(`提交 ${job.submissionId} 不存在`);
  return row;
}

/** 不同表单、不同版本里姓名字段的 key（v3 叫 employeeName，v4 改名为 fullName）。 */
const NAME_KEYS = ['fullName', 'employeeName', 'name'];

function displayName(data: FormData): string {
  const name = NAME_KEYS.map((key) => data[key]).find((value) => typeof value === 'string');
  return typeof name === 'string' ? name : '（未填写姓名）';
}

export function registerBuiltinPlugins(registry: PluginRegistry): void {
  for (const plugin of [trimStrings, dingtalkNotify, contractPdf, attendanceSync]) {
    registry.register(plugin);
  }
}
