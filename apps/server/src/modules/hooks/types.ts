import type { FormData, FormSchema } from '@hr/schema-core';
import type { Config } from '../../config';
import type { Db } from '../../db/pool';
import type { Actor } from '../auth/plugin';

// 场景二 Q4：插件机制。每个表单在 Schema 的 hooks 字段里声明启用哪些插件。
// - beforeValidate：同步阶段，可以规范化数据（例如去掉首尾空格）；
// - beforeSave：同步阶段，可以抛 AppError 拒绝提交（例如对接黑名单）；
// - afterSave：异步阶段。提交事务里只写一条 outbox 记录，由后台任务执行并失败重试，
//   第三方系统（钉钉、考勤、PDF 生成）慢或者挂掉，都不会拖慢或回滚候选人的提交。

export type SubmissionEvent = 'submission.created' | 'submission.updated';

export type SyncHookContext = {
  formId: string;
  schema: FormSchema;
  data: FormData;
  actor: Actor;
};

export type AfterSaveJob = {
  event: SubmissionEvent;
  formId: string;
  submissionId: string;
  schemaVersion: number;
};

export type PluginDeps = { db: Db; config: Config };

export type SubmissionPlugin = {
  id: string;
  name: string;
  description: string;
  beforeValidate?: (ctx: SyncHookContext) => FormData;
  beforeSave?: (ctx: SyncHookContext) => Promise<void> | void;
  /** 返回值会存进 outbox.result，方便在后台查看执行结果。 */
  afterSave?: (job: AfterSaveJob, deps: PluginDeps) => Promise<Record<string, unknown>>;
};
