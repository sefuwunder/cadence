// Email SMTP sender — zero deps, node:net / node:tls.
// Used by "Assign from feed": compose + send an email through the configured
// backend, then file it in Sent via IMAP APPEND (see email-imap.ts).
//
// Flow: EHLO → STARTTLS (587) or implicit TLS (465) → AUTH LOGIN or
// AUTH XOAUTH2 → MAIL FROM / RCPT TO / DATA → QUIT.
//
// Config resolution mirrors email-imap.ts:
//   1. connector config (stored in connector_cfg)
//   2. env: CADENCE_SMTP_HOST, CADENCE_SMTP_PORT, CADENCE_SMTP_USER,
//      CADENCE_SMTP_PASS, CADENCE_SMTP_SECURE ("ssl" | "starttls")
//   3. gitignored JSON file: $CADENCE_DATA_DIR/imap.json
//      { "smtp_host": "...", "smtp_port": 587, "smtp_user": "...",
//        "smtp_pass": "...", "smtp_secure": "starttls" }
//   4. GNOME Online Accounts: SMTP of the selected mail account (same
//      `goa_account` selection as IMAP: connector config, CADENCE_GOA_ACCOUNT
//      env, or imap.json — matches email or GOA id, else first account).
//      OAuth2 accounts authenticate with SASL XOAUTH2; password accounts with
//      AUTH LOGIN. Credentials are fetched per send and never stored.
// Credentials and message bodies are never logged. Sending is always
// user-initiated from the UI — nothing here sends on its own.

import { readFileSync } from "fs";
import { join } from "path";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { xoauth2Blob } from "./email-imap.ts";
import {
  listGoaMailAccounts, getGoaCredentials, goaSmtpCfg,
  type GoaMailAccount, type GoaCredentials,
} from "../goa.ts";

export class SmtpError extends Error {}

// ---------- line I/O (injectable for tests) ----------

/** Line-based duplex for the SMTP conversation. */
export interface SmtpLineIO {
  write(data: string): void;
  readLine(): Promise<string>;
  /** Upgrade a plaintext connection to TLS (STARTTLS). No-op for implicit TLS. */
  startTls(host: string): Promise<void>;
  close(): void;
}

const LINE_TIMEOUT_MS = 30000;

/** Real socket I/O: plain TCP for 587, implicit TLS for 465. */
class SocketLineIO implements SmtpLineIO {
  private sock: Socket;
  private buf = Buffer.alloc(0);
  private lines: string[] = [];
  private wake: (() => void) | null = null;
  private closedErr: Error | null = null;

  private constructor(sock: Socket) {
    this.sock = sock;
    this.attach();
  }

  static connect(host: string, port: number, secure: "ssl" | "starttls"): Promise<SocketLineIO> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new SmtpError(`smtp connect timed out (${host}:${port})`)); }
      }, LINE_TIMEOUT_MS);
      const done = (sock: Socket) => {
        if (!settled) { settled = true; clearTimeout(timer); resolve(new SocketLineIO(sock)); }
      };
      const fail = (err: Error) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(new SmtpError(`smtp connect failed: ${err.message}`)); }
      };
      if (secure === "ssl") {
        const s: any = tlsConnect({ host, port, servername: host });
        s.once("secureConnect", () => done(s));
        s.once("error", fail);
      } else {
        const s = netConnect({ host, port });
        s.once("connect", () => done(s));
        s.once("error", fail);
      }
    });
  }

  private attach() {
    this.sock.on("data", (d: Buffer) => this.onData(d));
    this.sock.on("error", (e: Error) => this.onClose(e));
    this.sock.on("close", () => this.onClose(new Error("smtp connection closed by server")));
  }

  private onData(data: Buffer) {
    this.buf = Buffer.concat([this.buf, data]);
    for (;;) {
      const idx = this.buf.indexOf("\r\n");
      if (idx < 0) break;
      this.lines.push(this.buf.slice(0, idx).toString("utf8"));
      this.buf = this.buf.slice(idx + 2);
    }
    if (this.wake) { const w = this.wake; this.wake = null; w(); }
  }

  private onClose(err: Error) {
    if (!this.closedErr) this.closedErr = err;
    if (this.wake) { const w = this.wake; this.wake = null; w(); }
  }

  write(data: string) {
    this.sock.write(data);
  }

  readLine(): Promise<string> {
    if (this.lines.length) return Promise.resolve(this.lines.shift()!);
    if (this.closedErr) return Promise.reject(new SmtpError(this.closedErr.message));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.wake = null;
        reject(new SmtpError("smtp timed out waiting for reply"));
      }, LINE_TIMEOUT_MS);
      this.wake = () => {
        clearTimeout(timer);
        if (this.lines.length) resolve(this.lines.shift()!);
        else reject(new SmtpError(this.closedErr?.message || "smtp connection lost"));
      };
    });
  }

  async startTls(host: string): Promise<void> {
    const tlsSock: any = tlsConnect({ socket: this.sock as any, servername: host });
    await new Promise<void>((resolve, reject) => {
      tlsSock.once("secureConnect", () => resolve());
      tlsSock.once("error", (e: Error) => reject(new SmtpError(`smtp STARTTLS failed: ${e.message}`)));
    });
    this.sock = tlsSock;
    this.attach();
  }

  close() {
    try { this.sock.destroy(); } catch { /* gone */ }
  }
}

