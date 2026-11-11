import {
  checkSchemaDefinition,
  checkSchemaShape,
  checkVersionCompatibility,
  diffSchemas,
  type FieldError,
  type FormSchema,
  isFormSchema,
  type SchemaChange,
} from '@hr/schema-core';
import { type Db, withTransaction } from '../../db/pool';
import { AppError, notFound, validationFailed } from '../../errors';
import { writeAudit } from '../audit/repo';
import type { Actor } from '../auth/plugin';
import type { PluginRegistry } from '../hooks/registry';
import * as repo from './repo';

// 场景一 Q2：Schema 生命周期。草稿随便改；发布生成不可修改的新版本；历史提交保留原版本号。
// 场景二 Q5：草稿保存和发布都要带 If-Match（草稿的 lock_version），防止 B 覆盖 A 的修改。

const FORM_ID_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

export type FormDetail = repo.FormRow & {
  versions: Array<Omit<repo.VersionRow, 'schema'>>;
  /** 草稿相对当前已发布版本的改动；没有已发布版本时为 null。 */
  pendingChanges: ReturnType<typeof diffSchemas> | null;
  /** 保存草稿时不阻止，但发布前必须解决的问题。 */
  draftIssues: FieldError[];
};

export class FormService {
  constructor(
    private readonly db: Db,
    private readonly plugins: PluginRegistry,
  ) {}

  list(): Promise<repo.FormSummary[]> {
    return repo.listForms(this.db);
  }

  async get(formId: string): Promise<FormDetail> {
    const form = await this.requireForm(formId);
    const versions = await repo.listVersions(this.db, formId);
    const current = versions.find((v) => v.version === form.currentPublishedVersion);
    return {
      ...form,
      versions: versions.map(({ schema: _schema, ...rest }) => rest),
      pendingChanges: current ? diffSchemas(current.schema, form.draftSchema) : null,
      draftIssues: checkSchemaDefinition(form.draftSchema),
    };
  }

  async create(input: { formId: unknown; title: unknown }, actor: Actor): Promise<repo.FormRow> {
    const { formId, title } = input;
    if (typeof formId !== 'string' || !FORM_ID_PATTERN.test(formId)) {
      throw validationFailed(
        [
          {
            path: 'formId',
            code: 'format',
            message: 'formId 只能使用小写字母、数字和下划线，以字母开头',
          },
        ],
        '表单信息不正确',
      );
    }
    if (typeof title !== 'string' || title.trim() === '') {
      throw validationFailed([{ path: 'title', code: 'required', message: '表单标题为必填' }]);
    }
    const draft: FormSchema = { formId, title: title.trim(), version: 1, fields: [] };
    return withTransaction(this.db, async (client) => {
      if (await repo.findForm(client, formId)) {
        throw new AppError(409, 'duplicate', `表单 ${formId} 已存在`);
      }
      await repo.insertForm(client, {
        formId,
        title: draft.title,
        draft,
        userId: requireUserId(actor),
      });
      await writeAudit(client, actor, {
        action: 'form.create',
        entityType: 'form',
        entityId: formId,
        formId,
      });
      const created = await repo.findForm(client, formId);
      if (!created) throw notFound('表单');
      return created;
    });
  }

  async saveDraft(
    formId: string,
    input: unknown,
    expectedLock: number,
    actor: Actor,
  ): Promise<{ lockVersion: number; draftIssues: FieldError[] }> {
    const shapeErrors = checkSchemaShape(input);
    if (shapeErrors.length > 0 || !isFormSchema(input)) {
      throw validationFailed(shapeErrors, 'Schema 结构不正确');
    }
    if (input.formId !== formId) {
      throw validationFailed([{ path: 'formId', code: 'mismatch', message: 'formId 不能修改' }]);
    }

    return withTransaction(this.db, async (client) => {
      const form = await repo.findForm(client, formId, { forUpdate: true });
      if (!form) throw notFound('表单');
      const lock = await repo.updateDraft(client, {
        formId,
        draft: input,
        expectedLock,
        userId: requireUserId(actor),
      });
      if (lock === undefined) throw draftConflict(form, input);
      await writeAudit(client, actor, {
        action: 'form.draft_save',
        entityType: 'form',
        entityId: formId,
        formId,
        meta: { changes: diffSchemas(form.draftSchema, input), lockVersion: lock },
      });
      return { lockVersion: lock, draftIssues: checkSchemaDefinition(input) };
    });
  }

