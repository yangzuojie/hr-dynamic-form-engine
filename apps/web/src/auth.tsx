import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { api } from './api';

export type User = { id: number; username: string; displayName: string; role: 'hr' | 'admin' };

type AuthState = {
  user: User | null;
  /** 首次检查登录状态完成前为 true。 */
  checking: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    api
      .get<{ user: User }>('/api/v1/auth/me')
      .then(({ data }) => setUser(data.user))
      .catch(() => setUser(null)) // 401 表示未登录，不是错误
      .finally(() => setChecking(false));
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const { data } = await api.post<{ user: User }>('/api/v1/auth/login', { username, password });
    setUser(data.user);
  }, []);

  const logout = useCallback(async () => {
    await api.post('/api/v1/auth/logout');
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, checking, login, logout }), [user, checking, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return value;
}
