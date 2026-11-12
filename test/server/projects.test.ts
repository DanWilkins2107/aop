import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { deleteProject } from "../../src/server/projects.js";
import type { NodeView, ProjectRow } from "../../src/shared/api/types.js";
import { harness, makeRepo, type Harness, type Res } from "./helpers.js";

let h: Harness;

beforeEach(() => {
  h = harness();
});

const codeOf = (res: Res) => (res.body["error"] as { code: string }).code;
const messageOf = (res: Res) => (res.body["error"] as { message: string }).message;

/** Everything one project can have: subtask, blocks and removed edges, links, messages, events, runs. */
async function fill(projectId: string): Promise<string[]> {
  const make = async (title: string) =>
    (await h.call<NodeView>("POST", `/api/projects/${projectId}/nodes`, { type: "dev", title })).body;
  const [parent, child, blocker] = [await make("parent"), await make("child"), await make("blocker")];
  const edge = (source: NodeView, target: NodeView, kind: string) =>
    h.call<{ id: string }>("POST", `/api/nodes/${source.id}/edges`, { target_id: target.id, kind });

  await edge(parent, child, "subtask");
  await edge(blocker, child, "blocks");
  const removed = await edge(blocker, parent, "blocks");
  await h.call("DELETE", `/api/edges/${removed.body.id}`);
  await h.call("POST", `/api/nodes/${parent.id}/links`, { kind: "pr", url: "https://example.com/1" });
  await h.call("POST", `/api/nodes/${parent.id}/messages`, { body: "hello" });
  h.db
    .prepare("INSERT INTO runs (id, created_at, node_id, stage, status, log_path) VALUES (?, 'now', ?, 'write_spec', 'running', '/log')")
    .run(`run-${parent.id}`, parent.id);
  // Children first in rowid order would hide this: the spawner is older than what it spawned.
  h.db.prepare("UPDATE nodes SET spawned_by = ? WHERE id = ?").run(parent.id, child.id);
  h.db.prepare("UPDATE nodes SET spawned_by = ? WHERE id = ?").run(child.id, blocker.id);
  return [parent.id, child.id, blocker.id];
}

const TABLES = ["nodes", "edges", "links", "messages", "events", "runs"];

function counts(): Record<string, number> {
  return Object.fromEntries(
    TABLES.map((table) => [table, (h.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n]),
  );
}

describe("adding a project", () => {
  it("needs only a name", async () => {
    const res = await h.call<ProjectRow>("POST", "/api/projects", { name: "  No repo  " });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "No repo", repo_path: null });
    const listed = (await h.call<ProjectRow[]>("GET", "/api/projects")).body;
    expect(listed.find((p) => p.id === res.body.id)?.repo_path).toBeNull();
  });

  it("treats a null path the same as none, and allows many projects with no path", async () => {
    for (const name of ["One", "Two"]) {
      const res = await h.call<ProjectRow>("POST", "/api/projects", { name, repo_path: null });
      expect(res.status).toBe(201);
      expect(res.body.repo_path).toBeNull();
    }
  });

  it("refuses a project with neither a name nor a path", async () => {
    for (const body of [{}, { repo_path: null }, { name: "   " }]) {
      expect((await h.call("POST", "/api/projects", body)).status).toBe(400);
    }
  });

  it("takes work on a project with no path", async () => {
    const project = (await h.call<ProjectRow>("POST", "/api/projects", { name: "No repo" })).body;
    const res = await h.call<NodeView>("POST", `/api/projects/${project.id}/nodes`, { title: "x" });
    expect(res.status).toBe(201);
    expect(res.body.stage).toBe("awaiting_agent_breakdown");
  });

  it("needs only an existing folder if given a path, and writes nothing to it", async () => {
    const repo = makeRepo();
    const before = readdirSync(repo);
    const res = await h.call<ProjectRow>("POST", "/api/projects", { name: "  Mine  ", repo_path: repo });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Mine");
    expect(readdirSync(repo)).toEqual(before);
    expect(existsSync(join(repo, ".aop"))).toBe(false);
  });

  it("falls back to the folder's name, for `aop project add <path>`", async () => {
    const repo = makeRepo();
    const res = await h.call<ProjectRow>("POST", "/api/projects", { repo_path: repo });
    expect(res.body.name).toBe(repo.split(/[\\/]/).at(-1));
  });

  it("refuses a path that's already registered, however it's spelled", async () => {
    for (const spelling of [h.repo, `${h.repo}/`, join(h.repo, "x", "..")]) {
      const res = await h.call("POST", "/api/projects", { name: "Twin", repo_path: spelling });
      expect(res.status).toBe(409);
      expect(codeOf(res)).toBe("repo_path_taken");
      expect(messageOf(res)).toContain("already registered");
    }
    expect((await h.call<ProjectRow[]>("GET", "/api/projects")).body).toHaveLength(1);
  });

  it("refuses a missing path, a file and a relative path", async () => {
    const file = join(h.repo, "README.md");
    for (const [path, code] of [
      [join(h.repo, "missing"), "repo_path_not_found"],
      [file, "repo_path_not_found"],
      ["some/relative/path", "repo_path_not_absolute"],
    ] as const) {
      const res = await h.call("POST", "/api/projects", { name: "Nope", repo_path: path });
      expect(res.status).toBe(400);
      expect(codeOf(res)).toBe(code);
      expect(messageOf(res)).toContain(path);
    }
  });

  it("refuses a blank name or path", async () => {
    expect((await h.call("POST", "/api/projects", { name: "  ", repo_path: makeRepo() })).status).toBe(400);
    expect((await h.call("POST", "/api/projects", { name: "x", repo_path: "  " })).status).toBe(400);
  });
});

