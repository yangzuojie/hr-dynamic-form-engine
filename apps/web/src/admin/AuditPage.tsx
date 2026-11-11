import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { type AuditItem, AuditTable } from './AuditTable';
import { Pager } from './Pager';
import { useLoad } from './use-load';

type AuditPageData = { items: AuditItem[]; total: number; pageSize: number };

export function AuditPage() {
  const { user } = useAuth();
  const [page, setPage] = useState(1);
  const [formId, setFormId] = useState('');
  const query = new URLSearchParams({
    page: String(page),
    pageSize: '30',
    ...(formId ? { formId } : {}),
  });
  const forms = useLoad(
    'audit-forms',
    async () =>
      (await api.get<{ items: Array<{ formId: string; title: string }> }>('/api/v1/forms')).data
        .items,
  );
  const audit = useLoad(
    query.toString(),
    async () => (await api.get<AuditPageData>(`/api/v1/audit-logs?${query}`)).data,
  );

  return (
    <>
      <div className="page-head">
        <h1>审计日志</h1>
        <select
          value={formId}
          onChange={(e) => {
            setFormId(e.target.value);
            setPage(1);
          }}
        >
          <option value="">全部表单</option>
          {forms.data?.map((f) => (
            <option key={f.formId} value={f.formId}>
              {f.title}
            </option>
          ))}
        </select>
      </div>
      <p className="hint">
        审计日志只允许追加（数据库触发器禁止修改和删除）。
        {user?.role === 'admin'
          ? '管理员可看到敏感字段原值。'
          : '敏感字段（手机号、薪资、证件号等）已脱敏，管理员可见原值。'}
      </p>
      {audit.error && <p className="form-error">{audit.error}</p>}
      {audit.data && (
        <>
          <AuditTable items={audit.data.items} />
          <Pager
            page={page}
            pageSize={audit.data.pageSize}
            total={audit.data.total}
            onChange={setPage}
          />
        </>
      )}
    </>
  );
}
