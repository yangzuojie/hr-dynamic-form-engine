import pg from 'pg';

// 数据访问只用标准 pg 驱动：开发和测试连 PGlite（兼容协议），生产连真实 PostgreSQL。

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;
/** repo 函数既能在事务里（PoolClient）也能直接用连接池（Pool）执行。 */
export type Queryable = Pick<pg.Pool, 'query'>;

export function createPool(connectionString: string, max: number): Db {
  const pool = new pg.Pool({ connectionString, max });
  // 空闲连接断开（数据库重启、网络抖动；PGlite 在 SQL 报错后也会重置连接）时，pg 会在 Pool 上发 error 事件。
  // 不监听的话 Node 会因未处理的 error 事件直接退出。坏连接已被连接池丢弃，下次查询会新建连接。
  pool.on('error', (error) => {
    console.error('数据库空闲连接异常，已丢弃：', error.message);
  });
  return pool;
}

/** 在一个事务里执行；回调抛错时回滚并原样抛出。 */
export async function withTransaction<T>(
  db: Db,
  run: (client: DbClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