describe("renaming a project", () => {
  it("changes only the name", async () => {
    const res = await h.call<ProjectRow>("PATCH", `/api/projects/${h.projectId}`, { name: "  New name " });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: h.projectId, name: "New name", repo_path: expect.any(String) });
    const [stored] = (await h.call<ProjectRow[]>("GET", "/api/projects")).body;
    expect(stored?.name).toBe("New name");
  });

  it("refuses a blank or too-long name, an empty change and unknown fields", async () => {
    const path = `/api/projects/${h.projectId}`;
    for (const body of [{ name: "   " }, { name: "x".repeat(201) }, {}, { id: "other" }]) {
      expect((await h.call("PATCH", path, body)).status).toBe(400);
    }
  });

  it("404s an unknown project", async () => {
    expect((await h.call("PATCH", "/api/projects/nope", { name: "x" })).status).toBe(404);
  });
});

describe("changing a project's path", () => {
  const change = (repo_path: string) => h.call("PATCH", `/api/projects/${h.projectId}`, { repo_path });

  it("points the project at another folder and keeps its nodes", async () => {
    const node = await h.create("dev");
    const moved = makeRepo();
    const res = await change(moved);
    expect(res.status).toBe(200);
    expect(String(res.body["repo_path"]).toLowerCase()).toBe(moved.toLowerCase());
    expect((await h.node(node.id)).id).toBe(node.id);
  });

  it("frees the old path for another project", async () => {
    const old = h.repo;
    await change(makeRepo());
    expect((await h.call("POST", "/api/projects", { name: "Other", repo_path: old })).status).toBe(201);
  });

  it("refuses a path another project holds, naming it", async () => {
    const taken = makeRepo();
    await h.call("POST", "/api/projects", { name: "Holder", repo_path: taken });
    const res = await change(taken);
    expect(res.status).toBe(409);
    expect(codeOf(res)).toBe("repo_path_taken");
    expect(messageOf(res)).toContain('"Holder"');
  });

  it("accepts the project's own path", async () => {
    expect((await change(h.repo)).status).toBe(200);
  });

  it("refuses a missing path, a file and a relative path, changing nothing", async () => {
    const [before] = (await h.call<ProjectRow[]>("GET", "/api/projects")).body;
    const missing = await change(join(h.repo, "missing"));
    expect(missing.status).toBe(400);
    expect(codeOf(missing)).toBe("repo_path_not_found");
    expect(messageOf(missing)).toContain("no folder");
    expect((await change(join(h.repo, "README.md"))).status).toBe(400);
    expect((await change("relative/path")).status).toBe(400);
    expect((await h.call<ProjectRow[]>("GET", "/api/projects")).body[0]).toEqual(before);
  });

  it("clears the path with null, freeing it for another project and keeping the nodes", async () => {
    const node = await h.create("dev");
    const old = h.repo;
    const res = await h.call<ProjectRow>("PATCH", `/api/projects/${h.projectId}`, { repo_path: null });
    expect(res.status).toBe(200);
    expect(res.body.repo_path).toBeNull();
    expect((await h.call<ProjectRow[]>("GET", "/api/projects")).body[0]?.repo_path).toBeNull();
    expect((await h.node(node.id)).id).toBe(node.id);
    expect((await h.call("POST", "/api/projects", { name: "Other", repo_path: old })).status).toBe(201);
  });

  it("clears a path that has gone from disk", async () => {
    rmSync(h.repo, { recursive: true, force: true });
    expect((await h.call("PATCH", `/api/projects/${h.projectId}`, { repo_path: null })).status).toBe(200);
  });

  it("gives a project with no path a path, and renames it without touching a missing one", async () => {
    await h.call("PATCH", `/api/projects/${h.projectId}`, { repo_path: null });
    const renamed = await h.call<ProjectRow>("PATCH", `/api/projects/${h.projectId}`, { name: "Renamed" });
    expect(renamed.body).toMatchObject({ name: "Renamed", repo_path: null });
    const moved = makeRepo();
    const res = await change(moved);
    expect(String(res.body["repo_path"]).toLowerCase()).toBe(moved.toLowerCase());
  });

  it("refuses a blank path, which isn't how to clear one", async () => {
    expect((await change("   ")).status).toBe(400);
  });

  it("applies a name and a path together, or neither", async () => {
    const res = await h.call("PATCH", `/api/projects/${h.projectId}`, { name: "Both", repo_path: join(h.repo, "missing") });
    expect(res.status).toBe(400);
    expect((await h.call<ProjectRow[]>("GET", "/api/projects")).body[0]?.name).not.toBe("Both");
  });
});

