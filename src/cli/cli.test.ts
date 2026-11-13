import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it } from "vitest";
import { MCP_PORT } from "../shared/port.js";
import type { World } from "../../test/server/agents.helpers.js";
import { aopOn, cliWorld } from "./shared/cli.helpers.js";

// How every command finds its server, reads its arguments and fails. Each command's own behaviour
// is tested beside it in `commands/`.

let w: World;
beforeEach(async () => {
  w = await cliWorld();
});

const aop = (args: string[], options: { node?: string; env?: Record<string, string> } = {}) => aopOn(w, args, options);

describe("the commands", () => {
  it("bad usage is a clear message and exit code 2, with no stack trace", async () => {
    const bad = [["logs"], ["node"], ["nonsense"], ["logs", "x", "--bad"], ["ps", "x"], ["reap", "--bad"], ["next"], ["ask"], ["fail"], ["message"], ["link"], ["search"], ["edge"], ["node", "edit"], ["node", "create"], ["split"], ["context"]];
    for (const args of bad) {
      const res = await aop(args, { node: "n" });
      expect(res.code, args.join(" ")).toBe(2);
      expect(res.stderr).not.toContain("    at ");
    }
    // Usage comes before the node, so it's the usage that's reported without one.
    for (const args of [["logs"], ["logs", "a", "b"]]) {
      const res = await aop(args);
      expect(res.code, args.join(" ")).toBe(2);
      expect(res.stderr).toContain("Usage: aop ");
    }
  });

  it("a usage error shows that command's usage, as the help lists it", async () => {
    const help = (await aop(["help"])).stdout;
    const option = await aop(["logs", "x", "--bad"], { node: "n" });
    expect(option.stderr).toContain("--bad");
    expect(option.stderr).toContain("Usage: aop logs <node> [--lines N]");
    const project = await aop(["project", "sideways"]);
    expect(project.stderr).toBe("Usage: aop project add <path>\n");
    for (const line of ["aop logs <node> [--lines N]", "aop project add <path>", "aop ps"]) {
      expect(help).toContain(`\n  ${line}\n`);
    }
    expect(help).not.toContain("aop context");
    expect(help).toContain(`Agents use AOP's MCP server at http://127.0.0.1:${MCP_PORT}/mcp.\n`);
  });

  it("says when the server can't be reached", async () => {
    const res = await aop(["ps"], { env: { AOP_URL: "http://127.0.0.1:1" } });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("aop serve");
    expect(res.stderr).not.toContain("    at ");
  });

  it("says when what answers isn't the API, and when an error isn't the API's", async () => {
    // Stands in for something else on the port, such as the UI's dev server, which answers every path with a page.
    const stub = (status: number, type: string, body: string) =>
      new Promise<Server>((done) => {
        const server = createServer((_req, res) => res.writeHead(status, { "content-type": type }).end(body));
        server.listen(0, "127.0.0.1", () => done(server));
      });
    const urlOf = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const page = await stub(200, "text/html", "<!doctype html><title>Not AOP</title>");
    const badJson = await stub(200, "application/json", "{not json");
    const oddError = await stub(500, "application/json", JSON.stringify({ error: "a string, not the API's shape" }));
    try {
      for (const [server, args] of [[page, ["ps"]], [badJson, ["ps"]]] as const) {
        const res = await aop([...args], { env: { AOP_URL: urlOf(server) } });
        expect(res.code, args.join(" ")).toBe(1);
        expect(res.stderr).toContain("isn't the AOP server's API");
        expect(res.stderr).not.toContain("    at ");
      }
      const odd = await aop(["ps"], { env: { AOP_URL: urlOf(oddError) } });
      expect(odd.code).toBe(1);
      expect(odd.stderr).toBe("The server answered 500\n");
    } finally {
      for (const server of [page, badJson, oddError]) server.close();
    }
  });
});
