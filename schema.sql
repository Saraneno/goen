-- ============================================================
-- GOEN データベース設計 v2（Koyoi構成参考）
-- 対象: Supabase (PostgreSQL)
-- ============================================================

-- ① ユーザー（審査・本人確認フロー対応）
CREATE TABLE users (
  id              SERIAL PRIMARY KEY,
  line_user_id    TEXT UNIQUE NOT NULL,
  display_name    TEXT,
  gender          TEXT CHECK (gender IN ('male', 'female')),
  age             INTEGER,
  occupation      TEXT,                    -- 職業
  area_pref       TEXT,                    -- よく使うエリア
  profile_comment TEXT,                    -- 自己紹介

  -- 本人確認・審査
  verify_status   TEXT DEFAULT 'pending'
                  CHECK (verify_status IN ('pending','approved','rejected')),
  verify_method   TEXT,                    -- 'sns' | 'id_photo'
  verify_image_url TEXT,                   -- 身分証画像URL（Supabase Storage）
  reject_reason   TEXT,

  -- フラグ
  is_banned       BOOLEAN DEFAULT FALSE,
  ban_reason      TEXT,
  registration_step INTEGER DEFAULT 1,     -- 登録進捗（1〜4）

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ② 飲みリクエスト（希望条件）
CREATE TABLE requests (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  area            TEXT NOT NULL,           -- 恵比寿 / 渋谷 など
  meet_date       DATE NOT NULL,           -- 希望日
  meet_time       TEXT NOT NULL,           -- 例: "20:00"
  num_people      INTEGER NOT NULL DEFAULT 1,
  vibe            TEXT,                    -- ワイワイ / 落ち着き
  partner_age_min INTEGER,                 -- 相手希望年齢（下限）
  partner_age_max INTEGER,                 -- 相手希望年齢（上限）
  message         TEXT,                    -- 一言
  status          TEXT DEFAULT 'waiting'
                  CHECK (status IN ('waiting','matched','cancelled','expired')),
  expires_at      TIMESTAMPTZ,             -- 自動期限（当日23:59など）
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ③ マッチング
CREATE TABLE matches (
  id              SERIAL PRIMARY KEY,
  male_request_id   INTEGER REFERENCES requests(id),
  female_request_id INTEGER REFERENCES requests(id),
  area            TEXT,
  meet_time       TEXT,
  venue_name      TEXT,                    -- 提案店舗名
  venue_address   TEXT,                    -- 提案店舗住所
  venue_url       TEXT,                    -- 食べログ/Google Maps URL
  line_group_id   TEXT,                    -- 生成したLINEグループID
  status          TEXT DEFAULT 'confirmed'
                  CHECK (status IN ('confirmed','completed','cancelled')),
  admin_note      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- マッチング参加ユーザー
CREATE TABLE match_users (
  match_id  INTEGER REFERENCES matches(id) ON DELETE CASCADE,
  user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (match_id, user_id)
);

-- ④ 評価
CREATE TABLE ratings (
  id               SERIAL PRIMARY KEY,
  match_id         INTEGER REFERENCES matches(id) ON DELETE CASCADE,
  rater_id         INTEGER REFERENCES users(id),
  score_fun        INTEGER CHECK (score_fun BETWEEN 1 AND 5),
  score_safe       INTEGER CHECK (score_safe BETWEEN 1 AND 5),
  score_talk       INTEGER CHECK (score_talk BETWEEN 1 AND 5),
  would_meet_again BOOLEAN,
  comment          TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ⑤ チップ
CREATE TABLE tips (
  id           SERIAL PRIMARY KEY,
  match_id     INTEGER REFERENCES matches(id),
  from_user_id INTEGER REFERENCES users(id),
  amount       INTEGER NOT NULL,
  message      TEXT,
  status       TEXT DEFAULT 'pending'
               CHECK (status IN ('pending','paid','refunded')),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ⑥ キャンセル管理
CREATE TABLE cancellations (
  id          SERIAL PRIMARY KEY,
  match_id    INTEGER REFERENCES matches(id),
  user_id     INTEGER REFERENCES users(id),
  reason      TEXT,
  is_late     BOOLEAN DEFAULT FALSE,      -- 当日キャンセルか
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ⑦ 通報
CREATE TABLE reports (
  id           SERIAL PRIMARY KEY,
  reporter_id  INTEGER REFERENCES users(id),
  reported_id  INTEGER REFERENCES users(id),
  reason       TEXT NOT NULL,
  detail       TEXT,
  is_resolved  BOOLEAN DEFAULT FALSE,
  admin_note   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- インデックス
-- ============================================================
CREATE INDEX idx_users_line_id      ON users(line_user_id);
CREATE INDEX idx_users_verify       ON users(verify_status);
CREATE INDEX idx_requests_status    ON requests(status);
CREATE INDEX idx_requests_area_date ON requests(area, meet_date);
CREATE INDEX idx_matches_status     ON matches(status);

-- ============================================================
-- ビュー：審査待ちユーザー
-- ============================================================
CREATE VIEW pending_users AS
  SELECT id, line_user_id, display_name, gender, age,
         occupation, verify_method, verify_image_url, created_at
  FROM users
  WHERE verify_status = 'pending'
  ORDER BY created_at ASC;

-- ============================================================
-- ビュー：マッチング候補（同エリア・同日・異性）
-- ============================================================
CREATE VIEW match_candidates AS
  SELECT
    m.id AS male_req_id,   m.user_id AS male_user_id,
    f.id AS female_req_id, f.user_id AS female_user_id,
    m.area, m.meet_date, m.meet_time, m.vibe,
    m.num_people AS male_num, f.num_people AS female_num
  FROM requests m
  JOIN requests f
    ON  m.area      = f.area
    AND m.meet_date = f.meet_date
    AND m.status    = 'waiting'
    AND f.status    = 'waiting'
  JOIN users mu ON m.user_id = mu.id AND mu.gender = 'male'  AND mu.verify_status = 'approved'
  JOIN users fu ON f.user_id = fu.id AND fu.gender = 'female' AND fu.verify_status = 'approved'
  ORDER BY m.meet_time;
