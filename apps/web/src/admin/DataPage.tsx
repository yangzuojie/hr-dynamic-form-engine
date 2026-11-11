import type { FormData, FormSchema } from '@hr/schema-core';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api } from '../api';
import { getIn } from '../form-engine/paths';
import { loadPublishedSchema, type ScalarField, scalarFields } from './form-meta';
import { Pager } from './Pager';
import { useLoad } from './use-load';

// 场景二 Q1：按 JSON 字段动态筛选、排序、分页。筛选条件就是通用查询接口的 querystring，可直接复制给其他系统用。

type Item = {
  id: string;
  schemaVersion: number;
  viewVersion: number;
  data: FormData;
  missingFields: string[];
  createdAt: string;
  updatedBy: string | null;
};
type ListResult = {
  items: Item[];
  total: number;
  page: number;
  pageSize: number;
  latestVersion: number;
};

const OPS = [
  ['eq', '等于'],
  ['ne', '不等于'],
  ['gt', '大于'],
  ['gte', '大于等于'],
  ['lt', '小于'],
  ['lte', '小于等于'],
  ['in', '属于（逗号分隔）'],
  ['contains', '包含'],
  ['empty', '为空（true/false）'],
] as const;

export function DataPage() {
  const { formId = '' } = useParams();
  const schema = useLoad(`schema:${formId}`, () => loadPublishedSchema(formId));
  if (schema.error) return <p className="form-error">{schema.error}</p>;
  if (!schema.data) return <p className="page-loading">加载中…</p>;
  return <DataTable schema={schema.data} />;
}

