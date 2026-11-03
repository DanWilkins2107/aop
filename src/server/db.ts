import Database from "better-sqlite3";
import { migrations } from "./migrations.js";
import { dbPath } from "./paths.js";

export type Db = Database.Database;

const projectBeingDeleted = new WeakMap<Db, string>();

/**
 * Runs `work` in one transaction, during which the delete guards on nodes, messages and events let
 * through this project's rows and still refuse every other project's.
 */
export function allowProjectDeletion<T>(db: Db, projectId: string, work: () => T): T {
  projectBeingDeleted.set(db, projectId);
  try {
    return db.transaction(work)();
  } finally {
    projectBeingDeleted.delete(db);
  }
}

/** The folder must already exist: creating `~/.aop` is the job of `aop init`, not the server. */
export function openDb(file: string = dbPath()): Db {
  const db = new Database(file);
  try {
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    db.function("aop_project_being_deleted", { deterministic: false }, () => projectBeingDeleted.get(db) ?? null);
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
  for (const { version, sql, foreignKeysOff } of migrations) {
    if (version <= current) continue;
    // SQLite ignores this pragma inside a transaction.
    if (foreignKeysOff) db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(sql);
        if ((db.pragma("foreign_key_check") as unknown[]).length > 0) {
          throw new Error(`Migration ${version} would break foreign keys`);
        }
        db.pragma(`user_version = ${version}`);
      })();
    } finally {
      if (foreignKeysOff) db.pragma("foreign_keys = ON");
    }
  }
}
