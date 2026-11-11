# HR 动态表单与通用接口引擎

HR 在后台配置入职表单（技术岗填 GitHub、销售岗填驾驶证……），发布后**不需要开发介入**，就自动拥有渲染页面以及提交、查询、校验接口。

- 在线演示：`https://16-106-38-113.sslip.io`（部署后可用）
  - 候选人填写页：`/f/tech_onboarding`、`/f/sales_onboarding`
  - HR 后台：`/admin`，演示账号 `hr_a` / `hr_b`（HR）、`admin`（管理员），密码 `demo1234`
- 技术栈：TypeScript 全栈。后端 Fastify + PostgreSQL（JSONB），前端 React 19 + Vite，没有使用 Java。
- 测试：69 个自动化测试（规则引擎、校验、版本映射、接口集成测试、前端表单状态），`pnpm test` 一条命令运行。

## 目录

```
packages/schema-core   核心引擎（纯 TS，无框架依赖，前后端共用）：Schema 类型、校验、联动规则、环检测、版本映射、查询解析
apps/server            通用数据 API：Fastify + PostgreSQL
apps/web               渲染引擎、候选人填写页、HR 后台（Form Builder、数据查询、审计）
deploy/                Nginx、systemd、服务器初始化和一键部署脚本
```

**核心设计**：校验和联动规则只写一份（`schema-core`），前端实时提示和后端最终校验调用的是同一个函数，两边的规则永远一致。

## 本地运行

