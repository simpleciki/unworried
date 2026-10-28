// Node http server. route() is a pure function from a request description to a response description, so
// the whole screen can be tested without a socket. Binds 127.0.0.1 unless HOST says otherwise.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { ApiError, Api } from "./api.ts";
import type { Auth } from "./auth.ts";
import { clearCookie, setCookie } from "./auth.ts";
import type { SandboxManager } from "./sessions.ts";

export type Req = { method: string; url: string; headers: Record<string, string | undefined>; body?: string };
export type Res = { status: number; headers: Record<string, string>; body: string };

export type RouterDeps = { auth: Auth; sandboxes: SandboxManager; html: string; log?: (line: string) => void; newActionId?: () => string };

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const json = (status: number, value: unknown, extra: Record<string, string> = {}): Res => ({ status, headers: { ...JSON_HEADERS, ...extra }, body: JSON.stringify(value) });
const fail = (status: number, error: string, reason: string, extra: Record<string, string> = {}) => json(status, { error, reason }, extra);

export const NO_ACCOUNTS = "no judge accounts are configured (JUDGE_ACCOUNTS is empty); there is no anonymous mode";
export const NOT_LOGGED_IN = "log in first";

export function createRouter(deps: RouterDeps): (req: Req) => Promise<Res> {
  const api = new Api(deps.sandboxes);
  const log = deps.log ?? (() => {});
  const newActionId = deps.newActionId ?? (() => randomUUID());

  return async function route(req: Req): Promise<Res> {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;
    const action_id = newActionId();
    const started = Date.now();
    const done = (res: Res) => {
      log(`${req.method} ${path} ${res.status} ${Date.now() - started}ms action=${action_id}`);
      return res;
    };

    if (req.method === "GET" && (path === "/" || path === "/index.html")) return done({ status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, body: deps.html });

    let body: Record<string, unknown> = {};
    if (req.method === "POST" && req.body) {
      try {
        body = JSON.parse(req.body) as Record<string, unknown>;
      } catch {
        return done(fail(400, "bad_json", "the request body is not JSON"));
      }
    }

    if (path === "/api/login" && req.method === "POST") {
      if (!deps.auth.configured) return done(fail(401, "no_accounts", NO_ACCOUNTS));
      const name = typeof body.name === "string" ? body.name : "";
      const secret = typeof body.secret === "string" ? body.secret : "";
      const s = deps.auth.login(name, secret);
      if (!s) return done(fail(401, "bad_login", "unknown judge name or wrong secret"));
      deps.sandboxes.get(s.session_id, s.judge); // seeds the sandbox now, so the first screen is instant
      return done(json(200, { ok: true, judge: s.judge }, { "set-cookie": setCookie(s.session_id) }));
    }

    if (path === "/api/me" && req.method === "GET") {
      if (!deps.auth.configured) return done(fail(401, "no_accounts", NO_ACCOUNTS));
      const s = deps.auth.lookup(req.headers.cookie);
      if (!s) return done(fail(401, "not_logged_in", NOT_LOGGED_IN));
      return done(json(200, { judge: s.judge, judges: deps.auth.judges.length }));
    }

    if (!deps.auth.configured) return done(fail(401, "no_accounts", NO_ACCOUNTS));
    const session = deps.auth.lookup(req.headers.cookie);
    if (!session) return done(fail(401, "not_logged_in", NOT_LOGGED_IN));

    if (path === "/api/logout" && req.method === "POST") {
      deps.auth.logout(session.session_id);
      return done(json(200, { ok: true }, { "set-cookie": clearCookie() }));
    }

    const sb = deps.sandboxes.get(session.session_id, session.judge);
    const str = (k: string) => {
      if (typeof body[k] !== "string" || !(body[k] as string).length) throw new ApiError(400, "missing_field", `${k} is required`);
      return body[k] as string;
    };
    try {
      if (req.method === "GET" && path === "/api/state") return done(json(200, await api.state(sb)));
      if (req.method === "GET" && path === "/api/contrast") return done(json(200, await api.contrast(sb, action_id)));
      if (req.method === "POST" && path === "/api/reset") {
        const fresh = deps.sandboxes.reset(session.session_id, session.judge);
        return done(json(200, { ok: true, judge: fresh.judge }));
      }
      if (req.method === "POST" && path === "/api/chat") return done(json(200, await api.chat(sb, str("text"), action_id)));
      if (req.method === "POST" && path === "/api/confirm") return done(json(200, api.confirm(sb, str("candidate_id"), (body.edits ?? {}) as Parameters<Api["confirm"]>[2], action_id)));
      if (req.method === "POST" && path === "/api/discard") return done(json(200, api.discard(sb, str("candidate_id"), action_id)));
      if (req.method === "POST" && path === "/api/plan") return done(json(200, await api.plan(sb, str("conflict_id"), action_id)));
      if (req.method === "POST" && path === "/api/approve") return done(json(200, await api.approve(sb, str("plan_id"), action_id)));
      if (req.method === "POST" && path === "/api/undo") return done(json(200, await api.undo(sb, str("token"), action_id)));
      if (req.method === "POST" && path === "/api/reply") return done(json(200, await api.reply(sb, str("draft_id"), str("answer"), action_id)));
      return done(fail(404, "not_found", `no route ${req.method} ${path}`));
    } catch (e) {
      if (e instanceof ApiError) return done(fail(e.status, e.message, e.reason));
      const msg = (e as Error).message;
      log(`error on ${req.method} ${path}: ${msg}`);
      return done(fail(500, "internal", msg));
    }
  };
}

// Adapts route() to node:http. Resolves once listening. HOST unset → 127.0.0.1 only.
export function startServer(route: (req: Req) => Promise<Res>, opts: { host?: string; port: number }): Promise<Server> {
  const host = opts.host || "127.0.0.1";
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join("; ") : v;
      const out = await route({ method: req.method ?? "GET", url: req.url ?? "/", headers, body: chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined });
      res.writeHead(out.status, out.headers);
      res.end(out.body);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => resolve(server));
  });
}
