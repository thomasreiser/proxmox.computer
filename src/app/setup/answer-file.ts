// Each node's answer.toml: the file proxmox's unattended installer reads
// (phase 02 on /how-it-works). Written for pve 8.4+ — kebab-case keys.
// Reference: https://pve.proxmox.com/wiki/Automated_Installation
//
// The wizard records intent, never device identity, and this file sits on
// that line: the installer wipes whatever disk it's pointed at, so the boot
// disk is left as a placeholder the installer can't match (a safe failure)
// rather than guessed. The root password goes in as a sha-512-crypt hash,
// never in the clear, and the embedded setup is sealed with the visitor's
// passphrase (see vault.ts).

import { rootPasswordFor, sshKeyLines } from "./access";
import type { LocationPlan } from "./location";
import { sha512Crypt } from "./password-hash";
import { WrongPassphraseError, open, parseEnvelope, seal, type Envelope, type Opened } from "./vault";
import { STORAGE_VERSION, type NodeInfo, type PersistedState, type SavedStepId } from "./wizard-state";
import { restoreSaved } from "./saved-state";

/** the placeholder the installer can't match — it stops rather than guesses */
export const DISK_PLACEHOLDER = "CHANGE-ME";

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
  // step 1: the keyboard, country and timezone the installer asks first
  location: LocationPlan;
}