// ---------- SMTP session ----------

export interface SmtpCfg {
  host: string; port: number; user: string; pass: string;
  auth: "login" | "xoauth2"; // internal — never shown in the UI
  secure: "ssl" | "starttls";
  goaId?: string;            // GOA account id when credentials came from GOA
}

export class SmtpSession {
  constructor(private io: SmtpLineIO) {}

  private async expectLine(command: string, ok: RegExp, what: string): Promise<string> {
    this.io.write(command + "\r\n");
    const line = await this.io.readLine();
    if (!ok.test(line)) {
      throw new SmtpError(what
        ? `${what}: ${line.slice(0, 120)}`
        : `smtp command failed: ${line.slice(0, 120)}`);
    }
    return line;
  }

  /** EHLO, returning the advertised extension keywords (lowercased). */
  private async ehlo(): Promise<Set<string>> {
    this.io.write("EHLO cadence.local\r\n");
    const ext = new Set<string>();
    for (;;) {
      const line = await this.io.readLine();
      const m = line.match(/^250([ -])(.*)$/);
      if (!m) throw new SmtpError(`smtp EHLO failed: ${line.slice(0, 120)}`);
      const kw = m[2].trim().split(/\s+/)[0]?.toLowerCase();
      if (kw) ext.add(kw);
      if (m[1] === " ") return ext;
    }
  }

  /** Full send: greeting → EHLO → (STARTTLS) → AUTH → MAIL/RCPT/DATA → QUIT. */
  async send(cfg: SmtpCfg, msg: { to: string[]; raw: string }): Promise<void> {
    const greet = await this.io.readLine();
    if (!/^220[ -]/.test(greet)) {
      throw new SmtpError(`smtp server did not greet: ${greet.slice(0, 80)}`);
    }
    let ext = await this.ehlo();
    if (cfg.secure === "starttls") {
      if (!ext.has("starttls")) throw new SmtpError("smtp server does not offer STARTTLS");
      await this.expectLine("STARTTLS", /^220[ -]/, "smtp STARTTLS refused");
      await this.io.startTls(cfg.host);
      ext = await this.ehlo();
    }
    if (cfg.auth === "xoauth2") {
      await this.expectLine(
        `AUTH XOAUTH2 ${xoauth2Blob(cfg.user, cfg.pass)}`,
        /^235[ -]/, "smtp XOAUTH2 authentication failed");
    } else {
      if (!ext.has("auth")) throw new SmtpError("smtp server did not advertise AUTH");
      await this.expectLine("AUTH LOGIN", /^334[ -]/, "smtp AUTH LOGIN not accepted");
      await this.expectLine(
        Buffer.from(cfg.user, "utf8").toString("base64"), /^334[ -]/, "smtp username rejected");
      await this.expectLine(
        Buffer.from(cfg.pass, "utf8").toString("base64"), /^235[ -]/,
        "smtp authentication failed (bad username/password)");
    }
    await this.expectLine(`MAIL FROM:<${cfg.user}>`, /^250[ -]/, "smtp MAIL FROM rejected");
    for (const rcpt of msg.to) {
      await this.expectLine(`RCPT TO:<${rcpt}>`, /^25[02][ -]/, `smtp recipient rejected: ${rcpt}`);
    }
    await this.expectLine("DATA", /^354[ -]/, "smtp DATA not accepted");
    const stuffed = msg.raw
      .split("\r\n")
      .map((l) => (l.startsWith(".") ? "." + l : l))
      .join("\r\n");
    this.io.write(stuffed + "\r\n.\r\n");
    const dataResp = await this.io.readLine();
    if (!/^250[ -]/.test(dataResp)) {
      throw new SmtpError(`smtp message rejected: ${dataResp.slice(0, 120)}`);
    }
    try { await this.expectLine("QUIT", /^221[ -]/, ""); } catch { /* best effort */ }
  }
}

