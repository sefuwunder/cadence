/* Cadence — contact photos.
 *
 * Avatars prefer the contact's real photo from the system address book
 * (GNOME Contacts / evolution-data-server, which syncs the user's GOA
 * accounts), falling back to initial-based avatars when none is found.
 *
 * Photos are cached in SQLite (contact_photos, 30-day TTL) so the UI never
 * blocks on D-Bus. Every external call is defensive: any failure → null.
 */

import { readFileSync, readdirSync } from "fs";

export interface PhotoResult {
  mime: string;
  data: Uint8Array;
}

/** Injectable busctl runner (real one shells out; tests stub it). */
export type BusctlRunner = (args: string[]) => Promise<{ code: number; out: string }>;

const PHOTO_TTL_MS = 30 * 24 * 3600 * 1000;
const EDS_TIMEOUT_MS = 8000;
const EDS_VERDICT_TTL_MS = 60 * 1000;

let edsVerdict: { available: boolean; at: number } | null = null;

export function defaultBusctl(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (code: number, out: string) => {
      if (done) return;
      done = true;
      resolve({ code, out });
    };
    try {
      const proc = Bun.spawn(["busctl", "--user", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => {
        try { proc.kill(); } catch { /* already gone */ }
        finish(124, "");
      }, EDS_TIMEOUT_MS);
      proc.exited.then(async (code) => {
        clearTimeout(timer);
        const out = await new Response(proc.stdout).text().catch(() => "");
        finish(code, out);
      }).catch(() => finish(1, ""));
    } catch {
      finish(127, "");
    }
  });
}

/** Unfold vCard lines and extract the first PHOTO as bytes.
 *  Handles vCard 3.0 `PHOTO;ENCODING=b;TYPE=JPEG:<base64>` (folded or not)
 *  and vCard 4.0 `PHOTO:data:<mime>;base64,<data>`. */
export function parseVCardPhoto(vcard: string): PhotoResult | null {
  const unfolded: string[] = [];
  for (const raw of String(vcard || "").split(/\r?\n/)) {
    if (/^[ \t]/.test(raw) && unfolded.length) unfolded[unfolded.length - 1] += raw.slice(1);
    else unfolded.push(raw);
  }
  for (const line of unfolded) {
    const m = line.match(/^PHOTO(?:;[^:]*)?:(.*)$/i);
    if (!m) continue;
    const prop = line.slice(0, line.indexOf(":"));
    const value = m[1].trim();
    if (!value) continue;
    // vCard 4.0 data URI form
    const uri = value.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/i);
    if (uri) {
      try {
        return { mime: uri[1].toLowerCase(), data: Buffer.from(uri[2].replace(/\s+/g, ""), "base64") };
      } catch { continue; }
    }
    // vCard 3.0 inline base64 form
    const params = prop.toUpperCase();
    if (/ENCODING=B/.test(params) || /^[A-Za-z0-9+/=\s]+$/.test(value)) {
      const typeM = params.match(/TYPE=([^;]+)/);
      const mime = typeM ? `image/${typeM[1].toLowerCase()}` : "image/jpeg";
      try {
        const data = Buffer.from(value.replace(/\s+/g, ""), "base64");
        if (data.length > 0) return { mime, data };
      } catch { continue; }
    }
    // URI form (not inlined) — not fetchable offline; skip
  }
  return null;
}

/** Look up one contact photo in the EDS address books over D-Bus.
 *  Returns null when EDS is absent or the contact has no photo. */
export async function edsPhotoByEmail(
  email: string,
  run: BusctlRunner = defaultBusctl,
): Promise<PhotoResult | null> {
  // EDS availability is memoized briefly so avatar-heavy pages don't
  // spawn a busctl per image on machines without EDS.
  const now = Date.now();
  if (!edsVerdict || now - edsVerdict.at > EDS_VERDICT_TTL_MS) {
    try {
      const ls = await run(["list", "--no-legend", "--no-pager"]);
      edsVerdict = {
        available: ls.code === 0 && /evolution.*addressbook|addressbook.*evolution/i.test(ls.out),
        at: now,
      };
    } catch {
      edsVerdict = { available: false, at: now };
    }
  }
  if (!edsVerdict.available) return null;

  const vcards = await edsVCardsForEmail(email, run).catch(() => [] as string[]);
  for (const vc of vcards) {
    const photo = parseVCardPhoto(vc);
    if (photo) return photo;
  }
  return null;
}

/** Split raw vCard export text into individual cards. */
export function splitVCards(text: string): string[] {
  const cards: string[] = [];
  const re = /BEGIN:VCARD[\s\S]*?END:VCARD/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) cards.push(m[0]);
  return cards;
}

/** Unfold a vCard's lines (continuation lines start with space/tab). */
function unfoldVCard(card: string): string[] {
  const out: string[] = [];
  for (const raw of card.split(/\r?\n/)) {
    if (/^[ \t]/.test(raw) && out.length) out[out.length - 1] += raw.slice(1);
    else out.push(raw);
  }
  return out;
}

