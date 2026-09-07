import Database from 'better-sqlite3';

export type TekonDatabase = Database.Database & {
  markClosed: () => void;
  isClosed: () => boolean;
};

export interface OpenTekonDatabaseOptions {
  filename: string;
}

export function openTekonDatabase(
  options: OpenTekonDatabaseOptions,
): TekonDatabase {
  const db = new Database(options.filename) as TekonDatabase;
  let closed = false;

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.markClosed = () => {
    closed = true;
  };
  db.isClosed = () => closed;

  const origPrepare = db.prepare.bind(db);
  // @ts-expect-error - wrapping prepare to enforce write fence when database is closed
  db.prepare = function (source: string) {
    const stmt = origPrepare(source);
    const origRun = stmt.run.bind(stmt);
    stmt.run = function (...args: unknown[]) {
      if (closed) {
        throw new Error('Database is closed for writes (shutdown fence active)');
      }
      return origRun(...args);
    };
    return stmt;
  };

  const origExec = db.exec.bind(db);
  db.exec = function (source: string) {
    if (closed) {
      throw new Error('Database is closed for writes (shutdown fence active)');
    }
    return origExec(source);
  };

  return db;
}
