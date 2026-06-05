import Database from 'better-sqlite3';

export type DonkeyDatabase = Database.Database;

export interface OpenDonkeyDatabaseOptions {
  filename: string;
}

export function openDonkeyDatabase(
  options: OpenDonkeyDatabaseOptions,
): DonkeyDatabase {
  const db = new Database(options.filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}
