import type { FormSchema, SchemaChange } from '@hr/schema-core';
import type { Queryable } from '../../db/pool';

// JSONB 列读出来已经是对象。写入前都经过 checkSchemaShape 校验，所以读出时按 FormSchema 类型使用。

export type FormRow = {
  formId: string;
  title: string;
  status: 'active' | 'archived';
  currentPublishedVersion: number | null;
  draftSchema: FormSchema;
  draftBaseVersion: number | null;
  draftLockVersion: number;
  updatedBy: string | null;
  updatedAt: Date;
};

const FORM_COLUMNS = `f.form_id AS "formId", f.title, f.status,
  f.current_published_version AS "currentPublishedVersion", f.draft_schema AS "draftSchema",
  f.draft_base_version AS "draftBaseVersion", f.draft_lock_version AS "draftLockVersion",
  u.display_name AS "updatedBy", f.updated_at AS "updatedAt"`;

export async function findForm(
  db: Queryable,
  formId: string,
  options: { forUpdate?: boolean } = {},
): Promise<FormRow | undefined> {
  // FOR UPDATE 不能和 LEFT JOIN 的可空侧一起用，所以只锁 forms 表。
  const lock = options.forUpdate ? 'FOR UPDATE OF f' : '';
  const { rows } = await db.query<FormRow>(
    `SELECT ${FORM_COLUMNS} FROM forms f LEFT JOIN users u ON u.id = f.updated_by
      WHERE f.form_id = $1 ${lock}`,
    [formId],
  );
  return rows[0];
}

export type FormSummary = {
  formId: string;
  title: string;
  status: string;
  currentPublishedVersion: number | null;
  hasUnpublishedChanges: boolean;
  submissionCount: number;
  updatedAt: Date;
};

export async function listForms(db: Queryable): Promise<FormSummary[]> {
  const { rows } = await db.query<FormSummary & { submissionCount: string }>(
    `SELECT f.form_id AS "formId", f.title, f.status,
            f.current_published_version AS "currentPublishedVersion",
            (v.schema IS NULL OR v.schema - 'version' <> f.draft_schema - 'version') AS "hasUnpublishedChanges",
            (SELECT count(*) FROM submissions s WHERE s.form_id = f.form_id AND s.deleted_at IS NULL)
              AS "submissionCount",
            f.updated_at AS "updatedAt"
       FROM forms f
       LEFT JOIN form_versions v ON v.form_id = f.form_id AND v.version = f.current_published_version
      ORDER BY f.updated_at DESC`,
  );
  return rows.map((row) => ({ ...row, submissionCount: Number(row.submissionCount) }));
}

export async function insertForm(
  db: Queryable,
  form: { formId: string; title: string; draft: FormSchema; userId: number },
): Promise<void> {
  await db.query(
    `INSERT INTO forms (form_id, title, draft_schema, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $4)`,
    [form.formId, form.title, JSON.stringify(form.draft), form.userId],
  );
}

/** 带乐观锁地保存草稿：lock_version 不匹配时不更新，返回 undefined。 */
export async function updateDraft(
  db: Queryable,
  params: { formId: string; draft: FormSchema; expectedLock: number; userId: number },
): Promise<number | undefined> {
  const { rows } = await db.query<{ lock: number }>(
    `UPDATE forms
        SET draft_schema = $2, title = $3, draft_lock_version = draft_lock_version + 1,
            updated_by = $4, updated_at = now()
      WHERE form_id = $1 AND draft_lock_version = $5
      RETURNING draft_lock_version AS lock`,
    [
      params.formId,
      JSON.stringify(params.draft),
      params.draft.title,
      params.userId,
      params.expectedLock,
    ],
  );
  return rows[0]?.lock;
}

export async function insertVersion(
  db: Queryable,
  version: {
    schema: FormSchema;
    changes: SchemaChange[];
    changeNote: string | null;
    userId: number;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO form_versions (form_id, version, schema, changes, change_note, published_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      version.schema.formId,
      version.schema.version,
      JSON.stringify(version.schema),
      JSON.stringify(version.changes),
      version.changeNote,
      version.userId,
    ],
  );
}

export async function markPublished(
  db: Queryable,
  params: { formId: string; schema: FormSchema; userId: number },
): Promise<number> {
  const { rows } = await db.query<{ lock: number }>(
    `UPDATE forms
        SET current_published_version = $2, draft_base_version = $2, draft_schema = $3,
            title = $4, draft_lock_version = draft_lock_version + 1, updated_by = $5, updated_at = now()
      WHERE form_id = $1
      RETURNING draft_lock_version AS lock`,
    [
      params.formId,
      params.schema.version,
      JSON.stringify(params.schema),
      params.schema.title,
      params.userId,
    ],
  );
  return rows[0]?.lock ?? 0;
}

export async function setFormStatus(
  db: Queryable,
  formId: string,
  status: 'active' | 'archived',
  userId: number,
): Promise<void> {
  await db.query(
    'UPDATE forms SET status = $2, updated_by = $3, updated_at = now() WHERE form_id = $1',
    [formId, status, userId],
  );
}

export type VersionRow = {
  version: number;
  schema: FormSchema;
  status: string;
  changes: SchemaChange[];
  changeNote: string | null;
  publishedBy: string | null;
  publishedAt: Date;
};

const VERSION_COLUMNS = `v.version, v.schema, v.status, v.changes, v.change_note AS "changeNote",
  u.display_name AS "publishedBy", v.published_at AS "publishedAt"`;

export async function findVersion(
  db: Queryable,
  formId: string,
  version: number,
): Promise<VersionRow | undefined> {
  const { rows } = await db.query<VersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM form_versions v LEFT JOIN users u ON u.id = v.published_by
      WHERE v.form_id = $1 AND v.version = $2`,
    [formId, version],
  );
  return rows[0];
}

export async function listVersions(db: Queryable, formId: string): Promise<VersionRow[]> {
  const { rows } = await db.query<VersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM form_versions v LEFT JOIN users u ON u.id = v.published_by
      WHERE v.form_id = $1 ORDER BY v.version DESC`,
    [formId],
  );
  return rows;
}
