import { HOPPER, INVENTORY_CAPACITY, RESOURCE_VALUES, type HistogramSummary, type MetricBucket, type PhysicalAction, type PublicMiner, type RunRecord, type WorldEvent } from '../shared/protocol';

/** Called by Mine inside its construction-time storage transaction. */
export function initializeSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS cg_run (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cg_tiles (
      key INTEGER PRIMARY KEY,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      terrain TEXT NOT NULL CHECK (terrain IN ('floor', 'rock', 'coal', 'diamond')),
      visible INTEGER NOT NULL CHECK (visible IN (0, 1)),
      available INTEGER NOT NULL CHECK (available >= 0),
      reserved INTEGER NOT NULL CHECK (reserved >= 0),
      UNIQUE (x, y)
    );
    CREATE INDEX IF NOT EXISTS cg_tiles_visible ON cg_tiles (visible);
    CREATE TABLE IF NOT EXISTS cg_miners (
      agent_id TEXT PRIMARY KEY NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cg_actions (
      action_id TEXT PRIMARY KEY NOT NULL,
      effect_id TEXT NOT NULL UNIQUE,
      agent_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('walk_to', 'mine')),
      generation INTEGER NOT NULL,
      target_key INTEGER NOT NULL,
      ends_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('accepted', 'completed', 'cancelled')),
      data TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS cg_actions_active_miner
      ON cg_actions (agent_id) WHERE status = 'accepted';
    CREATE UNIQUE INDEX IF NOT EXISTS cg_actions_active_target
      ON cg_actions (target_key) WHERE status = 'accepted' AND kind = 'mine';
    CREATE INDEX IF NOT EXISTS cg_actions_deadline ON cg_actions (status, ends_at);
    CREATE TABLE IF NOT EXISTS cg_receipts (
      operation_id TEXT PRIMARY KEY NOT NULL,
      fingerprint TEXT NOT NULL,
      result TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cg_events (
      revision INTEGER PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cg_deliveries (
      miner_id TEXT PRIMARY KEY NOT NULL,
      desired_revision INTEGER NOT NULL,
      reasons TEXT NOT NULL,
      next_attempt_at INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
      created_at INTEGER NOT NULL,
      grant TEXT
    );
    CREATE INDEX IF NOT EXISTS cg_deliveries_deadline ON cg_deliveries (next_attempt_at);
    CREATE TABLE IF NOT EXISTS cg_messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT NOT NULL,
      audience TEXT NOT NULL CHECK (audience IN ('mine', 'agent')),
      recipient TEXT,
      body TEXT NOT NULL,
      at_key INTEGER,
      revision INTEGER NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cg_messages_recipient ON cg_messages (recipient, sequence);
    CREATE INDEX IF NOT EXISTS cg_messages_sender ON cg_messages (sender, timestamp);
    CREATE TABLE IF NOT EXISTS cg_model_queue (
      miner_id TEXT PRIMARY KEY NOT NULL,
      generation INTEGER NOT NULL,
      burst_id TEXT NOT NULL,
      eligible_at INTEGER NOT NULL,
      ordinal INTEGER NOT NULL UNIQUE,
      queued_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cg_model_queue_eligible ON cg_model_queue (eligible_at, ordinal);
    CREATE TABLE IF NOT EXISTS cg_model_calls (
      grant_id TEXT PRIMARY KEY NOT NULL,
      invocation_id TEXT UNIQUE,
      miner_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      burst_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      claimed_at INTEGER,
      expires_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('granted', 'claimed', 'unknown', 'settled', 'unused')),
      reservation INTEGER NOT NULL CHECK (reservation >= 0),
      input_tokens INTEGER CHECK (input_tokens >= 0),
      output_tokens INTEGER CHECK (output_tokens >= 0),
      cache_read_tokens INTEGER CHECK (cache_read_tokens >= 0),
      charged INTEGER NOT NULL DEFAULT 0 CHECK (charged >= 0),
      settlement TEXT
    );
    CREATE INDEX IF NOT EXISTS cg_model_calls_deadline ON cg_model_calls (state, expires_at);
    CREATE INDEX IF NOT EXISTS cg_model_calls_claimed ON cg_model_calls (claimed_at);
    CREATE TABLE IF NOT EXISTS cg_samples (
      second INTEGER PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cg_counters (
      name TEXT PRIMARY KEY NOT NULL,
      value INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cg_histograms (
      name TEXT NOT NULL,
      bucket INTEGER NOT NULL CHECK (bucket >= 0 AND bucket < 32),
      count INTEGER NOT NULL CHECK (count >= 0),
      PRIMARY KEY (name, bucket)
    );
    CREATE TABLE IF NOT EXISTS cg_schema_migrations (
      version INTEGER PRIMARY KEY
    );
  `).toArray();
  migrateResources(sql);
  migrateInventories(sql);
}

/** Versioned with the table rebuild and JSON backfill in the constructor's transaction. */
function migrateResources(sql: SqlStorage): void {
  if (sql.exec('SELECT version FROM cg_schema_migrations WHERE version=1').toArray().length) return;
  const definition = sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name='cg_tiles'").toArray()[0]!.sql;
  if (!definition.includes("'diamond'") || /reserved\s*<=\s*5/i.test(definition)) {
    const indexes = sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='cg_tiles' AND sql IS NOT NULL ORDER BY name").toArray();
    sql.exec(`
      CREATE TABLE cg_tiles_resources (
        key INTEGER PRIMARY KEY,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        terrain TEXT NOT NULL CHECK (terrain IN ('floor', 'rock', 'coal', 'diamond')),
        visible INTEGER NOT NULL CHECK (visible IN (0, 1)),
        available INTEGER NOT NULL CHECK (available >= 0),
        reserved INTEGER NOT NULL CHECK (reserved >= 0),
        UNIQUE (x, y)
      );
      INSERT INTO cg_tiles_resources SELECT key,x,y,terrain,visible,available,reserved FROM cg_tiles;
      DROP TABLE cg_tiles;
      ALTER TABLE cg_tiles_resources RENAME TO cg_tiles;
    `).toArray();
    for (const index of indexes) sql.exec(index.sql).toArray();
  }
  const totals = sql.exec<{ available: number; reserved: number }>("SELECT COALESCE(SUM(available),0) available,COALESCE(SUM(reserved),0) reserved FROM cg_tiles WHERE terrain='diamond'").toArray()[0]!;
  let minedDiamonds = 0;
  for (const row of sql.exec<{ agent_id: string; data: string }>('SELECT agent_id,data FROM cg_miners').toArray()) {
    const miner = JSON.parse(row.data) as PublicMiner;
    minedDiamonds += miner.diamonds ?? 0;
    if (miner.diamonds === undefined) {
      miner.diamonds = 0;
      sql.exec('UPDATE cg_miners SET data=? WHERE agent_id=?', JSON.stringify(miner), row.agent_id).toArray();
    }
  }
  const row = sql.exec<{ data: string }>('SELECT data FROM cg_run WHERE id=1').toArray()[0];
  if (row) {
    const run = JSON.parse(row.data) as RunRecord;
    run.availableDiamonds ??= totals.available;
    run.reservedDiamonds ??= totals.reserved;
    run.minedDiamonds ??= minedDiamonds;
    run.initialDiamonds ??= run.availableDiamonds + run.reservedDiamonds + run.minedDiamonds;
    sql.exec('UPDATE cg_run SET data=? WHERE id=1', JSON.stringify(run)).toArray();
  }
  for (const row of sql.exec<{ second: number; data: string }>('SELECT second,data FROM cg_samples').toArray()) {
    const sample = JSON.parse(row.data) as MetricBucket;
    sample.diamonds ??= 0;
    sample.value ??= sample.coal * RESOURCE_VALUES.coal + sample.diamonds * RESOURCE_VALUES.diamond;
    sql.exec('UPDATE cg_samples SET data=? WHERE second=?', JSON.stringify(sample), row.second).toArray();
  }
  sql.exec('INSERT INTO cg_schema_migrations(version) VALUES(1)').toArray();
}

/** Historic extraction credit is already banked; oversized pending claims refund once. */
function migrateInventories(sql: SqlStorage): void {
  if (sql.exec('SELECT version FROM cg_schema_migrations WHERE version=2').toArray().length) return;
  const row = sql.exec<{ data: string }>('SELECT data FROM cg_run WHERE id=1').toArray()[0];
  if (row) {
    const run = JSON.parse(row.data) as RunRecord;
    const now = Date.now();
    let carriedCoal = 0;
    let carriedDiamonds = 0;
    for (const row of sql.exec<{ agent_id: string; data: string }>('SELECT agent_id,data FROM cg_miners').toArray()) {
      const miner = JSON.parse(row.data) as PublicMiner;
      miner.inventory ??= { coal: 0, diamonds: 0 };
      carriedCoal += miner.inventory.coal;
      carriedDiamonds += miner.inventory.diamonds;
      const pending = sql.exec<{ data: string }>("SELECT data FROM cg_actions WHERE agent_id=? AND kind='mine' AND status='accepted'", row.agent_id).toArray()[0];
      if (pending) {
        const action = JSON.parse(pending.data) as PhysicalAction;
        if (action.quantity + miner.inventory.coal + miner.inventory.diamonds > INVENTORY_CAPACITY) {
          const resource = action.resource ?? 'coal';
          sql.exec('UPDATE cg_tiles SET available=available+?,reserved=reserved-? WHERE x=? AND y=?', action.quantity, action.quantity, action.target.x, action.target.y).toArray();
          if (resource === 'diamond') { run.availableDiamonds += action.quantity; run.reservedDiamonds -= action.quantity; }
          else { run.availableCoal += action.quantity; run.reservedCoal -= action.quantity; }
          action.resource = resource;
          action.status = 'cancelled';
          action.result = { cancelled: true, resource };
          sql.exec("UPDATE cg_actions SET status='cancelled',data=? WHERE action_id=?", JSON.stringify(action), action.actionId).toArray();
          miner.activeAction = undefined;
          miner.state = miner.retired ? 'retired' : run.mode === 'running' ? 'idle' : 'paused';
          sql.exec("INSERT INTO cg_counters(name,value) VALUES('actionCancellations',1) ON CONFLICT(name) DO UPDATE SET value=value+1").toArray();
        }
      }
      sql.exec('UPDATE cg_miners SET data=? WHERE agent_id=?', JSON.stringify(miner), row.agent_id).toArray();
    }
    run.hopper ??= { ...HOPPER, coal: run.minedCoal - carriedCoal, diamonds: run.minedDiamonds - carriedDiamonds };
    sql.exec('UPDATE cg_tiles SET visible=1 WHERE x=? AND y=?', run.hopper.x, run.hopper.y).toArray();
    run.revision++;
    run.flushAt = now;
    run.sweepAt = now;
    const event: WorldEvent = { revision: run.revision, timestamp: now, type: 'control', summary: 'Three-rock inventories and shared coal hopper enabled', changes: [], invalidation: true };
    sql.exec('INSERT INTO cg_events(revision,timestamp,type,data) VALUES(?,?,?,?)', run.revision, now, event.type, JSON.stringify(event)).toArray();
    sql.exec('UPDATE cg_run SET data=? WHERE id=1', JSON.stringify(run)).toArray();
  }
  sql.exec('INSERT INTO cg_schema_migrations(version) VALUES(2)').toArray();
}

const HISTOGRAM_BUCKETS = 32;

/** Bucket zero covers [0, 1] ms; subsequent buckets have power-of-two ceilings. */
export function bucketIndex(milliseconds: number): number {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new RangeError('Histogram duration must be finite and nonnegative');
  }
  return Math.min(HISTOGRAM_BUCKETS - 1, Math.ceil(Math.log2(Math.max(1, milliseconds))));
}

export function histogramSummary(buckets: readonly number[]): HistogramSummary {
  const counts = Array.from({ length: HISTOGRAM_BUCKETS }, (_, index) => buckets[index] ?? 0);
  const count = counts.reduce((total, value) => total + value, 0);
  const percentile = (fraction: number): number | null => {
    if (count === 0) return null;
    const rank = Math.ceil(count * fraction);
    let cumulative = 0;
    for (let index = 0; index < HISTOGRAM_BUCKETS; index++) {
      cumulative += counts[index]!;
      if (cumulative >= rank) {
        // The final bucket includes overflow; use a finite, JSON-safe upper bound.
        return index === HISTOGRAM_BUCKETS - 1 ? Number.MAX_VALUE : 2 ** index;
      }
    }
    return null;
  };
  return { count, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), buckets: counts };
}

type SamplePatch = Partial<Omit<MetricBucket, 'second'>>;

/** Synchronous storage-only helpers; the caller owns the enclosing transaction. */
export class MetricsStore {
  constructor(private readonly sql: SqlStorage) {}

  increment(name: string, amount = 1): void {
    this.sql.exec(
      `INSERT INTO cg_counters (name, value) VALUES (?, ?)
       ON CONFLICT (name) DO UPDATE SET value = value + excluded.value`,
      name, amount,
    ).toArray();
  }

  count(name: string): number {
    return this.sql.exec<{ value: number }>(
      'SELECT value FROM cg_counters WHERE name = ?', name,
    ).toArray()[0]?.value ?? 0;
  }

  histogram(name: string, duration: number): void {
    this.sql.exec(
      `INSERT INTO cg_histograms (name, bucket, count) VALUES (?, ?, 1)
       ON CONFLICT (name, bucket) DO UPDATE SET count = count + 1`,
      name, bucketIndex(duration),
    ).toArray();
  }

  summary(name: string): HistogramSummary {
    const buckets = new Array<number>(HISTOGRAM_BUCKETS).fill(0);
    for (const row of this.sql.exec<{ bucket: number; count: number }>(
      'SELECT bucket, count FROM cg_histograms WHERE name = ?', name,
    ).toArray()) {
      buckets[row.bucket] = row.count;
    }
    return histogramSummary(buckets);
  }

  sample(patch: SamplePatch, now = Date.now()): void {
    const second = Math.floor(now / 1000);
    const previous = this.sql.exec<{ data: string }>(
      'SELECT data FROM cg_samples WHERE second = ?', second,
    ).toArray()[0];
    const sample: MetricBucket = previous
      ? JSON.parse(previous.data) as MetricBucket
      : { second, calls: 0, coal: 0, diamonds: 0, value: 0, errors: 0, toolRPCs: 0, deliveryMs: 0 };
    sample.calls += patch.calls ?? 0;
    sample.coal += patch.coal ?? 0;
    sample.diamonds += patch.diamonds ?? 0;
    sample.value += patch.value ?? 0;
    sample.errors += patch.errors ?? 0;
    sample.toolRPCs += patch.toolRPCs ?? 0;
    sample.deliveryMs += patch.deliveryMs ?? 0;
    this.sql.exec(
      `INSERT INTO cg_samples (second, data) VALUES (?, ?)
       ON CONFLICT (second) DO UPDATE SET data = excluded.data`,
      second, JSON.stringify(sample),
    ).toArray();
    this.sql.exec('DELETE FROM cg_samples WHERE second < ?', second - 3600).toArray();
  }

  recentSamples(now = Date.now()): MetricBucket[] {
    const second = Math.floor(now / 1000);
    return this.sql.exec<{ data: string }>(
      'SELECT data FROM cg_samples WHERE second >= ? AND second <= ? ORDER BY second',
      second - 3600, second,
    ).toArray().map((row) => JSON.parse(row.data) as MetricBucket);
  }

  counters(): Record<string, number> {
    return Object.fromEntries(this.sql.exec<{ name: string; value: number }>(
      'SELECT name, value FROM cg_counters ORDER BY name',
    ).toArray().map((row) => [row.name, row.value]));
  }
}
