-- 初始表结构。设计说明见仓库 README“数据模型”一节。

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('hr', 'admin')),
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 每个表单一行：只有一份可编辑的草稿，发布后生成 form_versions 中不可修改的版本。
CREATE TABLE forms (
  form_id                   TEXT PRIMARY KEY,
  title                     TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  current_published_version INTEGER,
  draft_schema              JSONB NOT NULL,
  -- 草稿是基于哪个已发布版本编辑的；发布时与 current_published_version 比较，防止覆盖别人刚发布的版本（场景二 Q5）。
  draft_base_version        INTEGER,
  -- 草稿的乐观锁版本号，对应 HTTP ETag / If-Match（场景二 Q5）。
  draft_lock_version        INTEGER NOT NULL DEFAULT 1,
  created_by                INTEGER REFERENCES users (id),
  updated_by                INTEGER REFERENCES users (id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE form_versions (
  form_id      TEXT NOT NULL REFERENCES forms (form_id),
  version      INTEGER NOT NULL CHECK (version > 0),
  schema       JSONB NOT NULL,
  status       TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'archived')),
  change_note  TEXT,
  changes      JSONB NOT NULL DEFAULT '[]',
  published_by INTEGER REFERENCES users (id),
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (form_id, version)
);

-- 场景一 Q2：已发布的 Schema 不允许修改。应用层没有修改接口，数据库再兜底一次。
CREATE FUNCTION forbid_published_schema_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'form_versions 不允许删除（%: v%）', OLD.form_id, OLD.version;
  END IF;
  IF NEW.schema IS DISTINCT FROM OLD.schema
     OR NEW.version <> OLD.version
     OR NEW.form_id <> OLD.form_id THEN
    RAISE EXCEPTION '已发布的 Schema 不允许修改（%: v%），请发布新版本', OLD.form_id, OLD.version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER form_versions_immutable
  BEFORE UPDATE OR DELETE ON form_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_published_schema_change();

CREATE TABLE submissions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id        TEXT NOT NULL,
  -- 提交时使用的 Schema 版本，之后不再变化（除非 HR 编辑并升级到新版本，会记审计）。
  schema_version INTEGER NOT NULL,
  data           JSONB NOT NULL,
  lock_version   INTEGER NOT NULL DEFAULT 1,
  submitter_ip   TEXT,
  created_by     INTEGER REFERENCES users (id),
  updated_by     INTEGER REFERENCES users (id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ,
  FOREIGN KEY (form_id, schema_version) REFERENCES form_versions (form_id, version)
);

CREATE INDEX submissions_form_created_idx ON submissions (form_id, created_at DESC) WHERE deleted_at IS NULL;
-- 场景二 Q1：等值筛选转成 data @> {...}，走 GIN 索引。
CREATE INDEX submissions_data_gin_idx ON submissions USING GIN (data jsonb_path_ops);

-- 场景二 Q3：文件只存元数据，内容在磁盘（生产可换 S3），提交里只保存 fileId。
CREATE TABLE files (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id       TEXT NOT NULL REFERENCES forms (form_id),
  field_key     TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  storage_key   TEXT NOT NULL,
  category      TEXT,
  sensitive     BOOLEAN NOT NULL DEFAULT false,
  submission_id UUID REFERENCES submissions (id),
  uploader_ip   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX files_orphan_idx ON files (created_at) WHERE submission_id IS NULL;

-- 场景二 Q6：审计日志只追加，不允许修改和删除。
CREATE TABLE audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id    INTEGER REFERENCES users (id),
  actor_name  TEXT NOT NULL,
  ip          TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  form_id     TEXT,
  -- 字段级变化：[{ "path": "expectedSalary", "before": 30000, "after": 35000 }]
  changes     JSONB NOT NULL DEFAULT '[]',
  meta        JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, at DESC);
CREATE INDEX audit_logs_form_idx ON audit_logs (form_id, at DESC);

CREATE FUNCTION forbid_audit_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '审计日志只允许追加';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_change();

-- 场景二 Q4：afterSave 钩子先写 outbox，与业务数据同一事务提交，再由后台任务异步执行并重试。
CREATE TABLE outbox (
  id          BIGSERIAL PRIMARY KEY,
  hook        TEXT NOT NULL,
  event       TEXT NOT NULL,
  payload     JSONB NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error  TEXT,
  result      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at     TIMESTAMPTZ
);

CREATE INDEX outbox_pending_idx ON outbox (next_run_at) WHERE status = 'pending';
