import {
  checkSchemaShape,
  type Field,
  type FieldError,
  type FieldType,
  type FormSchema,
  isFormSchema,
  type SchemaChange,
} from '@hr/schema-core';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError, api } from '../api';
import { FormRenderer } from '../form-engine/FormRenderer';
import { useFormState } from '../form-engine/use-form-state';
import { useUnsavedWarning } from '../form-engine/use-unsaved-warning';
import { FieldEditor } from './builder/FieldEditor';
import { FieldTree } from './builder/FieldTree';
import {
  appendField,
  collectFieldIds,
  createField,
  getFieldAt,
  hasChildren,
  type IndexPath,
  moveFieldAt,
  removeFieldAt,
  TYPE_LABELS,
  updateFieldAt,
} from './builder/schema-edit';
import { useLoad } from './use-load';

// 场景一 Q2 + 场景二 Q5：Form Builder。
// 编辑的是草稿；保存带 If-Match（ETag），别人先保存过就会得到 409 和差异；发布生成不可修改的新版本。

type Version = {
  version: number;
  status: string;
  changes: SchemaChange[];
  changeNote: string | null;
  publishedBy: string | null;
  publishedAt: string;
};

type FormDetail = {
  formId: string;
  title: string;
  status: 'active' | 'archived';
  currentPublishedVersion: number | null;
  draftSchema: FormSchema;
  draftLockVersion: number;
  updatedBy: string | null;
  updatedAt: string;
  versions: Version[];
  pendingChanges: SchemaChange[] | null;
  draftIssues: FieldError[];
};

type Loaded = { detail: FormDetail; etag: string | undefined; published: FormSchema | undefined };

export function BuilderPage() {
  const { formId = '' } = useParams();
  const loaded = useLoad(`builder:${formId}`, async (): Promise<Loaded> => {
    const { data: detail, etag } = await api.get<FormDetail>(`/api/v1/forms/${formId}`);
    const published = detail.currentPublishedVersion
      ? (
          await api.get<{ schema: FormSchema }>(
            `/api/v1/forms/${formId}/versions/${detail.currentPublishedVersion}`,
          )
        ).data.schema
      : undefined;
    return { detail, etag, published };
  });

  if (loaded.error) return <p className="form-error">{loaded.error}</p>;
  if (!loaded.data) return <p className="page-loading">加载中…</p>;
  // 重新加载后用新的 key 重建编辑器，丢弃本地状态
  return <Builder key={`${loaded.data.etag}`} loaded={loaded.data} reload={loaded.reload} />;
}

type Conflict = { message: string; yourChanges: SchemaChange[] };

/** 409 响应结构见后端 forms/service.ts 的 draftConflict。 */
function toConflict(err: unknown): Conflict | undefined {
  if (!(err instanceof ApiError) || err.status !== 409) return undefined;
  const changes = err.details.yourChanges;
  return {
    message: err.message,
    yourChanges: Array.isArray(changes) ? (changes as SchemaChange[]) : [], // 后端按 SchemaChange[] 返回
  };
}

function errorText(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  const first = err.errors[0]?.message;
  return first ? `${err.message}：${first}` : err.message;
}

