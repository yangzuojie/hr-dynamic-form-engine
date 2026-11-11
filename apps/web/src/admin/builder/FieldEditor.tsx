import type { Field, InputKind, SelectOption, ValidationRule } from '@hr/schema-core';
import { useState } from 'react';
import { TYPE_LABELS } from './schema-edit';

// 单个字段的属性编辑。已发布过的字段：不能改类型、不能删除，只能废弃（与后端发布检查一致）。

type EditorProps = {
  field: Field;
  published: boolean;
  onChange: (field: Field) => void;
  onRemove: () => void;
  onMove: (delta: -1 | 1) => void;
};

const INPUT_KINDS: Record<InputKind, string> = {
  text: '单行文本',
  textarea: '多行文本',
  number: '数字',
  email: '邮箱',
  url: '链接',
  date: '日期',
};

export function FieldEditor({ field, published, onChange, onRemove, onMove }: EditorProps) {
  const set = <K extends keyof Field>(key: K, value: Field[K] | undefined): void => {
    const next = { ...field } as Record<string, unknown>; // 动态键更新，类型由调用处的 K 约束
    if (value === undefined || value === false || value === '') delete next[key];
    else next[key] = value;
    onChange(next as Field); // 只改了 Field 已有的键，结构不变
  };

  return (
    <div className="field-editor">
      <div className="editor-head">
        <strong>{TYPE_LABELS[field.type]}</strong>
        <span className="muted small">fieldId：{field.fieldId}（永不改变，用于版本间对应）</span>
      </div>
      <div className="grid-2">
        <TextProp
          label="标签"
          value={field.label}
          onChange={(v) => onChange({ ...field, label: v })}
        />
        <TextProp
          label="key（数据键名）"
          value={field.key}
          onChange={(v) => onChange({ ...field, key: v })}
          hint={published ? '改名后，历史数据会按 fieldId 自动对应到新名字' : undefined}
        />
      </div>
      <TextProp
        label="说明"
        value={field.description ?? ''}
        onChange={(v) => set('description', v)}
      />
      <div className="checks">
        <Check
          label="必填"
          checked={field.required === true}
          onChange={(v) => set('required', v)}
        />
        <Check
          label="默认隐藏（由联动显示）"
          checked={field.hidden === true}
          onChange={(v) => set('hidden', v)}
        />
        <Check
          label="敏感字段（审计脱敏）"
          checked={field.sensitive === true}
          onChange={(v) => set('sensitive', v)}
        />
        <Check
          label="已废弃"
          checked={field.deprecated === true}
          onChange={(v) => set('deprecated', v)}
        />
      </div>
      <TypeProps field={field} onChange={onChange} />
      {field.type === 'input' && (
        <RulesEditor
          rules={field.rules ?? []}
          onChange={(rules) => set('rules', rules.length ? rules : undefined)}
        />
      )}
      <div className="editor-actions">
        <button type="button" className="secondary" onClick={() => onMove(-1)}>
          上移
        </button>
        <button type="button" className="secondary" onClick={() => onMove(1)}>
          下移
        </button>
        {published ? (
          <span className="muted small">
            已发布过的字段不能删除，请勾选“已废弃”，历史数据会保留。
          </span>
        ) : (
          <button type="button" className="danger" onClick={onRemove}>
            删除字段
          </button>
        )}
      </div>
    </div>
  );
}

