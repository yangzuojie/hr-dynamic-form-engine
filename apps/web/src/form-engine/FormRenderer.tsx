import type { Field, FieldState, FormSchema, RepeaterField } from '@hr/schema-core';
import { createContext, useContext, useMemo } from 'react';
import { InputControl, SelectControl, UploadControl } from './controls';
import { getIn, joinPath } from './paths';
import type { FormActions, FormStatus } from './use-form-state';

// 场景一 Q1：根据 Schema 自动渲染表单控件。
// 容器（object / repeater）每次都会重渲染，叶子控件用 memo 包裹、只接收原始值，
// 所以修改一个输入框时，其他字段的控件不会重渲染。

type EngineContext = {
  actions: FormActions;
  formId: string;
  readOnly: boolean;
  /** 后台查看时点击已上传文件，换取签名链接后打开。 */
  onOpenFile?: ((fileId: string) => void) | undefined;
};

const Engine = createContext<EngineContext | null>(null);

export function useEngine(): EngineContext {
  const value = useContext(Engine);
  if (!value) throw new Error('useEngine 必须在 FormRenderer 内使用');
  return value;
}

type RendererProps = {
  schema: FormSchema;
  status: FormStatus;
  actions: FormActions;
  readOnly?: boolean;
  onOpenFile?: (fileId: string) => void;
};

export function FormRenderer({
  schema,
  status,
  actions,
  readOnly = false,
  onOpenFile,
}: RendererProps) {
  // Context 的值必须稳定，否则每次输入都会让所有用 useEngine 的叶子控件重渲染，memo 就失效了。
  const engine = useMemo(
    () => ({ actions, formId: schema.formId, readOnly, onOpenFile }),
    [actions, schema.formId, readOnly, onOpenFile],
  );
  return (
    <Engine.Provider value={engine}>
      <div className="form-fields">
        <FieldList fields={schema.fields} prefix="" status={status} />
      </div>
      {status.messages.map((m) => (
        <div key={`${m.scope}:${m.ruleId}`} className={`notice notice-${m.level}`} role="status">
          {m.text}
        </div>
      ))}
    </Engine.Provider>
  );
}

function FieldList({
  fields,
  prefix,
  status,
}: {
  fields: Field[];
  prefix: string;
  status: FormStatus;
}) {
  return fields.map((field) => {
    if (field.deprecated) return null;
    const path = joinPath(prefix, field.key);
    const state = status.fieldStates[path];
    if (state && !state.visible) return null;
    return (
      <FieldView key={field.fieldId} field={field} path={path} status={status} state={state} />
    );
  });
}

type FieldViewProps = {
  field: Field;
  path: string;
  status: FormStatus;
  state: FieldState | undefined;
};

function FieldView({ field, path, status, state }: FieldViewProps) {
  const required = state?.required ?? field.required === true;
  const error = status.fieldErrors[path];
  const value = getIn(status.display, path);
  switch (field.type) {
    case 'input':
      return (
        <InputControl field={field} path={path} value={value} error={error} required={required} />
      );
    case 'select':
      return (
        <SelectControl field={field} path={path} value={value} error={error} required={required} />
      );
    case 'upload':
      return (
        <UploadControl field={field} path={path} value={value} error={error} required={required} />
      );
    case 'object':
      return (
        <fieldset className="group">
          <legend>{field.label}</legend>
          {field.description && <p className="hint">{field.description}</p>}
          <FieldList fields={field.fields} prefix={path} status={status} />
        </fieldset>
      );
    case 'repeater':
      return <RepeaterView field={field} path={path} status={status} error={error} rows={value} />;
    default: {
      const unreachable: never = field;
      return unreachable;
    }
  }
}

type RepeaterProps = {
  field: RepeaterField;
  path: string;
  status: FormStatus;
  error: string | undefined;
  rows: unknown;
};

function RepeaterView({ field, path, status, error, rows }: RepeaterProps) {
  const { actions, readOnly } = useEngine();
  const list = Array.isArray(rows) ? rows : [];
  const full = field.maxItems !== undefined && list.length >= field.maxItems;
  return (
    <fieldset className="group repeater">
      <legend>
        {field.label}
        {field.required && <span className="required">*</span>}
      </legend>
      {list.length === 0 && <p className="hint">暂无记录</p>}
      {list.map((_, index) => (
        // 行没有稳定 ID，下标就是它在数据里的身份；删除行时后续行整体前移是预期行为。
        // biome-ignore lint/suspicious/noArrayIndexKey: 行数据本身没有唯一标识，用下标与数据路径保持一致
        <div key={index} className="repeater-row">
          <div className="repeater-row-head">
            <span>第 {index + 1} 项</span>
            {!readOnly && (
              <button
                type="button"
                className="link danger"
                onClick={() => actions.removeRow(path, index)}
              >
                删除
              </button>
            )}
          </div>
          <FieldList fields={field.fields} prefix={`${path}[${index}]`} status={status} />
        </div>
      ))}
      {!readOnly && (
        <button
          type="button"
          className="secondary"
          disabled={full}
          onClick={() => actions.addRow(path, field)}
        >
          + 添加{field.label}
          {full && `（最多 ${field.maxItems} 项）`}
        </button>
      )}
      {error && <p className="field-error">{error}</p>}
    </fieldset>
  );
}
