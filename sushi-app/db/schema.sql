-- 寿司メニュー提案アプリ スキーマ
-- trends / knowledge_notes はリサーチ担当・アルセウスが書き込み、アプリが読む。
-- proposals / feedback はアプリが書き込み、ゴース（検証担当）が読む。

CREATE TABLE IF NOT EXISTS shops (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,          -- 店舗コード（ログインに使う）
  name        TEXT NOT NULL,
  concept     TEXT,                          -- お店のコンセプト（店舗が最初に登録する）
  features    TEXT NOT NULL DEFAULT '[]',    -- 特徴（JSON 配列）
  price_per_guest INTEGER,                   -- 客単価（円）
  price_band  TEXT,                          -- 客単価から決まる価格帯（src/shop-profile.ts）
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- リサーチで集めたメニュートレンド（他店の文章はそのまま保存せず、傾向として要約する）
CREATE TABLE IF NOT EXISTS trends (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  category     TEXT NOT NULL CHECK (category IN ('nigiri','dish','both')),
  title        TEXT NOT NULL,                -- 傾向の見出し（例: 熟成魚×柑橘の握り）
  summary      TEXT NOT NULL,                -- 傾向の要約
  ingredients  TEXT NOT NULL DEFAULT '[]',   -- JSON 配列
  techniques   TEXT NOT NULL DEFAULT '[]',   -- JSON 配列
  season       TEXT,                         -- spring/summer/autumn/winter/all
  region       TEXT,
  price_band   TEXT,                         -- どの価格帯のお店の流行か（NULL は価格帯を問わない）
  source_type  TEXT NOT NULL CHECK (source_type IN ('sns','web','sample')),
  source_url   TEXT,
  collected_by TEXT,                         -- 書き込んだエージェント
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  observed_at  TEXT NOT NULL DEFAULT (date('now','localtime')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_trends_active ON trends(status, category, observed_at);

-- アルセウスがまとめる素材・技法の知識
CREATE TABLE IF NOT EXISTS knowledge_notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  topic       TEXT NOT NULL,                 -- ingredient / technique / season / pairing
  subject     TEXT NOT NULL,                 -- 例: 秋刀魚
  body        TEXT NOT NULL,
  confidence  REAL NOT NULL DEFAULT 0.5,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS proposals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id     INTEGER NOT NULL REFERENCES shops(id),
  ingredients TEXT NOT NULL,                 -- JSON 配列
  category    TEXT NOT NULL CHECK (category IN ('nigiri','dish')),
  notes       TEXT,
  result      TEXT NOT NULL,                 -- JSON（提案3件）
  trend_ids   TEXT NOT NULL DEFAULT '[]',
  experiment_ids TEXT NOT NULL DEFAULT '[]', -- 提案時に効いていた実験（menu_hypotheses.id）
  mode        TEXT NOT NULL CHECK (mode IN ('live','demo')),
  model       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_proposals_shop ON proposals(shop_id, created_at);

-- 学習ループの状態（ゲンガー集団が書く）。行は消さず status を進める。
--   hypothesis(proposed) → experiment(executing) → validated/falsified/inconclusive
--   validated は playbook、falsified は anti_pattern として新しい行に昇華する
-- experiment(executing) の action がアプリの「提案方針」として AI に渡される。
CREATE TABLE IF NOT EXISTS menu_hypotheses (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  kind               TEXT NOT NULL CHECK (kind IN ('hypothesis','experiment','playbook','anti_pattern')),
  status             TEXT NOT NULL CHECK (status IN ('proposed','executing','validated','falsified','inconclusive','retired','active')),
  category           TEXT NOT NULL CHECK (category IN ('nigiri','dish','both')),
  title              TEXT NOT NULL,
  statement          TEXT NOT NULL,          -- 仮説（〜すると〜が上がる）
  evidence           TEXT NOT NULL,          -- 根拠（トレンド id・評価の集計など）
  action             TEXT NOT NULL,          -- アプリの AI に渡す提案方針（職人向けの具体的な指示文）
  metric             TEXT NOT NULL CHECK (metric IN ('positive_rate','adoption_rate')),
  baseline           REAL NOT NULL,          -- 施策前の値（0〜1）
  target             REAL NOT NULL,          -- 目標値（0〜1）
  min_samples        INTEGER NOT NULL DEFAULT 10,
  follow_up_schedule TEXT NOT NULL,          -- JSON: [{"at":"T+3d"},{"at":"T+7d","final":true}]
  follow_up_results  TEXT NOT NULL DEFAULT '[]',
  score              REAL,                   -- 選抜時の点数
  trend_ids          TEXT NOT NULL DEFAULT '[]',
  parent_id          INTEGER REFERENCES menu_hypotheses(id),
  created_by         TEXT NOT NULL,
  started_at         TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_menu_hyp_state ON menu_hypotheses(kind, status, category);

-- 検証できない仮説は作れない
CREATE TRIGGER IF NOT EXISTS menu_hypotheses_contract
BEFORE INSERT ON menu_hypotheses
FOR EACH ROW WHEN NEW.kind = 'hypothesis'
BEGIN
  SELECT CASE
    WHEN trim(NEW.statement) = '' OR trim(NEW.evidence) = '' OR trim(NEW.action) = ''
      THEN RAISE(ABORT, 'hypothesis: statement / evidence / action は必須です')
    WHEN NEW.baseline < 0 OR NEW.baseline > 1 OR NEW.target < 0 OR NEW.target > 1
      THEN RAISE(ABORT, 'hypothesis: baseline / target は 0〜1 の割合で書いてください')
    WHEN NEW.target <= NEW.baseline
      THEN RAISE(ABORT, 'hypothesis: target は baseline より大きくしてください')
    WHEN json_array_length(NEW.follow_up_schedule) < 2
      THEN RAISE(ABORT, 'hypothesis: follow_up_schedule は最低2点（途中確認と最終判定）必要です')
  END;
END;

-- 同時に走らせる実験は各カテゴリ 2 件まで（効果が混ざるのを防ぐ）
CREATE TRIGGER IF NOT EXISTS menu_hypotheses_experiment_cap
BEFORE UPDATE OF status ON menu_hypotheses
FOR EACH ROW WHEN NEW.status = 'executing' AND OLD.status <> 'executing'
BEGIN
  SELECT CASE
    WHEN (SELECT COUNT(*) FROM menu_hypotheses
           WHERE status = 'executing' AND id <> NEW.id
             AND (category = NEW.category OR category = 'both' OR NEW.category = 'both')) >= 2
      THEN RAISE(ABORT, 'experiment: このカテゴリで実行中の実験がすでに2件あります')
  END;
END;

-- 職人の評価（学習ループの材料）
CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id INTEGER NOT NULL REFERENCES proposals(id),
  dish_index  INTEGER NOT NULL,
  rating      TEXT NOT NULL CHECK (rating IN ('adopted','tried','not_fit')),
  comment     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (proposal_id, dish_index)
);

-- 提案メニューのイメージ画像（職人が「イメージ画像を見る」を押したときだけ作る）
CREATE TABLE IF NOT EXISTS dish_images (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id INTEGER NOT NULL REFERENCES proposals(id),
  dish_index  INTEGER NOT NULL,
  file        TEXT NOT NULL,               -- images/ フォルダ内のファイル名
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (proposal_id, dish_index)
);
