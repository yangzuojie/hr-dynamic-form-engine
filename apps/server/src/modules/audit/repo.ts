import type { Queryable } from '../../db/pool';
import type { Actor } from '../auth/plugin';
import type { Change } from './diff';

export type AuditEntry = {
  action: string;
  entityType: 'form' | 'form_version' | 'submission' | 'file';
  entityId: string;
  formId?: string;
  changes?: Change[];
  meta?: Record<string, unknown>;
};

/** 必须传入业务操作所在事务的 client，保证“改了数据就一定有审计”。 */
export async function writeAudit(db: Queryable, actor: Actor, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (actor_id, actor_name, ip, action, entity_type, entity_id, form_id, changes, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      actor.id,
      actor.name,
      actor.ip,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.formId ?? null,
      JSON.stringify(entry.changes ?? []),
      JSON.stringify({ role: actor.role, ...entry.meta }),
    ],
  );
}

export type AuditRow = {
  id: string;
  at: Date;
  actorName: string;
  ip: string | null;
  action: string;
  entityType: string;
  entityId: string;
  formId: string | null;
  changes: Change[];
  meta: Record<string, unknown>;
};

export async function listAudit(
  db: Queryable,
  filter: { formId?: string; entityType?: string; entityId?: string },
  page: number,
  pageSize: number,
): Promise<{ items: AuditRow[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown): void => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (filter.formId) add('form_id = ?', filter.formId);
  if (filter.entityType) add('entity_type = ?', filter.entityType);
  if (filter.entityId) add('entity_id = ?', filter.entityId);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = await db.query<{ count: string }>(
    `SELECT count(*) FROM audit_logs ${whereSql}`,
    params,
  );
  const { rows } = await db.query<AuditRow>(
    `SELECT id, at, actor_name AS "actorName", ip, action, entity_type AS "entityType",
            entity_id AS "entityId", form_id AS "formId", changes, meta
       FROM audit_logs ${whereSql}
      ORDER BY at DESC, id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return { items: rows, total: Number(total.rows[0]?.count ?? 0) };
}
