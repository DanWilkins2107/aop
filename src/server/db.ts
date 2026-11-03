import Database from "better-sqlite3";
import { migrations } from "./migrations.js";
import { dbPath } from "./paths.js";

export type Db = Database.Database;

/** The folder must already exist: creating `~/.aop` is the job of `aop init`, not the server. */
export function openDb(file: string = dbPath()): Db {
  const db = new Database(file);
  try {
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function migrate(db: Db): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  const latest = migrations.at(-1)?.version ?? 0;
  if (current > latest) {
    throw new Error(`Database is at version ${current}, but this AOP only knows up to ${latest}. Upgrade AOP.`);
  }
  for (const { version, sql } of migrations) {
    if (version <= current) continue;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
    })();
  }
}
