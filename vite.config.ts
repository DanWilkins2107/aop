import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const DEV_PORT = 5173;
const server = `http://127.0.0.1:${process.env["AOP_PORT"] ?? "4317"}`;
const ownOrigins = [`http://localhost:${DEV_PORT}`, `http://127.0.0.1:${DEV_PORT}`];

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: DEV_PORT,
    strictPort: true,
    proxy: {
      "/api": {
        target: server,
        changeOrigin: true,
        configure: (proxy) => {
          // The server only accepts its own Origin. Vouch for this dev server's pages alone, so
          // that other websites are still refused through the proxy.
          proxy.on("proxyReq", (request, incoming) => {
            if (ownOrigins.includes(incoming.headers.origin ?? "")) request.setHeader("origin", server);
          });
        },
      },
    },
  },
});
