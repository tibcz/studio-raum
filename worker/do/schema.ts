export const MIGRATIONS: string[] = [
  `
  CREATE TABLE team (
    id TEXT PRIMARY KEY,
    team_ref TEXT NOT NULL,
    name TEXT NOT NULL,
    time_zone TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    join_mode TEXT NOT NULL DEFAULT 'approval',
    join_secret_hash TEXT,
    join_secret_rotated_at INTEGER
  );

  CREATE TABLE members (
    user_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('member','admin','owner')),
    is_active INTEGER NOT NULL CHECK (is_active IN (0,1)),
    is_pending INTEGER NOT NULL CHECK (is_pending IN (0,1)),
    can_write INTEGER NOT NULL DEFAULT 1 CHECK (can_write IN (0,1)),
    created_at INTEGER NOT NULL,
    secret_hash TEXT NOT NULL UNIQUE,
    is_placeholder INTEGER NOT NULL DEFAULT 0 CHECK (is_placeholder IN (0,1))
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES members(user_id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE studios (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    subtitle TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
  );

  CREATE TABLE bookings (
    id TEXT PRIMARY KEY,
    studio_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    start_ts INTEGER NOT NULL,
    end_ts INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'occupied' CHECK (state IN ('reserved','occupied')),
    origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','standing','provisional')),
    standing_rule_id TEXT,
    day_request_id TEXT,
    CHECK (start_ts < end_ts),
    CHECK (start_ts % 900 = 0),
    CHECK (end_ts % 900 = 0),
    CHECK (end_ts - start_ts <= 86400)
  );
  CREATE INDEX bookings_studio_start ON bookings(studio_id, start_ts);
  CREATE INDEX bookings_owner ON bookings(owner_user_id);
  CREATE INDEX bookings_standing ON bookings(standing_rule_id);

  CREATE TABLE booking_locks (
    studio_id TEXT NOT NULL,
    slot_ts INTEGER NOT NULL,
    booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    owner_user_id TEXT NOT NULL,
    PRIMARY KEY (studio_id, slot_ts)
  );
  CREATE INDEX booking_locks_booking ON booking_locks(booking_id);

  CREATE TABLE booking_requests (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL,
    studio_id TEXT NOT NULL,
    booking_owner_user_id TEXT NOT NULL,
    requester_user_id TEXT NOT NULL,
    start_ts INTEGER NOT NULL,
    end_ts INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','accepted','declined','cancelled')),
    created_at INTEGER NOT NULL,
    answered_at INTEGER,
    day_request_id TEXT,
    priority INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX booking_requests_booking ON booking_requests(booking_id);
  CREATE INDEX booking_requests_status ON booking_requests(status);
  CREATE INDEX booking_requests_day ON booking_requests(day_request_id);
  CREATE INDEX booking_requests_queue ON booking_requests(booking_id, status, created_at);

  CREATE TABLE activities (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    related_user_ids TEXT NOT NULL DEFAULT '[]',
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX activities_created ON activities(created_at);

  CREATE TABLE rate_limits (
    bucket TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    window_start INTEGER NOT NULL
  );

  CREATE TABLE standing_rules (
    id TEXT PRIMARY KEY,
    studio_id TEXT NOT NULL,
    weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
    member_user_id TEXT NOT NULL,
    start_minute INTEGER NOT NULL CHECK (start_minute >= 0 AND start_minute < 1440),
    end_minute INTEGER NOT NULL CHECK (end_minute > 0 AND end_minute <= 1440),
    state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','occupied')),
    title TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    created_at INTEGER NOT NULL,
    CHECK (start_minute < end_minute)
  );
  CREATE INDEX standing_rules_studio ON standing_rules(studio_id, weekday);

  CREATE TABLE standing_marks (
    rule_id TEXT NOT NULL,
    day_ts INTEGER NOT NULL,
    booking_id TEXT,
    PRIMARY KEY (rule_id, day_ts)
  );
  CREATE INDEX standing_marks_day ON standing_marks(day_ts);

  CREATE TABLE day_requests (
    id TEXT PRIMARY KEY,
    requester_user_id TEXT NOT NULL,
    start_ts INTEGER NOT NULL,
    end_ts INTEGER NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('single','cascade')),
    status TEXT NOT NULL CHECK (status IN ('pending','fulfilled','declined','cancelled')),
    granted_studio_id TEXT,
    provisional_booking_id TEXT,
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    answered_at INTEGER
  );
  CREATE INDEX day_requests_status ON day_requests(status);
  CREATE INDEX day_requests_requester ON day_requests(requester_user_id);

  CREATE TABLE member_prefs (
    user_id TEXT PRIMARY KEY,
    notify_enabled INTEGER NOT NULL DEFAULT 1 CHECK (notify_enabled IN (0,1)),
    notify_vibrate INTEGER NOT NULL DEFAULT 1 CHECK (notify_vibrate IN (0,1)),
    studio_priority TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE push_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);

  CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );
  CREATE INDEX notifications_user ON notifications(user_id, created_at);

  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

export function migrate(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
      id INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const current = sql
    .exec<{ version: number }>("SELECT COALESCE(MAX(id), 0) AS version FROM _sql_schema_migrations")
    .one().version;

  for (let index = current; index < MIGRATIONS.length; index++) {
    sql.exec(MIGRATIONS[index]!);
    sql.exec("INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (?, ?)", index + 1, Date.now());
  }
}
