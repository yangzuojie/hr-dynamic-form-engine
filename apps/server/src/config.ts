import { resolve } from 'node:path';

// 所有配置都来自环境变量，生产环境的值写在服务器的 /etc/hr-form/env（不进仓库），示例见 .env.example。

export type Config = {
  port: number;
  host: string;
  databaseUrl: string;
  dbPoolMax: number;
  jwtSecret: string;
  /** 文件下载签名链接用的密钥，与 JWT 分开，方便单独轮换。 */
  fileSigningSecret: string;
  uploadDir: string;
  /** PDF 合同用的中文字体（scripts/fetch-font.ts 下载）。 */
  fontPath: string;
  /** 生产环境走 HTTPS，cookie 加 Secure。 */
  secureCookies: boolean;
  /** 可选：真实的钉钉机器人 webhook；不配置时只模拟发送。 */
  dingtalkWebhook: string | undefined;
  /** 后台任务（outbox、孤儿文件清理）是否启动；测试里关掉，手动触发。 */
  backgroundJobs: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const isProduction = env.NODE_ENV === 'production';
  const required = (name: string, devFallback: string): string => {
    const value = env[name];
    if (value) return value;
    if (isProduction) throw new Error(`缺少环境变量 ${name}`);
    return devFallback;
  };
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '127.0.0.1',
    databaseUrl: required('DATABASE_URL', 'postgres://postgres@127.0.0.1:5433/postgres'),
    dbPoolMax: Number(env.DB_POOL_MAX ?? (isProduction ? 5 : 1)),
    jwtSecret: required('JWT_SECRET', 'dev-only-jwt-secret-change-me-0123456789'),
    fileSigningSecret: required('FILE_SIGNING_SECRET', 'dev-only-file-secret-change-me-012345'),
    uploadDir: resolve(env.UPLOAD_DIR ?? './uploads'),
    fontPath: resolve(env.FONT_PATH ?? './assets/fonts/NotoSansSC-Regular.otf'),
    secureCookies: isProduction,
    dingtalkWebhook: env.DINGTALK_WEBHOOK || undefined,
    backgroundJobs: env.BACKGROUND_JOBS !== 'false',
  };
}