function Builder({ loaded, reload }: { loaded: Loaded; reload: () => void }) {
  const { detail } = loaded;
  const [draft, setDraft] = useState<FormSchema>(detail.draftSchema);
  const [savedJson, setSavedJson] = useState(() => JSON.stringify(detail.draftSchema));
  const [etag, setEtag] = useState(loaded.etag);
  const [selected, setSelected] = useState<IndexPath | undefined>(
    detail.draftSchema.fields.length ? [0] : undefined,
  );
  const [issues, setIssues] = useState<FieldError[]>(detail.draftIssues);
  const [conflict, setConflict] = useState<Conflict | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [changeNote, setChangeNote] = useState('');
  const [showJson, setShowJson] = useState(false);

  const dirty = JSON.stringify(draft) !== savedJson;
  useUnsavedWarning(dirty);
  const publishedIds = useMemo(
    () => (loaded.published ? collectFieldIds(loaded.published.fields) : new Set<string>()),
    [loaded.published],
  );
  const field = selected ? getFieldAt(draft.fields, selected) : undefined;
  const setFields = (fields: Field[]) => setDraft((d) => ({ ...d, fields }));

  const addField = (type: FieldType, asChild: boolean) => {
    const parent = asChild && selected && field && hasChildren(field) ? selected : [];
    const keys = (
      parent.length ? (field && hasChildren(field) ? field.fields : []) : draft.fields
    ).map((f) => f.key);
    const [fields, path] = appendField(draft.fields, parent, createField(type, keys));
    setFields(fields);
    setSelected(path);
  };

  const save = async () => {
    setBusy(true);
    setConflict(undefined);
    setNotice(undefined);
    try {
      const res = await api.put<{ draftIssues: FieldError[] }>(
        `/api/v1/forms/${detail.formId}/draft`,
        draft,
        etag,
      );
      setEtag(res.etag);
      setSavedJson(JSON.stringify(draft));
      setIssues(res.data.draftIssues);
      setNotice('草稿已保存');
    } catch (err) {
      const conflictInfo = toConflict(err);
      if (conflictInfo) setConflict(conflictInfo);
      else setNotice(errorText(err, '保存失败'));
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    setBusy(true);
    setNotice(undefined);
    try {
      const { data } = await api.post<{ version: number }>(
        `/api/v1/forms/${detail.formId}/publish`,
        { changeNote },
        etag,
      );
      setNotice(`已发布 v${data.version}`);
      reload();
    } catch (err) {
      if (err instanceof ApiError) {
        setIssues(err.errors);
        setNotice(err.message);
        if (err.status === 409) setConflict({ message: err.message, yourChanges: [] });
      }
    } finally {
      setBusy(false);
    }
  };

  /** 冲突时：拿最新版本号，用“我的草稿”覆盖保存（HR 确认过要以自己的为准）。 */
  const overwrite = async () => {
    const latest = await api.get<FormDetail>(`/api/v1/forms/${detail.formId}`);
    setEtag(latest.etag);
    setConflict(undefined);
    setNotice('已取得最新版本号，请再次点击“保存草稿”确认覆盖');
  };

  return (
    <>
      <div className="page-head">
        <h1>
          {draft.title} <span className="muted small">{detail.formId}</span>
        </h1>
        <div className="actions">
          <Link to={`/admin/forms/${detail.formId}/data`}>查看数据</Link>
          {detail.currentPublishedVersion && (
            <a href={`/f/${detail.formId}`} target="_blank" rel="noreferrer">
              填写链接
            </a>
          )}
        </div>
      </div>

      {conflict && (
        <div className="notice notice-warning">
          <strong>{conflict.message}</strong>
          {conflict.yourChanges.length > 0 && (
            <ul className="changes">
              {conflict.yourChanges.map((c) => (
                <li key={`${c.kind}:${'path' in c ? c.path : c.to}`}>{describeChange(c)}</li>
              ))}
            </ul>
          )}
          <div className="actions">
            <button type="button" className="secondary" onClick={reload}>
              放弃我的修改，加载最新草稿
            </button>
            <button type="button" className="secondary" onClick={() => void overwrite()}>
              以我的为准
            </button>
          </div>
        </div>
      )}
      {notice && <div className="notice notice-info">{notice}</div>}

      <div className="builder">
        <section className="card builder-tree">
          <label className="field">
            表单标题
            <input
              value={draft.title}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            />
          </label>
          <FieldTree fields={draft.fields} selected={selected} onSelect={setSelected} />
          <AddFieldMenu onAdd={addField} canNest={!!field && hasChildren(field)} />
        </section>

        <section className="card builder-editor">
          {field && selected ? (
            <FieldEditor
              key={field.fieldId}
              field={field}
              published={publishedIds.has(field.fieldId)}
              onChange={(next) => setFields(updateFieldAt(draft.fields, selected, () => next))}
              onRemove={() => {
                setFields(removeFieldAt(draft.fields, selected));
                setSelected(undefined);
              }}
              onMove={(delta) => {
                setFields(moveFieldAt(draft.fields, selected, delta));
                const index = selected.at(-1) ?? 0;
                setSelected([...selected.slice(0, -1), Math.max(0, index + delta)]);
              }}
            />
          ) : (
            <p className="hint">在左侧选择一个字段进行编辑。</p>
          )}
          <button type="button" className="link" onClick={() => setShowJson((v) => !v)}>
            {showJson ? '收起' : '高级：编辑完整 JSON（联动规则、插件）'}
          </button>
          {showJson && <JsonEditor key={savedJson} draft={draft} onApply={setDraft} />}
        </section>

        <section className="card builder-preview">
          <h2>实时预览</h2>
          <Preview schema={draft} />
        </section>
      </div>

      <section className="card">
        <div className="publish-bar">
          <span className="muted">{dirty ? '草稿有未保存的修改' : '草稿已保存'}</span>
          <button
            type="button"
            className="secondary"
            disabled={busy || !dirty}
            onClick={() => void save()}
          >
            保存草稿
          </button>
          <input
            placeholder="发布说明（可选）"
            value={changeNote}
            onChange={(e) => setChangeNote(e.target.value)}
          />
          <button
            type="button"
            className="primary"
            disabled={busy || dirty}
            onClick={() => void publish()}
            title={dirty ? '请先保存草稿' : ''}
          >
            发布为 v{(detail.currentPublishedVersion ?? 0) + 1}
          </button>
        </div>
        {issues.length > 0 && (
          <div className="form-error">
            <p>发布前需要解决：</p>
            <ul>
              {issues.map((issue) => (
                <li key={`${issue.path}:${issue.code}:${issue.message}`}>{issue.message}</li>
              ))}
            </ul>
          </div>
        )}
        {detail.pendingChanges && detail.pendingChanges.length > 0 && (
          <>
            <h3>已保存草稿相对 v{detail.currentPublishedVersion} 的改动</h3>
            <ul className="changes">
              {detail.pendingChanges.map((c) => (
                <li key={`${c.kind}:${'path' in c ? c.path : c.to}`}>{describeChange(c)}</li>
              ))}
            </ul>
          </>
        )}
      </section>

      <VersionHistory formId={detail.formId} versions={detail.versions} />
    </>
  );
}

function AddFieldMenu({
  onAdd,
  canNest,
}: {
  onAdd: (type: FieldType, asChild: boolean) => void;
  canNest: boolean;
}) {
  const [asChild, setAsChild] = useState(false);
  return (
    <div className="add-field">
      <select
        value=""
        onChange={(e) => {
          if (e.target.value) onAdd(e.target.value as FieldType, asChild && canNest); // 选项来自 TYPE_LABELS 的键
        }}
      >
        <option value="">+ 添加字段…</option>
        {Object.entries(TYPE_LABELS).map(([type, label]) => (
          <option key={type} value={type}>
            {label}
          </option>
        ))}
      </select>
      {canNest && (
        <label className="checkbox">
          <input type="checkbox" checked={asChild} onChange={(e) => setAsChild(e.target.checked)} />
          作为选中分组的子字段
        </label>
      )}
    </div>
  );
}

function Preview({ schema }: { schema: FormSchema }) {
  const [status, actions] = useFormState(schema, { onSubmit: async () => undefined });
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void actions.submit();
      }}
    >
      <FormRenderer schema={schema} status={status} actions={actions} />
      {status.formErrors.map((m) => (
        <p key={m} className="form-error">
          {m}
        </p>
      ))}
      <button type="submit" className="secondary">
        试填校验
      </button>
    </form>
  );
}

