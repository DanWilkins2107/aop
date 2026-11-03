import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { createApp } from "./api.js";
import type { Db } from "./db.js";

export const HOSTNAME = "127.0.0.1";

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

/** Serves the API on localhost only. Pass port 0 for any free port. */
export function startServer(db: Db, port: number): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: createApp(db).fetch, hostname: HOSTNAME, port }, (info) => {
      resolve({
        port: info.port,
        close: () => new Promise((done, fail) => server.close((e) => (e ? fail(e) : done()))),
      });
    }) as Server;
    server.once("error", reject);
  });
}
