// @twenty4/api — minimal Fastify-on-Bun app (M0).
// M0 ships ONLY GET /health. Full skeleton (error envelope, CORS, content-type
// parser, DB-verify-on-boot, rate-limit, graceful shutdown) lands in M1.
import Fastify from "fastify";

// Bind 0.0.0.0 so a real device on the LAN/Tailscale net can reach it.
// 127.0.0.1 would be loopback-only and unreachable from the phone. See RUNNING.md.
const API_HOST = process.env.API_HOST ?? "0.0.0.0";
const API_PORT = Number(process.env.API_PORT ?? 3000);

export function buildApp() {
  const app = Fastify({ logger: true });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  return app;
}

async function main() {
  const app = buildApp();
  try {
    await app.listen({ host: API_HOST, port: API_PORT });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Bun runs this file directly via `bun run --watch src/index.ts`.
main();
