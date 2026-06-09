import Database from 'better-sqlite3';

export type TekonDatabase = Database.Database;

export interface OpenTekonDatabaseOptions {
  filename: string;
}

export function openTekonDatabase(
  options: OpenTekonDatabaseOptions,
): TekonDatabase {
  const db = new Database(options.filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}
