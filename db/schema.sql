-- 心与规划 · 学习数据 schema（受支持的迁移 SQL 子集）
-- 通过 reviewed migration 提交；accessPolicies 传 []（function_backend 固定私有策略）

CREATE TABLE app.courses (
  id uuid PRIMARY KEY,
  visitor_id uuid NOT NULL,
  name text NOT NULL,
  day integer NOT NULL,
  start_time text NOT NULL,
  end_time text NOT NULL,
  location text NOT NULL,
  teacher text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX courses_visitor_idx ON app.courses (visitor_id);
-- 周次：受支持的迁移子集要求新增列可空且无默认值，
-- 因此 NULL 由 Function 解释为 week_start=1 / week_end=20（全周次）。
ALTER TABLE app.courses ADD COLUMN week_start integer;
ALTER TABLE app.courses ADD COLUMN week_end integer;

CREATE TABLE app.tasks (
  id uuid PRIMARY KEY,
  visitor_id uuid NOT NULL,
  title text NOT NULL,
  subject text NOT NULL,
  due_at text NOT NULL,
  priority text NOT NULL,
  note text NOT NULL,
  status text NOT NULL,
  done_at timestamptz,
  created_at timestamptz NOT NULL
);
CREATE INDEX tasks_visitor_idx ON app.tasks (visitor_id);

CREATE TABLE app.messages (
  id uuid PRIMARY KEY,
  visitor_id uuid NOT NULL,
  agent text NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX messages_visitor_idx ON app.messages (visitor_id);
-- 聊天图片附件：存 Storage 对象路径数组（jsonb），NULL 视为无附件。
ALTER TABLE app.messages ADD COLUMN images jsonb;

CREATE TABLE app.fired (
  id uuid PRIMARY KEY,
  visitor_id uuid NOT NULL,
  fire_key text NOT NULL,
  fired_at timestamptz NOT NULL,
  UNIQUE (visitor_id, fire_key)
);
CREATE INDEX fired_visitor_idx ON app.fired (visitor_id);
