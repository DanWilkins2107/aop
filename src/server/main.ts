import { runServer } from "./serve.js";

await runServer(process.argv.slice(2), "Usage: npm start -- [--port <port>]");
