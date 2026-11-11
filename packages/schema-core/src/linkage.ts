import { getAt, isEmptyValue, isPlainObject, joinPath, setAt } from './path';
import type {
  Condition,
  Effect,
  Field,
  FieldError,
  FieldPath,
  FormData,
  FormSchema,
  LinkageRule,
} from './types';

// 场景一 Q1 进阶 + 场景二 Q2：字段联动引擎。
// 只有 setValue 会改数据，show/hide/require/unrequire 是“由当前数据推导出的状态”，
// 所以每次都从数据重新计算，不会累积副作用。循环只可能由 setValue 链造成，分两层防护：
//   1. 发布时 detectLinkageCycles 静态检查依赖图，有环拒绝发布；
//   2. 运行时同一轮求值里每个字段最多被 setValue 改一次，超过迭代上限即停止并报表单级错误。

export type FieldState = { visible: boolean; required: boolean };

export type LinkageMessage = {
  ruleId: string;
  /** 规则所在作用域的数据路径，根作用域为空字符串，repeater 行为 "workHistory[0]"。 */
  scope: string;
  text: string;
  level: 'info' | 'warning';
};

export type LinkageResult = {
  data: FormData;
  /** 键是具体数据路径，如 "previousCompany"、"workHistory[1].company"。 */
  fieldStates: Record<string, FieldState>;
  messages: LinkageMessage[];
  errors: FieldError[];
};

export function evaluateCondition(condition: Condition, scope: FormData): boolean {
  if ('and' in condition) return condition.and.every((c) => evaluateCondition(c, scope));
  if ('or' in condition) return condition.or.some((c) => evaluateCondition(c, scope));
  if ('not' in condition) return !evaluateCondition(condition.not, scope);
  if ('empty' in condition) return isEmptyValue(getAt(scope, condition.empty));
  if ('in' in condition) {
    const [path, list] = condition.in;
    const value = getAt(scope, path);
    return list.some((item) => item === value);
  }
  if ('eq' in condition) return getAt(scope, condition.eq[0]) === condition.eq[1];
  if ('ne' in condition) return getAt(scope, condition.ne[0]) !== condition.ne[1];
  const [op, [path, target]] = numericOperands(condition);
  const value = toNumber(getAt(scope, path));
  if (value === undefined) return false;
  switch (op) {
    case 'gt':
      return value > target;
    case 'gte':
      return value >= target;
    case 'lt':
      return value < target;
    case 'lte':
      return value <= target;
    default: {
      const unreachable: never = op;
      throw new Error(`未知操作符：${String(unreachable)}`);
    }
  }
}

type NumericOp = 'gt' | 'gte' | 'lt' | 'lte';
type NumericCondition =
  | { gt: [FieldPath, number] }
  | { gte: [FieldPath, number] }
  | { lt: [FieldPath, number] }
  | { lte: [FieldPath, number] };