/** All EMAIL values in a card (lowercased). */
export function vCardEmails(card: string): string[] {
  const emails: string[] = [];
  for (const line of unfoldVCard(card)) {
    const m = line.match(/^EMAIL(?:;[^:]*)?:(.+)$/i);
    if (m) {
      const em = m[1].trim().toLowerCase();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em) && !emails.includes(em)) emails.push(em);
    }
  }
  return emails;
}

/** Index every EMAIL → photo in a bulk vCard export. */
export function indexVCardPhotos(text: string): Map<string, PhotoResult> {
  const idx = new Map<string, PhotoResult>();
  for (const card of splitVCards(text)) {
    const photo = parseVCardPhoto(card);
    if (!photo) continue;
    for (const em of vCardEmails(card)) {
      if (!idx.has(em)) idx.set(em, photo);
    }
  }
  return idx;
}

/** EDS source directory (override with CADENCE_EDS_SOURCES in tests). */
export function edsSourcesDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return process.env.CADENCE_EDS_SOURCES || `${home}/.config/evolution/sources`;
}

/** UIDs of enabled contacts sources: filename stem of every *.source file
 *  with Enabled=true and ContactsEnabled=true. */
export function enabledContactsUids(
  dir: string = edsSourcesDir(),
  readFile: (p: string) => string | null = (p) => {
    try { return readFileSync(p, "utf8"); } catch { return null; }
  },
  listDir: (d: string) => string[] = (d) => {
    try { return readdirSync(d).filter((f) => f.endsWith(".source")); } catch { return []; }
  },
): string[] {
  const uids: string[] = [];
  for (const f of listDir(dir)) {
    const txt = readFile(`${dir}/${f}`);
    if (!txt) continue;
    const get = (k: string) => {
      const m = txt.match(new RegExp(`^${k}=(.*)$`, "im"));
      return m ? m[1].trim().toLowerCase() : "";
    };
    if (get("Enabled") === "true" && get("ContactsEnabled") === "true") {
      uids.push(f.replace(/\.source$/, ""));
    }
  }
  return uids;
}

export interface PhotoSyncResult {
  books: number;
  contacts: number;
  photos: number;
  errors: string[];
}

function spawnCapture(cmd: string[], timeoutMs: number): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (code: number, out: string, err: string) => {
      if (done) return;
      done = true;
      resolve({ code, out, err });
    };
    try {
      const proc = Bun.spawn(cmd, {
        stdout: "pipe", stderr: "pipe",
        env: { ...process.env }, // inherit session bus etc.
      });
      const timer = setTimeout(() => {
        try { proc.kill(); } catch { /* gone */ }
        finish(124, "", "timeout");
      }, timeoutMs);
      proc.exited.then(async (code) => {
        clearTimeout(timer);
        const out = await new Response(proc.stdout).text().catch(() => "");
        const err = await new Response(proc.stderr).text().catch(() => "");
        finish(code, out, err);
      }).catch(() => finish(1, "", "spawn failed"));
    } catch {
      finish(127, "", "spawn threw");
    }
  });
}

/** Bulk-sync contact photos from every enabled EDS address book via
 *  `addressbook-export`. Populates contact_photos; per-avatar requests
 *  then hit the cache only. Never throws — errors are collected. */
export async function syncPhotosFromEDS(
  db: any,
  opts: { sourcesDir?: string; exportBin?: string; timeoutMs?: number } = {},
): Promise<PhotoSyncResult> {
  const res: PhotoSyncResult = { books: 0, contacts: 0, photos: 0, errors: [] };
  const bin = opts.exportBin || process.env.CADENCE_ADDRESSBOOK_EXPORT || "addressbook-export";
  let uids: string[];
  try {
    uids = enabledContactsUids(opts.sourcesDir);
  } catch (e: any) {
    res.errors.push(`sources scan failed: ${e?.message || e}`);
    return res;
  }
  if (!uids.length) {
    res.errors.push("no enabled contacts sources found");
    return res;
  }
  const now = new Date().toISOString();
  const up = db.prepare(
    "INSERT INTO contact_photos (email, mime, data, fetched_at, source) VALUES (?, ?, ?, ?, 'eds') " +
    "ON CONFLICT(email) DO UPDATE SET mime = excluded.mime, data = excluded.data, " +
    "fetched_at = excluded.fetched_at WHERE contact_photos.source <> 'manual'");
  for (const uid of uids) {
    const r = await spawnCapture(
      [bin, "--format=vcard", uid], opts.timeoutMs || 60000);
    if (r.code !== 0) {
      res.errors.push(`${uid}: exit ${r.code}${r.err ? ` — ${r.err.trim().slice(0, 160)}` : ""}`);
      continue;
    }
    res.books++;
    const idx = indexVCardPhotos(r.out);
    res.contacts += splitVCards(r.out).length;
    const run = db.transaction((entries: [string, PhotoResult][]) => {
      for (const [email, photo] of entries) {
        up.run(email, photo.mime, Buffer.from(photo.data), now);
      }
    });
    try {
      run([...idx.entries()]);
      res.photos += idx.size;
    } catch (e: any) {
      res.errors.push(`${uid}: cache write failed: ${e?.message || e}`);
    }
  }
  return res;
}

