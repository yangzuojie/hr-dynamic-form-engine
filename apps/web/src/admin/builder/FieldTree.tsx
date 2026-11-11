import type { Field } from '@hr/schema-core';
import { hasChildren, type IndexPath, TYPE_LABELS } from './schema-edit';

type TreeProps = {
  fields: Field[];
  selected: IndexPath | undefined;
  onSelect: (path: IndexPath) => void;
  prefix?: IndexPath;
};

const samePath = (a: IndexPath | undefined, b: IndexPath): boolean =>
  a !== undefined && a.length === b.length && a.every((v, i) => v === b[i]);

export function FieldTree({ fields, selected, onSelect, prefix = [] }: TreeProps) {
  return (
    <ul className="field-tree">
      {fields.map((field, index) => {
        const path = [...prefix, index];
        return (
          <li key={field.fieldId}>
            <button
              type="button"
              className={`tree-item${samePath(selected, path) ? ' selected' : ''}${field.deprecated ? ' deprecated' : ''}`}
              onClick={() => onSelect(path)}
            >
              <span>
                {field.label}
                {field.required && <span className="required">*</span>}
              </span>
              <span className="muted small">
                {field.key} · {TYPE_LABELS[field.type]}
                {field.deprecated && ' · 已废弃'}
                {field.hidden && ' · 默认隐藏'}
              </span>
            </button>
            {hasChildren(field) && field.fields.length > 0 && (
              <FieldTree
                fields={field.fields}
                selected={selected}
                onSelect={onSelect}
                prefix={path}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
