// Email IMAP connector — counts sent messages per day in a date range.
// Reads the Sent folder read-only (EXAMINE, never SELECT) so nothing is
// flagged or modified.
//
// Config resolution (first hit wins per field, GOA last):
//   1. connector config passed to sync() (stored in connector_cfg)
//   2. env: CADENCE_IMAP_HOST, CADENCE_IMAP_PORT, CADENCE_IMAP_USER,
//      CADENCE_IMAP_PASS, CADENCE_IMAP_FOLDER
//   3. gitignored JSON file: $CADENCE_DATA_DIR/imap.json (default ./data/imap.json)
//      { "host": "...", "port": 993, "user": "...", "pass": "...", "folder": "Sent" }
//   4. GNOME Online Accounts: mail-enabled accounts via goa-daemon; account
//      selection by `goa_account` (connector config, CADENCE_GOA_ACCOUNT env,
//      or imap.json) matching email or GOA id, else the first account.
//      OAuth2 accounts authenticate with SASL XOAUTH2; password accounts with
//      LOGIN. Credentials are fetched per sync and never stored by Cadence.
// Credentials are never logged.

import { readFileSync } from "fs";
import { join } from "path";
import {
  listGoaMailAccounts, getGoaCredentials, goaImapCfg,
  type GoaMailAccount, type GoaCredentials,
} from "../goa.ts";

class ImapError extends Error {}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function imapDate(iso: string): string {
  // "2026-10-22" -> "22-Oct-2026"
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new ImapError(`bad date: ${iso}`);
  return `${m[3]}-${MONTHS[Number(m[2]) - 1]}-${m[1]}`;
}

