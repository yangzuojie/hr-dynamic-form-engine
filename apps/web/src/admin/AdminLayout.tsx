import { Navigate, NavLink, Outlet, useLocation } from 'react-router';
import { useAuth } from '../auth';

export function AdminLayout() {
  const { user, checking, logout } = useAuth();
  const location = useLocation();
  if (checking) return <p className="page-loading">加载中…</p>;
  if (!user)
    return (
      <Navigate
        to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}
        replace
      />
    );

  return (
    <div className="admin">
      <header className="topbar">
        <strong>HR 动态表单引擎</strong>
        <nav>
          <NavLink to="/admin" end>
            表单
          </NavLink>
          <NavLink to="/admin/audit">审计日志</NavLink>
        </nav>
        <span className="spacer" />
        <span className="muted">
          {user.displayName}（{user.role === 'admin' ? '管理员' : 'HR'}）
        </span>
        <button type="button" className="link" onClick={() => void logout()}>
          退出
        </button>
      </header>
      <main className="page">
        <Outlet />
      </main>
    </div>
  );
}
