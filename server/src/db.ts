import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const DB_PATH = join(process.cwd(), 'data', 'flowmate-v3.sqlite')

export function createDatabase() {
  mkdirSync(dirname(DB_PATH), { recursive: true })
  const database = new DatabaseSync(DB_PATH)
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      state TEXT NOT NULL,
      creator_id TEXT NOT NULL,
      req_owner_id TEXT NOT NULL,
      pm_id TEXT NOT NULL,
      frontend_dev_id TEXT NOT NULL,
      backend_dev_id TEXT NOT NULL,
      tester_id TEXT NOT NULL DEFAULT '',
      frontend_repo TEXT NOT NULL DEFAULT '',
      backend_repo TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_stages (
      task_id TEXT NOT NULL,
      stage_key TEXT NOT NULL,
      branch TEXT NOT NULL,
      stage_order INTEGER NOT NULL,
      status TEXT NOT NULL,
      run_count INTEGER NOT NULL DEFAULT 0,
      extra_prompt TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      artifact_json TEXT NOT NULL DEFAULT '',
      pending_note TEXT NOT NULL DEFAULT '',
      active_run_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (task_id, stage_key, branch),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS stage_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      stage_key TEXT NOT NULL,
      branch TEXT NOT NULL,
      run_index INTEGER NOT NULL,
      status TEXT NOT NULL,
      executor_id TEXT NOT NULL,
      agent_name TEXT NOT NULL DEFAULT '',
      model_id TEXT NOT NULL DEFAULT '',
      effort TEXT NOT NULL DEFAULT '',
      fast_mode TEXT NOT NULL DEFAULT '',
      extra_prompt TEXT NOT NULL DEFAULT '',
      process_json TEXT NOT NULL,
      artifact_json TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      reveal_interval_ms INTEGER NOT NULL DEFAULT 700,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS clarifications (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      question TEXT NOT NULL,
      options_json TEXT NOT NULL,
      answer TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      answered_by TEXT,
      answered_at TEXT,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS verifications (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      result TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      operator_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS timeline_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      stage_key TEXT,
      branch TEXT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      actor_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS testing_bugs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      target TEXT NOT NULL,
      detail TEXT NOT NULL,
      status TEXT NOT NULL,
      reporter_id TEXT NOT NULL,
      frontend_fixed_by TEXT NOT NULL DEFAULT '',
      frontend_fixed_at TEXT,
      backend_fixed_by TEXT NOT NULL DEFAULT '',
      backend_fixed_at TEXT,
      closed_by TEXT,
      closed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_stage_runs_task ON stage_runs(task_id, stage_key, branch, run_index DESC);
    CREATE INDEX IF NOT EXISTS idx_timeline_task ON timeline_events(task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_testing_bugs_task ON testing_bugs(task_id, seq DESC);
  `)
  ensureColumn(database, 'tasks', 'tester_id', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(database, 'stage_runs', 'agent_name', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(database, 'stage_runs', 'model_id', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(database, 'stage_runs', 'effort', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(database, 'stage_runs', 'fast_mode', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(database, 'stage_runs', 'error_message', "TEXT NOT NULL DEFAULT ''")
  return database
}

function ensureColumn(database: DatabaseSync, table: string, column: string, definition: string) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>
  if (columns.some((entry) => entry.name === column)) {
    return
  }
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

export function withTransaction<T>(database: DatabaseSync, callback: () => T) {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = callback()
    database.exec('COMMIT')
    return result
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}