function numericOperands(condition: NumericCondition): [NumericOp, [FieldPath, number]] {
  if ('gt' in condition) return ['gt', condition.gt];
  if ('gte' in condition) return ['gte', condition.gte];
  if ('lt' in condition) return ['lt', condition.lt];
  return ['lte', condition.lte];
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** 条件读取了哪些字段（用于依赖图）。 */
export function conditionReads(condition: Condition): FieldPath[] {
  if ('and' in condition) return condition.and.flatMap(conditionReads);
  if ('or' in condition) return condition.or.flatMap(conditionReads);
  if ('not' in condition) return conditionReads(condition.not);
  if ('empty' in condition) return [condition.empty];
  if ('in' in condition) return [condition.in[0]];
  if ('eq' in condition) return [condition.eq[0]];
  if ('ne' in condition) return [condition.ne[0]];
  return [numericOperands(condition)[1][0]];
}

/** 效果作用于哪个字段（message 没有目标字段）。 */
export function effectTarget(effect: Effect): FieldPath | undefined {
  if ('show' in effect) return effect.show;
  if ('hide' in effect) return effect.hide;
  if ('require' in effect) return effect.require;
  if ('unrequire' in effect) return effect.unrequire;
  if ('setValue' in effect) return effect.setValue.field;
  return undefined;
}

export function evaluateLinkage(schema: FormSchema, data: FormData): LinkageResult {
  const result: LinkageResult = { data, fieldStates: {}, messages: [], errors: [] };
  result.data = evaluateScope(schema.fields, schema.linkage ?? [], data, '', true, result);
  return result;
}

type Overrides = Map<FieldPath, Partial<FieldState>>;

function evaluateScope(
  fields: Field[],
  rules: LinkageRule[],
  input: FormData,
  scopePath: string,
  parentVisible: boolean,
  result: LinkageResult,
): FormData {
  const data = runSetValues(rules, input, scopePath, result);
  const overrides: Overrides = new Map();
  for (const rule of rules) {
    if (!evaluateCondition(rule.when, data)) continue;
    for (const effect of rule.actions) applyStateEffect(effect, rule, scopePath, overrides, result);
  }
  return walkFields(fields, data, '', scopePath, parentVisible, overrides, result);
}

/** 反复执行 setValue 直到稳定；同一字段在一轮求值中只允许被写一次。 */
function runSetValues(
  rules: LinkageRule[],
  input: FormData,
  scopePath: string,
  result: LinkageResult,
): FormData {
  const setters = rules.filter((r) => r.actions.some((e) => 'setValue' in e));
  if (setters.length === 0) return input;

  const pass: SetterPass = { data: input, written: new Map(), changed: false, cycle: false };
  const maxIterations = setters.length + 1;
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    pass.changed = false;
    for (const rule of setters) {
      if (evaluateCondition(rule.when, pass.data)) applySetters(rule, pass, scopePath, result);
      if (pass.cycle) return pass.data;
    }
    if (!pass.changed) return pass.data;
  }
  result.errors.push({
    path: '',
    code: 'linkage_cycle',
    message: '联动规则超过最大迭代次数仍未稳定，已停止计算',
  });
  return pass.data;
}

type SetterPass = {
  data: FormData;
  /** 字段 → 第一次写它的规则 ID。 */
  written: Map<FieldPath, string>;
  changed: boolean;
  cycle: boolean;
};

function applySetters(
  rule: LinkageRule,
  pass: SetterPass,
  scopePath: string,
  result: LinkageResult,
): void {
  for (const effect of rule.actions) {
    if (!('setValue' in effect)) continue;
    const { field, value } = effect.setValue;
    if (Object.is(getAt(pass.data, field), value)) continue;
    const previousRule = pass.written.get(field);
    if (previousRule !== undefined) {
      result.errors.push({
        path: '',
        code: 'linkage_cycle',
        message: `联动规则出现循环：字段 ${joinScope(scopePath, field)} 在同一次计算中被规则 ${previousRule} 和 ${rule.id} 反复修改，已停止计算`,
      });
      pass.cycle = true;
      return;
    }
    pass.written.set(field, rule.id);
    pass.data = setAt(pass.data, field, value);
    pass.changed = true;
  }
}

function applyStateEffect(
  effect: Effect,
  rule: LinkageRule,
  scopePath: string,
  overrides: Overrides,
  result: LinkageResult,
): void {
  if ('message' in effect) {
    result.messages.push({
      ruleId: rule.id,
      scope: scopePath,
      text: effect.message.text,
      level: effect.message.level ?? 'info',
    });
    return;
  }
  const patch: [FieldPath, Partial<FieldState>] | undefined =
    'show' in effect
      ? [effect.show, { visible: true }]
      : 'hide' in effect
        ? [effect.hide, { visible: false }]
        : 'require' in effect
          ? [effect.require, { required: true }]
          : 'unrequire' in effect
            ? [effect.unrequire, { required: false }]
            : undefined;
  if (!patch) return;
  const [path, state] = patch;
  overrides.set(path, { ...overrides.get(path), ...state });
}

