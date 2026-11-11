import type { FastifyBaseLogger } from 'fastify';
import type { PluginRegistry } from './registry';
import type { AfterSaveJob, PluginDeps } from './types';

// outbox 执行器：认领到期的任务 → 执行插件 → 成功标记 done，失败按指数退避重试，超过次数标记 failed。
// 认领时先把 next_run_at 推后（租约），进程中途崩溃的任务过一会儿会被重新认领，不会丢。

const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 5;
const LEASE_SECONDS = 120;

type OutboxRow = { id: string; hook: string; payload: AfterSaveJob; attempts: number };

export class OutboxWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly registry: PluginRegistry,
    private readonly deps: PluginDeps,
    private readonly log: FastifyBaseLogger,
  ) {}

  start(intervalMs = 3000): void {
    this.timer = setInterval(() => {
      void this.runOnce().catch((err: unknown) => this.log.error({ err }, 'outbox 执行失败'));
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** 执行一批到期任务，返回处理条数。测试里直接调用它，不依赖定时器。 */
  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const { rows } = await this.deps.db.query<OutboxRow>(
        `UPDATE outbox SET attempts = attempts + 1,
                next_run_at = now() + make_interval(secs => $2)
          WHERE id IN (SELECT id FROM outbox
                        WHERE status = 'pending' AND next_run_at <= now()
                        ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
          RETURNING id, hook, payload, attempts`,
        [BATCH_SIZE, LEASE_SECONDS],
      );
      for (const row of rows) await this.execute(row);
      return rows.length;
    } finally {
      this.running = false;
    }
  }

  private async execute(row: OutboxRow): Promise<void> {
    const plugin = this.registry.get(row.hook);
    try {
      if (!plugin?.afterSave) throw new Error(`插件 ${row.hook} 不存在或没有 afterSave`);
      const result = await plugin.afterSave(row.payload, this.deps);
      await this.deps.db.query(
        `UPDATE outbox SET status = 'done', result = $2, done_at = now(), last_error = NULL WHERE id = $1`,
        [row.id, JSON.stringify(result)],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const giveUp = row.attempts >= MAX_ATTEMPTS;
      // 退避：10s、20s、40s、80s……
      const delaySeconds = 10 * 2 ** (row.attempts - 1);
      await this.deps.db.query(
        `UPDATE outbox SET status = $2, last_error = $3,
                next_run_at = now() + make_interval(secs => $4) WHERE id = $1`,
        [row.id, giveUp ? 'failed' : 'pending', message, delaySeconds],
      );
      this.log.warn(
        { outboxId: row.id, hook: row.hook, attempts: row.attempts, message },
        '钩子执行失败',
      );
    }
  }
}
