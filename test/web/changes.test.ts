import { describe, expect, it } from "vitest";
import { EVERYTHING, mergeNotices, readNotice, touchesNode, touchesProject } from "../../web/src/lib/changes.js";

describe("change notices", () => {
  it("reads a notice, and takes anything unexpected as everything", () => {
    expect(readNotice('{"project_ids":["p"],"node_ids":["n"]}')).toEqual({ project_ids: ["p"], node_ids: ["n"] });
    expect(readNotice('{"project_ids":["p"],"node_ids":null}')).toEqual({ project_ids: ["p"], node_ids: null });
    expect(readNotice("{}")).toEqual(EVERYTHING);
    expect(readNotice("not json")).toEqual(EVERYTHING);
    expect(readNotice('{"project_ids":[1]}')).toEqual(EVERYTHING);
  });

  it("merges, with null winning", () => {
    expect(mergeNotices({ project_ids: ["a"], node_ids: ["x"] }, { project_ids: ["b", "a"], node_ids: [] })).toEqual({
      project_ids: ["a", "b"],
      node_ids: ["x"],
    });
    expect(mergeNotices({ project_ids: ["a"], node_ids: ["x"] }, { project_ids: ["a"], node_ids: null }).node_ids).toBeNull();
    expect(mergeNotices(EVERYTHING, { project_ids: ["a"], node_ids: [] }).project_ids).toBeNull();
  });

  it("says which pages a change concerns", () => {
    const change = { project_ids: ["a"], node_ids: ["x"] };
    expect(touchesProject(change, "a")).toBe(true);
    expect(touchesProject(change, "b")).toBe(false);
    expect(touchesProject(EVERYTHING, "b")).toBe(true);
    expect(touchesNode(change, "x", "a")).toBe(true);
    expect(touchesNode(change, "y", "a")).toBe(false);
    // Any node of the projects named, or of any project.
    expect(touchesNode({ project_ids: ["a"], node_ids: null }, "y", "a")).toBe(true);
    expect(touchesNode({ project_ids: ["a"], node_ids: null }, "y", "b")).toBe(false);
    expect(touchesNode(EVERYTHING, "y", "b")).toBe(true);
  });
});
