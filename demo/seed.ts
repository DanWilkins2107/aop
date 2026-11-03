import type { Hono } from "hono";
import type { Db } from "../src/server/db.js";
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

  const create = (type: string, title: string, body = "") =>
    call<NodeView>("POST", `/projects/${projectId}/nodes`, { type, title, body });
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

  const exportPdf = await create("dev", "Invoice PDF export", "Render invoices from the new ledger.");
  const webhooks = await create("dev", "Retry failed payment webhooks", "Back off and retry, with a dead-letter queue.");
  const emails = await create("dev", "Dunning emails", "Needs the webhook retries so that it can trust payment state.");
  const rounding = await create("dev", "Tax rounding per line or per invoice", "Finance needs this to match their exports.");
  const migrate = await create("dev", "Migrate historic invoices", "Backfill two years of invoices into the ledger.");
  for (const child of [exportPdf, webhooks, emails, rounding, migrate]) await edge(billing, child, "subtask");
  await call("POST", `/nodes/${billing.id}/move`, { stage: "broken_down" });

  // Human turn.
  await outcome(exportPdf, "pr_raised");
  await say(exportPdf, "PR is up. Rendering is golden-file tested against 40 sample invoices.");
  await call("POST", `/nodes/${exportPdf.id}/links`, { kind: "pr", url: "https://github.com/example/billing/pull/412" });
  await call("POST", `/nodes/${exportPdf.id}/links`, { kind: "ticket", url: "https://linear.app/example/issue/BIL-88" });

  // A blocked node: the emails wait for the webhooks, which an agent is still working on.
  await edge(webhooks, emails, "blocks");

  // A question and a failure.
  await call("POST", `/nodes/${rounding.id}/ask`, {
    question: "Should tax round per line or per invoice? Finance's export rounds per line, the old system per invoice.",
  });
  await call("POST", `/nodes/${migrate.id}/fail`, { reason: "Agent exited with code 1 during the backfill." });

  // An invalidated node with a stale child.
  const reporting = await create("triage", "Rewrite the reporting pipeline", "Move reporting onto the warehouse.");
  const reportingApi = await create("dev", "Reporting API", "Serve the new reports.");
  await edge(reporting, reportingApi, "subtask");
  await call("POST", `/nodes/${reporting.id}/invalidate`, { reason: "We're buying a reporting tool instead." });

  // The rest of the process.
  const admin = await create("triage", "Admin console for support", "Support needs refunds, account lookups and audit logs.");
  await outcome(admin, "split");
  await say(admin, "I propose three children: refunds, account lookup and the audit log view.");

  await create("triage", "Flaky login test on CI", "Fails about one run in twenty.");

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
