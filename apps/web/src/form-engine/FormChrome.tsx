import type { FormStatus } from './use-form-state';

// 表单级错误和提交栏：表单级错误包括联动循环、服务端返回的非字段错误。

export function FormErrors({ status }: { status: FormStatus }) {
  const fieldErrorCount = Object.keys(status.fieldErrors).length;
  if (status.formErrors.length === 0 && !(status.submitAttempted && fieldErrorCount > 0))
    return null;
  return (
    <div className="form-error" role="alert">
      {status.formErrors.map((message) => (
        <p key={message}>{message}</p>
      ))}
      {status.submitAttempted && fieldErrorCount > 0 && (
        <p>还有 {fieldErrorCount} 处需要修改，请检查标红的字段。</p>
      )}
    </div>
  );
}

export function SubmitBar({
  status,
  label,
  extra,
}: {
  status: FormStatus;
  label: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className="submit-bar">
      <span className="muted">{status.dirty ? '有未保存的修改' : '没有修改'}</span>
      {extra}
      <button type="submit" className="primary" disabled={status.submitting}>
        {status.submitting ? '提交中…' : label}
      </button>
    </div>
  );
}
