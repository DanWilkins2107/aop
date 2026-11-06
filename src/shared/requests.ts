/**
 * The bodies the HTTP API accepts. The server validates against these schemas, and the clients type
 * what they send with the `*Request` types in `api.ts`, so the two can't drift apart. Clients import
 * only types from here, never the schemas, so that zod stays out of the browser's bundle.
 */
import { z } from "zod";
import { TIME_PATTERN } from "./schedule.js";

const actor = z.enum(["human", "agent", "system"]);
const nonBlank = z.string().refine((s) => s.trim().length > 0, "must not be blank");
const title = nonBlank.refine((s) => [...s].length <= 200, "must be at most 200 characters");

const repoPath = nonBlank.nullable().optional();
export const addProjectBody = z.strictObject({ name: title.optional(), repo_path: repoPath });
export const updateProjectBody = z
  .strictObject({ name: title.optional(), repo_path: repoPath })
  .refine((edit) => edit.name !== undefined || edit.repo_path !== undefined, "must include name or repo_path");
export const createNodeBody = z.strictObject({
  type: nonBlank.optional(),
  stage: nonBlank.optional(),
  title,
  body: z.string().optional(),
  parent_id: nonBlank.optional(),
  actor: actor.default("human"),
});
export const editNodeBody = z
  .strictObject({ title: title.optional(), body: z.string().optional(), actor: actor.default("human") })
  .refine((edit) => edit.title !== undefined || edit.body !== undefined, "must include title or body");
export const nextBody = z.strictObject({ outcome: nonBlank, actor: actor.default("human") });
export const moveBody = z.strictObject({
  stage: nonBlank,
  type: nonBlank.optional(),
});
export const askBody = z.strictObject({ question: nonBlank });
export const answerBody = z.strictObject({ answer: nonBlank });
export const failBody = z.strictObject({ actor: actor.default("system"), reason: nonBlank.optional() });
export const invalidateBody = z.strictObject({ reason: nonBlank, actor: actor.default("human") });
export const actorBody = z.strictObject({ actor: actor.default("human") });
export const steerBody = z.strictObject({ no_sandbox: z.boolean().default(false) });
export const blockBody = z.strictObject({ reason: nonBlank, actor: actor.default("human") });
export const unblockBody = z.strictObject({ actor: actor.default("human") });
export const claimBody = z.strictObject({ actor: z.enum(["human", "agent"]).default("human") });
export const messageBody = z.strictObject({ body: nonBlank, author: actor.default("human") });
export const linkBody = z.strictObject({
  kind: z.enum(["ticket", "pr"]),
  url: z.string().regex(/^https?:\/\/\S+$/, "must start with http:// or https://"),
  actor: actor.default("human"),
});
export const edgeBody = z.strictObject({
  target_id: nonBlank,
  kind: z.enum(["subtask", "blocks"]),
  actor: actor.default("human"),
});
export const improvementBody = z.strictObject({
  body: nonBlank,
  source_message_id: nonBlank.optional(),
  actor: actor.default("human"),
});
export const proposalBody = z.strictObject({
  path: nonBlank,
  content: z.string().max(1_000_000, "must be at most 1,000,000 characters"),
  actor: actor.default("human"),
});
export const withdrawBody = z.strictObject({ path: nonBlank, actor: actor.default("human") });
export const applyBody = z.strictObject({ into: nonBlank.optional(), actor: actor.default("agent") });
/** A time of day and the days to fire on, or null for no schedule. */
export const scheduleBody = z
  .strictObject({
    time: z.string().regex(TIME_PATTERN, "must be HH:MM, from 00:00 to 23:59"),
    days: z
      .array(z.number().int().min(0).max(6))
      .min(1, "must include at least one day")
      .refine((days) => new Set(days).size === days.length, "must not repeat a day"),
  })
  .nullable();
