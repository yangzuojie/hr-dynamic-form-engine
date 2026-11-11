// subset-font 没有自带类型声明，这里只声明本项目用到的部分。
declare module 'subset-font' {
  type Options = { targetFormat?: 'sfnt' | 'woff' | 'woff2' | 'truetype' };
  export default function subsetFont(
    font: Buffer,
    text: string,
    options?: Options,
  ): Promise<Buffer>;
}
