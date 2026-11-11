// 包入口：只做再导出。前端用 Vite、后端用 esbuild 打包，未使用的部分会被 tree-shaking 去掉。
export { applyDefaults, createRepeaterRow } from './defaults';
export { checkSchemaDefinition, checkVersionCompatibility } from './definition';
export { techOnboardingV3, techOnboardingV4 } from './examples/tech-onboarding';
export { toJsonSchema } from './json-schema';
export {
  conditionReads,
  detectLinkageCycles,
  effectTarget,
  evaluateCondition,
  evaluateLinkage,
  type FieldState,
  type LinkageCycle,
  type LinkageMessage,
  type LinkageResult,
} from './linkage';
export { findField, getAt, isEmptyValue, isPlainObject, setAt } from './path';
export {
  type FilterCondition,
  type FilterOp,
  type FilterScalar,
  type FilterValueType,
  type ListQuery,
  MAX_PAGE_SIZE,
  parseListQuery,
  type RawQuery,
  type SortSpec,
} from './query';
export { checkSchemaShape, isFormSchema } from './shape';
export type * from './types';
export {
  type ValidateOptions,
  type ValidationResult,
  validateSubmission,
} from './validate';
export {
  diffSchemas,
  type MigrationResult,
  migrateData,
  resolveKeyPath,
  type SchemaChange,
} from './versioning';