function walkFields(
  fields: Field[],
  data: FormData,
  relativePrefix: string,
  scopePath: string,
  parentVisible: boolean,
  overrides: Overrides,
  result: LinkageResult,
): FormData {
  let next = data;
  for (const field of fields) {
    if (field.deprecated) continue;
    const relativePath = joinPath(relativePrefix, field.key);
    const override = overrides.get(relativePath);
    const visible = parentVisible && (override?.visible ?? !field.hidden);
    const required = visible && (override?.required ?? field.required === true);
    const absolutePath = joinScope(scopePath, relativePath);
    result.fieldStates[absolutePath] = { visible, required };

    if (field.type === 'object') {
      next = walkFields(field.fields, next, relativePath, scopePath, visible, overrides, result);
    } else if (field.type === 'repeater') {
      const rows = getAt(next, relativePath);
      if (!Array.isArray(rows)) continue;
      const evaluatedRows = rows.map((row: unknown, index) =>
        evaluateScope(
          field.fields,
          field.linkage ?? [],
          isPlainObject(row) ? row : {},
          `${absolutePath}[${index}]`,
          visible,
          result,
        ),
      );
      next = setAt(next, relativePath, evaluatedRows);
    }
  }
  return next;
}

function joinScope(scopePath: string, relativePath: string): string {
  return scopePath === '' ? relativePath : `${scopePath}.${relativePath}`;
}

// ---- 静态环检测（发布时调用） ----

export type LinkageCycle = {
  /** 作用域：根为空字符串，repeater 为其字段路径（如 "workHistory[]"）。 */
  scope: string;
  /** 环上的字段，首尾相同，如 ["a", "b", "c", "a"]。 */
  path: FieldPath[];
};

export function detectLinkageCycles(schema: FormSchema): LinkageCycle[] {
  const cycles: LinkageCycle[] = [];
  collectScopeCycles(schema.fields, schema.linkage ?? [], '', cycles);
  return cycles;
}

function collectScopeCycles(
  fields: Field[],
  rules: LinkageRule[],
  scope: string,
  cycles: LinkageCycle[],
): void {
  // 边：规则读取的字段 → 规则 setValue 写入的字段。
  const graph = new Map<FieldPath, Set<FieldPath>>();
  for (const rule of rules) {
    const reads = conditionReads(rule.when);
    for (const effect of rule.actions) {
      if (!('setValue' in effect)) continue;
      for (const from of reads) {
        const targets = graph.get(from) ?? new Set<FieldPath>();
        targets.add(effect.setValue.field);
        graph.set(from, targets);
      }
    }
  }
  for (const path of findCycles(graph)) cycles.push({ scope, path });

  forEachRepeater(fields, '', (repeater, path) =>
    collectScopeCycles(
      repeater.fields,
      repeater.linkage ?? [],
      `${joinScope(scope, path)}[]`,
      cycles,
    ),
  );
}

function forEachRepeater(
  fields: Field[],
  prefix: string,
  visit: (field: Extract<Field, { type: 'repeater' }>, path: string) => void,
): void {
  for (const field of fields) {
    const path = joinPath(prefix, field.key);
    if (field.type === 'repeater') visit(field, path);
    if (field.type === 'object') forEachRepeater(field.fields, path, visit);
  }
}

function findCycles(graph: Map<FieldPath, Set<FieldPath>>): FieldPath[][] {
  const cycles: FieldPath[][] = [];
  const state = new Map<FieldPath, 'visiting' | 'done'>();
  const stack: FieldPath[] = [];

  const visit = (node: FieldPath): void => {
    state.set(node, 'visiting');
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const nextState = state.get(next);
      if (nextState === 'visiting') {
        cycles.push([...stack.slice(stack.indexOf(next)), next]);
      } else if (nextState === undefined) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, 'done');
  };

  for (const node of graph.keys()) {
    if (!state.has(node)) visit(node);
  }
  return cycles;
}
