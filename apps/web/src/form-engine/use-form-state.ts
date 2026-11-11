import {
  applyDefaults,
  createRepeaterRow,
  evaluateLinkage,
  type FieldError,
  type FieldState,
  type FormData,
  type FormSchema,
  type LinkageMessage,
  type RepeaterField,
  validateSubmission,
} from '@hr/schema-core';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ApiError } from '../api';
import { getIn, isWithin, setIn } from './paths';

// 场景一 Q1：表单状态管理（不依赖 react-hook-form 等库）。
// - values：用户输入的原始数据；display：执行联动 setValue 之后用于展示的数据；
// - 联动和校验都调用 schema-core，与服务端是同一份代码，所以前端提示和后端结果一致；
// - 字段级错误在“碰过该字段”或“点过提交”后才显示，避免一打开就满屏红字；
// - 服务端返回的 422 错误按 path 挂到对应字段上，用户改了该字段就清除；
// - dirty：与初始快照比较；loading：submitting 期间禁用提交按钮。
// - 防循环由 schema-core 保证：同一轮计算中字段只会被改一次，超限会产生表单级错误而不是卡死页面。

export type FormStatus = {
  values: FormData;
  display: FormData;
  fieldStates: Record<string, FieldState>;
  messages: LinkageMessage[];
  /** 当前应该显示的字段错误（path → 文案）。 */
  fieldErrors: Record<string, string>;
  /** 表单级错误：联动循环、服务端非字段错误等。 */
  formErrors: string[];
  /** 本地校验是否通过（不论是否显示）。 */
  isValid: boolean;
  dirty: boolean;
  submitting: boolean;
  submitAttempted: boolean;
};

export type FormActions = {
  setField: (path: string, value: unknown) => void;
  touch: (path: string) => void;
  addRow: (path: string, field: RepeaterField) => void;
  removeRow: (path: string, index: number) => void;
  submit: () => Promise<boolean>;
  reset: (initial?: FormData) => void;
};

export type UseFormOptions = {
  initial?: FormData | undefined;
  /** 返回值不重要；抛出 ApiError(422) 时错误会挂到字段上，其他错误显示为表单级错误。 */
  onSubmit: (data: FormData) => Promise<unknown>;
};

export function useFormState(
  schema: FormSchema,
  options: UseFormOptions,
): [FormStatus, FormActions] {
  const [values, setValues] = useState<FormData>(() =>
    applyDefaults(schema.fields, options.initial ?? {}),
  );
  const [snapshot, setSnapshot] = useState(() => JSON.stringify(values));
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const [serverErrors, setServerErrors] = useState<FieldError[]>([]);
  const [serverFormError, setServerFormError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);

  // onSubmit 通常是页面里的内联函数，放进 ref，submit 回调就能保持稳定引用。
  const onSubmitRef = useRef(options.onSubmit);
  onSubmitRef.current = options.onSubmit;

  const linkage = useMemo(
    () => evaluateLinkage(schema, applyDefaults(schema.fields, values)),
    [schema, values],
  );
  const validation = useMemo(() => validateSubmission(schema, values), [schema, values]);

  const fieldErrors = useMemo(() => {
    const result: Record<string, string> = {};
    for (const error of validation.errors) {
      if (error.path && (submitAttempted || touched.has(error.path)))
        result[error.path] ??= error.message;
    }
    // 服务端错误优先显示：它代表最终结果（例如文件已被占用这类前端无法判断的情况）。
    for (const error of serverErrors) if (error.path) result[error.path] = error.message;
    return result;
  }, [validation.errors, serverErrors, submitAttempted, touched]);

  const formErrors = useMemo(() => {
    const list = linkage.errors.map((e) => e.message);
    for (const error of serverErrors) if (!error.path) list.push(error.message);
    if (serverFormError) list.push(serverFormError);
    return [...new Set(list)];
  }, [linkage.errors, serverErrors, serverFormError]);

  const setField = useCallback((path: string, value: unknown) => {
    setValues((current) => setIn(current, path, value));
    setTouched((current) => (current.has(path) ? current : new Set(current).add(path)));
    setServerErrors((current) => current.filter((e) => !isWithin(e.path, path)));
    setServerFormError(undefined);
  }, []);

  const touch = useCallback((path: string) => {
    setTouched((current) => (current.has(path) ? current : new Set(current).add(path)));
  }, []);

  const addRow = useCallback((path: string, field: RepeaterField) => {
    setValues((current) => {
      const rows = getIn(current, path);
      return setIn(current, path, [...(Array.isArray(rows) ? rows : []), createRepeaterRow(field)]);
    });
  }, []);

  const removeRow = useCallback((path: string, index: number) => {
    setValues((current) => {
      const rows = getIn(current, path);
      return Array.isArray(rows)
        ? setIn(
            current,
            path,
            rows.filter((_, i) => i !== index),
          )
        : current;
    });
    // 删除一行后，后面行的下标会变，旧的服务端错误位置不再准确，直接清掉该列表下的错误。
    setServerErrors((current) => current.filter((e) => !isWithin(e.path, path)));
  }, []);

  const validationRef = useRef(validation);
  validationRef.current = validation;

  const submit = useCallback(async (): Promise<boolean> => {
    setSubmitAttempted(true);
    const current = validationRef.current;
    if (current.errors.length > 0) return false;
    setSubmitting(true);
    setServerErrors([]);
    setServerFormError(undefined);
    try {
      await onSubmitRef.current(current.data);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.errors.length > 0) {
        setServerErrors(error.errors);
        setServerFormError(error.message);
      } else {
        setServerFormError(error instanceof Error ? error.message : '提交失败，请稍后重试');
      }
      return false;
    } finally {
      setSubmitting(false);
    }
  }, []);

  const reset = useCallback(
    (initial?: FormData) => {
      const next = applyDefaults(schema.fields, initial ?? {});
      setValues(next);
      setSnapshot(JSON.stringify(next));
      setTouched(new Set());
      setServerErrors([]);
      setServerFormError(undefined);
      setSubmitAttempted(false);
    },
    [schema],
  );

  const status: FormStatus = {
    values,
    display: linkage.data,
    fieldStates: linkage.fieldStates,
    messages: linkage.messages,
    fieldErrors,
    formErrors,
    isValid: validation.errors.length === 0,
    dirty: JSON.stringify(values) !== snapshot,
    submitting,
    submitAttempted,
  };
  const actions = useMemo(
    () => ({ setField, touch, addRow, removeRow, submit, reset }),
    [setField, touch, addRow, removeRow, submit, reset],
  );
  return [status, actions];
}
