// 场景一 Q0：表单 Schema 数据结构。
// 设计要点：
// - fieldId 永不变，key 可以改名；版本之间靠 fieldId 对应字段（场景一 Q2）。
// - 字段删除只做软删除（deprecated），历史数据仍可读。
// - object / repeater 可以嵌套任意层；联动规则按“作用域”书写：表单根上的规则引用根字段路径，
//   repeater 上的规则引用单行内的字段路径，并对每一行分别求值。

export type FieldType = 'input' | 'select' | 'upload' | 'repeater' | 'object';

export type InputKind = 'text' | 'textarea' | 'number' | 'email' | 'url' | 'date';

export type ValidationRule =
  | { type: 'regex'; pattern: string; message?: string }
  | { type: 'email'; message?: string }
  | { type: 'min'; value: number; message?: string }
  | { type: 'max'; value: number; message?: string }
  | { type: 'minLength'; value: number; message?: string }
  | { type: 'maxLength'; value: number; message?: string };

type BaseField = {
  /** 稳定 ID：创建后不再改变，用于版本间映射。 */
  fieldId: string;
  /** 数据里的键名，可以在新版本中改名。 */
  key: string;
  label: string;
  description?: string;
  required?: boolean;
  /** 默认隐藏，需要联动规则 show 才显示。 */
  hidden?: boolean;
  /** 已废弃：新表单不再渲染、不接受新值，历史数据保留。 */
  deprecated?: boolean;
  /** 敏感字段：审计和列表中脱敏显示。 */
  sensitive?: boolean;
  rules?: ValidationRule[];
};

export type InputField = BaseField & {
  type: 'input';
  inputKind?: InputKind;
  placeholder?: string;
  default?: string | number;
};

export type SelectOption = { label: string; value: string | number | boolean };

export type SelectField = BaseField & {
  type: 'select';
  options: SelectOption[];
  multiple?: boolean;
  default?: SelectOption['value'] | Array<SelectOption['value']>;
};

export type UploadField = BaseField & {
  type: 'upload';
  /** 允许的 MIME 类型，如 application/pdf、image/png。 */
  accept: string[];
  maxSizeMb: number;
  maxFiles?: number;
  /** 文件分类：身份证、合同、简历、银行卡等，影响存储和下载权限（场景二 Q3）。 */
  category?: 'id_card' | 'contract' | 'resume' | 'bank_card' | 'other';
};

export type ObjectField = BaseField & {
  type: 'object';
  fields: Field[];
};

export type RepeaterField = BaseField & {
  type: 'repeater';
  fields: Field[];
  minItems?: number;
  maxItems?: number;
  /** 初始行，每一行会再用子字段默认值补齐。 */
  default?: Array<Record<string, unknown>>;
  /** 单行作用域内的联动规则。 */
  linkage?: LinkageRule[];
};

export type Field = InputField | SelectField | UploadField | ObjectField | RepeaterField;

/** 上传字段在提交数据里只存引用，不存二进制（场景二 Q3）。 */
export type FileRef = { fileId: string; name: string; size: number; mimeType: string };

// ---- 联动规则（场景一 Q1 进阶、场景二 Q2） ----

/** 字段路径，相对于规则所在作用域，如 "isFreshGraduate"、"contact.email"。 */
export type FieldPath = string;
export type Literal = string | number | boolean | null;

export type Condition =
  | { eq: [FieldPath, Literal] }
  | { ne: [FieldPath, Literal] }
  | { gt: [FieldPath, number] }
  | { gte: [FieldPath, number] }
  | { lt: [FieldPath, number] }
  | { lte: [FieldPath, number] }
  | { in: [FieldPath, Literal[]] }
  | { empty: FieldPath }
  | { and: Condition[] }
  | { or: Condition[] }
  | { not: Condition };

export type Effect =
  | { show: FieldPath }
  | { hide: FieldPath }
  | { require: FieldPath }
  | { unrequire: FieldPath }
  | { setValue: { field: FieldPath; value: Literal } }
  | { message: { text: string; level?: 'info' | 'warning' } };

export type LinkageRule = {
  id: string;
  description?: string;
  when: Condition;
  actions: Effect[];
};

export type FormSchema = {
  formId: string;
  title: string;
  description?: string;
  version: number;
  fields: Field[];
  linkage?: LinkageRule[];
  /** 提交后要执行的插件 ID（场景二 Q4）。 */
  hooks?: string[];
};

export type FormData = Record<string, unknown>;

// ---- 错误 ----

export type FieldError = {
  /** 数据路径，如 "email"、"workHistory[1].company"；表单级错误为空字符串。 */
  path: string;
  code: string;
  message: string;
};
