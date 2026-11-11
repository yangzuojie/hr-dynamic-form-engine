// 生产构建：把服务端和演示数据脚本各打成一个 ESM 文件，部署时不需要在服务器上安装 node_modules。
import { build } from 'esbuild';

await build({
  entryPoints: { main: 'src/main.ts', seed: 'scripts/seed.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  // pg 可选的原生绑定，用不到。
  external: ['pg-native'],
  // 部分依赖是 CommonJS，打进 ESM 后需要 require。
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
