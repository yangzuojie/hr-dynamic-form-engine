import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 下载生成 PDF 合同用的中文字体 Noto Sans SC（SIL Open Font License）。
// 字体约 8MB，不提交进仓库；部署和本地开发时执行一次：pnpm --filter @hr/server fetch-font
// 下载后校验 SHA-256，防止拿到被篡改或上游已变更的文件。

const URL =
  'https://github.com/notofonts/noto-cjk/raw/main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf';
const SHA256 = 'faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9';
const target = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../assets/fonts/NotoSansSC-Regular.otf',
);

const digest = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

if (existsSync(target) && digest(await readFile(target)) === SHA256) {
  console.log(`字体已存在且校验通过：${target}`);
} else {
  console.log(`下载 ${URL}`);
  const response = await fetch(URL);
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const actual = digest(data);
  if (actual !== SHA256) throw new Error(`SHA-256 不匹配：期望 ${SHA256}，实际 ${actual}`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
  console.log(`已保存：${target}`);
}