需要 Node.js ≥ 22 和 pnpm。本地数据库用 [PGlite](https://pglite.dev)（编译成 WASM 的 PostgreSQL），不用安装任何数据库。

```bash
pnpm install
pnpm --filter @hr/server fetch-font      # 下载 PDF 合同用的中文字体（Noto Sans SC，约 8MB，校验 SHA-256）
pnpm --filter @hr/server dev:db          # 终端 1：本地数据库，127.0.0.1:5433
pnpm --filter @hr/server seed            # 写入演示数据（1 万条历史提交，约 1 秒）
pnpm --filter @hr/server dev             # 终端 2：后端 http://127.0.0.1:3000
pnpm --filter @hr/web dev                # 终端 3：前端 http://localhost:5173

pnpm check   # Biome（格式 + lint）+ TypeScript 严格模式类型检查
pnpm test    # 全部测试；后端集成测试每个文件起一个内存 PGlite，与生产走同一套 SQL
```

## 演示步骤（约 5 分钟）

1. 打开 `/f/tech_onboarding`，直接点“提交”：看到字段级错误和表单级汇总。
2. “是否应届生”选“是”：“前公司名称”消失并取消必填，“工作年限”自动变成 0；“期望薪资”填 35000：出现“需要 HRBP 特别审批”。
3. 添加两条“工作履历”，其中一条选“至今在职”：这一条的“结束日期”被隐藏（规则对每一行分别求值）。
4. 用 `hr_a` 登录后台 → 技术岗表单“数据”：点“示例：工作年限 > 3”，在 1 万多条数据里筛选；勾选“按最新版本显示”，v3 的历史数据按 v4 的字段名显示，`department` 显示为“历史版本未采集”。
5. 点开一条 v3 记录，补上部门后保存：记录升级到 v4，下方审计日志显示 `department: （空）→ 测试`，并标注“从 v3 升级”。
6. 换一个浏览器用 `hr_b` 打开同一条记录或同一个表单的 Form Builder，各自保存：后保存的一方得到 409 冲突提示和差异，不会覆盖先保存的修改。
7. “配置”进入 Form Builder：查看版本历史 v1～v4、每个版本的改动和 JSON Schema 导出。

---

## 场景一：动态表单 Schema 与前端渲染引擎

### Q0 Schema 数据结构 — [`packages/schema-core/src/types.ts`](packages/schema-core/src/types.ts)

```jsonc
{
  "formId": "tech_onboarding",
  "title": "技术岗入职信息表",
  "version": 4,
  "hooks": ["dingtalk_notify", "contract_pdf", "attendance_sync"],
  "fields": [
    { "fieldId": "f_name", "key": "fullName", "label": "姓名", "type": "input", "required": true,
      "rules": [{ "type": "maxLength", "value": 50 }] },
    { "fieldId": "f_nickname", "key": "nickname", "label": "昵称", "type": "input", "deprecated": true },
    { "fieldId": "f_fresh", "key": "isFreshGraduate", "label": "是否应届生", "type": "select",
      "default": false, "options": [{ "label": "是", "value": true }, { "label": "否", "value": false }] },
    { "fieldId": "f_contact", "key": "contact", "label": "联系信息", "type": "object", "fields": [ ... ] },
    { "fieldId": "f_work_history", "key": "workHistory", "label": "工作履历", "type": "repeater",
      "fields": [ ... ], "linkage": [ /* 行内规则 */ ] },
    { "fieldId": "f_resume", "key": "resume", "label": "简历", "type": "upload",
      "accept": ["application/pdf"], "maxSizeMb": 10, "category": "resume" }
  ],
  "linkage": [ /* 见场景二 Q2 */ ]
}
```

| 要求 | 设计 |
| --- | --- |
| key / label / type | `type` 为 `input`（细分 text、number、email、url、date）、`select`、`upload`、`repeater`，另有 `object` 分组 |
| 校验规则 | `required`，以及 `rules`：`regex`、`email`、`min`、`max`、`minLength`、`maxLength`，可自定义提示 |
| 嵌套 Object / Array | `object` 与 `repeater` 可任意层嵌套；错误路径形如 `workHistory[1].company` |
| 默认值 | `default`：渲染时填入；提交时缺失也会补上；repeater 新增行用子字段默认值初始化 |
| Schema Version | `version`；已发布版本存在 `form_versions` 表，不可修改 |
| 废弃但历史数据仍在 | `deprecated: true`：新表单不渲染、不接受提交，历史数据保留可查 |
| **改名不丢数据** | 每个字段有永不改变的 `fieldId`，`key` 可以改。版本之间按 `fieldId` 对应，这是实现 Q2 的关键 |

另外提供“导出为标准 JSON Schema（draft 2020-12）”接口，方便和外部系统对接。没有直接用 JSON Schema + Ajv，是因为联动规则（隐藏后取消必填）、废弃字段、UI 类型都不是静态 JSON Schema 能表达的，硬塞进去反而两套逻辑混在一起。

### Q1 前端渲染引擎 — [`apps/web/src/form-engine/`](apps/web/src/form-engine)

`useFormState(schema)` 自己实现，没有用 react-hook-form 之类的库；`<FormRenderer>` 根据 Schema 递归渲染。

| 要求 | 实现 |
| --- | --- |
| 动态添加/删除 | repeater 的 `addRow` / `removeRow`，新行带默认值；`maxItems` 到上限时禁用添加 |
| Rule Engine | 每次数据变化调用 `schema-core` 的 `evaluateLinkage`，得到每个字段的显示/必填状态、`setValue` 后的数据、提示信息 |
| 字段级错误 | 碰过该字段或点过提交后才显示，避免一打开满屏红字 |
| 表单级错误 | 汇总“还有 N 处需要修改”、联动循环错误、服务端非字段错误 |
| Dirty State | 与初始快照比较；有未保存修改时离开页面会弹出浏览器确认 |
| Loading State | 提交中禁用按钮并显示“提交中…”；文件上传单独显示进度状态 |
| Server Validation Error | 后端 422 返回的 `{ path, message }` 直接挂到对应字段；用户改了该字段就清除 |
| 性能 | 叶子控件 `memo` 且只接收原始值类型的 props；数据不可变更新时保持未改分支的引用；改一个输入框不会重渲染其他字段 |

**防止 Rule Engine 无限循环**（A 改 B、B 改 C、C 又改 A）—— [`linkage.ts`](packages/schema-core/src/linkage.ts)：

1. 只有 `setValue` 会修改数据；显示/隐藏、必填这些都是“由当前数据推导的状态”，每次重新计算，不会累积。
2. **发布时静态检查**：用“规则读取的字段 → setValue 写入的字段”建依赖图，DFS 找环，有环拒绝发布，并指出环的路径，例如 `isFreshGraduate → experience → isFreshGraduate`。
3. **运行时兜底**：同一轮计算中每个字段最多被 setValue 改一次，迭代次数有上限；超限时停止计算并报表单级错误，页面不会卡死。

### Q2 Schema 生命周期与版本管理 — [`apps/server/src/modules/forms/service.ts`](apps/server/src/modules/forms/service.ts)、[`versioning.ts`](packages/schema-core/src/versioning.ts)

```
forms          一份可编辑的草稿 draft_schema + 乐观锁 draft_lock_version + 指向当前发布版本
form_versions  已发布版本，(form_id, version) 主键；数据库触发器禁止 UPDATE schema 和 DELETE
submissions    每条提交记录自己的 schema_version
```

- **已发布的不允许修改**：应用层没有修改接口，数据库触发器再兜底一次（有测试验证）。
- **修改生成新版本**：HR 改的是草稿，点“发布”才生成 `version + 1`。发布前检查：结构、联动环、引用的插件是否存在；与上一版本相比**不能硬删除字段**（只能废弃）、**同一 fieldId 不能改类型**，否则历史数据的含义会变。
- **历史 Submission 保留原版本**：1 万条 v3 数据**不批量迁移**。读取时按 `fieldId` 懒映射：`?view=latest` 把 `employeeName` 显示为 `fullName`，`nickname` 保留，`department` 标记“历史版本未采集”。批量改写会抹掉“这条数据当时按哪个版本采集”，还要停机和回滚方案，没有必要。
- **新 Submission 用最新发布版本**：通用接口只按 `current_published_version` 校验。
- HR 编辑一条旧数据时，先映射到最新版本再保存，记录随之升级，审计里注明“从 v3 升级”。
- 演示数据完整复现了题目场景：v3 有 1 万条提交，v4 做了改名 + 删除（废弃）+ 新增必填，走的是正式发布流程。

---

## 场景二：可配置通用数据 API 引擎

所有表单共用一套路由，代码里没有任何针对具体表单的分支。

| 接口 | 说明 |
| --- | --- |
| `POST /api/v1/dynamic-data/:formId` | 提交（公开） |
| `GET /api/v1/dynamic-data/:formId` | 查询、筛选、分页（需登录） |
| `GET/PUT/DELETE /api/v1/dynamic-data/:formId/:id` | 单条读取（返回 ETag）、修改（必须带 If-Match）、软删除 |
| `POST /api/v1/files?formId=&field=` | 上传文件，返回 `{ fileId }` |
| `GET/POST/PUT /api/v1/forms...` | 表单、草稿、发布、版本、JSON Schema 导出 |
| `GET /api/v1/audit-logs` | 审计日志 |

### Q0 通用提交接口 — [`submissions/service.ts`](apps/server/src/modules/submissions/service.ts)

按 `formId` 取当前发布版本 → `beforeValidate` 插件 → 补默认值 → 执行联动 → 共享校验器校验（被隐藏的字段不校验也不保存，未知字段和已废弃字段拒绝）→ `beforeSave` 插件 → **同一个事务**写入提交、绑定文件、审计、outbox → 返回 201 和 ETag。

校验失败返回 422，**一次给出全部错误**：

```json
{
  "message": "提交数据校验未通过",
  "code": "validation_failed",
  "errors": [
    { "path": "email", "code": "format", "message": "邮箱格式不正确，请填写有效的邮箱" },
    { "path": "workHistory[0].company", "code": "required", "message": "工作履历第 1 项的公司名称为必填" }
  ]
}
```

### Q1 查询与筛选 — [`schema-core/src/query.ts`](packages/schema-core/src/query.ts)、[`submissions/filter-sql.ts`](apps/server/src/modules/submissions/filter-sql.ts)

```
GET /api/v1/dynamic-data/tech_onboarding?filter[experience][gt]=3&filter[department][in]=研发,测试
    &filter[contact.emergency.name][contains]=李&sort=-expectedSalary&page=1&pageSize=20&view=latest
```

- 操作符：`eq ne gt gte lt lte in contains empty`；字段可以穿过嵌套对象。
- **安全**：只允许筛选 Schema 里存在的字段，取值按字段类型转换；路径和取值全部用 `$n` 参数传入，用户输入不会拼进 SQL（有 SQL 注入测试）。
- **跨版本**：同一字段在不同版本里 key 可能不同，按 fieldId 解析每个版本的路径，生成 `(schema_version = ANY($1) AND ...) OR (...)`，所以按 v4 的 `fullName` 筛选也能查到 v3 的 `employeeName`。
- **性能**：等值筛选转成 `data @> '{...}'`，走 `jsonb_path_ops` GIN 索引；数值比较用带类型守卫的 `numeric` 转换。如果某个字段的范围查询特别高频，可以针对它加表达式索引。

### Q2 字段联动与表达式引擎 — [`linkage.ts`](packages/schema-core/src/linkage.ts)

规则用 JSON 结构化条件表达，**不用字符串表达式加 `eval`**，从根上没有代码注入问题，也方便静态分析（环检测要用），以后做成可视化配置也容易。

```json
[
  { "id": "fresh_graduate_no_prev_company",
    "when": { "eq": ["isFreshGraduate", true] },
    "actions": [{ "hide": "previousCompany" }, { "unrequire": "previousCompany" }] },
  { "id": "high_salary_hrbp",
    "when": { "gt": ["expectedSalary", 30000] },
    "actions": [{ "message": { "text": "期望薪资超过 30000，需要 HRBP 特别审批", "level": "warning" } }] }
]
```

条件支持 `eq ne gt gte lt lte in empty and or not`，效果支持 `show hide require unrequire setValue message`。规则可以写在表单根上，也可以写在 repeater 上，对每一行分别求值。

> 规则的效果列表叫 `actions` 而不是 `then`：对象上有 `then` 属性会被 JS 当成 Promise（thenable），被 `await` 时行为异常。

### Q3 文件上传安全 — [`files/service.ts`](apps/server/src/modules/files/service.ts)

1. **先上传**：`POST /api/v1/files` 按该字段的配置限制大小和类型；类型**以文件头（magic bytes）为准**，伪装成 PDF 的图片会被拒绝。
2. **提交只带引用**：`resume: [{ "fileId": "..." }]`。校验器拒绝任何内嵌的文件内容，数据库里的 Submission JSON 不存二进制。
3. **绑定**：提交时在同一个事务里校验文件归属（同一表单、同一字段、没有被别的提交占用），防止拿别人的 fileId 冒用。
4. **存储**：文件放在 Web 根目录之外，随机文件名、无扩展名、权限 600，数据库记录 SHA-256；Nginx 不会直接对外提供这些文件。
5. **下载**：HR 登录后换取 5 分钟有效的 HMAC 签名链接；响应带 `Content-Disposition: attachment` 和 `nosniff`；身份证这类敏感文件每次取链接都记审计。
6. **清理**：候选人上传后放弃提交的孤儿文件，24 小时后由后台任务删除。
7. **生产建议**：存储层换成 S3 私有桶 + KMS 加密 + 预签名 URL，流程不变。

### Q4 生命周期钩子与插件 — [`modules/hooks/`](apps/server/src/modules/hooks)

```ts
type SubmissionPlugin = {
  id: string;
  beforeValidate?(ctx): FormData;        // 同步：规范化数据
  beforeSave?(ctx): void;                // 同步：抛错可拒绝提交
  afterSave?(job, deps): Promise<...>;   // 异步：经 outbox 执行，失败重试
};
```

- 每个表单在 Schema 的 `hooks` 里声明启用哪些插件；新增插件只需实现接口并注册，通用接口不用改。
- `afterSave` 采用 **Outbox 模式**：提交事务里只写一条 outbox 记录，后台任务认领后执行，失败按 10s、20s、40s…… 指数退避重试，5 次后标记失败，可在后台手动重试。第三方系统慢或者挂掉，都不会拖慢或回滚候选人的提交；进程崩溃也不会丢任务（认领带租约）。
- 内置插件：`trim_strings`（去首尾空格）、`dingtalk_notify`（配置 `DINGTALK_WEBHOOK` 后真实发送，否则只记录内容）、`contract_pdf`（**真实生成**带中文的入职确认书 PDF，挂到该提交下供 HR 下载）、`attendance_sync`（模拟）。

### Q5 并发修改 — [`forms/service.ts`](apps/server/src/modules/forms/service.ts)、[`http.ts`](apps/server/src/http.ts)

两个 HR 都读到同一版本，A 先保存并发布，B 再提交：

- 读取时返回 `ETag: "<lock_version>"`，修改时**必须**带 `If-Match`：缺失返回 **428**，不匹配返回 **409**。
- 数据库层用 `UPDATE ... WHERE lock_version = $expected`，在 `SELECT ... FOR UPDATE` 的事务里执行，没有竞态窗口。
- 409 响应告诉 B：谁在什么时候改的、当前已经发布到哪个版本、B 的草稿和最新草稿差在哪（字段级差异），界面上让 B 选择“加载最新”或“确认以我的为准”。
- 发布时再检查一次“草稿是基于当前最新发布版本编辑的”，作为第二道保险。
- 提交数据的修改、删除也是同样的机制（集成测试覆盖了 A/B 场景）。

### Q6 审计日志 — [`modules/audit/`](apps/server/src/modules/audit)

- 记录谁（操作人、IP）、什么时候、做了什么，以及**字段级的前后值**：`expectedSalary: 30000 → 35000`。
- 和业务数据**在同一个事务里写入**：改了数据就一定有审计，回滚了就一定没有。
- **只允许追加**：数据库触发器禁止 UPDATE 和 DELETE（有测试验证）。
- 旧版本数据升级时，先映射到新版本再比较，改名的字段不会被误记成“删除 + 新增”。
- Schema 里标了 `sensitive` 的字段（手机号、薪资、证件号），普通 HR 看到的是脱敏值（`3***0`），管理员可以看原值。
- 覆盖范围：表单创建、草稿保存、发布、停用；提交的新建、修改、删除；文件上传、敏感文件访问。

---

## 部署

客户提供的 AWS 实例（2 核、908MB 内存）上，不用 Docker，以节省内存：

- `deploy/setup-server.sh`（一次性）：2G swap、Node.js、PostgreSQL（`shared_buffers=64MB` 等调小参数）、Nginx、Let's Encrypt 证书、专用运行用户、随机生成的数据库密码和密钥。
- `deploy/deploy.sh`：本地跑检查和测试 → 后端用 esbuild 打成单文件、前端构建成静态文件 → 上传 → 重启 systemd 服务 → 健康检查。服务器上不需要 `node_modules`。
- Nginx 提供静态文件，`/api` 反代到只监听 127.0.0.1 的 Node；公开接口限流；后端只信任本机代理传来的 `X-Forwarded-For`。

## 代码质量

- TypeScript 严格模式（含 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`），全仓库禁用 `any`。
- Biome 统一格式和 lint，`pnpm check` 零警告。
- 外部输入一律先当 `unknown`：Schema 先过结构检查（`checkSchemaShape`），请求体经校验器收窄后才使用。
- 统一错误格式与状态码：400 参数错误、401 未登录、404 不存在、409 冲突、413 文件过大、415 类型不符、422 校验失败、428 缺少 If-Match。

## 有意没做的部分

- 拖拽式可视化编辑器：Form Builder 提供字段树、属性编辑、实时预览，联动规则和插件通过 JSON 编辑；拖拽交互不是本题重点。
- 多租户和细粒度权限：只区分 HR 和管理员两个角色。
- 第三方集成（钉钉、考勤）是接口和重试机制完整的模拟实现，配置真实地址即可接入。
