import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/server/db.js";
import { migrations } from "../../src/server/migrations.js";
import { aopHome } from "../../src/server/paths.js";
import { deleteProject } from "../../src/server/projects.js";
import { ftsQuery, search } from "../../src/server/search.js";
import type { NodeView, SearchResult } from "../../src/shared/api/types.js";
import { harness, makeRepo, type Harness } from "./helpers.js";

let h: Harness;
beforeEach(() => {
  h = harness();
});

const find = async (query: string, project?: string) => {
  const params = new URLSearchParams({ q: query, ...(project ? { project } : {}) });
  return h.call<SearchResult[]>("GET", `/api/search?${params}`);
};
const ids = async (query: string, project?: string) => (await find(query, project)).body.map((result) => result.node_id);

describe("what it searches", () => {
  it("finds nodes by title, description, messages and invalidation reason", async () => {
    const byTitle = await h.create("dev", { title: "Rebuild the ledger" });
    const byBody = await h.create("dev", { body: "Touches the zeppelin module" });
    const byMessage = await h.create("dev");
    await h.call("POST", `/api/nodes/${byMessage.id}/messages`, { body: "Blocked on the walrus API" });
    const byReason = await h.create("dev");
    await h.post(byReason.id, "invalidate", { reason: "Superseded by quokka" });

    expect(await ids("ledger")).toEqual([byTitle.id]);
    expect(await ids("zeppelin")).toEqual([byBody.id]);
    expect(await ids("walrus")).toEqual([byMessage.id]);
    expect(await ids("quokka")).toEqual([byReason.id]);
  });

  it("shows each node's stage and includes invalidated ones", async () => {
    const node = await h.create("dev", { title: "Dead parrot" });
    await h.post(node.id, "invalidate", { reason: "It's deceased" });
    const [result] = (await find("parrot")).body;
    expect(result).toMatchObject({ node_id: node.id, stage: "invalidated", title: "Dead parrot", type: "dev" });
  });

  it("returns a node once, even if several things about it match", async () => {
    const node = await h.create("dev", { title: "Marmot", body: "marmot marmot" });
    await h.call("POST", `/api/nodes/${node.id}/messages`, { body: "A marmot again" });
    expect(await ids("marmot")).toEqual([node.id]);
  });

  it("matches word forms, and needs every word", async () => {
    const node = await h.create("dev", { title: "Retries for webhooks" });
    expect(await ids("retry webhook")).toEqual([node.id]);
    expect(await ids("retry bananas")).toEqual([]);
  });

  it("marks the match in a snippet", async () => {
    await h.create("dev", { body: "Something about a capybara somewhere" });
    expect((await find("capybara")).body[0]?.snippet).toContain("[capybara]");
  });

  it("narrows to a project, or covers all of them", async () => {
    const other = (await h.call<{ id: string }>("POST", "/api/projects", { repo_path: makeRepo() })).body;
    const here = await h.create("dev", { title: "Shared word okapi" });
    const there = (await h.call<NodeView>("POST", `/api/projects/${other.id}/nodes`, { type: "dev", title: "Also okapi" })).body;
    expect(await ids("okapi", h.projectId)).toEqual([here.id]);
    expect(await ids("okapi", other.id)).toEqual([there.id]);
    expect((await ids("okapi")).sort()).toEqual([here.id, there.id].sort());
    expect((await find("okapi", "no-such-project")).status).toBe(404);
  });

  it("needs a query", async () => {
    expect((await h.call("GET", "/api/search")).status).toBe(400);
    expect((await find("   ")).status).toBe(400);
  });
});