  async publish(
    formId: string,
    expectedLock: number,
    changeNote: string | null,
    actor: Actor,
  ): Promise<{ version: number; lockVersion: number }> {
    return withTransaction(this.db, async (client) => {
      const form = await repo.findForm(client, formId, { forUpdate: true });
      if (!form) throw notFound('表单');
      if (form.draftLockVersion !== expectedLock) throw draftConflict(form, undefined);
      const current =
        form.currentPublishedVersion === null
          ? undefined
          : await repo.findVersion(client, formId, form.currentPublishedVersion);
      const changes = this.assertPublishable(form, current?.schema);

      const version = (form.currentPublishedVersion ?? 0) + 1;
      const schema: FormSchema = { ...form.draftSchema, version };
      const userId = requireUserId(actor);
      await repo.insertVersion(client, { schema, changes, changeNote, userId });
      const lockVersion = await repo.markPublished(client, { formId, schema, userId });
      await writeAudit(client, actor, {
        action: 'form.publish',
        entityType: 'form_version',
        entityId: `${formId}@v${version}`,
        formId,
        meta: { version, changes, changeNote },
      });
      return { version, lockVersion };
    });
  }

  /** 发布前的全部检查；通过时返回相对当前版本的改动列表。 */
  private assertPublishable(form: repo.FormRow, current: FormSchema | undefined): SchemaChange[] {
    // 草稿必须基于当前最新发布版本编辑；否则说明别人在此期间发布过（双保险，正常情况下草稿锁已拦住）。
    if (form.draftBaseVersion !== form.currentPublishedVersion) {
      throw new AppError(
        409,
        'publish_conflict',
        '草稿不是基于最新发布版本编辑的，请刷新后合并再发布',
        undefined,
        {
          currentPublishedVersion: form.currentPublishedVersion,
          draftBaseVersion: form.draftBaseVersion,
        },
      );
    }
    const draft = form.draftSchema;
    const definitionErrors = [
      ...checkSchemaDefinition(draft),
      ...this.plugins
        .unknownIds(draft)
        .map((id) => ({ path: 'hooks', code: 'unknown_plugin', message: `插件 ${id} 不存在` })),
    ];
    if (definitionErrors.length > 0)
      throw validationFailed(definitionErrors, '表单配置有误，不能发布');
    if (!current) return [];

    const compatErrors = checkVersionCompatibility(current, draft);
    if (compatErrors.length > 0)
      throw validationFailed(compatErrors, '改动会破坏历史数据，不能发布');
    const changes = diffSchemas(current, draft);
    if (changes.length === 0 && current.title === draft.title) {
      throw new AppError(422, 'no_changes', '草稿与当前发布版本相同，无需发布');
    }
    return changes;
  }

  async setStatus(formId: string, status: 'active' | 'archived', actor: Actor): Promise<void> {
    await withTransaction(this.db, async (client) => {
      const form = await repo.findForm(client, formId, { forUpdate: true });
      if (!form) throw notFound('表单');
      await repo.setFormStatus(client, formId, status, requireUserId(actor));
      await writeAudit(client, actor, {
        action: status === 'archived' ? 'form.archive' : 'form.activate',
        entityType: 'form',
        entityId: formId,
        formId,
      });
    });
  }

  async getVersion(formId: string, version: number): Promise<repo.VersionRow> {
    const row = await repo.findVersion(this.db, formId, version);
    if (!row) throw notFound(`表单 ${formId} 的 v${version}`);
    return row;
  }

  /** 候选人填写页：只返回当前发布版本；未发布或已停用时不可填写。 */
  async getPublishedSchema(formId: string): Promise<FormSchema> {
    const form = await this.requireForm(formId);
    if (form.status !== 'active' || form.currentPublishedVersion === null) {
      throw new AppError(409, 'form_unavailable', '该表单暂未开放填写');
    }
    return (await this.getVersion(formId, form.currentPublishedVersion)).schema;
  }

  private async requireForm(formId: string): Promise<repo.FormRow> {
    const form = await repo.findForm(this.db, formId);
    if (!form) throw notFound('表单');
    return form;
  }
}

/** 409：告诉 B 现在的草稿是谁、什么时候改的，以及 B 的版本和它差在哪里，便于合并。 */
function draftConflict(current: repo.FormRow, attempted: FormSchema | undefined): AppError {
  return new AppError(
    409,
    'version_conflict',
    `草稿已被${current.updatedBy ?? '其他人'}修改，请刷新后合并再保存`,
    undefined,
    {
      current: {
        lockVersion: current.draftLockVersion,
        updatedBy: current.updatedBy,
        updatedAt: current.updatedAt,
        currentPublishedVersion: current.currentPublishedVersion,
      },
      ...(attempted ? { yourChanges: diffSchemas(current.draftSchema, attempted) } : {}),
    },
  );
}

function requireUserId(actor: Actor): number {
  if (actor.id === null) throw new AppError(401, 'unauthorized', '请先登录');
  return actor.id;
}
