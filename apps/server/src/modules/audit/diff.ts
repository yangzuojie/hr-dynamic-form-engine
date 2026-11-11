// 场景二 Q6：计算字段级变化，如 [{ path: "expectedSalary", before: 30000, after: 35000 }]。
// 对象逐层展开；数组按下标展开（repeater 的行），文件引用等叶子对象按整体比较。

export type Change = { path: string; before: unknown; after: unknown };

export function diffData(before: unknown, after: unknown, path = ''): Change[] {
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) => diffData(before[key], after[key], path ? `${path}.${key}` : key));
  }
  if (
    Array.isArray(before) &&
    Array.isArray(after) &&
    before.every(isRecord) &&
    after.every(isRecord)
  ) {
    const length = Math.max(before.length, after.length);
    return Array.from({ length }, (_, i) => diffData(before[i], after[i], `${path}[${i}]`)).flat();
  }
  return JSON.stringify(before) === JSON.stringify(after)
    ? []
    : [{ path, before: before ?? null, after: after ?? null }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !('fileId' in value)
  );
}