describe("keeping the index in step", () => {
  it("follows edits and stage changes", async () => {
    const node = await h.create("dev", { title: "Old heading", body: "Old text" });
    await h.call("PATCH", `/api/nodes/${node.id}`, { title: "New heading", body: "New wording" });
    expect(await ids("old")).toEqual([]);
    expect(await ids("heading wording")).toEqual([node.id]);

    await h.post(node.id, "invalidate", { reason: "Pangolin reason" });
    expect(await ids("pangolin")).toEqual([node.id]);
    await h.post(node.id, "restore");
    expect(await ids("pangolin")).toEqual([]);
    expect(await ids("heading")).toEqual([node.id]);
  });

  it("forgets everything in a deleted project", async () => {
    const node = await h.create("dev", { title: "Doomed tapir" });
    await h.call("POST", `/api/nodes/${node.id}/messages`, { body: "A doomed tapir message" });
    deleteProject(h.db, h.projectId);
    expect(search(h.db, "tapir", null)).toEqual([]);
    expect(h.db.prepare("SELECT count(*) AS n FROM nodes_fts").get()).toEqual({ n: 0 });
    expect(h.db.prepare("SELECT count(*) AS n FROM messages_fts").get()).toEqual({ n: 0 });
  });

  it("backfills what was there before the migration", () => {
    const path = join(mkdtempSync(join(aopHome(), "upgrade-")), "aop.db");
    const old = new Database(path);
    old.function("aop_project_being_deleted", { deterministic: false }, () => null);
    for (const migration of migrations.filter((m) => m.version <= 5)) old.exec(migration.sql);
    old.pragma("user_version = 5");
    old.prepare("INSERT INTO projects (id, created_at, name) VALUES ('p', 'now', 'P')").run();
    old
      .prepare("INSERT INTO nodes (id, created_at, project_id, title, body, type, stage, invalidation_reason) VALUES ('n', 'now', 'p', 'Ancient lemur', 'Ancient body', 'dev', 'invalidated', 'Ancient reason')")
      .run();
    old.prepare("INSERT INTO messages (id, created_at, node_id, stage, author, body) VALUES ('m', 'now', 'n', 'x', 'human', 'Ancient gecko')").run();
    old.close();

    const upgraded = openDb(path);
    try {
      for (const word of ["lemur", "body", "reason", "gecko"]) {
        expect(search(upgraded, word, null).map((r) => r.node_id), word).toEqual(["n"]);
      }
    } finally {
      upgraded.close();
    }
  });
});

describe("escaping", () => {
  // Each of these is an FTS5 syntax error, or means something else, if passed straight through.
  const AWKWARD = [
    '"',
    '""',
    '"unterminated',
    "a\"b",
    "'",
    "*",
    "foo*",
    "^start",
    "col:value",
    "title:hello",
    "NEAR(",
    "NEAR(a b, 2)",
    "a AND",
    "OR",
    "NOT x",
    "AND OR NOT",
    "(",
    ")",
    "((a))",
    "{a b}",
    "-",
    "--",
    "a-b",
    "+",
    "a + b",
    ":",
    ";DROP TABLE nodes;--",
    "\\",
    "%",
    "日本語",
    "🦊",
    "foo\0bar",
    "\0",
    "a\nb\tc",
  ];

  it.each(AWKWARD)("answers normally for %j", async (query) => {
    const res = await find(query);
    if (query.replaceAll("\0", " ").trim() === "") return;
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("finds a node by text that looks like query syntax", async () => {
    const node = await h.create("dev", { title: "Handle NEAR and title:foo AND a-b" });
    expect(await ids("NEAR")).toEqual([node.id]);
    expect(await ids("title:foo")).toEqual([node.id]);
    expect(await ids("AND")).toEqual([node.id]);
    expect(await ids("a-b")).toEqual([node.id]);
    expect(await ids('"NEAR"')).toEqual([node.id]);
  });

  it("can't reach another column or wildcard", async () => {
    const node = await h.create("dev", { title: "Prefixes", body: "wombat" });
    expect(await ids("title:wombat")).toEqual([]);
    expect(await ids("wom*")).toEqual([]);
    expect(await ids("wombat")).toEqual([node.id]);
  });

  it("has nothing to look for in punctuation alone", () => {
    expect(ftsQuery("  - * ( ")).toBeNull();
    expect(ftsQuery('say "hi"')).toBe('"say" """hi"""');
    expect(ftsQuery("a\0b")).toBe('"a" "b"');
  });

  it("the table survives", async () => {
    await find(";DROP TABLE nodes;--");
    expect((await h.call("GET", `/api/projects/${h.projectId}/nodes`)).status).toBe(200);
  });
});