function internalDateToIso(d: string): string {
  const m = String(d || "").match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (!m) return "";
  const mon = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
  if (mon < 0) return "";
  return `${m[3]}-${String(mon + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

// ---------- thread search ----------
// Pragmatic threading: a "thread" is a normalized-subject group. No JWZ.
// Strips reply/forward prefixes (several languages) and [bracket] tags,
// then lowercases + collapses whitespace.

const THREAD_PREFIXES = /^(?:re|fwd?|aw|wg|sv|vs|tr|antw|enc|odp)\s*:/i;

export function normalizeSubject(subject: string): string {
  let s = String(subject || "");
  for (let i = 0; i < 10; i++) {
    const t = s
      .replace(/^\s*\[[^\][\r\n]*\]\s*/, "") // [EXTERNAL], [Ticket #12], …
      .replace(THREAD_PREFIXES, "")
      .trim();
    if (t === s) break;
    s = t;
  }
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Minimal RFC 2047 decoder (=?UTF-8?B|Q?...?=). Returns best effort. */
export function decodeHeader(s: string): string {
  return String(s || "").replace(/=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, _cs, enc, text) => {
    try {
      if (String(enc).toUpperCase() === "B") return Buffer.from(text, "base64").toString("utf8");
      const qp = String(text)
        .replace(/_/g, " ")
        .replace(/=([0-9A-Fa-f]{2})/g, (_h, hex) => String.fromCharCode(parseInt(hex, 16)));
      return Buffer.from(qp, "latin1").toString("utf8");
    } catch {
      return text;
    }
  });
}

export interface ThreadHit {
  thread_key: string; // normalized subject — the stable link ref
  subject: string;    // newest message's subject (display)
  from: string;
  date: string;       // YYYY-MM-DD (INTERNALDATE)
  count: number;
}

/** SASL XOAUTH2 initial client response: base64("user=<email>\x01auth=Bearer <token>\x01\x01"). */
export function xoauth2Blob(user: string, token: string): string {
  return Buffer.from(`user=${user}\x01auth=Bearer ${token}\x01\x01`, "utf8").toString("base64");
}

/**
 * Search a folder for messages matching the query (SUBJECT/FROM/TEXT),
 * grouped into threads by normalized subject, newest first. Cap 25.
 */
export async function searchThreads(opts: {
  query: string; folder?: string; config: any;
}): Promise<ThreadHit[]> {
  const cfg = await resolveConfig(opts.config); // throws human-readable ImapError when missing
  const q = String(opts.query || "").trim();
  if (!q) return [];
  const conn = new Conn();
  await conn.open(cfg.host, cfg.port);
  try {
    const greet = await conn.greeting();
    if (!/^\* OK/i.test(greet)) throw new ImapError("imap server did not greet");
    await authenticate(conn, "t001", cfg);
    const folder = opts.folder || cfg.folder || (await findSentFolder(conn));
    if (!folder) throw new ImapError("imap: could not find a Sent folder");
    await conn.cmd("t002", `EXAMINE ${qstr(folder)}`); // read-only
    const ascii = /^[\x00-\x7F]*$/.test(q);
    const crit = `(OR (OR SUBJECT ${qstr(q)} FROM ${qstr(q)}) TEXT ${qstr(q)})`;
    const lines = await conn.cmd(
      "t003", ascii ? `UID SEARCH ${crit}` : `UID SEARCH CHARSET UTF-8 ${crit}`);
    let uids: string[] = [];
    for (const l of lines) {
      const m = l.match(/^\* SEARCH\s*(.*)$/i);
      if (m && m[1].trim()) uids.push(...m[1].trim().split(/\s+/));
    }
    // Newest ~300 only; group into threads, cap 25.
    uids = uids.slice(-300);
    const msgs: { subject: string; from: string; internal: string }[] = [];
    for (let i = 0; i < uids.length; i += 200) {
      const chunk = uids.slice(i, i + 200);
      const fl = await conn.cmd(
        "t004", `UID FETCH ${chunk.join(",")} (INTERNALDATE BODY[HEADER.FIELDS (SUBJECT FROM DATE)])`);
      for (const l of fl) {
        const head = l.includes("\n") ? l.slice(0, l.indexOf("\n")) : l;
        const im = head.match(/INTERNALDATE "([^"]+)"/i);
        if (!im) continue;
        // Literal bytes were appended after "\n" by the connection reader.
        const hdrBlock = l.includes("\n") ? l.slice(l.indexOf("\n") + 1) : "";
        const unfolded: string[] = [];
        for (const hl of hdrBlock.replace(/\)\s*$/, "").split(/\r?\n/)) {
          if (/^[ \t]/.test(hl) && unfolded.length) unfolded[unfolded.length - 1] += " " + hl.trim();
          else if (hl.trim()) unfolded.push(hl.trim());
        }
        const headers: Record<string, string> = {};
        for (const hl of unfolded) {
          const c = hl.indexOf(":");
          if (c > 0) {
            const k = hl.slice(0, c).toLowerCase();
            if (!(k in headers)) headers[k] = decodeHeader(hl.slice(c + 1).trim());
          }
        }
        msgs.push({
          subject: headers.subject || "(no subject)",
          from: headers.from || "",
          internal: im[1],
        });
      }
    }
    const groups = new Map<string, { subject: string; from: string; internal: string; count: number }>();
    for (const m of msgs) {
      const key = normalizeSubject(m.subject) || "(no subject)";
      const g = groups.get(key);
      if (!g) {
        groups.set(key, { subject: m.subject, from: m.from, internal: m.internal, count: 1 });
      } else {
        g.count++;
        if (m.internal > g.internal) { g.subject = m.subject; g.from = m.from; g.internal = m.internal; }
      }
    }
    return [...groups.entries()]
      .map(([thread_key, g]) => ({
        thread_key,
        subject: g.subject,
        from: g.from,
        date: internalDateToIso(g.internal),
        count: g.count,
        _internal: g.internal,
      }))
      .sort((a, b) => (a._internal < b._internal ? 1 : -1))
      .slice(0, 25)
      .map(({ _internal, ...rest }) => rest);
  } finally {
    conn.close();
  }
}

// ---------- inbound thread sync ----------
// Pulls replies into a linked thread (task_links row, kind=thread).
// Diffs MESSAGE-IDs against meta.seen_ids; the first sync seeds seen_ids
// silently (old mail isn't "new"). meta gains: seen_ids, unseen
// (accumulated), count, last_from, last_date, last_snippet.

export interface ThreadMessage {
  messageId: string; // "" when the message has none — falls back to a date/from/subject key
  from: string;
  date: string;      // YYYY-MM-DD (INTERNALDATE)
  subject: string;
  snippet: string;   // first ~140 chars of body text, tags stripped
}

export interface ThreadSyncResult {
  meta: Record<string, any>;
  newCount: number;
  seeded: boolean;
  /** From-addresses seen in this sync (for contact harvesting). */
  harvest: string[];
}

function msgKey(m: ThreadMessage): string {
  return m.messageId || `~${m.date}|${m.from}|${m.subject}`.toLowerCase();
}

export async function syncThread(opts: {
  link: { ref: string; label: string; meta?: any };
  config: any;
  fetchMessages?: (subject: string) => Promise<ThreadMessage[]>;
}): Promise<ThreadSyncResult> {
  const meta = { ...(opts.link.meta || {}) };
  const subject = opts.link.label || opts.link.ref;
  const fetchImpl = opts.fetchMessages || ((s: string) => imapFetchThreadMessages(s, opts.config));
  const msgs = (await fetchImpl(subject)).slice()
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const newest = msgs[0];
  const ids = msgs.map(msgKey);
  const prevSeen: string[] = Array.isArray(meta.seen_ids) ? meta.seen_ids : [];
  const harvest = [...new Set(msgs.map((m) => m.from).filter(Boolean))];
  if (!meta.seen_ids) {
    return {
      meta: {
        ...meta, seen_ids: ids, unseen: 0, count: msgs.length,
        last_from: newest?.from || meta.from || "",
        last_date: newest?.date || meta.date || "",
        last_snippet: newest?.snippet || "",
      },
      newCount: 0, seeded: true, harvest,
    };
  }
  const seenSet = new Set(prevSeen);
  const fresh = msgs.filter((m) => !seenSet.has(msgKey(m)));
  const freshIds = fresh.map(msgKey).filter((k) => !seenSet.has(k));
  return {
    meta: {
      ...meta, seen_ids: [...prevSeen, ...freshIds],
      unseen: (Number(meta.unseen) || 0) + fresh.length, count: msgs.length,
      last_from: newest?.from || meta.last_from || "",
      last_date: newest?.date || meta.last_date || "",
      last_snippet: newest?.snippet || meta.last_snippet || "",
    },
    newCount: fresh.length, seeded: false,
    harvest: [...new Set(fresh.map((m) => m.from).filter(Boolean))],
  };
}

/** Reassemble a multi-literal UID FETCH response into per-message payloads.
 *  The connection reader joins each {n} literal to its command line with "\n",
 *  so one FETCH reply can arrive as several "lines": the head line plus one
 *  continuation line per literal. */
function parseThreadFetch(lines: string[]): ThreadMessage[] {
  const out: ThreadMessage[] = [];
  let cur: { date: string; payloads: { kind: "hdr" | "body"; text: string }[] } | null = null;
  const pushPayload = (line: string) => {
    const nl = line.indexOf("\n");
    if (nl < 0 || !cur) return;
    const marker = line.slice(0, nl);
    const kind = /HEADER\.FIELDS/i.test(marker) ? "hdr" : "body";
    cur.payloads.push({ kind, text: line.slice(nl + 1) });
  };
  const flush = () => {
    if (!cur) return;
    if (!cur.payloads.length) { cur = null; return; } // degenerate FETCH line — nothing to parse
    const hdr = cur.payloads.find((p) => p.kind === "hdr")?.text || "";
    const body = cur.payloads.find((p) => p.kind === "body")?.text || "";
    const headers: Record<string, string> = {};
    let acc = "";
    const take = () => {
      if (!acc) return;
      const c = acc.indexOf(":");
      if (c > 0 && !(acc.slice(0, c).toLowerCase() in headers)) {
        headers[acc.slice(0, c).toLowerCase()] = acc.slice(c + 1).trim();
      }
      acc = "";
    };
    for (const hl of hdr.split(/\r?\n/)) {
      if (/^[ \t]/.test(hl) && acc) acc += " " + hl.trim();
      else { take(); acc = hl.trim(); }
    }
    take();
    out.push({
      messageId: decodeHeader(headers["message-id"] || "").replace(/^<|>$/g, "").trim(),
      from: decodeHeader(headers["from"] || ""),
      date: cur.date,
      subject: decodeHeader(headers["subject"] || ""),
      snippet: body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 140),
    });
    cur = null;
  };
  for (const l of lines) {
    if (/^\* \d+ FETCH/i.test(l)) {
      flush();
      const im = l.match(/INTERNALDATE "([^"]+)"/i);
      cur = { date: im ? internalDateToIso(im[1]) : "", payloads: [] };
      pushPayload(l);
    } else if (cur && l.includes("\n")) {
      pushPayload(l);
    }
  }
  flush();
  return out;
}

/** Default fetcher: SUBJECT-search INBOX + Sent, newest first. Read-only. */
async function imapFetchThreadMessages(subject: string, config: any): Promise<ThreadMessage[]> {
  const cfg = await resolveConfig(config); // throws human-readable ImapError when missing
  const conn = new Conn();
  await conn.open(cfg.host, cfg.port);
  try {
    const greet = await conn.greeting();
    if (!/^\* OK/i.test(greet)) throw new ImapError("imap server did not greet");
    await authenticate(conn, "s001", cfg);
    const sent = cfg.folder || (await findSentFolder(conn));
    const folders = [...new Set(["INBOX", sent].filter(Boolean) as string[])];
    const byKey = new Map<string, ThreadMessage>();
    const ascii = /^[\x00-\x7F]*$/.test(subject);
    let n = 0;
    for (const folder of folders) {
      const tag = `s1${n}`;
      await conn.cmd(`${tag}a`, `EXAMINE ${qstr(folder)}`); // read-only
      const sLines = await conn.cmd(`${tag}b`, ascii
        ? `UID SEARCH SUBJECT ${qstr(subject)}`
        : `UID SEARCH CHARSET UTF-8 SUBJECT ${qstr(subject)}`);
      let uids: string[] = [];
      for (const l of sLines) {
        const m = l.match(/^\* SEARCH\s*(.*)$/i);
        if (m && m[1].trim()) uids.push(...m[1].trim().split(/\s+/));
      }
      uids = uids.slice(-200);
      for (let i = 0; i < uids.length; i += 100) {
        const chunk = uids.slice(i, i + 100);
        const fl = await conn.cmd(`${tag}c`,
          `UID FETCH ${chunk.join(",")} (INTERNALDATE BODY[HEADER.FIELDS (MESSAGE-ID FROM DATE SUBJECT)] BODY[TEXT]<0.500>)`);
        for (const m of parseThreadFetch(fl)) {
          const k = msgKey(m);
          if (!byKey.has(k)) byKey.set(k, m);
        }
      }
      n++;
    }
    return [...byKey.values()];
  } finally {
    conn.close();
  }
}

class Conn {
  private buf = Buffer.alloc(0);
  private lines: string[] = [];
  private wake: (() => void) | null = null;
  private closedErr: Error | null = null;
  private sock: any = null;

  async open(host: string, port: number) {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new ImapError(`imap connect timed out (${host}:${port})`)); }
      }, 30000);
      const self = this;
      const pending: any = Bun.connect({
        hostname: host, port, tls: true,
        socket: {
          open(sock: any) { self.sock = sock; if (!settled) { settled = true; clearTimeout(timer); resolve(); } },
          data(_s: any, data: Buffer) { self.onData(data); },
          error(_s: any, err: Error) {
            if (!settled) { settled = true; clearTimeout(timer); reject(new ImapError(`imap connect failed: ${err.message}`)); }
            else self.onClose(err);
          },
          close() { self.onClose(new Error("imap connection closed by server")); },
        },
      });
      if (pending && typeof pending.catch === "function") {
        pending.catch((err: Error) => {
          if (!settled) { settled = true; clearTimeout(timer); reject(new ImapError(`imap connect failed: ${err?.message || err}`)); }
        });
      }
    });
  }

  private onData(data: Buffer) {
    this.buf = Buffer.concat([this.buf, data]);
    for (;;) {
      const idx = this.buf.indexOf("\r\n");
      if (idx < 0) break;
      const line = this.buf.slice(0, idx).toString("latin1");
      let rest = this.buf.slice(idx + 2);
      const lm = line.match(/\{(\d+)\}$/);
      if (lm) {
        const n = Number(lm[1]);
        if (rest.length < n) break;
        this.lines.push(line + "\n" + rest.slice(0, n).toString("latin1"));
        this.buf = rest.slice(n);
        continue;
      }
      this.buf = rest;
      this.lines.push(line);
    }
    if (this.wake) { const w = this.wake; this.wake = null; w(); }
  }

  private onClose(err: Error) {
    if (!this.closedErr) this.closedErr = err;
    if (this.wake) { const w = this.wake; this.wake = null; w(); }
  }

  private async readLine(): Promise<string> {
    for (;;) {
      if (this.lines.length) return this.lines.shift()!;
      if (this.closedErr) throw new ImapError(this.closedErr.message);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { this.wake = null; reject(new ImapError("imap timed out waiting for reply")); }, 30000);
        this.wake = () => { clearTimeout(timer); resolve(); };
      });
    }
  }

  /** Read the server greeting after connect. */
  async greeting(): Promise<string> {
    return this.readLine();
  }

  async cmd(tag: string, command: string): Promise<string[]> {
    this.sock.write(`${tag} ${command}\r\n`);
    const out: string[] = [];
    for (;;) {
      const line = await this.readLine();
      if (line.startsWith(`${tag} `)) {
        if (/^OK\b/i.test(line.slice(tag.length + 1))) return out;
        throw new ImapError(`imap command refused: ${line.slice(0, 120)}`);
      }
      out.push(line);
    }
  }

  /** SASL XOAUTH2: AUTHENTICATE XOAUTH2, then the base64 blob on the "+" continuation. */
  async authXoauth2(tag: string, user: string, token: string): Promise<void> {
    this.sock.write(`${tag} AUTHENTICATE XOAUTH2\r\n`);
    const cont = await this.readLine();
    if (!cont.startsWith("+")) {
      throw new ImapError(`imap XOAUTH2 not offered: ${cont.slice(0, 120)}`);
    }
    this.sock.write(`${xoauth2Blob(user, token)}\r\n`);
    for (;;) {
      const line = await this.readLine();
      if (line.startsWith(`${tag} `)) {
        if (/^OK\b/i.test(line.slice(tag.length + 1))) return;
        throw new ImapError(`imap XOAUTH2 authentication failed: ${line.slice(0, 120)}`);
      }
    }
  }

  close() {
    try { this.sock.write("a999 LOGOUT\r\n"); } catch { /* gone */ }
    try { this.sock.end(); } catch { /* gone */ }
  }

  /** APPEND a message to a folder: literal handshake, then the exact bytes. */
  async append(tag: string, folder: string, raw: string): Promise<void> {
    const n = Buffer.byteLength(raw, "utf8");
    this.sock.write(`${tag} APPEND ${qstr(folder)} (\\Seen) {${n}}\r\n`);
    const cont = await this.readLine();
    if (!cont.startsWith("+")) {
      throw new ImapError(`imap APPEND not accepted: ${cont.slice(0, 120)}`);
    }
    this.sock.write(raw);
    for (;;) {
      const line = await this.readLine();
      if (line.startsWith(`${tag} `)) {
        if (/^OK\b/i.test(line.slice(tag.length + 1))) return;
        throw new ImapError(`imap APPEND failed: ${line.slice(0, 120)}`);
      }
    }
  }
}

const qstr = (s: string) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

async function findSentFolder(conn: Conn): Promise<string | null> {
  const lines = await conn.cmd("f001", 'LIST "" "*"');
  const names: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\* LIST\s+(?:\([^)]*\)\s+)?(?:"[^"]*"|NIL)\s+"?([^"\r\n]+)"?\s*$/i);
    if (m) names.push(m[1].trim());
  }
  for (const re of [/^sent$/i, /^\[gmail\]\/sent mail$/i, /^sent items$/i, /sent/i]) {
    const hit = names.find((n) => re.test(n));
    if (hit) return hit;
  }
  return null;
}

/** Pick LOGIN or SASL XOAUTH2 based on the resolved config. */
async function authenticate(conn: Conn, tag: string, cfg: ImapCfg): Promise<void> {
  if (cfg.auth === "xoauth2") {
    await conn.authXoauth2(tag, cfg.user, cfg.pass);
  } else {
    await conn.cmd(tag, `LOGIN ${qstr(cfg.user)} ${qstr(cfg.pass)}`);
  }
}

export interface ImapCfg {
  host: string; port: number; user: string; pass: string; folder?: string;
  auth: "login" | "xoauth2"; // internal — never shown in the UI
  goaId?: string;            // GOA account id when credentials came from GOA
}

const MISSING_CREDENTIALS =
  "email-imap: missing IMAP credentials — set host/user/pass via connector config, " +
  "CADENCE_IMAP_* env vars, or $CADENCE_DATA_DIR/imap.json, " +
  "or add a mail account in GNOME Settings (Online Accounts)";

/** Injectable GOA functions so tests never touch D-Bus. */
export interface GoaFns {
  listGoaMailAccounts(): Promise<GoaMailAccount[]>;
  getGoaCredentials(a: GoaMailAccount): Promise<GoaCredentials>;
}
const realGoaFns: GoaFns = { listGoaMailAccounts, getGoaCredentials };

async function resolveConfig(overrides: any, goaFns: GoaFns = realGoaFns): Promise<ImapCfg> {
  let fileCfg: any = {};
  try {
    const dir = process.env.CADENCE_DATA_DIR || "data";
    fileCfg = JSON.parse(readFileSync(join(dir, "imap.json"), "utf8"));
  } catch { /* optional file */ }
  const o = overrides && typeof overrides === "object" ? overrides : {};
  const cfg: ImapCfg = {
    host: o.host || process.env.CADENCE_IMAP_HOST || fileCfg.host || "",
    port: Number(o.port || process.env.CADENCE_IMAP_PORT || fileCfg.port || 993),
    user: o.user || process.env.CADENCE_IMAP_USER || fileCfg.user || "",
    pass: o.pass || process.env.CADENCE_IMAP_PASS || fileCfg.pass || "",
    folder: o.folder || process.env.CADENCE_IMAP_FOLDER || fileCfg.folder || undefined,
    auth: "login",
  };
  if (cfg.host && cfg.user && cfg.pass) return cfg; // explicit credentials win

  // GOA fallback — credentials come from the keyring via goa-daemon,
  // fetched per sync and never written to Cadence's DB.
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
      throw new ImapError(`email-imap: no GOA mail account matches "${sel}" (have: ${have})`);
    }
    throw new ImapError(MISSING_CREDENTIALS + " …and no GNOME Online Accounts mail account found");
  }
  const imap = goaImapCfg(acct); // throws human-readable GoaError on missing host / STARTTLS
  const creds = await goaFns.getGoaCredentials(acct); // auth failures propagate (human-readable)
  if (creds.oauth2 && creds.token) {
    return { ...cfg, host: imap.host, port: imap.port, user: imap.user, pass: creds.token,
             auth: "xoauth2", goaId: acct.id };
  }
  if (creds.imapPassword) {
    return { ...cfg, host: imap.host, port: imap.port, user: imap.user, pass: creds.imapPassword,
             auth: "login", goaId: acct.id };
  }
  throw new ImapError(`email-imap: GOA account ${acct.email} returned no usable credentials`);
}

export const connector = {
  id: "email-imap",
  name: "Email (IMAP sent folder)",
  description:
    "Counts messages in your Sent folder per day over a date range. Read-only (EXAMINE). " +
    "Configure host/user/pass via connector config, CADENCE_IMAP_* env, or data/imap.json — " +
    "or leave blank to use a GNOME Online Accounts mail account (OAuth2 → XOAUTH2, creds never stored).",
  async sync(opts: { from: string; to: string; config: any }) {
    const cfg = await resolveConfig(opts.config); // never logged
    const conn = new Conn();
    await conn.open(cfg.host, cfg.port);
    try {
      const greet = await conn.greeting();
      if (!/^\* OK/i.test(greet)) throw new ImapError("imap server did not greet");
      await authenticate(conn, "a001", cfg);
      const folder = cfg.folder || (await findSentFolder(conn));
      if (!folder) throw new ImapError("imap: could not find a Sent folder");
      await conn.cmd("a002", `EXAMINE ${qstr(folder)}`); // read-only
      // SENTBEFORE is exclusive: search up to and including `to`.
      const toPlus = new Date(new Date(opts.to + "T00:00:00Z").getTime() + 864e5)
        .toISOString().slice(0, 10);
      const searchLines = await conn.cmd(
        "a003",
        `UID SEARCH SENTSINCE ${imapDate(opts.from)} SENTBEFORE ${imapDate(toPlus)}`
      );
      const uids: string[] = [];
      for (const l of searchLines) {
        const m = l.match(/^\* SEARCH\s*(.*)$/i);
        if (m && m[1].trim()) uids.push(...m[1].trim().split(/\s+/));
      }
      const byDay = new Map<string, number>();
      if (uids.length) {
        // Fetch in chunks to keep commands small.
        for (let i = 0; i < uids.length; i += 200) {
          const chunk = uids.slice(i, i + 200);
          const fl = await conn.cmd("a004", `UID FETCH ${chunk.join(",")} (INTERNALDATE)`);
          for (const l of fl) {
            const m = l.match(/INTERNALDATE "([^"]+)"/i);
            if (m) {
              const day = internalDateToIso(m[1]);
              if (day) byDay.set(day, (byDay.get(day) || 0) + 1);
            }
          }
        }
      }
      return [...byDay.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([date, value]) => ({ date, value, note: `${value} sent` }));
    } finally {
      conn.close();
    }
  },
};

// Exported for tests (pure helpers, no network).
export const _test = { imapDate, internalDateToIso, resolveConfig, normalizeSubject, decodeHeader, xoauth2Blob, parseThreadFetch };

/** APPEND a raw RFC 5322 message to the Sent folder (files a sent message so
 *  it shows up in sent-mail and in later thread searches). Read-write, unlike
 *  the rest of this module — used only right after a successful SMTP send. */
export async function appendToSent(opts: { config: any; raw: string }): Promise<void> {
  const cfg = await resolveConfig(opts.config); // throws human-readable ImapError when missing
  const conn = new Conn();
  await conn.open(cfg.host, cfg.port);
  try {
    const greet = await conn.greeting();
    if (!/^\* OK/i.test(greet)) throw new ImapError("imap server did not greet");
    await authenticate(conn, "p001", cfg);
    const folder = cfg.folder || (await findSentFolder(conn));
    if (!folder) throw new ImapError("imap: could not find a Sent folder");
    const raw = opts.raw.endsWith("\r\n") ? opts.raw : opts.raw + "\r\n";
    await conn.append("p002", folder, raw);
  } finally {
    conn.close();
  }
}
