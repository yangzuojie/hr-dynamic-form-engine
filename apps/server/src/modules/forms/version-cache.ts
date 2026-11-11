import type { FormSchema } from '@hr/schema-core';
import type { Queryable } from '../../db/pool';

// 已发布版本不可修改（数据库触发器保证），所以可以放心地在内存里长期缓存，无需失效逻辑。
// 只有遇到缓存里没有的版本号（刚发布的新版本）时才回数据库补齐。

export class VersionCache {
  private readonly byForm = new Map<string, Map<number, FormSchema>>();

  constructor(private readonly db: Queryable) {}

  async get(formId: string, version: number): Promise<FormSchema | undefined> {
    const cached = this.byForm.get(formId)?.get(version);
    if (cached) return cached;
    return (await this.refresh(formId)).get(version);
  }

  /** 返回该表单所有已发布版本；requiredVersion 不在缓存里时先刷新。 */
  async all(formId: string, requiredVersion?: number): Promise<Map<number, FormSchema>> {
    const cached = this.byForm.get(formId);
    if (cached && (requiredVersion === undefined || cached.has(requiredVersion))) return cached;
    return this.refresh(formId);
  }

  private async refresh(formId: string): Promise<Map<number, FormSchema>> {
    const { rows } = await this.db.query<{ version: number; schema: FormSchema }>(
      'SELECT version, schema FROM form_versions WHERE form_id = $1',
      [formId],
    );
    const versions = new Map(rows.map((row) => [row.version, row.schema]));
    this.byForm.set(formId, versions);
    return versions;
  }
}
