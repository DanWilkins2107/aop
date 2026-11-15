// What every route file gets from `createApp`, and the helpers they share for reading requests.

import type { Context, Hono } from "hono";
import type { z } from "zod";
import { RUN_ID_HEADER } from "../../shared/runs/runIdHeader.js";
import type { ChangeNotice } from "../db/changes.js";
import type { Db } from "../db/db.js";
import type { Orchestrator } from "../runs/orchestrator.js";
import { badRequest } from "../shared/errors.js";

export interface RouteContext {
  app: Hono;
  db: Db;
  /** Runs agents. Refuses if this server doesn't. */
  orchestrator(): Orchestrator;
  /** The orchestrator, if this server has one. */
  maybeOrchestrator: Orchestrator | undefined;
  /** Records what a write touched, for its change notice. None recorded means anything. */
  touch(c: Context, notice: ChangeNotice): void;
  /** A change to these nodes, and so to their projects. */
  touchedNodes(...nodeIds: string[]): ChangeNotice;
  /** A project's own row: its nodes' messages, events, links and edges are untouched unless `nodeIds` says. */
  touchedProject(projectId: string, nodeIds?: string[] | null): ChangeNotice;
}

export async function readBody<S extends z.ZodType>(c: Context, schema: S, emptyAllowed = false): Promise<z.output<S>> {
  const text = await c.req.text();
  let json: unknown = {};
  if (text.trim() !== "" || !emptyAllowed) {
    try {
      json = JSON.parse(text);
    } catch {
      throw badRequest("The request body must be JSON");
    }
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw badRequest(
      "Invalid request body",
      parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    );
  }
  return parsed.data;
}

/** The agent run, or steered session, a request says it comes from. See `RUN_ID_HEADER`. */
export function runIdOf(c: Context): string | undefined {
  const value = c.req.header(RUN_ID_HEADER)?.trim();
  return value === undefined || value === "" ? undefined : value;
}
