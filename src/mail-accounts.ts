/* Cadence — multiple sending accounts.
 *
 * The Assign-from-feed composer lets the user pick which account an email
 * goes out from. Effective send accounts, in order:
 *
 *   1. config.accounts[] — accounts added in the connector setup UI, each
 *      either GOA-backed ({goa_account}) or manual ({smtp_host/user/pass}).
 *   2. Every GNOME Online Accounts mail account (zero-config: credentials
 *      come from the keyring per send, never stored), deduped by email.
 *   3. Legacy flat config (smtp_* keys / CADENCE_SMTP_* env / imap.json) —
 *      only when neither of the above yields an account.
 *
 * Account ids: "cfg:<id>" (configured), "goa:<goa-id>" (GOA), "legacy".
 * The send endpoint also accepts a bare email address as the selector.
 */

import {
  listGoaMailAccounts, getGoaCredentials, type GoaMailAccount,
} from "./goa.ts";
import {
  resolveSmtpConfig, type SmtpCfg, type GoaFns, SmtpError,
} from "./connectors/email-smtp.ts";

export interface MailAccount {
  id: string;
  email: string;
  label: string;
  kind: "goa" | "manual";
}

export interface SendAccountList {
  accounts: MailAccount[];
  default_account: string | null;
}

type ListFns = Pick<GoaFns, "listGoaMailAccounts">;
const defaultListFns: ListFns = { listGoaMailAccounts };
const defaultGoaFns: GoaFns = { listGoaMailAccounts, getGoaCredentials };

export function readImapConfig(db: any): any {
  const row: any = db.query("SELECT config_json FROM connector_cfg WHERE id = 'email-imap'").get();
  return row ? JSON.parse(row.config_json) : {};
}

export function writeImapConfig(db: any, config: any): void {
  db.run(
    "INSERT INTO connector_cfg (id, name, config_json) VALUES ('email-imap', 'Email (IMAP)', ?) " +
    "ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json",
    [JSON.stringify(config)]);
}

function cfgEntryId(a: any): string {
  return `cfg:${a.id || String(a.email || "").toLowerCase()}`;
}

export async function listSendAccounts(
  db: any,
  fns: ListFns = defaultListFns,
): Promise<SendAccountList> {
  const config = readImapConfig(db);
  const accounts: MailAccount[] = [];
  const seen = new Set<string>();

  // 1. Configured accounts.
  for (const a of (Array.isArray(config.accounts) ? config.accounts : [])) {
    const email = String(a.email || "").trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    accounts.push({
      id: cfgEntryId(a),
      email,
      label: String(a.label || a.email || ""),
      kind: a.goa_account ? "goa" : "manual",
    });
  }

  // 2. All GOA mail accounts, zero-config, deduped by email.
  let goa: GoaMailAccount[] = [];
  try {
    goa = await fns.listGoaMailAccounts();
  } catch { /* GOA absent → skip */ }
  for (const g of goa) {
    const email = String(g.email || "").toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    accounts.push({
      id: `goa:${g.id}`,
      email,
      label: `${g.email} (${g.provider || "GOA"})`,
      kind: "goa",
    });
  }

  // 3. Legacy flat config fallback (manual smtp_* / env / imap.json).
  if (!accounts.length) {
    const hasManual = config.smtp_host || config.smtp_user || config.host || config.user ||
      process.env.CADENCE_SMTP_HOST || process.env.CADENCE_SMTP_USER;
    if (hasManual || config.goa_account) {
      const email = String(config.smtp_user || config.user || "default").toLowerCase();
      accounts.push({ id: "legacy", email, label: email, kind: "manual" });
    }
  }

  const def = typeof config.default_account === "string" &&
    accounts.some((a) => a.id === config.default_account)
    ? config.default_account
    : (accounts[0]?.id || null);
  return { accounts, default_account: def };
}

/** Resolve SMTP credentials for one sending account. Throws SmtpError. */
export async function resolveSmtpForAccount(
  db: any,
  accountRef: string,
  goaFns: GoaFns = defaultGoaFns,
): Promise<{ cfg: SmtpCfg; account: MailAccount }> {
  const { accounts, default_account } = await listSendAccounts(db, goaFns);
  const ref = String(accountRef || "").trim();
  const config = readImapConfig(db);
  const account = accounts.find((a) => a.id === ref) ||
    accounts.find((a) => a.email === ref.toLowerCase()) ||
    (!ref && default_account ? accounts.find((a) => a.id === default_account)! : undefined);
  if (!account) {
    if (ref) throw new SmtpError(`unknown sending account "${ref}"`);
    // No accounts at all and no selector: legacy behavior. resolveSmtpConfig
    // throws the human-readable missing-credentials error when unconfigured.
    const cfg = await resolveSmtpConfig(config, goaFns);
    return { cfg, account: { id: "legacy", email: cfg.user || "default", label: cfg.user || "default", kind: "manual" } };
  }

  if (account.id.startsWith("goa:")) {
    const cfg = await resolveSmtpConfig({ ...config, goa_account: account.id.slice(4) }, goaFns);
    return { cfg, account };
  }
  if (account.id.startsWith("cfg:")) {
    const entry = (Array.isArray(config.accounts) ? config.accounts : [])
      .find((a: any) => cfgEntryId(a) === account.id) || {};
    if (entry.goa_account) {
      const cfg = await resolveSmtpConfig({ ...config, goa_account: entry.goa_account }, goaFns);
      return { cfg, account };
    }
    const cfg = await resolveSmtpConfig({
      smtp_host: entry.smtp_host, smtp_port: entry.smtp_port, smtp_secure: entry.smtp_secure,
      smtp_user: entry.smtp_user || account.email, smtp_pass: entry.smtp_pass,
    }, goaFns);
    return { cfg, account };
  }
  // legacy flat config (unchanged behavior)
  const cfg = await resolveSmtpConfig(config, goaFns);
  return { cfg, account };
}

/** IMAP config override so the sent message is filed in the SENDING
 *  account's Sent folder (best-effort; failures are non-fatal upstream). */
export function imapConfigForAccount(db: any, account: MailAccount): any {
  const config = readImapConfig(db);
  if (account.id.startsWith("goa:")) {
    return { ...config, goa_account: account.id.slice(4) };
  }
  if (account.id.startsWith("cfg:")) {
    const entry = (Array.isArray(config.accounts) ? config.accounts : [])
      .find((a: any) => cfgEntryId(a) === account.id) || {};
    if (entry.goa_account) return { ...config, goa_account: entry.goa_account };
    return {
      ...config,
      host: entry.imap_host || config.host, port: entry.imap_port || config.port,
      user: entry.imap_user || entry.smtp_user || config.user,
      pass: entry.imap_pass || entry.smtp_pass || config.pass,
    };
  }
  return config;
}
