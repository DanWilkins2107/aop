import { runServer } from "./serve.js";
import { noCwdLookupEnv } from "../shared/os/noCwdLookupEnv.js";

Object.assign(process.env, noCwdLookupEnv);

await runServer(process.argv.slice(2), "Usage: npm start -- [--port <port>]");