/** Query every EDS address book for vCards whose EMAIL matches.
 *  Kept as the per-email D-Bus seam (factory OpenAddressBook s→ss);
 *  the bulk export above is the primary path. Isolated for testability. */
export async function edsVCardsForEmail(
  _email: string,
  _run: BusctlRunner = defaultBusctl,
): Promise<string[]> {
  // TODO: wire to the EDS D-Bus address-book API once confirmed on the
  // user's machine (scripts/probe-eds.sh). Until then: no live lookup.
  return [];
}

function validEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/** Resolve a contact photo: cache → EDS → null. Never throws. */
export async function getContactPhoto(
  db: any,
  email: string,
  opts: { run?: BusctlRunner } = {},
): Promise<PhotoResult | null> {
  const em = String(email || "").trim().toLowerCase();
  if (!validEmail(em)) return null;
  try {
    const row: any = db.query(
      "SELECT mime, data, fetched_at, source FROM contact_photos WHERE email = ?").get(em);
    if (row) {
      // Manual uploads never expire and are never overwritten by the sync.
      const fresh = row.source === "manual" ||
        (Number.isFinite(Date.now() - new Date(row.fetched_at).getTime()) &&
         Date.now() - new Date(row.fetched_at).getTime() < PHOTO_TTL_MS);
      if (fresh && row.data?.length) {
        return { mime: row.mime || "image/jpeg", data: row.data };
      }
    }
    const photo = await edsPhotoByEmail(em, opts.run);
    if (photo) {
      db.run(
        "INSERT INTO contact_photos (email, mime, data, fetched_at, source) VALUES (?, ?, ?, ?, 'eds') " +
        "ON CONFLICT(email) DO UPDATE SET mime = excluded.mime, data = excluded.data, " +
        "fetched_at = excluded.fetched_at WHERE contact_photos.source <> 'manual'",
        [em, photo.mime, Buffer.from(photo.data), new Date().toISOString()]);
    }
    return photo;
  } catch {
    return null;
  }
}

/** Magic-byte sniffing for the image formats browsers can render as avatars. */
function sniffImageMime(buf: Buffer): string | null {
  if (buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length > 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export const MANUAL_PHOTO_MAX_BYTES = 2 * 1024 * 1024;

/** Parse a user-supplied avatar: a `data:image/…;base64,…` URI or raw base64.
 *  Returns { mime, data } or throws a human-readable error. */
export function parseManualPhoto(input: string): PhotoResult {
  const s = String(input || "").trim();
  if (!s) throw new Error("no image data provided");
  let b64 = s;
  const dm = s.match(/^data:(image\/[a-z+]+);base64,(.+)$/is);
  if (dm) b64 = dm[2];
  let buf: Buffer;
  try {
    buf = Buffer.from(b64.replace(/\s+/g, ""), "base64");
  } catch {
    throw new Error("could not decode the image (expected base64)");
  }
  if (!buf.length) throw new Error("could not decode the image (expected base64)");
  // Reject base64 that decodes to garbage: re-encoding must round-trip.
  if (Buffer.from(buf.toString("base64"), "base64").length !== buf.length) {
    throw new Error("could not decode the image (expected base64)");
  }
  if (buf.length > MANUAL_PHOTO_MAX_BYTES) {
    throw new Error(`image is too large (${(buf.length / 1048576).toFixed(1)} MB — max 2 MB)`);
  }
  const mime = sniffImageMime(buf);
  if (!mime) throw new Error("not a recognized image (JPEG, PNG, GIF, or WebP)");
  return { mime, data: new Uint8Array(buf) };
}

/** Store a user-uploaded avatar. Manual photos win over EDS-synced ones and
 *  never expire. Throws human-readable errors. */
export function saveManualPhoto(db: any, email: string, input: string): { email: string; mime: string } {
  const em = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) throw new Error("a valid email is required");
  const photo = parseManualPhoto(input);
  db.run(
    "INSERT INTO contact_photos (email, mime, data, fetched_at, source) VALUES (?, ?, ?, ?, 'manual') " +
    "ON CONFLICT(email) DO UPDATE SET mime = excluded.mime, data = excluded.data, " +
    "fetched_at = excluded.fetched_at, source = 'manual'",
    [em, photo.mime, Buffer.from(photo.data), new Date().toISOString()]);
  return { email: em, mime: photo.mime };
}

/** Remove a stored avatar (manual or synced). Idempotent. */
export function deleteContactPhoto(db: any, email: string): void {
  const em = String(email || "").trim().toLowerCase();
  if (!em) return;
  db.run("DELETE FROM contact_photos WHERE email = ?", [em]);
}

/** Test hook: reset the memoized EDS availability verdict. */
export function _resetEdsVerdict() {
  edsVerdict = null;
}
