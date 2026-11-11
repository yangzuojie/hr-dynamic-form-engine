import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../../config';
import type { Db } from '../../db/pool';
import { AppError } from '../../errors';
import { verifyPassword } from './password';

// 登录：不开放注册，预置 hr_a / hr_b / admin（设计决策第 11 条）。
// JWT 放在 httpOnly + SameSite=Lax 的 cookie 里，前端 JS 读不到，降低 XSS 窃取风险。

export type Role = 'hr' | 'admin';
export type AuthUser = { id: number; username: string; displayName: string; role: Role };

/** 审计日志里的“操作人”。候选人匿名提交时 id 为 null。 */
export type Actor = { id: number | null; name: string; role: Role | 'candidate'; ip: string };

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthUser;
    user: AuthUser;
  }
}

const COOKIE_NAME = 'hr_session';
const SESSION_SECONDS = 8 * 60 * 60;

export async function registerAuth(app: FastifyInstance, db: Db, config: Config): Promise<void> {
  await app.register(cookie);
  await app.register(jwt, {
    secret: config.jwtSecret,
    cookie: { cookieName: COOKIE_NAME, signed: false },
    sign: { expiresIn: SESSION_SECONDS },
  });

  app.post<{ Body: { username?: unknown; password?: unknown } }>(
    '/api/v1/auth/login',
    async (request, reply) => {
      const { username, password } = request.body ?? {};
      if (typeof username !== 'string' || typeof password !== 'string') {
        throw new AppError(400, 'bad_request', '请输入用户名和密码');
      }
      const { rows } = await db.query<{
        id: number;
        username: string;
        display_name: string;
        role: Role;
        password_hash: string;
      }>('SELECT id, username, display_name, role, password_hash FROM users WHERE username = $1', [
        username,
      ]);
      const row = rows[0];
      if (!row || !(await verifyPassword(password, row.password_hash))) {
        throw new AppError(401, 'invalid_credentials', '用户名或密码错误');
      }
      const user: AuthUser = {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        role: row.role,
      };
      const token = await reply.jwtSign(user);
      reply.setCookie(COOKIE_NAME, token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: config.secureCookies,
        maxAge: SESSION_SECONDS,
      });
      return { user };
    },
  );

  app.post('/api/v1/auth/logout', async (_request, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return { ok: true };
  });

  app.get('/api/v1/auth/me', { preHandler: requireAuth }, async (request) => ({
    user: request.user,
  }));
}

export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    // 令牌缺失、过期或被篡改，统一按未登录处理。
    throw new AppError(401, 'unauthorized', '请先登录');
  }
}

export function actorOf(request: FastifyRequest): Actor {
  const user = request.user as AuthUser | undefined;
  return user
    ? { id: user.id, name: user.displayName, role: user.role, ip: request.ip }
    : { id: null, name: '候选人（匿名）', role: 'candidate', ip: request.ip };
}
