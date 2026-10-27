// `npm start` / `npm run ui`: the screen. Everything from the environment (see .env.example):
//   JUDGE_ACCOUNTS  name:secret,…   (required; without it the site shows only the login page and 401s)
//   HOST, PORT      default 127.0.0.1:8787
//   DEMO_CLOCK      default 2026-11-03T09:00:00-06:00
//   plus the spend wall's variables (NEBIUS_*, LLM_ENABLED, SPEND_*).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SpendGuard } from "../spend/guard.ts";
import { Auth, parseAccounts } from "../ui/auth.ts";
import { createRouter, startServer } from "../ui/server.ts";
import { SandboxManager } from "../ui/sessions.ts";

const root = join(import.meta.dirname, "..", "..");
const env = process.env;

function main() {
  const accounts = parseAccounts(env.JUDGE_ACCOUNTS);
  const auth = new Auth({ accounts, file: join(root, "state", "sessions", "auth.json") });
  const guard = SpendGuard.fromEnv(env, { log: (line) => console.error(line) });
  const sandboxes = new SandboxManager({ root, guard, clock: env.DEMO_CLOCK });
  const html = readFileSync(join(root, "src", "ui", "index.html"), "utf8");
  const route = createRouter({ auth, sandboxes, html, log: (line) => console.log(line) });
  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT=${env.PORT} is not a port`);
  const host = env.HOST || "127.0.0.1";
  const wall = guard.state();
  console.log(`unworried — demo clock ${new Date(sandboxes.clock).toISOString()} — wall ${wall.enabled ? "ON" : `OFF (${wall.reason})`} — judges: ${accounts.size ? [...accounts.keys()].join(", ") : "NONE (login impossible)"}`);
  return startServer(route, { host, port }).then((server) => {
    const a = server.address();
    const where = typeof a === "object" && a ? `${a.address}:${a.port}` : String(a);
    console.log(`listening on http://${where}/${host === "127.0.0.1" ? "  (this machine only; set HOST to expose)" : ""}`);
  });
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
