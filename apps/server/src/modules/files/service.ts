import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FileRef } from '@hr/schema-core';
import { fileTypeFromBuffer } from 'file-type';
import type { Config } from '../../config';
import { type Db, withTransaction } from '../../db/pool';
import { AppError, notFound } from '../../errors';
import { writeAudit } from '../audit/repo';
import type { Actor } from '../auth/plugin';
import { findForm } from '../forms/repo';
import type { VersionCache } from '../forms/version-cache';
import { findUploadField } from './collect';
import * as repo from './repo';

// 场景二 Q3：敏感文件上传流程。
// 1. 先上传：按当前发布版本里该字段的配置检查大小和类型；类型以文件头（magic bytes）为准，不信任扩展名和浏览器声明；
// 2. 文件存到 Web 根目录之外，随机文件名、无扩展名、权限 600；数据库只存元数据和 SHA-256；
// 3. 提交时只带 { fileId }，后端在同一事务里校验归属并绑定（见 repo.bindFiles）；
// 4. 下载需要登录，先换取 5 分钟有效的 HMAC 签名链接；敏感文件每次取链接都记审计；
// 5. 未被提交引用的文件 24 小时后由后台任务清理。
// 生产环境可把存储层换成 S3 私有桶 + KMS 加密 + 预签名 URL，流程不变。

const LINK_TTL_SECONDS = 5 * 60;
const ORPHAN_HOURS = 24;

export type UploadInput = {
  formId: string;
  fieldPath: string;
  filename: string;
  content: Buffer;
  actor: Actor;
};

export class FileService {
  constructor(
    private readonly db: Db,
    private readonly versions: VersionCache,
    private readonly config: Config,
  ) {}

  async upload(input: UploadInput): Promise<FileRef> {
    const form = await findForm(this.db, input.formId);
    const version = form?.status === 'active' ? form.currentPublishedVersion : null;
    if (version === null || version === undefined) {
      throw new AppError(409, 'form_unavailable', '该表单暂未开放填写');
    }
    const schema = await this.versions.get(input.formId, version);
    const field = schema && findUploadField(schema.fields, input.fieldPath);
    if (!field) throw new AppError(400, 'invalid_field', `字段 ${input.fieldPath} 不是上传字段`);

    if (input.content.length === 0) throw new AppError(422, 'empty_file', '文件为空');
    if (input.content.length > field.maxSizeMb * 1024 * 1024) {
      throw new AppError(
        413,
        'file_too_large',
        `${field.label}单个文件不能超过 ${field.maxSizeMb}MB`,
      );
    }
    const detected = await fileTypeFromBuffer(input.content);
    if (!detected || !field.accept.includes(detected.mime)) {
      throw new AppError(
        415,
        'unsupported_type',
        `${field.label}只接受 ${field.accept.join('、')}，实际文件类型为 ${detected?.mime ?? '未知'}`,
      );
    }

    const id = randomUUID();
    const now = new Date();
    const storageKey = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}`;
    const target = join(this.config.uploadDir, storageKey);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, input.content, { mode: 0o600 });

    const name = sanitizeName(input.filename);
    await withTransaction(this.db, async (client) => {
      await repo.insertFile(client, {
        id,
        formId: input.formId,
        fieldKey: input.fieldPath,
        originalName: name,
        mimeType: detected.mime,
        sizeBytes: input.content.length,
        sha256: createHash('sha256').update(input.content).digest('hex'),
        storageKey,
        category: field.category ?? null,
        sensitive: field.sensitive === true,
        uploaderIp: input.actor.ip,
      });
      await writeAudit(client, input.actor, {
        action: 'file.upload',
        entityType: 'file',
        entityId: id,
        formId: input.formId,
        meta: { field: input.fieldPath, size: input.content.length, mimeType: detected.mime },
      });
    });
    return { fileId: id, name, size: input.content.length, mimeType: detected.mime };
  }

  /** 已登录的 HR 换取短时签名链接。 */
  async createLink(id: string, actor: Actor): Promise<{ url: string; expiresAt: string }> {
    const file = await this.requireFile(id);
    const expires = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
    if (file.sensitive) {
      await writeAudit(this.db, actor, {
        action: 'file.access',
        entityType: 'file',
        entityId: id,
        formId: file.formId,
        meta: { category: file.category, submissionId: file.submissionId },
      });
    }
    return {
      url: `/api/v1/files/${id}/content?exp=${expires}&sig=${this.sign(id, expires)}`,
      expiresAt: new Date(expires * 1000).toISOString(),
    };
  }

  /** 校验签名后读取文件内容。签名错误和过期一律 403，不区分原因。 */
  async readSigned(
    id: string,
    exp: string,
    sig: string,
  ): Promise<{ file: repo.FileRow; content: Buffer }> {
    const expires = Number(exp);
    const expected = Buffer.from(this.sign(id, expires));
    const actual = Buffer.from(sig);
    const valid =
      Number.isInteger(expires) &&
      expires > Date.now() / 1000 &&
      actual.length === expected.length &&
      timingSafeEqual(actual, expected);
    if (!valid) throw new AppError(403, 'invalid_link', '下载链接无效或已过期');
    const file = await this.requireFile(id);
    return { file, content: await readFile(join(this.config.uploadDir, file.storageKey)) };
  }

  async cleanupOrphans(): Promise<number> {
    const orphans = await repo.listOrphans(this.db, ORPHAN_HOURS);
    for (const file of orphans) {
      await rm(join(this.config.uploadDir, file.storageKey), { force: true });
      await repo.deleteFileRow(this.db, file.id);
    }
    return orphans.length;
  }

  private sign(id: string, expires: number): string {
    return createHmac('sha256', this.config.fileSigningSecret)
      .update(`${id}.${expires}`)
      .digest('base64url');
  }

  private async requireFile(id: string): Promise<repo.FileRow> {
    const file = /^[0-9a-f-]{36}$/i.test(id) ? await repo.findFile(this.db, id) : undefined;
    if (!file) throw notFound('文件');
    return file;
  }
}

/** 只保留文件名本身，去掉路径和控制字符，避免下载时的头注入和路径穿越。 */
function sanitizeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const cleaned = Array.from(base)
    .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch !== '\u007f')
    .join('')
    .trim()
    .slice(0, 200);
  return cleaned || 'file';
}
