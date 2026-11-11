import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ApiError, api } from '../api';
import { useLoad } from './use-load';

type FormSummary = {
  formId: string;
  title: string;
  status: 'active' | 'archived';
  currentPublishedVersion: number | null;
  hasUnpublishedChanges: boolean;
  submissionCount: number;
  updatedAt: string;
};

export function FormsPage() {
  const forms = useLoad(
    'forms',
    async () => (await api.get<{ items: FormSummary[] }>('/api/v1/forms')).data.items,
  );
  return (
    <>
      <div className="page-head">
        <h1>入职表单</h1>
      </div>
      <p className="hint">
        HR 在这里配置表单。发布后自动拥有提交、查询、校验接口：
        <code>/api/v1/dynamic-data/&lt;formId&gt;</code>，无需开发介入。
      </p>
      {forms.error && <p className="form-error">{forms.error}</p>}
      <table className="table">
        <thead>
          <tr>
            <th>表单</th>
            <th>当前版本</th>
            <th>提交数</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {forms.data?.map((form) => (
            <tr key={form.formId}>
              <td>
                <strong>{form.title}</strong>
                <div className="muted">{form.formId}</div>
              </td>
              <td>
                {form.currentPublishedVersion ? `v${form.currentPublishedVersion}` : '未发布'}
                {form.hasUnpublishedChanges && <span className="badge">草稿有改动</span>}
              </td>
              <td>{form.submissionCount.toLocaleString()}</td>
              <td>{form.status === 'active' ? '开放填写' : '已停用'}</td>
              <td className="actions">
                <Link to={`/admin/forms/${form.formId}/builder`}>配置</Link>
                <Link to={`/admin/forms/${form.formId}/data`}>数据</Link>
                {form.currentPublishedVersion && (
                  <a href={`/f/${form.formId}`} target="_blank" rel="noreferrer">
                    填写链接
                  </a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <CreateForm />
    </>
  );
}

function CreateForm() {
  const navigate = useNavigate();
  const [formId, setFormId] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | undefined>();

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.post('/api/v1/forms', { formId, title });
      navigate(`/admin/forms/${formId}/builder`);
    } catch (err) {
      setError(err instanceof ApiError ? (err.errors[0]?.message ?? err.message) : '创建失败');
    }
  };

  return (
    <form className="card inline-form" onSubmit={onSubmit}>
      <h2>新建表单</h2>
      <input
        placeholder="formId，如 ops_onboarding"
        value={formId}
        onChange={(e) => setFormId(e.target.value)}
      />
      <input
        placeholder="标题，如 运维岗入职信息表"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <button type="submit" className="primary">
        创建
      </button>
      {error && <p className="form-error">{error}</p>}
    </form>
  );
}
