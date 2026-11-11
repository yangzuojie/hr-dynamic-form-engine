import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { AdminLayout } from './admin/AdminLayout';
import { AuthProvider } from './auth';
import { FillPage } from './pages/FillPage';
import { LoginPage } from './pages/LoginPage';

// 后台页面按需加载：候选人打开填写链接时，不下载 Form Builder 等后台代码。
const FormsPage = lazy(() => import('./admin/FormsPage').then((m) => ({ default: m.FormsPage })));
const BuilderPage = lazy(() =>
  import('./admin/BuilderPage').then((m) => ({ default: m.BuilderPage })),
);
const DataPage = lazy(() => import('./admin/DataPage').then((m) => ({ default: m.DataPage })));
const RecordPage = lazy(() =>
  import('./admin/RecordPage').then((m) => ({ default: m.RecordPage })),
);
const AuditPage = lazy(() => import('./admin/AuditPage').then((m) => ({ default: m.AuditPage })));

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Suspense fallback={<p className="page-loading">加载中…</p>}>
          <Routes>
            <Route path="/" element={<Navigate to="/admin" replace />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/f/:formId" element={<FillPage />} />
            <Route path="/admin" element={<AdminLayout />}>
              <Route index element={<FormsPage />} />
              <Route path="forms/:formId/builder" element={<BuilderPage />} />
              <Route path="forms/:formId/data" element={<DataPage />} />
              <Route path="forms/:formId/data/:id" element={<RecordPage />} />
              <Route path="audit" element={<AuditPage />} />
            </Route>
            <Route path="*" element={<p className="page-loading">页面不存在</p>} />
          </Routes>
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
  );
}
