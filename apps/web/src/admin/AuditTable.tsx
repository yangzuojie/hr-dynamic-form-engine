type Change = { path: string; before: unknown; after: unknown };

export type AuditItem = {
  id: string;
  at: string;
  actorName: string;
  ip: string | null;
  action: string;
  entityType: string;
  entityId: string;
  formId: string | null;
  changes: Change[];
  meta: Record<string, unknown>;
};

const ACTIONS: Record<string, string> = {
  'form.create': '创建表单',
  'form.draft_save': '保存草稿',
  'form.publish': '发布版本',
  'form.archive': '停用表单',
  'form.activate': '启用表单',
  'submission.create': '新提交',
  'submission.update': '修改提交',
  'submission.delete': '删除提交',
  'file.upload': '上传文件',
  'file.access': '查看敏感文件',
};

const show = (value: unknown): string =>
  value === null || value === undefined
    ? '（空）'
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);

/** 场景二 Q6：谁、在什么时候、改了什么（字段级前后值）。 */
export function AuditTable({ items }: { items: AuditItem[] }) {
  if (items.length === 0) return <p className="hint">暂无记录</p>;
  return (
    <table className="table audit">
      <thead>
        <tr>
          <th>时间</th>
          <th>操作人</th>
          <th>操作</th>
          <th>对象</th>
          <th>变化</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id}>
            <td className="nowrap">{new Date(item.at).toLocaleString()}</td>
            <td>
              {item.actorName}
              <div className="muted">{item.ip}</div>
            </td>
            <td>{ACTIONS[item.action] ?? item.action}</td>
            <td className="muted small">{item.entityId}</td>
            <td>
              {item.changes.length > 0 ? (
                <ul className="changes">
                  {item.changes.map((c) => (
                    <li key={c.path}>
                      <code>{c.path}</code>：{show(c.before)} → <strong>{show(c.after)}</strong>
                    </li>
                  ))}
                </ul>
              ) : (
                <MetaSummary meta={item.meta} />
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MetaSummary({ meta }: { meta: Record<string, unknown> }) {
  const parts: string[] = [];
  if (typeof meta.version === 'number') parts.push(`v${meta.version}`);
  if (typeof meta.upgradedFrom === 'number') parts.push(`从 v${meta.upgradedFrom} 升级`);
  if (typeof meta.changeNote === 'string') parts.push(meta.changeNote);
  if (typeof meta.field === 'string') parts.push(`字段 ${meta.field}`);
  return <span className="muted">{parts.join('，') || '—'}</span>;
}
