// 生产构建：把服务端和演示数据脚本各打成一个 ESM 文件，部署时不需要在服务器上安装 node_modules。
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const WASM = 'harfbuzz-subset.wasm';

// subset-font 运行时用 require.resolve('harfbuzzjs/dist/harfbuzz-subset.wasm') 找 wasm，
// 打包后服务器上没有 node_modules：构建时把 wasm 复制到 dist/，并把这行改成从产物所在目录读取。
const harfbuzzWasm = {
  name: 'harfbuzz-wasm',
  setup(b) {
    b.onLoad({ filter: /subset-font[\\/]index\.js$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      const target = "require.resolve('harfbuzzjs/dist/harfbuzz-subset.wasm')";
      if (!source.includes(target))
        throw new Error('subset-font 的 wasm 加载方式变了，请更新 build.mjs');
      return {
        // 不能直接写 import.meta：esbuild 会因此把这个 CommonJS 文件当成 ES 模块。__bundleDir 由 banner 定义。
        contents: source.replace(target, `require('node:path').join(__bundleDir, '${WASM}')`),
        loader: 'js',
      };
    });
  },
};

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
  plugins: [harfbuzzWasm],
  // 部分依赖是 CommonJS，打进 ESM 后需要 require。
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { dirname as __dirnameOf } from 'node:path';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      'const require = __createRequire(import.meta.url);',
      'const __bundleDir = __dirnameOf(__fileURLToPath(import.meta.url));',
      // harfbuzzjs 的 Emscripten 加载代码用到 CommonJS 的 __dirname / __filename
      'const __filename = __fileURLToPath(import.meta.url); const __dirname = __bundleDir;',
    ].join(' '),
  },
  logLevel: 'info',
});

await mkdir('dist', { recursive: true });
await copyFile(
  require.resolve(`harfbuzzjs/dist/${WASM}`, { paths: [require.resolve('subset-font')] }),
  `dist/${WASM}`,
);
console.log(`已复制 ${WASM} 到 dist/`);
