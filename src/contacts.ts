/* Cadence — contact photos.
 *
 * Avatars prefer the contact's real photo from the system address book
 * (GNOME Contacts / evolution-data-server, which syncs the user's GOA
 * accounts), falling back to initial-based avatars when none is found.
 *
 * Photos are cached in SQLite (contact_photos, 30-day TTL) so the UI never
 * blocks on D-Bus. Every external call is defensive: any failure → null.
 */

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

/** Query every EDS address book for vCards whose EMAIL matches.
 *  Wiring needs the exact D-Bus surface from the user's machine — run
 *  scripts/probe-eds.sh there and paste the output; then implement here.
 *  Isolated so tests can stub the runner and unit-test parsing/wiring. */
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
      "SELECT mime, data, fetched_at FROM contact_photos WHERE email = ?").get(em);
    if (row) {
      const age = Date.now() - new Date(row.fetched_at).getTime();
      if (Number.isFinite(age) && age < PHOTO_TTL_MS && row.data?.length) {
        return { mime: row.mime || "image/jpeg", data: row.data };
      }
    }
    const photo = await edsPhotoByEmail(em, opts.run);
    if (photo) {
      db.run(
        "INSERT INTO contact_photos (email, mime, data, fetched_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(email) DO UPDATE SET mime = excluded.mime, data = excluded.data, fetched_at = excluded.fetched_at",
        [em, photo.mime, Buffer.from(photo.data), new Date().toISOString()]);
    }
    return photo;
  } catch {
    return null;
  }
}

/** Test hook: reset the memoized EDS availability verdict. */
export function _resetEdsVerdict() {
  edsVerdict = null;
}
