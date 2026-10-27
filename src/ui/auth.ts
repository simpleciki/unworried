// Judge accounts from JUDGE_ACCOUNTS ("name:secret,name:secret"); cookie sessions with random ids. The
// session id is also the session_id for the judge's calendar, ledger, outbox and spend budget. Sessions are
// persisted to a small JSON file so a server restart does not orphan a judge's sandbox. No accounts → no
// anonymous mode: every route but /login answers 401.
import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const COOKIE = "unworried_session";

export type AuthSession = { session_id: string; judge: string; created_at: string };

export function parseAccounts(value: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (value ?? "").split(",")) {
    const p = part.trim();
    if (!p) continue;
    const i = p.indexOf(":");
    if (i <= 0 || i === p.length - 1) throw new Error(`JUDGE_ACCOUNTS: entry ${JSON.stringify(p)} must be name:secret`);
    const name = p.slice(0, i).trim();
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(name)) throw new Error(`JUDGE_ACCOUNTS: name ${JSON.stringify(name)} must match [A-Za-z0-9._-]{1,32}`);
    if (out.has(name)) throw new Error(`JUDGE_ACCOUNTS: duplicate name ${name}`);
    out.set(name, p.slice(i + 1));
  }
  return out;
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
};

export class Auth {
  private readonly accounts: Map<string, string>;
  private readonly sessions = new Map<string, AuthSession>();
  private readonly file?: string;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(opts: { accounts: Map<string, string>; file?: string; now?: () => number; newId?: () => string }) {
    this.accounts = opts.accounts;
    this.file = opts.file;
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? (() => randomUUID());
    if (this.file && existsSync(this.file)) {
      try {
        for (const s of JSON.parse(readFileSync(this.file, "utf8")) as AuthSession[]) if (this.accounts.has(s.judge)) this.sessions.set(s.session_id, s);
      } catch (e) {
        throw new Error(`${this.file}: cannot read sessions (${(e as Error).message})`);
      }
    }
  }

  get configured(): boolean {
    return this.accounts.size > 0;
  }

  get judges(): string[] {
    return [...this.accounts.keys()];
  }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify([...this.sessions.values()], null, 2) + "\n");
    renameSync(tmp, this.file);
  }

  login(name: string, secret: string): AuthSession | null {
    const expected = this.accounts.get(name);
    if (expected === undefined || !safeEqual(expected, secret)) return null;
    const s: AuthSession = { session_id: this.newId(), judge: name, created_at: new Date(this.now()).toISOString() };
    this.sessions.set(s.session_id, s);
    this.save();
    return s;
  }

  lookup(cookieHeader: string | undefined): AuthSession | null {
    const id = readCookie(cookieHeader, COOKIE);
    return id ? (this.sessions.get(id) ?? null) : null;
  }

  logout(session_id: string): void {
    this.sessions.delete(session_id);
    this.save();
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export const setCookie = (session_id: string) => `${COOKIE}=${encodeURIComponent(session_id)}; HttpOnly; Path=/; SameSite=Strict`;
export const clearCookie = () => `${COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`;
