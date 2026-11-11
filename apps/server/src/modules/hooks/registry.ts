import type { FormData, FormSchema } from '@hr/schema-core';
import type { Queryable } from '../../db/pool';
import type { AfterSaveJob, SubmissionPlugin, SyncHookContext } from './types';

export class PluginRegistry {
  private readonly plugins = new Map<string, SubmissionPlugin>();

  register(plugin: SubmissionPlugin): void {
    if (this.plugins.has(plugin.id)) throw new Error(`插件 ${plugin.id} 重复注册`);
    this.plugins.set(plugin.id, plugin);
  }

  get(id: string): SubmissionPlugin | undefined {
    return this.plugins.get(id);
  }

  list(): Array<Pick<SubmissionPlugin, 'id' | 'name' | 'description'>> {
    return [...this.plugins.values()].map(({ id, name, description }) => ({
      id,
      name,
      description,
    }));
  }

  /** 表单引用了未注册的插件时返回这些 ID，发布前检查用。 */
  unknownIds(schema: FormSchema): string[] {
    return (schema.hooks ?? []).filter((id) => !this.plugins.has(id));
  }

  runBeforeValidate(ctx: SyncHookContext): FormData {
    return this.enabled(ctx.schema).reduce(
      (data, plugin) => plugin.beforeValidate?.({ ...ctx, data }) ?? data,
      ctx.data,
    );
  }

  async runBeforeSave(ctx: SyncHookContext): Promise<void> {
    for (const plugin of this.enabled(ctx.schema)) await plugin.beforeSave?.(ctx);
  }

  /** 在业务事务内调用：为每个启用了 afterSave 的插件写一条待执行记录。 */
  async enqueueAfterSave(db: Queryable, schema: FormSchema, job: AfterSaveJob): Promise<void> {
    for (const plugin of this.enabled(schema)) {
      if (!plugin.afterSave) continue;
      await db.query('INSERT INTO outbox (hook, event, payload) VALUES ($1, $2, $3)', [
        plugin.id,
        job.event,
        JSON.stringify(job),
      ]);
    }
  }

  private enabled(schema: FormSchema): SubmissionPlugin[] {
    return (schema.hooks ?? []).flatMap((id) => {
      const plugin = this.plugins.get(id);
      return plugin ? [plugin] : [];
    });
  }
}