function JsonEditor({
  draft,
  onApply,
}: {
  draft: FormSchema;
  onApply: (schema: FormSchema) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(draft, null, 2));
  const [errors, setErrors] = useState<string[]>([]);
  const apply = () => {
    try {
      const parsed: unknown = JSON.parse(text);
      const shape = checkSchemaShape(parsed);
      if (shape.length > 0 || !isFormSchema(parsed)) {
        setErrors(shape.map((e) => e.message));
        return;
      }
      setErrors([]);
      onApply(parsed);
    } catch (err) {
      setErrors([`JSON 格式错误：${err instanceof Error ? err.message : String(err)}`]);
    }
  };
  return (
    <div className="json-editor">
      <textarea
        rows={18}
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {errors.map((e) => (
        <p key={e} className="field-error">
          {e}
        </p>
      ))}
      <button type="button" className="secondary" onClick={apply}>
        应用到草稿
      </button>
    </div>
  );
}

function VersionHistory({ formId, versions }: { formId: string; versions: Version[] }) {
  return (
    <section className="card">
      <h2>版本历史（已发布版本不可修改）</h2>
      <table className="table">
        <thead>
          <tr>
            <th>版本</th>
            <th>发布人 / 时间</th>
            <th>说明与改动</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.version}>
              <td>v{v.version}</td>
              <td>
                {v.publishedBy ?? '—'}
                <div className="muted small">{new Date(v.publishedAt).toLocaleString()}</div>
              </td>
              <td>
                {v.changeNote && <div>{v.changeNote}</div>}
                <ul className="changes">
                  {v.changes.map((c) => (
                    <li key={`${c.kind}:${'path' in c ? c.path : c.to}`}>{describeChange(c)}</li>
                  ))}
                </ul>
              </td>
              <td>
                <a
                  href={`/api/v1/forms/${formId}/versions/${v.version}/json-schema`}
                  target="_blank"
                  rel="noreferrer"
                >
                  JSON Schema
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function describeChange(change: SchemaChange): string {
  switch (change.kind) {
    case 'added':
      return `新增字段「${change.label}」（${change.path}）`;
    case 'removed':
      return `删除字段「${change.label}」（${change.path}）`;
    case 'renamed':
      return `字段「${change.label}」改名：${change.from} → ${change.to}`;
    case 'deprecated':
      return `废弃字段「${change.label}」（${change.path}）`;
    case 'restored':
      return `恢复字段「${change.label}」（${change.path}）`;
    case 'modified':
      return `修改「${change.label}」的设置（${change.path}）`;
    default: {
      const unreachable: never = change;
      return String(unreachable);
    }
  }
}