function DataTable({ schema }: { schema: FormSchema }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const fields = useMemo(() => scalarFields(schema.fields), [schema]);
  const columns = useMemo(() => fields.filter((f) => !f.field.deprecated).slice(0, 6), [fields]);
  const query = params.toString();
  const list = useLoad(
    query,
    async () => (await api.get<ListResult>(`/api/v1/dynamic-data/${schema.formId}?${query}`)).data,
  );
  const view = params.get('view') === 'latest' ? 'latest' : 'raw';

  const update = (mutate: (p: URLSearchParams) => void) => {
    const next = new URLSearchParams(params);
    mutate(next);
    setParams(next);
  };

  return (
    <>
      <div className="page-head">
        <h1>
          {schema.title} <span className="muted small">当前 v{schema.version}</span>
        </h1>
        <div className="actions">
          <Link to={`/admin/forms/${schema.formId}/builder`}>配置表单</Link>
        </div>
      </div>

      <FilterBar
        fields={fields}
        params={params}
        onApply={(filters) => update((p) => applyFilters(p, filters))}
      />

      <div className="toolbar">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={view === 'latest'}
            onChange={(e) =>
              update((p) => (e.target.checked ? p.set('view', 'latest') : p.delete('view')))
            }
          />
          按最新版本 v{schema.version} 的字段名显示历史数据（场景一 Q2：按 fieldId
          懒映射，不改历史数据）
        </label>
        <code className="muted small">
          GET /api/v1/dynamic-data/{schema.formId}?{query}
        </code>
      </div>

      {list.error && <p className="form-error">{list.error}</p>}
      <table className="table clickable">
        <thead>
          <tr>
            <th>采集版本</th>
            {columns.map((c) => (
              <SortHeader
                key={c.path}
                column={c}
                params={params}
                onSort={(s) => update((p) => p.set('sort', s))}
              />
            ))}
            <th>提交时间</th>
          </tr>
        </thead>
        <tbody>
          {list.data?.items.map((item) => (
            <tr
              key={item.id}
              onClick={() => navigate(`/admin/forms/${schema.formId}/data/${item.id}`)}
            >
              <td>
                v{item.schemaVersion}
                {item.viewVersion !== item.schemaVersion && (
                  <span className="badge">显示为 v{item.viewVersion}</span>
                )}
              </td>
              {columns.map((c) => (
                <td key={c.path}>{renderCell(item, c)}</td>
              ))}
              <td className="nowrap">{new Date(item.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.loading && <p className="hint">加载中…</p>}
      {list.data && (
        <Pager
          page={list.data.page}
          pageSize={list.data.pageSize}
          total={list.data.total}
          onChange={(page) => update((p) => p.set('page', String(page)))}
        />
      )}
    </>
  );
}

function renderCell(item: Item, column: ScalarField): string {
  if (item.missingFields.includes(column.path)) return '（历史版本未采集）';
  const value = getIn(item.data, column.path);
  if (value === undefined || value === null || value === '') return '';
  if (column.field.type === 'select') {
    return column.field.options.find((o) => o.value === value)?.label ?? String(value);
  }
  return String(value);
}

function SortHeader({
  column,
  params,
  onSort,
}: {
  column: ScalarField;
  params: URLSearchParams;
  onSort: (sort: string) => void;
}) {
  const sort = params.get('sort');
  const mark = sort === column.path ? ' ↑' : sort === `-${column.path}` ? ' ↓' : '';
  return (
    <th>
      <button
        type="button"
        className="link"
        onClick={() => onSort(sort === `-${column.path}` ? column.path : `-${column.path}`)}
      >
        {column.label}
        {mark}
      </button>
    </th>
  );
}

type FilterRow = { path: string; op: string; value: string };

function readFilters(params: URLSearchParams): FilterRow[] {
  const rows: FilterRow[] = [];
  for (const [key, value] of params) {
    const match = /^filter\[([^\]]+)\]\[([a-z]+)\]$/.exec(key);
    if (match?.[1] && match[2]) rows.push({ path: match[1], op: match[2], value });
  }
  return rows;
}

function applyFilters(params: URLSearchParams, rows: FilterRow[]): void {
  for (const key of [...params.keys()]) if (key.startsWith('filter[')) params.delete(key);
  for (const row of rows)
    if (row.path && row.value !== '') params.set(`filter[${row.path}][${row.op}]`, row.value);
  params.delete('page');
}

function FilterBar({
  fields,
  params,
  onApply,
}: {
  fields: ScalarField[];
  params: URLSearchParams;
  onApply: (rows: FilterRow[]) => void;
}) {
  const [rows, setRows] = useState<FilterRow[]>(() => {
    const existing = readFilters(params);
    return existing.length ? existing : [{ path: '', op: 'eq', value: '' }];
  });
  const set = (index: number, patch: Partial<FilterRow>) =>
    setRows((r) => r.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <form
      className="card filter-bar"
      onSubmit={(e) => {
        e.preventDefault();
        onApply(rows);
      }}
    >
      {rows.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 筛选行没有 ID，按位置编辑
        <div key={index} className="filter-row">
          <select value={row.path} onChange={(e) => set(index, { path: e.target.value })}>
            <option value="">选择字段</option>
            {fields.map((f) => (
              <option key={f.path} value={f.path}>
                {f.label}
              </option>
            ))}
          </select>
          <select value={row.op} onChange={(e) => set(index, { op: e.target.value })}>
            {OPS.map(([op, label]) => (
              <option key={op} value={op}>
                {label}
              </option>
            ))}
          </select>
          <input
            value={row.value}
            placeholder="值"
            onChange={(e) => set(index, { value: e.target.value })}
          />
          <button
            type="button"
            className="link danger"
            onClick={() => setRows((r) => r.filter((_, i) => i !== index))}
          >
            移除
          </button>
        </div>
      ))}
      <div className="actions">
        <button
          type="button"
          className="secondary"
          onClick={() => setRows((r) => [...r, { path: '', op: 'eq', value: '' }])}
        >
          + 条件
        </button>
        <button type="submit" className="primary">
          查询
        </button>
        <button
          type="button"
          className="link"
          onClick={() => {
            setRows([{ path: 'experience', op: 'gt', value: '3' }]);
            onApply([{ path: 'experience', op: 'gt', value: '3' }]);
          }}
        >
          示例：工作年限 &gt; 3
        </button>
      </div>
    </form>
  );
}
