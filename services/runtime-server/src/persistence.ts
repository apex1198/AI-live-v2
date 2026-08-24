import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class RuntimeDatabase {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    const resolved = filename === ':memory:' ? filename : path.resolve(filename);
    if (resolved !== ':memory:') fs.mkdirSync(path.dirname(resolved), { recursive: true });
    this.db = new DatabaseSync(resolved);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const current = Number(this.db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get()?.version || 0);
    if (current < 1) {
      this.db.exec(`
        BEGIN;
        CREATE TABLE IF NOT EXISTS settings (
          scope TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          root_path TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS avatars (
          id TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS avatar_sessions (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          selected_json TEXT NOT NULL,
          random INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS speech_commands (
          id TEXT PRIMARY KEY,
          text TEXT NOT NULL,
          provider TEXT NOT NULL,
          state TEXT NOT NULL,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'));
        COMMIT;
      `);
    }
  }

  getSetting<T>(scope: string): T | null {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE scope = ?').get(scope) as { value_json?: string } | undefined;
    if (!row?.value_json) return null;
    try { return JSON.parse(row.value_json) as T; } catch { return null; }
  }

  setSetting(scope: string, value: unknown): void {
    this.db.prepare(`
      INSERT INTO settings(scope, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(scope, JSON.stringify(value), new Date().toISOString());
  }

  getActiveProject(): { projectName: string; rootPath: string } | null {
    const row = this.db.prepare('SELECT id, root_path FROM projects WHERE active = 1 LIMIT 1').get() as { id?: string; root_path?: string } | undefined;
    return row?.id && row.root_path ? { projectName: row.id, rootPath: row.root_path } : null;
  }

  setActiveProject(projectName: string, rootPath: string): void {
    const now = new Date().toISOString();
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE projects SET active = 0, updated_at = ? WHERE active = 1').run(now);
      this.db.prepare(`
        INSERT INTO projects(id, root_path, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET root_path = excluded.root_path, active = 1, updated_at = excluded.updated_at
      `).run(projectName, rootPath, now, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listAvatars<T = any>(): T[] {
    return this.db.prepare('SELECT value_json FROM avatars ORDER BY updated_at DESC').all()
      .flatMap((row: any) => { try { return [JSON.parse(String(row.value_json)) as T]; } catch { return []; } });
  }

  upsertAvatar(id: string, value: unknown): void {
    this.db.prepare(`
      INSERT INTO avatars(id, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(id, JSON.stringify(value), new Date().toISOString());
  }

  getAvatarSession(): { selected: string[]; random: boolean } | null {
    const row = this.db.prepare('SELECT selected_json, random FROM avatar_sessions WHERE id = 1').get() as { selected_json?: string; random?: number } | undefined;
    if (!row?.selected_json) return null;
    try {
      const selected = JSON.parse(row.selected_json);
      return { selected: Array.isArray(selected) ? selected.map(String) : [], random: Boolean(row.random) };
    } catch { return null; }
  }

  setAvatarSession(selected: string[], random: boolean): void {
    this.db.prepare(`
      INSERT INTO avatar_sessions(id, selected_json, random, updated_at) VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET selected_json = excluded.selected_json, random = excluded.random, updated_at = excluded.updated_at
    `).run(JSON.stringify(selected), random ? 1 : 0, new Date().toISOString());
  }

  upsertSpeechCommand(command: { id: string; text: string; provider: string; state: string; error?: string | null }): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO speech_commands(id, text, provider, state, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state = excluded.state, error = excluded.error, updated_at = excluded.updated_at
    `).run(command.id, command.text, command.provider, command.state, command.error || null, now, now);
  }

  close(): void {
    this.db.close();
  }
}
