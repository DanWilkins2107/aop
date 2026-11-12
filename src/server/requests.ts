/**
 * The bodies the HTTP API accepts. The clients type what they send with the `*Request` types in
 * `src/shared`, and each schema here is checked against its type, so the two can't drift apart.
 */
import { z } from "zod";
import type { ApplyRequest, ImprovementRequest, ProposalRequest, WithdrawRequest } from "../shared/improvements/types.js";
import type { ActorRequest, CreateNodeRequest, EdgeRequest, EditNodeRequest, LinkRequest, MessageRequest } from "../shared/nodes/types.js";
import type { AddProjectRequest, UpdateProjectRequest } from "../shared/projects/types.js";
import type { SteerRequest } from "../shared/runs/types.js";
import type { ScheduleRequest } from "../shared/schedule/types.js";
import type { AnswerRequest, AskRequest, BlockRequest, FailRequest, InvalidateRequest, MoveRequest, NextRequest } from "../shared/stages/types.js";

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? unknown : never;

/** Ties a schema to the `Request` type clients send. It compiles only if the schema accepts exactly that type. */
const bodyOf =
  <Request>() =>
  <S extends z.ZodType>(schema: S & Same<z.input<S>, Request>): S =>
    schema;

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const actor = z.enum(["human", "agent", "system"]);
const nonBlank = z.string().refine((s) => s.trim().length > 0, "must not be blank");
const title = nonBlank.refine((s) => [...s].length <= 200, "must be at most 200 characters");

const repoPath = nonBlank.nullable().optional();
export const addProjectBody = bodyOf<AddProjectRequest>()(z.strictObject({ name: title.optional(), repo_path: repoPath }));
export const updateProjectBody = bodyOf<UpdateProjectRequest>()(
  z
    .strictObject({ name: title.optional(), repo_path: repoPath })
    .refine((edit) => edit.name !== undefined || edit.repo_path !== undefined, "must include name or repo_path"),
);
export const createNodeBody = bodyOf<CreateNodeRequest>()(
  z.strictObject({
    type: nonBlank.optional(),
    stage: nonBlank.optional(),
    title,
    body: z.string().optional(),
    parent_id: nonBlank.optional(),
    actor: actor.default("human"),
  }),
);
export const editNodeBody = bodyOf<EditNodeRequest>()(
  z
    .strictObject({ title: title.optional(), body: z.string().optional(), actor: actor.default("human") })
    .refine((edit) => edit.title !== undefined || edit.body !== undefined, "must include title or body"),
);
export const nextBody = bodyOf<NextRequest>()(z.strictObject({ outcome: nonBlank, actor: actor.default("human") }));
export const moveBody = bodyOf<MoveRequest>()(z.strictObject({ stage: nonBlank, type: nonBlank.optional() }));
export const askBody = bodyOf<AskRequest>()(z.strictObject({ question: nonBlank }));
export const answerBody = bodyOf<AnswerRequest>()(z.strictObject({ answer: nonBlank }));
export const failBody = bodyOf<FailRequest>()(z.strictObject({ actor: actor.default("system"), reason: nonBlank.optional() }));
export const invalidateBody = bodyOf<InvalidateRequest>()(z.strictObject({ reason: nonBlank, actor: actor.default("human") }));
export const actorBody = bodyOf<ActorRequest>()(z.strictObject({ actor: actor.default("human") }));
export const steerBody = bodyOf<SteerRequest>()(z.strictObject({ no_sandbox: z.boolean().default(false) }));
export const blockBody = bodyOf<BlockRequest>()(z.strictObject({ reason: nonBlank, actor: actor.default("human") }));
// No client sends a body to unblock or claim, so these two have no shared type.
export const unblockBody = z.strictObject({ actor: actor.default("human") });
export const claimBody = z.strictObject({ actor: z.enum(["human", "agent"]).default("human") });
export const messageBody = bodyOf<MessageRequest>()(z.strictObject({ body: nonBlank, author: actor.default("human") }));
export const linkBody = bodyOf<LinkRequest>()(
  z.strictObject({
    kind: z.enum(["ticket", "pr"]),
    url: z.string().regex(/^https?:\/\/\S+$/, "must start with http:// or https://"),
    actor: actor.default("human"),
  }),
);
export const edgeBody = bodyOf<EdgeRequest>()(
  z.strictObject({
    target_id: nonBlank,
    kind: z.enum(["subtask", "blocks"]),
    actor: actor.default("human"),
  }),
);
export const improvementBody = bodyOf<ImprovementRequest>()(
  z.strictObject({
    body: nonBlank,
    source_message_id: nonBlank.optional(),
    actor: actor.default("human"),
  }),
);
export const proposalBody = bodyOf<ProposalRequest>()(
  z.strictObject({
    path: nonBlank,
    content: z.string().max(1_000_000, "must be at most 1,000,000 characters"),
    actor: actor.default("human"),
  }),
);
export const withdrawBody = bodyOf<WithdrawRequest>()(z.strictObject({ path: nonBlank, actor: actor.default("human") }));
export const applyBody = bodyOf<ApplyRequest>()(
  z.strictObject({
    reviewed: z.array(z.strictObject({ path: nonBlank, revision: nonBlank })).max(10_000),
    actor: actor.default("human"),
  }),
);
export const scheduleBody = bodyOf<ScheduleRequest>()(
  z
    .strictObject({
      time: z.string().regex(TIME_PATTERN, "must be HH:MM, from 00:00 to 23:59"),
      days: z
        .array(z.number().int().min(0).max(6))
        .min(1, "must include at least one day")
        .refine((days) => new Set(days).size === days.length, "must not repeat a day"),
    })
    .nullable(),
);
