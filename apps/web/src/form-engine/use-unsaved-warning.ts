import { useEffect } from 'react';

/** 有未保存的修改时，关闭或刷新页面前让浏览器弹出确认（dirty state 的实际用途）。 */
export function useUnsavedWarning(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const handler = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [active]);
}
