import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Hono } from "hono";
import type { Db } from "../src/server/db.js";
import { aopHome } from "../src/server/paths.js";
import type { NodeRow } from "../src/server/nodes.js";
import { logPathFor } from "../src/server/runLog.js";
import { beginRun } from "../src/server/runs.js";
import type { NodeView } from "../src/shared/api.js";

/**
 * Fills a project with one of everything worth looking at. Goes through the real API, so that
 * every stage change is checked and logged the same as if a human had clicked it.
 */
export async function seed(app: Hono, db: Db, projectId: string): Promise<void> {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const init: RequestInit = { method, headers: { host: "localhost" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await app.request(`/api${path}`, init);
    if (!response.ok) throw new Error(`${method} ${path}: ${await response.text()}`);
    return (await response.json()) as T;
  };

  const create = (type: string | undefined, title: string, body = "") =>
    call<NodeView>("POST", `/projects/${projectId}/nodes`, { ...(type ? { type } : {}), title, body });
  const outcome = (node: NodeView, name: string) => call("POST", `/nodes/${node.id}/next`, { outcome: name });
  const say = (node: NodeView, text: string, author: "human" | "agent" = "agent") =>
    call("POST", `/nodes/${node.id}/messages`, { body: text, author });
  const edge = (source: NodeView, target: NodeView, kind: "subtask" | "blocks") =>
    call("POST", `/nodes/${source.id}/edges`, { target_id: target.id, kind });

  // A finished split, with children spread across the stages.
  const billing = await create(
    "triage",
    "Rebuild billing on the new ledger",
    "Too big for one PR. Split into the export, the webhooks, the emails and the data migration.",
  );
  await outcome(billing, "split");
  await say(billing, "This touches four separate areas. I propose splitting it into one node for each.");
  await outcome(billing, "approve");
  await say(billing, "Agreed, go ahead.", "human");
  await call("POST", `/nodes/${billing.id}/split/start`);

  const exportPdf = await create("dev", "Invoice PDF export", "Render invoices from the new ledger.");
  const webhooks = await create("dev", "Retry failed payment webhooks", "Back off and retry, with a dead-letter queue.");
  const emails = await create("dev", "Dunning emails", "Needs the webhook retries so that it can trust payment state.");
  const rounding = await create("dev", "Tax rounding per line or per invoice", "Finance needs this to match their exports.");
  const migrate = await create("dev", "Migrate historic invoices", "Backfill two years of invoices into the ledger.");
  for (const child of [exportPdf, webhooks, emails, rounding, migrate]) await edge(billing, child, "subtask");
  await call("POST", `/nodes/${billing.id}/split/finish`);

  // A split still going: its children stay held until it finishes.
  const search = await create("triage", "Move search onto the new index", "One node for indexing and one for the query API.");
  await outcome(search, "split");
  await outcome(search, "approve");
  await call("POST", `/nodes/${search.id}/split/start`);
  for (const title of ["Build the search indexer", "Search query API"]) {
    await edge(search, await create("dev", title), "subtask");
  }

  // Waiting on the outside world, and work only a human can do.
  const vendor = await create("dev", "Integrate the vendor tax API", "Needs sandbox credentials from the vendor.");
  await call("POST", `/nodes/${vendor.id}/block`, { reason: "Waiting on the vendor to issue sandbox keys." });
  const dns = await create(undefined, "Point the billing domain at the new load balancer", "Only the infra team has DNS access.");
  await outcome(dns, "human_only");

  // Human turn.
  await outcome(exportPdf, "pr_raised");
  await say(exportPdf, "PR is up. Rendering is golden-file tested against 40 sample invoices.");
  await call("POST", `/nodes/${exportPdf.id}/links`, { kind: "pr", url: "https://github.com/example/billing/pull/412" });
  await call("POST", `/nodes/${exportPdf.id}/links`, { kind: "ticket", url: "https://linear.app/example/issue/BIL-88" });

  // A human is steering this one, whatever stage it reaches.
  await call("POST", `/nodes/${exportPdf.id}/claim`, { actor: "human" });

  // A blocked node: the emails wait for the webhooks, which an agent is still working on. The demo
  // runs no agents, so the run is recorded directly, the way the orchestrator opens one, to show
  // its ID on the claim.
  await edge(webhooks, emails, "blocks");
  const runId = randomUUID();
  beginRun(db, webhooks as unknown as NodeRow, runId, logPathFor(runId));

  // A question and a failure.
  await call("POST", `/nodes/${rounding.id}/ask`, {
    question: "Should tax round per line or per invoice? Finance's export rounds per line, the old system per invoice.",
  });
  await call("POST", `/nodes/${migrate.id}/fail`, { reason: "Agent exited with code 1 during the backfill." });

  // Back and forth between the agent and review, with messages on every visit.
  const receipts = await create(
    "dev",
    "Stop duplicate receipts when a payment retries",
    "A retried charge sends the customer a second receipt. Send one per payment, whatever the retries.",
  );
  await say(receipts, "Adding an idempotency key on the receipt job, built from the payment ID.");
  await outcome(receipts, "pr_raised");
  await say(receipts, "PR is up. The key is checked before the send, with a test for a retried charge.");
  await say(
    receipts,
    "If the first send times out after the provider accepted it, the retry still goes out. Can the key cover that?",
    "human",
  );
  await outcome(receipts, "changes");
  await say(receipts, "Reproduced the timeout case. The key is now recorded before the send and released only on a hard failure.");
  const dropTest = (await say(receipts, "Also add a test that drops the connection mid-send.", "human")) as { id: string };
  await say(receipts, "Added. It fakes a dropped connection after the provider accepts the email.");
  await outcome(receipts, "pr_raised");
  await say(receipts, "Updated the PR with both fixes. All receipt tests pass.");
  await say(receipts, "Looks right now. I'll give it a final read this afternoon.", "human");

  // Improvements, captured from a message: one waiting on review with a proposed skill change, one
  // being drafted, and one with no source.
  const improve = (body: string, source?: string) =>
    call<{ node: NodeView }>("POST", "/improvements", { body, ...(source ? { source_message_id: source } : {}) });
  const skill = join(aopHome(), "skills", "write-tests", "SKILL.md");
  const testing = await improve(
    "Agents should test failure paths, not only the happy path.\nThe receipts PR only got a dropped-connection test after review.",
    dropTest.id,
  );
  await call("PUT", `/improvements/${testing.node.id}/proposals`, {
    path: skill,
    actor: "agent",
    content: [
      "---",
      "name: write-tests",
      "description: How to write tests in this codebase.",
      "---",
      "",
      "# Writing tests",
      "",
      "- Test behaviour through the public API, not private helpers.",
      "- One behaviour per test, named for what it shows.",
      "- Cover the failure paths too: timeouts, dropped connections and retries.",
      "- Use a throwaway folder for anything that touches files.",
      "",
    ].join("\n"),
  });
  await call("POST", `/nodes/${testing.node.id}/messages`, {
    body: "Added one line to the write-tests skill asking for failure-path tests.",
    author: "agent",
  });
  await call("POST", `/nodes/${testing.node.id}/next`, { outcome: "drafted", actor: "agent" });
  const finance = (await say(billing, "Split looks right, but check with finance first next time.", "human")) as { id: string };
  await improve("Breakdown prompt: ask before splitting work that touches billing.", finance.id);
  await improve("Add a skill for writing database migrations.");

  // An invalidated node with a child it invalidates.
  const reporting = await create("triage", "Rewrite the reporting pipeline", "Move reporting onto the warehouse.");
  const reportingApi = await create("dev", "Reporting API", "Serve the new reports.");
  await edge(reporting, reportingApi, "subtask");
  await call("POST", `/nodes/${reporting.id}/invalidate`, { reason: "We're buying a reporting tool instead." });

  // The rest of the process.
  const admin = await create("triage", "Admin console for support", "Support needs refunds, account lookups and audit logs.");
  await outcome(admin, "split");
  await say(admin, "I propose three children: refunds, account lookup and the audit log view.");

  await create(undefined, "Flaky login test on CI", "Fails about one run in twenty.");

  const timezone = await create("triage", "Fix daylight saving bug in schedules", "Runs fire an hour late after the clocks change.");
  await outcome(timezone, "ready");
  await outcome(timezone, "pr_raised");
  await outcome(timezone, "approve");

  const node24 = await create("dev", "Upgrade to Node 24", "Includes the native module rebuilds.");
  await outcome(node24, "pr_raised");
  await outcome(node24, "approve");
  await outcome(node24, "merged");

  // Stands in for a stage later removed from stages.yaml, which the API rightly can't produce.
  const legacy = await create("dev", "Sign off the data retention policy", "Stuck on a stage that no longer exists.");
  db.prepare("UPDATE nodes SET stage = ? WHERE id = ?").run("legal_signoff", legacy.id);
}
