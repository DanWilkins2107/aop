import { existsSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowProjectDeletion, openDb, type Db } from "../../src/server/db.js";
import { migrations } from "../../src/server/migrations.js";
import { aopHome } from "../../src/server/paths.js";
import { deleteProject } from "../../src/server/projects.js";

let db: Db;
let file: string;
const T = "2026-01-01T00:00:00.000Z";

function project(id: string): void {
  db.prepare("INSERT INTO projects (id, created_at, name, repo_path) VALUES (?, ?, ?, ?)").run(id, T, id, `/repo/${id}`);
}

function node(id: string, projectId = "p1", fields: Record<string, string | null> = {}): void {
  const row: Record<string, string | null> = {
    id,
    created_at: T,
    project_id: projectId,
    title: "t",
    type: "dev",
    stage: "write_spec",
    ...fields,
  };
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO nodes (${columns.join(", ")}) VALUES (${columns.map((c) => `@${c}`).join(", ")})`,
  ).run(row);
}

function edge(id: string, source: string, target: string, kind = "subtask"): void {
  db.prepare("INSERT INTO edges (id, created_at, source_id, target_id, kind) VALUES (?, ?, ?, ?, ?)").run(
    id,
    T,
    source,
    target,
    kind,
  );
}

function event(id: string, data = "{}", actor = "human"): void {
  db.prepare("INSERT INTO events (id, created_at, node_id, actor, kind, data) VALUES (?, ?, 'n1', ?, 'x', ?)").run(
    id,
    T,
    actor,
    data,
  );
}

beforeEach(() => {
  file = join(mkdtempSync(join(aopHome(), "schema-")), "aop.db");
  db = openDb(file);
  project("p1");
  project("p2");
  node("n1");
  node("n2");
});

afterEach(() => db.close());

describe("database setup", () => {
  it("turns on foreign keys and records the migration version", () => {
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("user_version", { simple: true })).toBe(migrations.at(-1)?.version);
  });

  it("reopening doesn't rerun migrations or lose data", () => {
    db.close();
    db = openDb(file);
    expect(db.prepare("SELECT count(*) AS n FROM nodes").get()).toEqual({ n: 2 });
  });

  it("refuses a database newer than this code", () => {
    db.pragma("user_version = 9999");
    db.close();
    expect(() => openDb(file)).toThrow(/Upgrade AOP/);
    const fix = new Database(file);
    fix.pragma(`user_version = ${migrations.at(-1)?.version}`);
    fix.close();
    db = openDb(file);
  });

  it("gives every table an id and created_at", () => {
    for (const table of ["projects", "nodes", "edges", "links", "messages", "events", "runs"]) {
      const columns = db.pragma(`table_info(${table})`) as { name: string; notnull: number; pk: number }[];
      expect(columns.find((c) => c.name === "id")?.pk).toBe(1);
      expect(columns.find((c) => c.name === "created_at")?.notnull).toBe(1);
    }
  });
});

describe("projects", () => {
  it("keeps a set repo_path unique", () => {
    expect(() => db.prepare("INSERT INTO projects VALUES ('p3', ?, 'x', '/repo/p1')").run(T)).toThrow(/UNIQUE/);
  });

  it("lets any number of projects have no repo_path, but not a blank one", () => {
    const insert = db.prepare("INSERT INTO projects (id, created_at, name, repo_path) VALUES (?, ?, 'x', ?)");
    insert.run("none1", T, null);
    insert.run("none2", T, null);
    expect(() => insert.run("blank", T, "")).toThrow(/CHECK/);
  });

  it("still requires a name", () => {
    expect(() => db.prepare("INSERT INTO projects (id, created_at, name) VALUES ('p3', ?, NULL)").run(T)).toThrow(/NOT NULL/);
  });

  it("can't be deleted while it has nodes", () => {
    expect(() => db.prepare("DELETE FROM projects WHERE id = 'p1'").run()).toThrow(/FOREIGN KEY/);
  });
});

describe("nodes", () => {
  it("requires an existing project", () => {
    expect(() => node("x", "missing")).toThrow(/FOREIGN KEY/);
  });

  it("limits the title to 1-200 characters", () => {
    expect(() => node("x", "p1", { title: "" })).toThrow(/CHECK/);
    expect(() => node("x", "p1", { title: "a".repeat(201) })).toThrow(/CHECK/);
    node("x", "p1", { title: "a".repeat(200) });
  });

  it("defaults the body to empty", () => {
    expect(db.prepare("SELECT body FROM nodes WHERE id = 'n1'").get()).toEqual({ body: "" });
  });

  it("requires cron at scheduled", () => {
    expect(() => node("x", "p1", { stage: "scheduled" })).toThrow(/nodes_scheduled_requires_cron/);
    expect(() => node("x", "p1", { stage: "scheduled", cron: "" })).toThrow(/nodes_scheduled_requires_cron/);
    node("x", "p1", { stage: "scheduled", cron: "0 0 * * *" });
    expect(() => db.prepare("UPDATE nodes SET cron = NULL WHERE id = 'x'").run()).toThrow(/CHECK|cron/);
  });

  it("requires a reason at invalidated", () => {
    expect(() => node("x", "p1", { stage: "invalidated" })).toThrow(/nodes_invalidated_requires_reason/);
    expect(() => db.prepare("UPDATE nodes SET stage = 'invalidated' WHERE id = 'n1'").run()).toThrow(
      /nodes_invalidated_requires_reason/,
    );
    node("x", "p1", { stage: "invalidated", invalidation_reason: "why" });
  });

  it("requires return_stage at ask_human_question and failed", () => {
    for (const stage of ["ask_human_question", "failed"]) {
      expect(() => node("x", "p1", { stage })).toThrow(/nodes_waiting_requires_return_stage/);
      node(`ok_${stage}`, "p1", { stage, return_stage: "implement" });
    }
  });

  it("requires return_stage at externally_blocked and splitting, on insert and update", () => {
    for (const stage of ["externally_blocked", "splitting"]) {
      expect(() => node("x", "p1", { stage })).toThrow(/nodes_held_stages_require_return_stage/);
      node(`ok_${stage}`, "p1", { stage, return_stage: "implement" });
      expect(() => db.prepare("UPDATE nodes SET return_stage = NULL WHERE id = ?").run(`ok_${stage}`)).toThrow(
        /nodes_held_stages_require_return_stage/,
      );
    }
    expect(() => db.prepare("UPDATE nodes SET stage = 'splitting' WHERE id = 'n1'").run()).toThrow(
      /nodes_held_stages_require_return_stage/,
    );
  });

  it("limits claimed_by to human, agent or nothing", () => {
    node("h", "p1", { claimed_by: "human" });
    node("a", "p1", { claimed_by: "agent" });
    node("none", "p1", { claimed_by: null });
    for (const holder of ["system", "", "Human"]) {
      expect(() => node("x", "p1", { claimed_by: holder })).toThrow(/nodes_claimed_by_known/);
    }
    expect(() => db.prepare("UPDATE nodes SET claimed_by = 'robot' WHERE id = 'h'").run()).toThrow(/nodes_claimed_by_known/);
  });

  it("allows spawned_by to be null but not dangling", () => {
    node("child", "p1", { spawned_by: "n1" });
    expect(() => node("x", "p1", { spawned_by: "missing" })).toThrow(/FOREIGN KEY/);
  });

  it("are never deleted and can't change project", () => {
    expect(() => db.prepare("DELETE FROM nodes WHERE id = 'n1'").run()).toThrow(/never deleted/);
    expect(() => db.prepare("UPDATE nodes SET project_id = 'p2' WHERE id = 'n1'").run()).toThrow(/change project/);
  });

  it("enforces column types", () => {
    expect(() => db.prepare("UPDATE nodes SET title = x'00' WHERE id = 'n1'").run()).toThrow(/cannot store BLOB/);
  });
});

describe("edges", () => {
  it("refuses an edge from a node to itself", () => {
    expect(() => edge("e", "n1", "n1")).toThrow(/edges_no_self_reference/);
  });

  it("refuses an edge across projects, on insert and update", () => {
    node("other", "p2");
    expect(() => edge("e", "n1", "other")).toThrow(/share a project/);
    edge("e", "n1", "n2");
    expect(() => db.prepare("UPDATE edges SET target_id = 'other' WHERE id = 'e'").run()).toThrow(/share a project/);
  });

  it("refuses a missing endpoint", () => {
    expect(() => edge("e", "n1", "missing")).toThrow();
    expect(db.prepare("SELECT count(*) AS n FROM edges").get()).toEqual({ n: 0 });
  });

  it("limits the kind", () => {
    expect(() => edge("e", "n1", "n2", "parent")).toThrow(/CHECK/);
  });

  it("allows one active edge per source, target and kind, and a new one after removal", () => {
    edge("e1", "n1", "n2");
    expect(() => edge("e2", "n1", "n2")).toThrow(/UNIQUE/);
    edge("e3", "n1", "n2", "blocks");
    db.prepare("UPDATE edges SET removed_at = ? WHERE id = 'e1'").run(T);
    edge("e4", "n1", "n2");
  });

  it("blocks deleting a node with edges by trigger or foreign key", () => {
    edge("e", "n1", "n2");
    expect(() => db.prepare("DELETE FROM nodes WHERE id = 'n2'").run()).toThrow();
  });
});

describe("links", () => {
  const add = (id: string, url: string, kind = "pr") =>
    db.prepare("INSERT INTO links (id, created_at, node_id, kind, url) VALUES (?, ?, 'n1', ?, ?)").run(id, T, kind, url);

  it("requires an http or https url", () => {
    add("l1", "http://example.com");
    add("l2", "https://example.com");
    for (const url of ["ftp://example.com", "javascript:alert(1)", "example.com", " https://example.com", ""]) {
      expect(() => add("x", url)).toThrow(/CHECK/);
    }
  });

  it("limits the kind and refuses duplicates on a node", () => {
    expect(() => add("x", "https://example.com", "doc")).toThrow(/CHECK/);
    add("l1", "https://example.com");
    expect(() => add("l2", "https://example.com", "ticket")).toThrow(/UNIQUE/);
  });
});

describe("messages", () => {
  const add = (id: string, body: string, author = "human") =>
    db
      .prepare("INSERT INTO messages (id, created_at, node_id, stage, author, body) VALUES (?, ?, 'n1', 's', ?, ?)")
      .run(id, T, author, body);

  it("requires a known author and a non-empty body", () => {
    add("m1", "hello");
    expect(() => add("x", "")).toThrow(/CHECK/);
    expect(() => add("x", "hi", "robot")).toThrow(/CHECK/);
  });

  it("are never deleted", () => {
    add("m1", "hello");
    expect(() => db.prepare("DELETE FROM messages WHERE id = 'm1'").run()).toThrow(/never deleted/);
  });
});

describe("events", () => {
  it("rejects UPDATE and DELETE", () => {
    event("e1");
    expect(() => db.prepare("UPDATE events SET kind = 'changed' WHERE id = 'e1'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM events WHERE id = 'e1'").run()).toThrow(/append-only/);
    expect(db.prepare("SELECT kind FROM events WHERE id = 'e1'").get()).toEqual({ kind: "x" });
  });

  it("requires valid JSON and a known actor", () => {
    expect(() => event("x", "not json")).toThrow(/CHECK/);
    expect(() => event("x", "{}", "robot")).toThrow(/CHECK/);
  });
});

describe("runs", () => {
  const add = (id: string, status = "running") =>
    db
      .prepare("INSERT INTO runs (id, created_at, node_id, stage, status, log_path) VALUES (?, ?, 'n1', 's', ?, 'log')")
      .run(id, T, status);

  it("allows only one running row per node", () => {
    add("r1");
    expect(() => add("r2")).toThrow(/UNIQUE/);
    db.prepare("UPDATE runs SET status = 'exited' WHERE id = 'r1'").run();
    add("r3");
    add("r4", "exited");
  });

  it("limits the status and requires a log path", () => {
    expect(() => add("x", "paused")).toThrow(/CHECK/);
    expect(() =>
      db.prepare("INSERT INTO runs (id, created_at, node_id, stage, status) VALUES ('x', ?, 'n1', 's', 'exited')").run(T),
    ).toThrow(/NOT NULL/);
  });
});

describe("the delete guards", () => {
  beforeEach(() => {
    node("foreign", "p2");
    event("e1");
    db.prepare("INSERT INTO events (id, created_at, node_id, actor, kind, data) VALUES ('fe', ?, 'foreign', 'human', 'x', '{}')").run(T);
    db.prepare("INSERT INTO messages (id, created_at, node_id, stage, author, body) VALUES ('m1', ?, 'n1', 's', 'human', 'hi')").run(T);
    db.prepare("INSERT INTO messages (id, created_at, node_id, stage, author, body) VALUES ('fm', ?, 'foreign', 's', 'human', 'hi')").run(T);
  });

  const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

  it("refuse a stray delete of any row, in or out of a transaction", () => {
    expect(() => db.exec("DELETE FROM events")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM messages")).toThrow(/never deleted/);
    expect(() => db.exec("DELETE FROM nodes")).toThrow(/never deleted/);
    expect(() => db.transaction(() => db.exec("DELETE FROM events"))()).toThrow(/append-only/);
    expect([count("events"), count("messages"), count("nodes")]).toEqual([2, 2, 3]);
  });

  it("let the allowed project's rows through, and only those", () => {
    allowProjectDeletion(db, "p1", () => {
      expect(() => db.exec("DELETE FROM events")).toThrow(/append-only/);
      expect(() => db.exec("DELETE FROM events WHERE id = 'fe'")).toThrow(/append-only/);
      expect(() => db.exec("DELETE FROM messages WHERE id = 'fm'")).toThrow(/never deleted/);
      expect(() => db.exec("DELETE FROM nodes WHERE id = 'foreign'")).toThrow(/never deleted/);
      db.exec("DELETE FROM events WHERE id = 'e1'");
      db.exec("DELETE FROM messages WHERE id = 'm1'");
      db.exec("DELETE FROM nodes WHERE project_id = 'p1'");
    });
    expect([count("events"), count("messages"), count("nodes")]).toEqual([1, 1, 1]);
  });

  it("still refuse changing an event while a deletion is allowed", () => {
    expect(() =>
      allowProjectDeletion(db, "p1", () => db.exec("UPDATE events SET kind = 'changed' WHERE id = 'e1'")),
    ).toThrow(/append-only/);
  });

  it("close again after a deletion, whether it succeeded or failed", () => {
    allowProjectDeletion(db, "p1", () => db.exec("DELETE FROM events WHERE id = 'e1'"));
    expect(() => db.exec("DELETE FROM messages WHERE id = 'm1'")).toThrow(/never deleted/);

    expect(() =>
      allowProjectDeletion(db, "p1", () => {
        db.exec("DELETE FROM messages WHERE id = 'm1'");
        throw new Error("part-way");
      }),
    ).toThrow("part-way");
    expect(count("messages")).toBe(2);
    expect(() => db.exec("DELETE FROM messages WHERE id = 'm1'")).toThrow(/never deleted/);
  });

  it("can't be opened from SQL: the function only reads", () => {
    expect(db.prepare("SELECT aop_project_being_deleted() AS p").get()).toEqual({ p: null });
    expect(() => db.prepare("SELECT aop_project_being_deleted('p1')").get()).toThrow();
  });

  it("refuse a delete from a connection that didn't come through openDb", () => {
    const other = new Database(file);
    try {
      expect(() => other.exec("DELETE FROM events")).toThrow();
      expect(() => other.exec("DELETE FROM nodes")).toThrow();
    } finally {
      other.close();
    }
    expect([count("events"), count("nodes")]).toEqual([2, 3]);
  });

  it("are still in force after reopening", () => {
    db.close();
    db = openDb(file);
    expect(() => db.exec("DELETE FROM events")).toThrow(/append-only/);
  });

  it("doesn't create a missing folder for the database", () => {
    const missing = join(aopHome(), "not-created", "aop.db");
    expect(() => openDb(missing)).toThrow();
    expect(existsSync(dirname(missing))).toBe(false);
  });
});

describe("upgrading from the first migration", () => {
  it("adds claimed_by to existing nodes, keeping them and enforcing the new checks", () => {
    const path = join(mkdtempSync(join(aopHome(), "upgrade-")), "aop.db");
    const old = new Database(path);
    old.exec(migrations[0]?.sql ?? "");
    old.pragma("user_version = 1");
    old.prepare("INSERT INTO projects (id, created_at, name, repo_path) VALUES ('p', ?, 'p', '/p')").run(T);
    old
      .prepare(
        "INSERT INTO nodes (id, created_at, project_id, title, type, stage, return_stage) VALUES ('n', ?, 'p', 't', 'dev', 'failed', 'implement')",
      )
      .run(T);
    old.close();

    const upgraded = openDb(path);
    try {
      expect(upgraded.pragma("user_version", { simple: true })).toBe(migrations.at(-1)?.version);
      expect(upgraded.prepare("SELECT stage, claimed_by FROM nodes WHERE id = 'n'").get()).toEqual({
        stage: "failed",
        claimed_by: null,
      });
      expect(() => upgraded.prepare("UPDATE nodes SET claimed_by = 'robot' WHERE id = 'n'").run()).toThrow(/CHECK/);
      expect(() => upgraded.prepare("UPDATE nodes SET stage = 'splitting', return_stage = NULL WHERE id = 'n'").run()).toThrow(/CHECK/);
    } finally {
      upgraded.close();
    }
  });
});

describe("upgrading a database with projects that must have a path", () => {
  /** A database as the previous version left it, with one of everything in it. */
  function atVersion3(): string {
    const path = join(mkdtempSync(join(aopHome(), "upgrade-")), "aop.db");
    const old = new Database(path);
    old.function("aop_project_being_deleted", { deterministic: false }, () => null);
    for (const migration of migrations.filter((m) => m.version <= 3)) old.exec(migration.sql);
    old.pragma("user_version = 3");
    old.pragma("foreign_keys = ON");
    // Inserted out of id order, so that listing by rowid is a real check.
    const project = old.prepare("INSERT INTO projects (id, created_at, name, repo_path) VALUES (?, ?, ?, ?)");
    project.run("z", T, "First", "/repo/first");
    project.run("a", T, "Second", "/repo/second");
    const node = old.prepare("INSERT INTO nodes (id, created_at, project_id, title, type, stage) VALUES (?, ?, 'z', ?, 'dev', 'implement')");
    node.run("n1", T, "One");
    node.run("n2", T, "Two");
    old.prepare("INSERT INTO edges (id, created_at, source_id, target_id, kind) VALUES ('e', ?, 'n1', 'n2', 'blocks')").run(T);
    old.prepare("INSERT INTO links (id, created_at, node_id, kind, url) VALUES ('l', ?, 'n1', 'pr', 'https://example.com')").run(T);
    old.prepare("INSERT INTO messages (id, created_at, node_id, stage, author, body) VALUES ('m', ?, 'n1', 'implement', 'human', 'hi')").run(T);
    old.prepare("INSERT INTO events (id, created_at, node_id, actor, kind, data) VALUES ('ev', ?, 'n1', 'human', 'x', '{}')").run(T);
    old.prepare("INSERT INTO runs (id, created_at, node_id, stage, status, log_path) VALUES ('r', ?, 'n1', 'implement', 'exited', '/log')").run(T);
    old.close();
    return path;
  }

  it("keeps every project, in order, and everything that hangs off them", () => {
    const upgraded = openDb(atVersion3());
    try {
      expect(upgraded.pragma("user_version", { simple: true })).toBe(migrations.at(-1)?.version);
      expect(upgraded.prepare("SELECT * FROM projects ORDER BY rowid").all()).toEqual([
        { id: "z", created_at: T, name: "First", repo_path: "/repo/first" },
        { id: "a", created_at: T, name: "Second", repo_path: "/repo/second" },
      ]);
      for (const [table, count] of [["nodes", 2], ["edges", 1], ["links", 1], ["messages", 1], ["events", 1], ["runs", 1]] as const) {
        expect((upgraded.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(count);
      }
    } finally {
      upgraded.close();
    }
  });

  it("makes repo_path optional, and still unique and enforced by foreign keys", () => {
    const upgraded = openDb(atVersion3());
    try {
      const add = upgraded.prepare("INSERT INTO projects (id, created_at, name, repo_path) VALUES (?, ?, 'x', ?)");
      add.run("none1", T, null);
      add.run("none2", T, null);
      expect(() => add.run("twin", T, "/repo/first")).toThrow(/UNIQUE/);

      expect(upgraded.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(upgraded.pragma("foreign_key_check")).toEqual([]);
      expect(() => upgraded.prepare("DELETE FROM projects WHERE id = 'z'").run()).toThrow(/FOREIGN KEY/);
      expect(() =>
        upgraded.prepare("INSERT INTO nodes (id, created_at, project_id, title, type, stage) VALUES ('x', ?, 'missing', 't', 'dev', 'implement')").run(T),
      ).toThrow(/FOREIGN KEY/);
      // The other tables still point at `projects`, not at the name it was rebuilt under.
      const nodesSql = upgraded.prepare("SELECT sql FROM sqlite_schema WHERE name = 'nodes'").get() as { sql: string };
      expect(nodesSql.sql).not.toContain("projects_new");
    } finally {
      upgraded.close();
    }
  });

  it("keeps the delete guards, and the project delete that gets past them", () => {
    const upgraded = openDb(atVersion3());
    try {
      expect(() => upgraded.exec("DELETE FROM nodes")).toThrow(/never deleted/);
      deleteProject(upgraded, "z");
      expect(upgraded.prepare("SELECT id FROM projects").all()).toEqual([{ id: "a" }]);
    } finally {
      upgraded.close();
    }
  });

  it("only runs once, leaving later projects alone on reopening", () => {
    const path = atVersion3();
    const first = openDb(path);
    first.prepare("INSERT INTO projects (id, created_at, name, repo_path) VALUES ('later', ?, 'x', NULL)").run(T);
    first.close();
    const second = openDb(path);
    try {
      expect(second.prepare("SELECT repo_path FROM projects WHERE id = 'later'").get()).toEqual({ repo_path: null });
    } finally {
      second.close();
    }
  });

  it("leaves nothing half done if a rebuild would break foreign keys", () => {
    // An orphan a later FK check would catch: written with foreign keys off, as an old bug might have.
    const path = atVersion3();
    const old = new Database(path);
    old.function("aop_project_being_deleted", { deterministic: false }, () => null);
    old.pragma("foreign_keys = OFF");
    old.prepare("INSERT INTO nodes (id, created_at, project_id, title, type, stage) VALUES ('orphan', ?, 'gone', 't', 'dev', 'implement')").run(T);
    old.close();

    expect(() => openDb(path)).toThrow(/would break foreign keys/);
    const after = new Database(path);
    try {
      expect(after.pragma("user_version", { simple: true })).toBe(3);
      expect(after.prepare("SELECT count(*) AS n FROM projects").get()).toEqual({ n: 2 });
      expect(() => after.prepare("INSERT INTO projects (id, created_at, name, repo_path) VALUES ('x', ?, 'x', NULL)").run(T)).toThrow(/NOT NULL/);
    } finally {
      after.close();
    }
  });
});

describe("upgrading runs to record usage", () => {
  it("keeps every run, reading as plain text with no usage, and enforces the new checks", () => {
    const path = join(mkdtempSync(join(aopHome(), "upgrade-")), "aop.db");
    const old = new Database(path);
    old.function("aop_project_being_deleted", { deterministic: false }, () => null);
    for (const migration of migrations.filter((m) => m.version <= 6)) old.exec(migration.sql);
    old.pragma("user_version = 6");
    old.prepare("INSERT INTO projects (id, created_at, name, repo_path) VALUES ('p', ?, 'p', '/p')").run(T);
    old.prepare("INSERT INTO nodes (id, created_at, project_id, title, type, stage) VALUES ('n', ?, 'p', 't', 'dev', 'implement')").run(T);
    old
      .prepare(
        "INSERT INTO runs (id, created_at, node_id, stage, status, log_path, end_reason) VALUES ('r', ?, 'n', 'implement', 'exited', '/log', 'failed')",
      )
      .run(T);
    old.close();

    const upgraded = openDb(path);
    try {
      expect(upgraded.prepare("SELECT id, end_reason, output_format, context_tokens, output_tokens, timed_out FROM runs").all()).toEqual([
        { id: "r", end_reason: "failed", output_format: "text", context_tokens: null, output_tokens: null, timed_out: 0 },
      ]);
      expect(() => upgraded.prepare("UPDATE runs SET output_format = 'xml'").run()).toThrow(/CHECK/);
      expect(() => upgraded.prepare("UPDATE runs SET context_tokens = -1").run()).toThrow(/CHECK/);
      expect(() => upgraded.prepare("UPDATE runs SET output_tokens = -1").run()).toThrow(/CHECK/);
      expect(() => upgraded.prepare("UPDATE runs SET timed_out = 2").run()).toThrow(/CHECK/);
      expect(() => upgraded.prepare("UPDATE runs SET timed_out = 1, end_reason = 'stopped'").run()).toThrow(/CHECK/);
      upgraded.prepare("UPDATE runs SET timed_out = 1, context_tokens = 5, output_tokens = 6, output_format = 'stream-json'").run();
    } finally {
      upgraded.close();
    }
  });
});
