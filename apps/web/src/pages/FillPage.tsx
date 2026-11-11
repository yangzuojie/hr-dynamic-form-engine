import type { FormData, FormSchema, LinkageMessage } from '@hr/schema-core';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { ApiError, api } from '../api';
import { FormErrors, SubmitBar } from '../form-engine/FormChrome';
import { FormRenderer } from '../form-engine/FormRenderer';
import { useFormState } from '../form-engine/use-form-state';
import { useUnsavedWarning } from '../form-engine/use-unsaved-warning';

// 候选人填写页（公开）：读取当前发布版本 → 动态渲染 → 提交到通用接口。

export function FillPage() {
  const { formId = '' } = useParams();
  const [schema, setSchema] = useState<FormSchema | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();

  useEffect(() => {
    api
      .get<FormSchema>(`/api/v1/public/forms/${encodeURIComponent(formId)}`)
      .then(({ data }) => setSchema(data))
      .catch((err: unknown) =>
        setLoadError(err instanceof ApiError ? err.message : '表单加载失败'),
      );
  }, [formId]);

  if (loadError)
    return (
      <main className="center-page">
        <p className="card">{loadError}</p>
      </main>
    );
  if (!schema) return <p className="page-loading">加载中…</p>;
  // key 保证切换表单时状态完全重置
  return <FillForm key={`${schema.formId}@${schema.version}`} schema={schema} />;
}

type SubmitResult = { id: string; schemaVersion: number; messages: LinkageMessage[] };

function FillForm({ schema }: { schema: FormSchema }) {
  const [done, setDone] = useState<SubmitResult | undefined>();
  const [status, actions] = useFormState(schema, {
    onSubmit: async (data: FormData) => {
      const { data: result } = await api.post<SubmitResult>(
        `/api/v1/dynamic-data/${schema.formId}`,
        data,
      );
      setDone(result);
    },
  });
  useUnsavedWarning(status.dirty && !done);

  if (done) {
    return (
      <main className="page narrow">
        <div className="card success">
          <h1>提交成功</h1>
          <p>感谢填写《{schema.title}》。</p>
          <p className="muted">
            记录编号：{done.id}（表单版本 v{done.schemaVersion}）
          </p>
          {done.messages.map((m) => (
            <div key={m.ruleId} className={`notice notice-${m.level}`}>
              {m.text}
            </div>
          ))}
        </div>
      </main>
    );
  }

  return (
    <main className="page narrow">
      <form
        className="card"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void actions.submit();
        }}
      >
        <h1>{schema.title}</h1>
        {schema.description && <p className="hint">{schema.description}</p>}
        <FormRenderer schema={schema} status={status} actions={actions} />
        <FormErrors status={status} />
        <SubmitBar status={status} label="提交" />
      </form>
    </main>
  );
}
