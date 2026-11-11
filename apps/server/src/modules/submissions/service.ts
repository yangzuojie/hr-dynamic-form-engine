import {
  type FieldError,
  type FormData,
  type FormSchema,
  type LinkageMessage,
  migrateData,
  parseListQuery,
  type RawQuery,
  validateSubmission,
} from '@hr/schema-core';
import { type Db, type DbClient, withTransaction } from '../../db/pool';
import { AppError, notFound, validationFailed } from '../../errors';
import { diffData } from '../audit/diff';
import { writeAudit } from '../audit/repo';
import type { Actor } from '../auth/plugin';
import { collectFileRefs } from '../files/collect';
import { bindFiles } from '../files/repo';
import { findForm } from '../forms/repo';
import type { VersionCache } from '../forms/version-cache';
import type { PluginRegistry } from '../hooks/registry';
import { buildFilterSql, buildOrderSql, SqlParams } from './filter-sql';
import * as repo from './repo';

// 场景二：通用数据 API。所有表单共用这一套逻辑，没有任何针对具体表单的代码。

export type SubmissionView = {
  id: string;
  formId: string;
  /** 数据实际采集时的版本。 */
  schemaVersion: number;
  /** 返回的数据所对应的版本：view=latest 时为最新版本，否则等于 schemaVersion。 */
  viewVersion: number;
  data: FormData;
  /** view=latest 时，最新版本有但这条历史数据没有采集的字段。 */
  missingFields: string[];
  lockVersion: number;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string | null;
};

export class SubmissionService {
  constructor(
    private readonly db: Db,
    private readonly versions: VersionCache,
    private readonly plugins: PluginRegistry,
  ) {}

  /** POST /api/v1/dynamic-data/:formId —— 设计决策第 20 条的 7 个步骤。 */
  async create(
    formId: string,
    payload: unknown,
    actor: Actor,
  ): Promise<{
    id: string;
    schemaVersion: number;
    lockVersion: number;
    messages: LinkageMessage[];
  }> {
    const schema = await this.currentSchema(formId); // 1. 当前发布版本
    const prepared = await this.prepare(schema, payload, actor); // 2-5. 默认值、联动、校验、钩子

    return withTransaction(this.db, async (client) => {
      // 6. 同一个事务：提交 + 文件绑定 + 审计 + outbox
      const row = await repo.insertSubmission(client, {
        formId,
        schemaVersion: schema.version,
        data: prepared.data,
        ip: actor.ip,
        userId: actor.id,
      });
      await this.bind(client, schema, row.id, prepared.data);
      await writeAudit(client, actor, {
        action: 'submission.create',
        entityType: 'submission',
        entityId: row.id,
        formId,
        meta: { schemaVersion: schema.version },
      });
      await this.plugins.enqueueAfterSave(client, schema, {
        event: 'submission.created',
        formId,
        submissionId: row.id,
        schemaVersion: schema.version,
      });
      // 7. 返回 id、版本和锁版本（路由层设置 ETag）
      return {
        id: row.id,
        schemaVersion: schema.version,
        lockVersion: row.lockVersion,
        messages: prepared.messages,
      };
    });
  }

  async get(formId: string, id: string, view: 'raw' | 'latest'): Promise<SubmissionView> {
    const row = await repo.findSubmission(this.db, formId, id);
    if (!row) throw notFound('提交记录');
    const latest = view === 'latest' ? await this.latestVersion(formId) : undefined;
    return this.toView(row, latest);
  }

  async list(
    formId: string,
    raw: RawQuery,
  ): Promise<{
    items: SubmissionView[];
    total: number;
    page: number;
    pageSize: number;
    latestVersion: number;
  }> {
    const latest = await this.latestVersion(formId);
    const { query, errors } = parseListQuery(latest, raw);
    if (errors.length > 0) throw new AppError(400, 'invalid_query', '查询参数不正确', errors);

    const versions = await this.versions.all(formId, latest.version);
    const params = new SqlParams();
    const where = buildFilterSql(query.filters, versions, params);
    const orderBy = buildOrderSql(query.sort, versions, params);
    const { rows, total } = await repo.listSubmissions(this.db, {
      formId,
      where,
      orderBy,
      sqlParams: params,
      page: query.page,
      pageSize: query.pageSize,
    });
    const items = await Promise.all(
      rows.map((row) => this.toView(row, query.view === 'latest' ? latest : undefined)),
    );
    return {
      items,
      total,
      page: query.page,
      pageSize: query.pageSize,
      latestVersion: latest.version,
    };
  }

