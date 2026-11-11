import type { Field, FormSchema } from '@hr/schema-core';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/pool';
import { parsePage } from '../../http';
import { type AuthUser, requireAuth } from '../auth/plugin';
import type { VersionCache } from '../forms/version-cache';
import type { Change } from './diff';
import { type AuditRow, listAudit } from './repo';

// 场景二 Q6：审计查询。敏感字段（Schema 中 sensitive: true）对非管理员脱敏显示。

type Query = {
  formId?: string;
  entityType?: string;
  entityId?: string;
  page?: string;
  pageSize?: string;
};

export function registerAuditRoutes(app: FastifyInstance, db: Db, versions: VersionCache): void {
  app.get<{ Querystring: Query }>(
    '/api/v1/audit-logs',
    { preHandler: requireAuth },
    async (request) => {
      const { page, pageSize } = parsePage(request.query);
      const { formId, entityType, entityId } = request.query;
      const result = await listAudit(
        db,
        {
          ...(formId ? { formId } : {}),
          ...(entityType ? { entityType } : {}),
          ...(entityId ? { entityId } : {}),
        },
        page,
        pageSize,
      );
      const user: AuthUser = request.user;
      const items =
        user.role === 'admin'
          ? result.items
          : await Promise.all(result.items.map((item) => maskItem(item, versions)));
      return { items, total: result.total, page, pageSize };
    },
  );
}

async function maskItem(item: AuditRow, versions: VersionCache): Promise<AuditRow> {
  if (!item.formId || item.changes.length === 0) return item;
  const sensitive = sensitivePaths(await versions.all(item.formId));
  if (sensitive.size === 0) return item;
  return {
    ...item,
    changes: item.changes.map((change) =>
      sensitive.has(normalizePath(change.path)) ? maskChange(change) : change,
    ),
  };
}

/** 任一版本里被标为敏感的字段路径（repeater 下标去掉），例如 "phone"、"contact.emergency.phone"。 */
function sensitivePaths(all: Map<number, FormSchema>): Set<string> {
  const paths = new Set<string>();
  const walk = (fields: Field[], prefix: string): void => {
    for (const field of fields) {
      const path = prefix ? `${prefix}.${field.key}` : field.key;
      if (field.sensitive) paths.add(path);
      if (field.type === 'object' || field.type === 'repeater') walk(field.fields, path);
    }
  };
  for (const schema of all.values()) walk(schema.fields, '');
  return paths;
}

function normalizePath(path: string): string {
  return path.replace(/\[\d+\]/g, '');
}

function maskChange(change: Change): Change {
  return { path: change.path, before: mask(change.before), after: mask(change.after) };
}

function mask(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= 2) return '**';
  return `${text.slice(0, 1)}${'*'.repeat(Math.min(text.length - 2, 6))}${text.slice(-1)}`;
}
