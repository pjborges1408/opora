import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type Row = Record<string, any>;
export const now = () => new Date().toISOString();
export const today = () => new Intl.DateTimeFormat('en-CA', {timeZone: 'America/Sao_Paulo'}).format(new Date());
export const id = () => randomUUID();
export class Store {
  db: DatabaseSync;
  depth = 0;
  constructor(path: string) {
    if(path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
    if(!this.all('PRAGMA table_info(decisions)').some(c=>c.name==='snapshot_json'))this.db.exec("ALTER TABLE decisions ADD COLUMN snapshot_json TEXT NOT NULL DEFAULT '{}'");
    // Only read-only and idempotent internal analysis jobs are recoverable after interruption.
    this.run("UPDATE jobs SET status='pending' WHERE status='running' AND type IN ('diagnostics','research')");
    this.run("UPDATE research SET status='pending' WHERE status='running'");
  }
  all(sql: string, ...params: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...params); }
  get(sql: string, ...params: SQLInputValue[]): Row | undefined { return this.db.prepare(sql).get(...params); }
  run(sql: string, ...params: SQLInputValue[]) { return this.db.prepare(sql).run(...params); }
  transaction<T>(fn: () => T): T {
    const savepoint = `opora_${this.depth++}`;
    const nested = this.depth > 1;
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT'); return result; }
    catch(error) { this.db.exec(nested ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK'); if(nested)this.db.exec(`RELEASE ${savepoint}`); throw error; }
    finally { this.depth--; }
  }
  event(type: string, entity: string, action: string, before: unknown, after: unknown, impacts: string[] = []) {
    this.run('INSERT INTO events(id,entity_type,entity_id,action,before_json,after_json,impacts_json,created_at) VALUES(?,?,?,?,?,?,?,?)',id(),type,entity,action,JSON.stringify(before ?? null),JSON.stringify(after ?? null),JSON.stringify(impacts),now());
  }
  close() { this.db.close(); }
}