  /**
   * HR 修改一条提交：按最新发布版本校验，旧版本数据随之升级（场景一 Q2）。
   * 审计对比的是“映射到新版本后的旧数据”和新数据，所以改名字段不会被误记成“删除 + 新增”。
   */
  async update(
    formId: string,
    id: string,
    payload: unknown,
    expectedLock: number,
    actor: Actor,
  ): Promise<{ lockVersion: number; schemaVersion: number; messages: LinkageMessage[] }> {
    const schema = await this.currentSchema(formId);
    const prepared = await this.prepare(schema, payload, actor);
    const userId = requireUser(actor);

    return withTransaction(this.db, async (client) => {
      const row = await repo.findSubmission(client, formId, id, { forUpdate: true });
      if (!row) throw notFound('提交记录');
      if (row.lockVersion !== expectedLock) throw submissionConflict(row);

      const before = await this.mapTo(row, schema);
      const lock = await repo.updateSubmission(client, {
        id,
        schemaVersion: schema.version,
        data: prepared.data,
        expectedLock,
        userId,
      });
      if (lock === undefined) throw submissionConflict(row);
      await this.bind(client, schema, id, prepared.data);
      await writeAudit(client, actor, {
        action: 'submission.update',
        entityType: 'submission',
        entityId: id,
        formId,
        changes: diffData(before.data, prepared.data),
        meta:
          row.schemaVersion === schema.version
            ? { schemaVersion: schema.version }
            : { upgradedFrom: row.schemaVersion, schemaVersion: schema.version },
      });
      await this.plugins.enqueueAfterSave(client, schema, {
        event: 'submission.updated',
        formId,
        submissionId: id,
        schemaVersion: schema.version,
      });
      return { lockVersion: lock, schemaVersion: schema.version, messages: prepared.messages };
    });
  }

  async remove(formId: string, id: string, expectedLock: number, actor: Actor): Promise<void> {
    const userId = requireUser(actor);
    await withTransaction(this.db, async (client) => {
      const row = await repo.findSubmission(client, formId, id, { forUpdate: true });
      if (!row) throw notFound('提交记录');
      const ok = await repo.softDeleteSubmission(client, { id, expectedLock, userId });
      if (!ok) throw submissionConflict(row);
      await writeAudit(client, actor, {
        action: 'submission.delete',
        entityType: 'submission',
        entityId: id,
        formId,
        meta: { schemaVersion: row.schemaVersion },
      });
    });
  }

  // ---- 内部 ----

  private async prepare(
    schema: FormSchema,
    payload: unknown,
    actor: Actor,
  ): Promise<{ data: FormData; messages: LinkageMessage[] }> {
    const input =
      typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? this.plugins.runBeforeValidate({
            formId: schema.formId,
            schema,
            data: { ...payload },
            actor,
          })
        : payload;
    const result = validateSubmission(schema, input, { rejectUnknown: true });
    if (result.errors.length > 0) throw validationFailed(result.errors);
    await this.plugins.runBeforeSave({ formId: schema.formId, schema, data: result.data, actor });
    return { data: result.data, messages: result.messages };
  }

  private async bind(client: DbClient, schema: FormSchema, submissionId: string, data: FormData) {
    const errors: FieldError[] = await bindFiles(client, {
      formId: schema.formId,
      submissionId,
      uses: collectFileRefs(schema.fields, data),
    });
    if (errors.length > 0) throw validationFailed(errors);
  }

  private async currentSchema(formId: string): Promise<FormSchema> {
    const form = await findForm(this.db, formId);
    if (!form) throw notFound('表单');
    if (form.status !== 'active' || form.currentPublishedVersion === null) {
      throw new AppError(409, 'form_unavailable', '该表单暂未开放填写');
    }
    return this.requireVersion(formId, form.currentPublishedVersion);
  }

  private async latestVersion(formId: string): Promise<FormSchema> {
    const form = await findForm(this.db, formId);
    if (!form) throw notFound('表单');
    if (form.currentPublishedVersion === null)
      throw new AppError(409, 'form_unavailable', '该表单尚未发布');
    return this.requireVersion(formId, form.currentPublishedVersion);
  }

  private async requireVersion(formId: string, version: number): Promise<FormSchema> {
    const schema = await this.versions.get(formId, version);
    if (!schema) throw notFound(`表单 ${formId} 的 v${version}`);
    return schema;
  }

  private async mapTo(row: repo.SubmissionRow, target: FormSchema) {
    if (row.schemaVersion === target.version) {
      return { data: row.data, missingFields: [] as string[] };
    }
    const source = await this.requireVersion(row.formId, row.schemaVersion);
    return migrateData(row.data, source, target);
  }

  private async toView(
    row: repo.SubmissionRow,
    latest: FormSchema | undefined,
  ): Promise<SubmissionView> {
    const mapped = latest ? await this.mapTo(row, latest) : { data: row.data, missingFields: [] };
    return {
      id: row.id,
      formId: row.formId,
      schemaVersion: row.schemaVersion,
      viewVersion: latest?.version ?? row.schemaVersion,
      data: mapped.data,
      missingFields: mapped.missingFields,
      lockVersion: row.lockVersion,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  }
}

function submissionConflict(row: repo.SubmissionRow): AppError {
  return new AppError(
    409,
    'version_conflict',
    `该记录已被${row.updatedBy ?? '其他人'}修改，请刷新后再保存`,
    undefined,
    {
      current: { lockVersion: row.lockVersion, updatedBy: row.updatedBy, updatedAt: row.updatedAt },
    },
  );
}

function requireUser(actor: Actor): number {
  if (actor.id === null) throw new AppError(401, 'unauthorized', '请先登录');
  return actor.id;
}