function TypeProps({ field, onChange }: { field: Field; onChange: (field: Field) => void }) {
  switch (field.type) {
    case 'input':
      return (
        <label className="field">
          输入类型
          <select
            value={field.inputKind ?? 'text'}
            onChange={(e) => {
              const kind = e.target.value as InputKind; // 选项来自 INPUT_KINDS 的键
              onChange({ ...field, inputKind: kind });
            }}
          >
            {Object.entries(INPUT_KINDS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      );
    case 'select':
      return (
        <OptionsEditor
          // 切换到另一个字段时重建组件，文本框内容随之重置，不需要用 effect 同步 props。
          key={field.fieldId}
          options={field.options}
          onChange={(options) => onChange({ ...field, options })}
        />
      );
    case 'upload':
      return (
        <div className="grid-2">
          <TextProp
            label="允许的 MIME 类型（逗号分隔）"
            value={field.accept.join(',')}
            onChange={(v) =>
              onChange({
                ...field,
                accept: v
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
          <TextProp
            label="单个文件上限（MB）"
            value={String(field.maxSizeMb)}
            onChange={(v) => onChange({ ...field, maxSizeMb: Number(v) || 0 })}
          />
        </div>
      );
    case 'object':
    case 'repeater':
      return <p className="hint">子字段在左侧列表中选中后编辑；用“添加子字段”往这里加字段。</p>;
    default: {
      const unreachable: never = field;
      return unreachable;
    }
  }
}

const optionsToText = (list: SelectOption[]): string =>
  list.map((o) => `${o.label}=${String(o.value)}`).join('\n');

/** 每行一个选项：“显示文字=值”。值写 true/false 或数字时按对应类型保存。 */
function OptionsEditor({
  options,
  onChange,
}: {
  options: SelectOption[];
  onChange: (options: SelectOption[]) => void;
}) {
  const [text, setText] = useState(() => optionsToText(options));
  const parse = (raw: string): SelectOption[] =>
    raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [label = '', value = label] = line.split('=').map((s) => s.trim());
        const typed =
          value === 'true'
            ? true
            : value === 'false'
              ? false
              : /^-?\d+(\.\d+)?$/.test(value)
                ? Number(value)
                : value;
        return { label, value: typed };
      });
  return (
    <label className="field">
      选项（每行一个，“显示文字=值”）
      <textarea
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onChange(parse(text))}
      />
    </label>
  );
}

const RULE_LABELS: Record<ValidationRule['type'], string> = {
  regex: '正则',
  email: '邮箱格式',
  min: '最小值',
  max: '最大值',
  minLength: '最少字数',
  maxLength: '最多字数',
};

function RulesEditor({
  rules,
  onChange,
}: {
  rules: ValidationRule[];
  onChange: (rules: ValidationRule[]) => void;
}) {
  const update = (index: number, rule: ValidationRule) =>
    onChange(rules.map((r, i) => (i === index ? rule : r)));
  return (
    <div className="rules">
      <div className="muted small">校验规则</div>
      {rules.map((rule, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 规则没有 ID，按位置编辑
        <div key={index} className="rule-row">
          <span>{RULE_LABELS[rule.type]}</span>
          {rule.type === 'regex' ? (
            <input
              value={rule.pattern}
              onChange={(e) => update(index, { ...rule, pattern: e.target.value })}
            />
          ) : rule.type === 'email' ? (
            <span className="muted">—</span>
          ) : (
            <input
              type="number"
              value={rule.value}
              onChange={(e) => update(index, { ...rule, value: Number(e.target.value) })}
            />
          )}
          <input
            placeholder="自定义提示（可选）"
            value={rule.message ?? ''}
            onChange={(e) => update(index, { ...rule, message: e.target.value })}
          />
          <button
            type="button"
            className="link danger"
            onClick={() => onChange(rules.filter((_, i) => i !== index))}
          >
            删除
          </button>
        </div>
      ))}
      <select
        value=""
        onChange={(e) => {
          const type = e.target.value;
          const rule: ValidationRule | undefined =
            type === 'regex'
              ? { type: 'regex', pattern: '.*' }
              : type === 'email'
                ? { type: 'email' }
                : type === 'min' || type === 'max' || type === 'minLength' || type === 'maxLength'
                  ? { type, value: 0 }
                  : undefined;
          if (rule) onChange([...rules, rule]);
        }}
      >
        <option value="">+ 添加校验规则</option>
        {Object.entries(RULE_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}

function TextProp(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string | undefined;
}) {
  return (
    <label className="field">
      {props.label}
      <input value={props.value} onChange={(e) => props.onChange(e.target.value)} />
      {props.hint && <span className="hint">{props.hint}</span>}
    </label>
  );
}

function Check(props: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="checkbox">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      {props.label}
    </label>
  );
}
