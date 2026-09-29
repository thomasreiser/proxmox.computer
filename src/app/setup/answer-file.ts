// Each node's answer.toml: the file proxmox's unattended installer reads
// (phase 02 on /how-it-works). Written for pve 8.4+ — kebab-case keys.
// Reference: https://pve.proxmox.com/wiki/Automated_Installation
//
// The wizard records intent, never device identity, and this file sits on
// that line: the installer wipes whatever disk it's pointed at, so the boot
// disk is left as a placeholder the installer can't match (a safe failure)
// rather than guessed. The root password is left out entirely, so
// `prepare-iso` refuses the file until one is added — a guessed password
// would install fine and lock you out.

import { STORAGE_VERSION, isPersistedState, type NodeInfo, type PersistedState } from "./wizard-state";

/** the placeholder the installer can't match — it stops rather than guesses */
export const DISK_PLACEHOLDER = "CHANGE-ME";

// the layouts proxmox's installer accepts for `keyboard`
const KEYBOARDS = new Set([
  "de", "de-ch", "dk", "en-gb", "en-us", "es", "fi", "fr", "fr-be", "fr-ca", "fr-ch", "hu", "is", "it", "jp",
  "lt", "mk", "nl", "no", "pl", "pt", "pt-br", "se", "si", "tr",
]);

// languages whose layout proxmox names after something else
const LANGUAGE_KEYBOARD: Record<string, string> = { da: "dk", sv: "se", ja: "jp", nb: "no", nn: "no", sl: "si" };

/**
 * A best guess at the installer's keyboard layout from a browser locale
 * ("de-CH" → "de-ch", "sv-SE" → "se"), falling back to en-us. It's only a
 * default — the file says so, and it's one line to change.
 */
export function keyboardFor(locale: string): string {
  const [language = "", region = ""] = locale.toLowerCase().split(/[-_]/);
  const regional = `${language}-${region}`;
  if (region && KEYBOARDS.has(regional)) return regional;
  const mapped = LANGUAGE_KEYBOARD[language] ?? language;
  return KEYBOARDS.has(mapped) ? mapped : "en-us";
}

/** the two-letter country from a locale's region, or "us" */
export function countryFor(locale: string): string {
  const region = locale.split(/[-_]/)[1] ?? "";
  return /^[a-z]{2}$/i.test(region) ? region.toLowerCase() : "us";
}