/** everything a node's file needs from the setup beyond the node itself */
export function answerContext(state: PersistedState): AnswerContext {
  return { hostnameSuffix: state.hostnameSuffix, gateway: state.gateway, dns: state.dns, location: state.location };
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
// It holds root passwords, so it's the sealed envelope (see vault.ts),
// base64 so nothing in it can break out of the comment.

export const STATE_MARKER = "# proxmox.computer-state:";

/** the comment block that carries the sealed setup */
export function stateBlock(envelope: Envelope): string {
  const encoded = btoa(JSON.stringify(envelope));
  return [
    "# the whole setup, encrypted with your passphrase, so proxmox.computer can reopen it:",
    '# open the start page and pick "adjust a setup" with this file. the installer ignores comments.',
    `${STATE_MARKER} ${encoded}`,
    "",
  ].join("\n");
}

export type ReadAnswerResult = { envelope: Envelope } | { error: string };

const DAMAGED = "the setup line in this file is damaged — was it edited? download a fresh copy to reopen it.";

/**
 * The sealed setup an answer file carries, or why it can't be reopened.
 * Edits to the rest of the file (the boot disk, say) are the file's own
 * business — only the embedded setup is read back.
 */
export function readAnswerToml(text: string): ReadAnswerResult {
  const line = text.split(/\r?\n/).find((l) => l.trim().startsWith(STATE_MARKER));
  if (!line) {
    return {
      error:
        "this file has no proxmox.computer setup in it — it wasn't made here, or its state line was removed. there's nothing to reopen.",
    };
  }
  let envelope: Envelope | null = null;
  try {
    envelope = parseEnvelope(JSON.parse(atob(line.trim().slice(STATE_MARKER.length).trim())));
  } catch {
    envelope = null;
  }
  if (!envelope) {
    return {
      error:
        "this file's setup isn't in a form this version of proxmox.computer can read — it's damaged, or from an older version. download a fresh copy.",
    };
  }
  return { envelope };
}

// startedOverFrom: the first step this build couldn't keep (see restoreSaved) — null when it kept all
export type OpenAnswerResult = { state: PersistedState; opened: Opened; startedOverFrom: SavedStepId | null } | { error: string };

/** decrypts a file's setup with its passphrase */
export async function openAnswerSetup(envelope: Envelope, passphrase: string): Promise<OpenAnswerResult> {
  let opened: Opened;
  try {
    opened = await open(envelope, passphrase);
  } catch (e) {
    if (e instanceof WrongPassphraseError) return { error: "that's not the passphrase this file was saved with" };
    return { error: DAMAGED };
  }
  const value = opened.value;
  // a save in another layout — anything unnumbered is just damaged. a step
  // this build changed only starts that step over (see restoreSaved)
  const version = value && typeof value === "object" ? (value as { version?: unknown }).version : undefined;
  if (typeof version === "number" && version !== STORAGE_VERSION) {
    return {
      error:
        "this file was made by a different version of proxmox.computer, and this one can't read its setup. start the setup again, or download a fresh copy.",
    };
  }
  const restored = restoreSaved(value);
  if (!restored) return { error: DAMAGED };
  return { state: restored.state, opened, startedOverFrom: restored.startedOverFrom };
}

/** what a node's file carries beyond the plan itself */
export interface AnswerExtras {
  // sha-512-crypt of the node's root password — null leaves the key out
  passwordHash: string | null;
  sshKeys: string[];
  // the sealed setup (see stateBlock) — omitted for a bare answer file
  envelope?: Envelope;
}

export function buildAnswerToml(node: NodeInfo, ctx: AnswerContext, extras: AnswerExtras): string {
  const fqdn = nodeFqdn(node, ctx.hostnameSuffix);
  const mailDomain = ctx.hostnameSuffix || "localhost";
  const bootSize = node.bootDiskSizeGb ? `${node.bootDiskSizeGb} gb` : "size not set";
  const mgmtIsBond = node.network.managementInterfaceId.startsWith("bond-");

  return [
    `# answer file for ${fqdn} — proxmox ve 8.4+ unattended install`,
    "# generated by proxmox.computer. before building the iso:",
    `#   1. replace ${DISK_PLACEHOLDER} in [disk-setup] with this node's boot disk`,
    "#   2. proxmox-auto-install-assistant validate-answer this-file.toml",
    "#   3. proxmox-auto-install-assistant prepare-iso proxmox-ve.iso --fetch-from iso --answer-file this-file.toml",
    "",
    "[global]",
    "# from step 1, location",
    `keyboard = ${tomlString(ctx.location.keyboard)}`,
    `country = ${tomlString(ctx.location.country)}`,
    `timezone = ${tomlString(ctx.location.timezone || "UTC")}`,
    `fqdn = ${tomlString(fqdn)}`,
    "# where proxmox sends alerts — change it to an address you actually read",
    `mailto = ${tomlString(`root@${mailDomain}`)}`,
    ...(extras.passwordHash
      ? [
          "# the root password from step 6, as a sha-512-crypt hash — never the password itself",
          `root-password-hashed = ${tomlString(extras.passwordHash)}`,
        ]
      : [
          "# required: no root password was set in step 6. add its hash — openssl passwd -6",
          '# root-password-hashed = "$6$..."',
        ]),
    ...(extras.sshKeys.length > 0
      ? [
          "# root on this node accepts these keys — ansible logs in with them later",
          `root-ssh-keys = [${extras.sshKeys.map(tomlString).join(", ")}]`,
        ]
      : []),
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
    ...(extras.envelope ? [stateBlock(extras.envelope)] : []),
  ].join("\n");
}

/** a link target that downloads the text as a toml file, no server needed */
export function tomlDataUrl(toml: string): string {
  return `data:application/toml;charset=utf-8,${encodeURIComponent(toml)}`;
}

export interface PreparedAnswerFile {
  fileName: string;
  toml: string;
}

/**
 * Every node's answer file, ready to download: each root password hashed,
 * the setup sealed once with the session key. Async — hashing and
 * encrypting both go through WebCrypto.
 */
export async function prepareAnswerFiles(state: PersistedState, ctx: AnswerContext = answerContext(state)): Promise<PreparedAnswerFile[]> {
  const envelope = await seal(state);
  const sshKeys = sshKeyLines(state.access.sshKeys);
  return Promise.all(
    state.nodes.map(async (node, i) => {
      const password = rootPasswordFor(state.access, i);
      const passwordHash = password ? await sha512Crypt(password) : null;
      return { fileName: answerFileName(node), toml: buildAnswerToml(node, ctx, { passwordHash, sshKeys, envelope }) };
    }),
  );
}
