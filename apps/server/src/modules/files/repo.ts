import type { FieldError } from '@hr/schema-core';
import type { Queryable } from '../../db/pool';
import type { FileUse } from './collect';

export type FileRow = {
  id: string;
  formId: string;
  fieldKey: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  category: string | null;
  sensitive: boolean;
  submissionId: string | null;
  createdAt: Date;
};

const FILE_COLUMNS = `id, form_id AS "formId", field_key AS "fieldKey", original_name AS "originalName",
  mime_type AS "mimeType", size_bytes AS "sizeBytes", storage_key AS "storageKey", category, sensitive,
  submission_id AS "submissionId", created_at AS "createdAt"`;

export async function insertFile(
  db: Queryable,
  file: Omit<FileRow, 'id' | 'submissionId' | 'createdAt'> & {
    id: string;
    sha256: string;
    uploaderIp: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO files (id, form_id, field_key, original_name, mime_type, size_bytes, sha256, storage_key,
                        category, sensitive, uploader_ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      file.id,
      file.formId,
      file.fieldKey,
      file.originalName,
      file.mimeType,
      file.sizeBytes,
      file.sha256,
      file.storageKey,
      file.category,
      file.sensitive,
      file.uploaderIp,
    ],
  );
}

export async function findFile(db: Queryable, id: string): Promise<FileRow | undefined> {
  const { rows } = await db.query<FileRow>(`SELECT ${FILE_COLUMNS} FROM files WHERE id = $1`, [id]);
  return rows[0];
}

/**
 * 把提交引用的文件绑定到这条提交（在提交事务里调用）。
 * 文件必须存在、属于同一表单的同一字段、且没有被别的提交占用，防止拿别人的 fileId 冒用。
 */
export async function bindFiles(
  db: Queryable,
  params: { formId: string; submissionId: string; uses: FileUse[] },
): Promise<FieldError[]> {
  if (params.uses.length === 0) return [];
  const ids = params.uses.map((u) => u.fileId);
  const { rows } = await db.query<{
    id: string;
    formId: string;
    fieldKey: string;
    submissionId: string | null;
  }>(
    `SELECT id, form_id AS "formId", field_key AS "fieldKey", submission_id AS "submissionId"
       FROM files WHERE id::text = ANY($1::text[]) FOR UPDATE`,
    [ids],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const errors: FieldError[] = [];
  for (const use of params.uses) {
    const file = byId.get(use.fileId);
    const ok =
      file &&
      file.formId === params.formId &&
      file.fieldKey === use.fieldPath &&
      (file.submissionId === null || file.submissionId === params.submissionId);
    if (!ok) {
      errors.push({
        path: use.fieldPath,
        code: 'invalid_file',
        message: '文件不存在或不属于该字段，请重新上传',
      });
    }
  }
  if (errors.length > 0) return errors;
  await db.query('UPDATE files SET submission_id = $2 WHERE id::text = ANY($1::text[])', [
    ids,
    params.submissionId,
  ]);
  return [];
}

/** 未被任何提交引用、且超过保留时间的上传文件（候选人上传后放弃提交）。 */
export async function listOrphans(db: Queryable, olderThanHours: number): Promise<FileRow[]> {
  const { rows } = await db.query<FileRow>(
    `SELECT ${FILE_COLUMNS} FROM files
      WHERE submission_id IS NULL AND created_at < now() - make_interval(hours => $1)`,
    [olderThanHours],
  );
  return rows;
}

export async function deleteFileRow(db: Queryable, id: string): Promise<void> {
  await db.query('DELETE FROM files WHERE id = $1 AND submission_id IS NULL', [id]);
}
