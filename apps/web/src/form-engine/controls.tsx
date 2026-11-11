import type { FileRef, InputField, SelectField, UploadField } from '@hr/schema-core';
import { type ChangeEvent, memo, type ReactNode, useId, useState } from 'react';
import { ApiError, api } from '../api';
import { useEngine } from './FormRenderer';
import { stripIndexes } from './paths';

// 叶子控件：只接收原始值类型的 props，配合 memo，只有自身数据变化时才重渲染。

type ControlProps<F> = {
  field: F;
  path: string;
  value: unknown;
  error: string | undefined;
  required: boolean;
};

function FieldShell(props: {
  id: string;
  label: string;
  required: boolean;
  description?: string | undefined;
  error: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className={`field${props.error ? ' has-error' : ''}`}>
      <label htmlFor={props.id}>
        {props.label}
        {props.required && <span className="required">*</span>}
      </label>
      {props.children}
      {props.description && <p className="hint">{props.description}</p>}
      {props.error && (
        <p className="field-error" id={`${props.id}-error`} role="alert">
          {props.error}
        </p>
      )}
    </div>
  );
}

const HTML_TYPES = {
  text: 'text',
  textarea: 'text',
  number: 'number',
  email: 'email',
  url: 'url',
  date: 'date',
} as const;

export const InputControl = memo(function InputControl({
  field,
  path,
  value,
  error,
  required,
}: ControlProps<InputField>) {
  const { actions, readOnly } = useEngine();
  const id = useId();
  const kind = field.inputKind ?? 'text';
  const text = value === undefined || value === null ? '' : String(value);
  const onChange = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const raw = event.target.value;
    if (kind !== 'number') return actions.setField(path, raw);
    // 数字框：清空时存 undefined（触发必填校验），否则存数字；非法输入交给浏览器的数字框处理。
    return actions.setField(path, raw === '' ? undefined : Number(raw));
  };
  const common = {
    id,
    value: text,
    onChange,
    onBlur: () => actions.touch(path),
    disabled: readOnly,
    placeholder: field.placeholder,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? `${id}-error` : undefined,
  };
  return (
    <FieldShell
      id={id}
      label={field.label}
      required={required}
      description={field.description}
      error={error}
    >
      {kind === 'textarea' ? (
        <textarea rows={3} {...common} />
      ) : (
        <input type={HTML_TYPES[kind]} {...common} />
      )}
    </FieldShell>
  );
});

export const SelectControl = memo(function SelectControl({
  field,
  path,
  value,
  error,
  required,
}: ControlProps<SelectField>) {
  const { actions, readOnly } = useEngine();
  const id = useId();

  if (field.multiple) {
    const selected = Array.isArray(value) ? value : [];
    const toggle = (optionValue: unknown) =>
      actions.setField(
        path,
        selected.includes(optionValue)
          ? selected.filter((v) => v !== optionValue)
          : [...selected, optionValue],
      );
    return (
      <FieldShell
        id={id}
        label={field.label}
        required={required}
        description={field.description}
        error={error}
      >
        <div className="checkbox-group" id={id}>
          {field.options.map((option) => (
            <label key={String(option.value)} className="checkbox">
              <input
                type="checkbox"
                checked={selected.includes(option.value)}
                disabled={readOnly}
                onChange={() => toggle(option.value)}
              />
              {option.label}
            </label>
          ))}
        </div>
      </FieldShell>
    );
  }

  // 选项值可能是布尔或数字，<select> 只能存字符串，所以用下标作为 option 的 value。
  const index = field.options.findIndex((o) => o.value === value);
  return (
    <FieldShell
      id={id}
      label={field.label}
      required={required}
      description={field.description}
      error={error}
    >
      <select
        id={id}
        value={index}
        disabled={readOnly}
        onBlur={() => actions.touch(path)}
        onChange={(e) => {
          const chosen = field.options[Number(e.target.value)];
          actions.setField(path, chosen?.value);
        }}
        aria-invalid={error ? true : undefined}
      >
        <option value={-1}>请选择</option>
        {field.options.map((option, i) => (
          <option key={String(option.value)} value={i}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
});

function isFileRef(value: unknown): value is FileRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    'fileId' in value &&
    typeof value.fileId === 'string'
  );
}

export const UploadControl = memo(function UploadControl({
  field,
  path,
  value,
  error,
  required,
}: ControlProps<UploadField>) {
  const { actions, formId, readOnly, onOpenFile } = useEngine();
  const id = useId();
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | undefined>();
  const files = Array.isArray(value) ? value.filter(isFileRef) : [];
  const maxFiles = field.maxFiles ?? 1;

  const onPick = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    event.target.value = '';
    if (!picked) return;
    if (picked.size > field.maxSizeMb * 1024 * 1024) {
      setUploadError(`文件不能超过 ${field.maxSizeMb}MB`);
      return;
    }
    setUploading(true);
    setUploadError(undefined);
    try {
      const url = `/api/v1/files?formId=${encodeURIComponent(formId)}&field=${encodeURIComponent(stripIndexes(path))}`;
      const { data } = await api.upload<FileRef>(url, picked);
      actions.setField(path, [...files, data]);
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : '上传失败，请重试');
    } finally {
      setUploading(false);
    }
  };

  return (
    <FieldShell
      id={id}
      label={field.label}
      required={required}
      description={
        field.description ?? `支持 ${field.accept.join('、')}，单个不超过 ${field.maxSizeMb}MB`
      }
      error={error ?? uploadError}
    >
      <ul className="file-list">
        {files.map((file) => (
          <li key={file.fileId}>
            {onOpenFile ? (
              <button type="button" className="link" onClick={() => onOpenFile(file.fileId)}>
                {file.name}
              </button>
            ) : (
              <span>{file.name}</span>
            )}
            <span className="muted">（{Math.ceil(file.size / 1024)} KB）</span>
            {!readOnly && (
              <button
                type="button"
                className="link danger"
                onClick={() =>
                  actions.setField(
                    path,
                    files.filter((f) => f.fileId !== file.fileId),
                  )
                }
              >
                移除
              </button>
            )}
          </li>
        ))}
      </ul>
      {!readOnly && files.length < maxFiles && (
        <input
          id={id}
          type="file"
          accept={field.accept.join(',')}
          disabled={uploading}
          onChange={onPick}
        />
      )}
      {uploading && <p className="hint">正在上传…</p>}
    </FieldShell>
  );
});
