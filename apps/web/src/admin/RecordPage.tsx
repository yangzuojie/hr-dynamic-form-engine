import type { FormData, FormSchema } from '@hr/schema-core';
import { useCallback, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ApiError, api } from '../api';
import { FormErrors, SubmitBar } from '../form-engine/FormChrome';
import { FormRenderer } from '../form-engine/FormRenderer';
import { useFormState } from '../form-engine/use-form-state';
import { useUnsavedWarning } from '../form-engine/use-unsaved-warning';
import { type AuditItem, AuditTable } from './AuditTable';
import { loadPublishedSchema } from './form-meta';
import { useLoad } from './use-load';

// HR 查看和修改一条提交：
// - 历史版本数据按 fieldId 映射到最新版本显示，保存时升级到最新版本（场景一 Q2）；
// - 保存带 If-Match，别人先改过返回 409（场景二 Q5）；
// - 下方显示这条记录的审计历史（场景二 Q6）和钩子执行结果（场景二 Q4）。

type SubmissionRecord = {
  id: string;
  schemaVersion: number;
  viewVersion: number;
  data: FormData;
  missingFields: string[];
  updatedBy: string | null;
  updatedAt: string;
};

type Loaded = { schema: FormSchema; record: SubmissionRecord; etag: string | undefined };

export function RecordPage() {
  const { formId = '', id = '' } = useParams();
  const loaded = useLoad(`record:${formId}:${id}`, async (): Promise<Loaded> => {
    const schema = await loadPublishedSchema(formId);
    const { data, etag } = await api.get<SubmissionRecord>(
      `/api/v1/dynamic-data/${formId}/${id}?view=latest`,
    );
    return { schema, record: data, etag };
  });
  if (loaded.error) return <p className="form-error">{loaded.error}</p>;
  if (!loaded.data) return <p className="page-loading">加载中…</p>;
  return <RecordEditor key={loaded.data.etag} loaded={loaded.data} reload={loaded.reload} />;
}

function RecordEditor({ loaded, reload }: { loaded: Loaded; reload: () => void }) {
  const { schema, record } = loaded;
  const navigate = useNavigate();
  const [etag, setEtag] = useState(loaded.etag);
  const [conflict, setConflict] = useState<string | undefined>();
  const [saved, setSaved] = useState<string | undefined>();
  const [auditVersion, setAuditVersion] = useState(0);

  const [status, actions] = useFormState(schema, {
    initial: record.data,
    onSubmit: async (data) => {
      setConflict(undefined);
      try {
        const res = await api.put<{ schemaVersion: number }>(
          `/api/v1/dynamic-data/${schema.formId}/${record.id}`,
          data,
          etag,
        );
        setEtag(res.etag);
        setSaved(`已保存，记录现在是 v${res.data.schemaVersion}`);
        actions.reset(data);
        setAuditVersion((v) => v + 1);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) setConflict(err.message);
        throw err;
      }
    },
  });
  useUnsavedWarning(status.dirty);

  const openFile = useCallback(async (fileId: string) => {
    const { data } = await api.post<{ url: string }>(`/api/v1/files/${fileId}/link`);
    window.open(data.url, '_blank', 'noopener');
  }, []);

  const remove = async () => {
    if (!window.confirm('确定删除这条记录？（软删除，审计可查）')) return;
    await api.delete(`/api/v1/dynamic-data/${schema.formId}/${record.id}`, etag);
    navigate(`/admin/forms/${schema.formId}/data`);
  };

  return (
    <>
      <div className="page-head">
        <h1>提交记录</h1>
        <div className="actions">
          <Link to={`/admin/forms/${schema.formId}/data`}>返回列表</Link>
          <button type="button" className="link danger" onClick={() => void remove()}>
            删除
          </button>
        </div>
      </div>
      <p className="hint">
        记录 {record.id}，采集于 v{record.schemaVersion}
        {record.viewVersion !== record.schemaVersion && `，按 v${record.viewVersion} 显示`}
        {record.missingFields.length > 0 &&
          `；历史版本未采集：${record.missingFields.join('、')}（保存时需要补齐）`}
        。最后修改：{record.updatedBy ?? '候选人'} {new Date(record.updatedAt).toLocaleString()}
      </p>
      {conflict && (
        <div className="notice notice-warning">
          {conflict}
          <button type="button" className="secondary" onClick={reload}>
            加载最新内容
          </button>
        </div>
      )}
      {saved && <div className="notice notice-info">{saved}</div>}

      <form
        className="card"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(undefined);
          void actions.submit();
        }}
      >
        <FormRenderer
          schema={schema}
          status={status}
          actions={actions}
          onOpenFile={(id) => void openFile(id)}
        />
        <FormErrors status={status} />
        <SubmitBar status={status} label="保存修改" />
      </form>

      <HookJobs formId={schema.formId} submissionId={record.id} onOpenFile={openFile} />
      <RecordAudit formId={schema.formId} submissionId={record.id} version={auditVersion} />
    </>
  );
}

type Job = {
  id: string;
  hook: string;
  event: string;
  status: string;
  attempts: number;
  lastError: string | null;
  result: Record<string, unknown> | null;
};

function HookJobs({
  formId,
  submissionId,
  onOpenFile,
}: {
  formId: string;
  submissionId: string;
  onOpenFile: (id: string) => Promise<void>;
}) {
  const jobs = useLoad(
    `jobs:${submissionId}`,
    async () =>
      (
        await api.get<{ items: Job[] }>(
          `/api/v1/hook-jobs?formId=${formId}&submissionId=${submissionId}`,
        )
      ).data.items,
  );
  if (!jobs.data?.length) return null;
  return (
    <section className="card">
      <h2>插件执行情况（场景二 Q4：提交后异步执行，失败自动重试）</h2>
      <table className="table">
        <tbody>
          {jobs.data.map((job) => {
            const fileId = typeof job.result?.fileId === 'string' ? job.result.fileId : undefined;
            return (
              <tr key={job.id}>
                <td>{job.hook}</td>
                <td>{job.event}</td>
                <td>
                  {job.status}（第 {job.attempts} 次）
                </td>
                <td className="small">
                  {fileId ? (
                    <button type="button" className="link" onClick={() => void onOpenFile(fileId)}>
                      下载生成的 PDF
                    </button>
                  ) : (
                    (job.lastError ?? JSON.stringify(job.result))
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function RecordAudit({
  formId,
  submissionId,
  version,
}: {
  formId: string;
  submissionId: string;
  version: number;
}) {
  const audit = useLoad(
    `audit:${submissionId}:${version}`,
    async () =>
      (
        await api.get<{ items: AuditItem[] }>(
          `/api/v1/audit-logs?formId=${formId}&entityType=submission&entityId=${submissionId}`,
        )
      ).data.items,
  );
  return (
    <section className="card">
      <h2>修改历史（审计日志）</h2>
      {audit.data && <AuditTable items={audit.data} />}
    </section>
  );
}
