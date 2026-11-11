import type { FormData } from '@hr/schema-core';
import type { Queryable } from '../../db/pool';
import type { SqlParams } from './filter-sql';

export type SubmissionRow = {
  id: string;
  formId: string;
  schemaVersion: number;
  data: FormData;
  lockVersion: number;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string | null;
};

const COLUMNS = `s.id, s.form_id AS "formId", s.schema_version AS "schemaVersion", s.data,
  s.lock_version AS "lockVersion", s.created_at AS "createdAt", s.updated_at AS "updatedAt",
  u.display_name AS "updatedBy"`;

export async function insertSubmission(
  db: Queryable,
  row: { formId: string; schemaVersion: number; data: FormData; ip: string; userId: number | null },
): Promise<SubmissionRow> {
  const { rows } = await db.query<SubmissionRow>(
    `INSERT INTO submissions (form_id, schema_version, data, submitter_ip, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $5)
     RETURNING id, form_id AS "formId", schema_version AS "schemaVersion", data,
               lock_version AS "lockVersion", created_at AS "createdAt", updated_at AS "updatedAt",
               NULL AS "updatedBy"`,
    [row.formId, row.schemaVersion, JSON.stringify(row.data), row.ip, row.userId],
  );
  const inserted = rows[0];
  if (!inserted) throw new Error('插入提交失败');
  return inserted;
}

export async function findSubmission(
  db: Queryable,
  formId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<SubmissionRow | undefined> {
  if (!isUuid(id)) return undefined;
  const lock = options.forUpdate ? 'FOR UPDATE OF s' : '';
  const { rows } = await db.query<SubmissionRow>(
    `SELECT ${COLUMNS} FROM submissions s LEFT JOIN users u ON u.id = s.updated_by
      WHERE s.form_id = $1 AND s.id = $2 AND s.deleted_at IS NULL ${lock}`,
    [formId, id],
  );
  return rows[0];
}

/** 带乐观锁更新：lock_version 不匹配返回 undefined。 */
export async function updateSubmission(
  db: Queryable,
  params: {
    id: string;
    schemaVersion: number;
    data: FormData;
    expectedLock: number;
    userId: number;
  },
): Promise<number | undefined> {
  const { rows } = await db.query<{ lock: number }>(
    `UPDATE submissions
        SET data = $2, schema_version = $3, lock_version = lock_version + 1,
            updated_by = $4, updated_at = now()
      WHERE id = $1 AND lock_version = $5 AND deleted_at IS NULL
      RETURNING lock_version AS lock`,
    [
      params.id,
      JSON.stringify(params.data),
      params.schemaVersion,
      params.userId,
      params.expectedLock,
    ],
  );
  return rows[0]?.lock;
}

export async function softDeleteSubmission(
  db: Queryable,
  params: { id: string; expectedLock: number; userId: number },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE submissions SET deleted_at = now(), updated_by = $2, lock_version = lock_version + 1
      WHERE id = $1 AND lock_version = $3 AND deleted_at IS NULL`,
    [params.id, params.userId, params.expectedLock],
  );
  return result.rowCount === 1;
}

export async function listSubmissions(
  db: Queryable,
  params: {
    formId: string;
    where: string[];
    orderBy: string;
    sqlParams: SqlParams;
    page: number;
    pageSize: number;
  },
): Promise<{ rows: SubmissionRow[]; total: number }> {
  const p = params.sqlParams;
  const formParam = p.add(params.formId);
  const limit = p.add(params.pageSize);
  const offset = p.add((params.page - 1) * params.pageSize);
  const where = [`s.form_id = ${formParam}`, 's.deleted_at IS NULL', ...params.where].join(' AND ');
  // 不 JOIN users：筛选和排序 SQL 使用不带表前缀的列名（id、created_at），JOIN 后会产生歧义。
  const { rows } = await db.query<SubmissionRow & { total: string }>(
    `SELECT s.id, s.form_id AS "formId", s.schema_version AS "schemaVersion", s.data,
            s.lock_version AS "lockVersion", s.created_at AS "createdAt", s.updated_at AS "updatedAt",
            (SELECT display_name FROM users WHERE users.id = s.updated_by) AS "updatedBy",
            count(*) OVER () AS total
       FROM submissions s
      WHERE ${where}
      ORDER BY ${params.orderBy}
      LIMIT ${limit} OFFSET ${offset}`,
    p.values,
  );
  return {
    rows: rows.map(({ total: _total, ...row }) => row),
    total: Number(rows[0]?.total ?? 0),
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(text: string): boolean {
  return UUID_PATTERN.test(text);
}