/** a toml basic string — quotes, backslashes and control characters escaped */
export function tomlString(value: string): string {
  const escaped = value.replace(/[\\"\u0000-\u001f\u007f]/g, (ch) => {
    if (ch === "\\") return "\\\\";
    if (ch === '"') return '\\"';
    if (ch === "\n") return "\\n";
    if (ch === "\t") return "\\t";
    return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
  return `"${escaped}"`;
}

export interface AnswerContext {
  hostnameSuffix: string;
  gateway: string;
  dns: string;
  // the visitor's own browser settings — the installer wants a timezone,
  // keyboard and country, and the wizard never asks for them
  timezone: string;
  locale: string;
}

/** the node's fqdn — label plus the cluster's domain */
export function nodeFqdn(node: NodeInfo, hostnameSuffix: string): string {
  const label = node.network.hostLabel || node.name;
  return hostnameSuffix ? `${label}.${hostnameSuffix}` : label;
}

/** the file a node's answer is downloaded as */
export function answerFileName(node: NodeInfo): string {
  return `answer-${node.network.hostLabel || node.name}.toml`;
}

// ── the embedded setup ───────────────────────────────────────────────────
// An answer file only needs a sliver of the plan, so each one also carries
// the whole wizard state on a single comment line — the installer ignores
// comments, and any node's file can reopen the setup on the start page.
// Base64, so nothing a visitor typed can break out of the comment.

export const STATE_MARKER = "# proxmox.computer-state:";

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  // chunked: spreading a large array into one call overflows the stack
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(encoded: string): string {
  const binary = atob(encoded);
  return new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
}

/** the comment block that carries the setup */
export function stateBlock(state: PersistedState): string {
  return [
    "# the whole setup, so proxmox.computer can reopen it: open the start page and pick",
    '# "adjust a setup" with this file. the installer ignores comments — leave it in.',
    `${STATE_MARKER} ${toBase64(JSON.stringify(state))}`,
    "",
  ].join("\n");
}

export type ReadAnswerResult = { state: PersistedState } | { error: string };

/**
 * The setup an answer file carries, or why it can't be reopened. Edits made
 * to the rest of the file (the password, the boot disk) are the file's own
 * business — only the embedded state is read back.
 */
export function readAnswerToml(text: string): ReadAnswerResult {
  const line = text.split(/\r?\n/).find((l) => l.trim().startsWith(STATE_MARKER));
  if (!line) {
    return {
      error:
        "this file has no proxmox.computer setup in it — it wasn't made here, or its state line was removed. there's nothing to reopen.",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64(line.trim().slice(STATE_MARKER.length).trim()));
  } catch {
    return { error: "the setup line in this file is damaged — was it edited? download a fresh copy to reopen it." };
  }
  // a numbered save from another build — anything unnumbered is just damaged
  const version = parsed && typeof parsed === "object" ? (parsed as { version?: unknown }).version : undefined;
  if (typeof version === "number" && version !== STORAGE_VERSION) {
    return {
      error:
        "this file was made by a different version of proxmox.computer, and this one can't read its setup. start the setup again, or download a fresh copy.",
    };
  }
  if (!isPersistedState(parsed)) {
    return { error: "the setup line in this file is damaged — was it edited? download a fresh copy to reopen it." };
  }
  return { state: parsed };
}

/**
 * @param state the whole setup, embedded so the file can reopen it (see
 *   stateBlock); omit it for a bare answer file
 */
export function buildAnswerToml(node: NodeInfo, ctx: AnswerContext, state?: PersistedState): string {
  const fqdn = nodeFqdn(node, ctx.hostnameSuffix);
  const mailDomain = ctx.hostnameSuffix || "localhost";
  const bootSize = node.bootDiskSizeGb ? `${node.bootDiskSizeGb} gb` : "size not set";
  const mgmtIsBond = node.network.managementInterfaceId.startsWith("bond-");

  return [
    `# answer file for ${fqdn} — proxmox ve 8.4+ unattended install`,
    "# generated by proxmox.computer. before building the iso:",
    "#   1. add a root password (see [global] below) — the installer refuses the file without one",
    `#   2. replace ${DISK_PLACEHOLDER} in [disk-setup] with this node's boot disk`,
    "#   3. proxmox-auto-install-assistant validate-answer this-file.toml",
    "#   4. proxmox-auto-install-assistant prepare-iso proxmox-ve.iso --fetch-from iso --answer-file this-file.toml",
    "",
    "[global]",
    `# from your browser's settings — change them if this node lives elsewhere`,
    `keyboard = ${tomlString(keyboardFor(ctx.locale))}`,
    `country = ${tomlString(countryFor(ctx.locale))}`,
    `timezone = ${tomlString(ctx.timezone || "UTC")}`,
    `fqdn = ${tomlString(fqdn)}`,
    "# where proxmox sends alerts — change it to an address you actually read",
    `mailto = ${tomlString(`root@${mailDomain}`)}`,
    "# required: exactly one of these two. prefer the hash — generate it with",
    "#   mkpasswd --method=yescrypt   (or: openssl passwd -6)",
    '# root-password-hashed = "$y$j9T$..."',
    '# root-password = "..."',
    "# optional, and worth it — ansible will log in with this key later",
    '# root-ssh-keys = ["ssh-ed25519 AAAA... you@laptop"]',
    "",
    "[network]",
    'source = "from-answer"',
    `cidr = ${tomlString(node.network.cidr)}`,
    `gateway = ${tomlString(ctx.gateway)}`,
    `dns = ${tomlString(ctx.dns)}`,
    mgmtIsBond
      ? "# management is a bond — the installer can't build one, so it installs on a single member; ansible builds the bond later"
      : "# the installer picks the management nic itself",
    "# to pin it, find its mac with: proxmox-auto-install-assistant device-info -t network",
    '# filter.ID_NET_NAME_MAC = "*a0369f0ab382"',
    "",
    "[disk-setup]",
    'filesystem = "ext4"',
    `# the boot disk you declared: ${node.bootDiskType}, ${bootSize}. the installer wipes it.`,
    "# find its name with: proxmox-auto-install-assistant device-info -t disk",
    "# the wizard never names devices, so this won't match anything until you change it",
    `disk-list = [${tomlString(DISK_PLACEHOLDER)}]`,
    "",
    ...(state ? [stateBlock(state)] : []),
  ].join("\n");
}

/** a link target that downloads the text as a toml file, no server needed */
export function tomlDataUrl(toml: string): string {
  return `data:application/toml;charset=utf-8,${encodeURIComponent(toml)}`;
}