describe("deleting a project", () => {
  it("removes the project and everything in it, leaving others alone", async () => {
    const other = (await h.call<ProjectRow>("POST", "/api/projects", { name: "Other", repo_path: makeRepo() })).body;
    await fill(other.id);
    const untouched = counts();
    const [parent] = await fill(h.projectId);

    const res = await h.call<ProjectRow>("DELETE", `/api/projects/${h.projectId}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(h.projectId);

    expect(counts()).toEqual(untouched);
    expect((await h.call<ProjectRow[]>("GET", "/api/projects")).body.map((p) => p.id)).toEqual([other.id]);
    expect((await h.call("GET", `/api/nodes/${parent}`)).status).toBe(404);
    expect((await h.call("GET", `/api/projects/${h.projectId}/nodes`)).status).toBe(404);
    // The other project still works.
    expect((await h.call("GET", `/api/projects/${other.id}/nodes`)).status).toBe(200);
  });

  it("deletes a project with no nodes", async () => {
    expect((await h.call("DELETE", `/api/projects/${h.projectId}`)).status).toBe(200);
    expect(counts().nodes).toBe(0);
  });

  it("deletes a project with no path, with its nodes", async () => {
    const project = (await h.call<ProjectRow>("POST", "/api/projects", { name: "No repo" })).body;
    await fill(project.id);
    expect((await h.call("DELETE", `/api/projects/${project.id}`)).status).toBe(200);
    expect((await h.call<ProjectRow[]>("GET", "/api/projects")).body.map((p) => p.id)).toEqual([h.projectId]);
  });

  it("never touches the repo folder", async () => {
    await fill(h.projectId);
    writeFileSync(join(h.repo, "work.txt"), "precious");
    const before = readdirSync(h.repo);
    expect((await h.call("DELETE", `/api/projects/${h.projectId}`)).status).toBe(200);
    expect(readdirSync(h.repo)).toEqual(before);
    expect(readFileSync(join(h.repo, "work.txt"), "utf8")).toBe("precious");
  });

  it("works when the repo folder has gone or the config is broken", async () => {
    await fill(h.projectId);
    rmSync(h.repo, { recursive: true, force: true });
    h.rewriteStages("not: valid\n");
    expect((await h.call("DELETE", `/api/projects/${h.projectId}`)).status).toBe(200);
  });

  it("deletes nothing if any step fails", async () => {
    await fill(h.projectId);
    const before = counts();
    // A foreign key the delete doesn't clear: a table it doesn't know about, as a later migration might add.
    h.db.exec("CREATE TABLE extra (id TEXT PRIMARY KEY, node_id TEXT REFERENCES nodes(id) ON DELETE RESTRICT)");
    const [first] = h.db.prepare("SELECT id FROM nodes").all() as { id: string }[];
    h.db.prepare("INSERT INTO extra VALUES ('x', ?)").run(first?.id);

    expect(() => deleteProject(h.db, h.projectId)).toThrow(/FOREIGN KEY/);
    expect(counts()).toEqual(before);
    expect((await h.call<ProjectRow[]>("GET", "/api/projects")).body).toHaveLength(1);
    expect(() => h.db.exec("DELETE FROM events")).toThrow(/append-only/);
  });

  it("frees the path to be added again, empty", async () => {
    await fill(h.projectId);
    await h.call("DELETE", `/api/projects/${h.projectId}`);
    const again = await h.call<ProjectRow>("POST", "/api/projects", { name: "Again", repo_path: h.repo });
    expect(again.status).toBe(201);
    expect((await h.call<NodeView[]>("GET", `/api/projects/${again.body.id}/nodes`)).body).toEqual([]);
  });

  it("404s an unknown project", async () => {
    expect((await h.call("DELETE", "/api/projects/nope")).status).toBe(404);
  });

  it("is refused from another website, like every write", async () => {
    const { db } = h;
    const { createApp } = await import("../../src/server/api.js");
    const res = await createApp(db).request(`/api/projects/${h.projectId}`, {
      method: "DELETE",
      headers: { host: "localhost:4410", origin: "http://evil.example" },
    });
    expect(res.status).toBe(403);
    expect((await h.call<ProjectRow[]>("GET", "/api/projects")).body).toHaveLength(1);
  });
});

describe("a project needs nothing from its repo", () => {
  it("shows nodes after pointing at a folder with no config", async () => {
    const node = await h.create("dev");
    const empty = mkdtempSync(join(h.repo, "..", "empty-"));
    await h.call("PATCH", `/api/projects/${h.projectId}`, { repo_path: empty });
    expect((await h.call<NodeView[]>("GET", `/api/projects/${h.projectId}/nodes`)).body[0]?.id).toBe(node.id);
    expect(readdirSync(empty)).toEqual([]);
  });

  it("uses one process for every project", async () => {
    const other = (await h.call<ProjectRow>("POST", "/api/projects", { repo_path: makeRepo() })).body;
    const node = (await h.call<NodeView>("POST", `/api/projects/${other.id}/nodes`, { type: "dev", title: "x" })).body;
    expect(node.stage).toBe("write_spec");
  });
});