// ---------- message building (pure, unit-tested) ----------

/** RFC 2047 B-encoding for non-ASCII header values. Best effort. */
export function encodeHeader(s: string): string {
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

export interface OutgoingMessage {
  from: string;
  to: string[];
  subject: string;
  body: string;
  date?: Date;
  messageId?: string;
  inReplyTo?: string;    // raw message-id (no brackets) this message answers
  references?: string[]; // raw message-ids forming the thread chain
}

/** Build a plain-text RFC 5322 message. Returns the raw bytes + Message-ID. */
export function buildMessage(m: OutgoingMessage): { raw: string; messageId: string } {
  const messageId = m.messageId || `<${crypto.randomUUID()}@cadence>`;
  const date = (m.date || new Date()).toUTCString();
  const lines = [
    `From: ${m.from}`,
    `To: ${m.to.join(", ")}`,
    `Subject: ${encodeHeader(m.subject)}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
  ];
  if (m.inReplyTo) lines.push(`In-Reply-To: <${m.inReplyTo}>`);
  if (m.references && m.references.length) {
    lines.push(`References: ${m.references.map((r) => `<${r}>`).join(" ")}`);
  }
  lines.push(
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    m.body.replace(/\r?\n/g, "\r\n"),
  );
  return { raw: lines.join("\r\n") + "\r\n", messageId };
}

// ---------- config resolution ----------

/** Injectable GOA functions so tests never touch D-Bus. */
export interface GoaFns {
  listGoaMailAccounts(): Promise<GoaMailAccount[]>;
  getGoaCredentials(a: GoaMailAccount): Promise<GoaCredentials>;
}
const realGoaFns: GoaFns = { listGoaMailAccounts, getGoaCredentials };

const MISSING_SMTP =
  "email-smtp: missing SMTP credentials — set host/user/pass via connector config, " +
  "CADENCE_SMTP_* env vars, or $CADENCE_DATA_DIR/imap.json (smtp_* keys), " +
  "or add a mail account in GNOME Settings (Online Accounts)";

export async function resolveSmtpConfig(overrides: any, goaFns: GoaFns = realGoaFns): Promise<SmtpCfg> {
  let fileCfg: any = {};
  try {
    const dir = process.env.CADENCE_DATA_DIR || "data";
    fileCfg = JSON.parse(readFileSync(join(dir, "imap.json"), "utf8"));
  } catch { /* optional file */ }
  const o = overrides && typeof overrides === "object" ? overrides : {};
  const port = Number(
    o.smtp_port || o.port || process.env.CADENCE_SMTP_PORT || fileCfg.smtp_port || fileCfg.port || 587);
  const secureRaw = String(
    o.smtp_secure || process.env.CADENCE_SMTP_SECURE || fileCfg.smtp_secure ||
    (port === 465 ? "ssl" : "starttls")).toLowerCase();
  const secure: "ssl" | "starttls" = secureRaw === "ssl" ? "ssl" : "starttls";
  const cfg: SmtpCfg = {
    host: o.smtp_host || o.host || process.env.CADENCE_SMTP_HOST || fileCfg.smtp_host || "",
    port,
    user: o.smtp_user || o.user || process.env.CADENCE_SMTP_USER || fileCfg.smtp_user || "",
    pass: o.smtp_pass || o.pass || process.env.CADENCE_SMTP_PASS || fileCfg.smtp_pass || "",
    auth: "login",
    secure,
  };
  if (cfg.host && cfg.user && cfg.pass) return cfg; // explicit credentials win

  // GOA fallback — same account selection as IMAP so both use one account.
  // Credentials come from the keyring via goa-daemon, fetched per send,
  // never written to Cadence's DB.
  const sel = String(o.goa_account || process.env.CADENCE_GOA_ACCOUNT || fileCfg.goa_account || "")
    .toLowerCase().trim();
  let accounts: GoaMailAccount[] = [];
  try {
    accounts = await goaFns.listGoaMailAccounts();
  } catch { /* GOA unreachable/absent → fall through to the human-readable error */ }
  const acct = sel
    ? accounts.find((a) => a.email.toLowerCase() === sel || a.id.toLowerCase() === sel)
    : accounts[0];
  if (!acct) {
    if (sel && accounts.length) {
      const have = accounts.map((a) => a.email).join(", ");
      throw new SmtpError(`email-smtp: no GOA mail account matches "${sel}" (have: ${have})`);
    }
    throw new SmtpError(MISSING_SMTP + " …and no GNOME Online Accounts mail account found");
  }
  const smtp = goaSmtpCfg(acct); // throws human-readable GoaError on missing host / unencrypted
  const creds = await goaFns.getGoaCredentials(acct); // auth failures propagate (human-readable)
  if (creds.oauth2 && creds.token) {
    return { host: smtp.host, port: smtp.port, user: smtp.user, pass: creds.token,
             auth: "xoauth2", secure: smtp.secure, goaId: acct.id };
  }
  const pw = creds.smtpPassword || creds.imapPassword;
  if (pw) {
    return { host: smtp.host, port: smtp.port, user: smtp.user, pass: pw,
             auth: "login", secure: smtp.secure, goaId: acct.id };
  }
  throw new SmtpError(`email-smtp: GOA account ${acct.email} returned no usable credentials`);
}

// ---------- high-level send ----------

/** Resolve config, build the message, and send it. Returns the raw message
 *  (for IMAP APPEND into Sent) and the Message-ID. */
export async function sendEmail(opts: {
  to: string[]; subject: string; body: string; config: any;
  goaFns?: GoaFns; ioFactory?: () => Promise<SmtpLineIO>;
}): Promise<{ messageId: string; from: string; to: string[]; raw: string }> {
  const cfg = await resolveSmtpConfig(opts.config, opts.goaFns);
  return sendWithConfig(cfg, { to: opts.to, subject: opts.subject, body: opts.body }, opts.ioFactory);
}

/** Send with an already-resolved config (lets callers separate the
 *  "is SMTP configured?" check from the network send). */
export async function sendWithConfig(
  cfg: SmtpCfg,
  msg: { to: string[]; subject: string; body: string; inReplyTo?: string; references?: string[] },
  ioFactory?: () => Promise<SmtpLineIO>,
): Promise<{ messageId: string; from: string; to: string[]; raw: string }> {
  const { raw, messageId } = buildMessage({
    from: cfg.user, to: msg.to, subject: msg.subject, body: msg.body,
    inReplyTo: msg.inReplyTo, references: msg.references,
  });
  const io = ioFactory ? await ioFactory() : await SocketLineIO.connect(cfg.host, cfg.port, cfg.secure);
  try {
    await new SmtpSession(io).send(cfg, { to: msg.to, raw });
  } finally {
    io.close();
  }
  return { messageId, from: cfg.user, to: msg.to, raw };
}

// Exported for tests (pure helpers + session, no network).
export const _test = { encodeHeader, buildMessage, resolveSmtpConfig, SmtpSession };
