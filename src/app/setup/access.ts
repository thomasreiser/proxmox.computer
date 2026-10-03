// Step 6's logic: ssh keys, root passwords and the optional oidc realm —
// validated here, never shown back in the clear anywhere but their own
// field. Everything this step holds is encrypted at rest (see vault.ts).

import type { Hint } from "./hints";
import { fromBase64 } from "./vault";
import type { AccessPlan, NodeInfo, OidcUsernameClaim } from "./wizard-state";

export function defaultAccessPlan(): AccessPlan {
  return {
    sshKeys: "",
    disablePasswordSsh: true,
    rootPasswords: [],
    oidc: {
      enabled: false,
      realm: "oidc",
      issuerUrl: "",
      clientId: "",
      clientSecret: "",
      usernameClaim: "username",
      autocreate: true,
      isDefault: true,
    },
  };
}

/** a node's root password — "" for a node added since passwords were set */
export function rootPasswordFor(plan: AccessPlan, nodeIndex: number): string {
  return plan.rootPasswords[nodeIndex] ?? "";
}

// ── ssh keys ─────────────────────────────────────────────────────────────

const KEY_TYPES = [
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
];

export interface SshPublicKey {
  type: string;
  // the base64 blob, as pasted
  data: string;
  comment: string;
}

/** the non-blank lines of the keys field */
export function sshKeyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * One authorized_keys line — type, base64 blob, optional comment — or null.
 * The blob has to decode, and has to name the same key type inside it as
 * the line does outside, which catches a truncated or mangled paste.
 */
export function parseSshPublicKey(line: string): SshPublicKey | null {
  const [type, data, ...comment] = line.trim().split(/\s+/);
  if (!type || !data || !KEY_TYPES.includes(type)) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  let blob: Uint8Array;
  try {
    blob = fromBase64(data);
  } catch {
    return null;
  }
  if (blob.length < 4) return null;
  const nameLength = (blob[0] << 24) | (blob[1] << 16) | (blob[2] << 8) | blob[3];
  if (nameLength !== type.length || blob.length < 4 + nameLength) return null;
  if (new TextDecoder().decode(blob.subarray(4, 4 + nameLength)) !== type) return null;
  // a real key carries key material after its name
  if (blob.length <= 4 + nameLength + 4) return null;
  return { type, data, comment: comment.join(" ") };
}

export function validateSshKeys(text: string): string | null {
  // the one paste that must never happen, whatever else is wrong
  if (/PRIVATE KEY/.test(text)) {
    return "that's a private key — never paste it anywhere. use the .pub file next to it";
  }
  const lines = sshKeyLines(text);
  if (lines.length === 0) return "required — ssh and ansible log in with it";
  const bad = lines.findIndex((l) => !parseSshPublicKey(l));
  if (bad >= 0) {
    const which = lines.length > 1 ? `line ${bad + 1} isn't` : "that isn't";
    return `${which} a public key — paste a whole line from a .pub file, like "ssh-ed25519 AAAA… you@laptop"`;
  }
  const blobs = lines.map((l) => parseSshPublicKey(l)!.data);
  if (new Set(blobs).size !== blobs.length) return "the same key is in here twice";
  return null;
}

/** the fingerprint ssh-keygen -l prints: SHA256, unpadded base64 */
export async function sshFingerprint(key: SshPublicKey): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", fromBase64(key.data)));
  let binary = "";
  for (const b of digest) binary += String.fromCharCode(b);
  return `SHA256:${btoa(binary).replace(/=+$/, "")}`;
}

// ── root passwords ───────────────────────────────────────────────────────

export const MIN_ROOT_PASSWORD = 12;

export function validateRootPassword(password: string): string | null {
  if (!password) return "required — the web ui and the console log in with it";
  if (password.length < MIN_ROOT_PASSWORD) return `at least ${MIN_ROOT_PASSWORD} characters`;
  return null;
}

// letters and digits only, minus the ones that read alike (0/O, 1/l/I):
// a password typed at a console whose keyboard layout isn't the one you
// expect still works, where a symbol can land on another key
const PASSWORD_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** a random password — 24 characters is ~139 bits */
export function generatePassword(length = 24): string {
  const out: string[] = [];
  // rejection sampling, so every character is equally likely
  const limit = 256 - (256 % PASSWORD_ALPHABET.length);
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < limit && out.length < length) out.push(PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]);
    }
  }
  return out.join("");
}

// ── oidc ─────────────────────────────────────────────────────────────────

export const USERNAME_CLAIM_OPTIONS: { value: OidcUsernameClaim; label: string; hint: string }[] = [
  { value: "username", label: "username", hint: "the provider's preferred_username — readable names like alice@oidc" },
  { value: "email", label: "email", hint: "the email address — readable, but changes if the address does" },
  { value: "subject", label: "subject", hint: "the provider's stable id — never changes, but reads as a random string" },
];

/** a proxmox realm id — and not one of the two built in */
export function validateRealm(value: string): string | null {
  if (!value) return "required";
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,30}[A-Za-z0-9]$/.test(value)) {
    return "2–32 letters, digits, . _ or - — starting with a letter";
  }
  if (["pam", "pve"].includes(value.toLowerCase())) return "pam and pve are proxmox's own realms";
  return null;
}

export function validateIssuerUrl(value: string): string | null {
  if (!value) return "required";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "a url, like https://auth.example.com/realms/homelab";
  }
  if (url.protocol !== "https:") return "https only — proxmox won't talk to an issuer over plain http";
  if (url.search || url.hash) return "just the issuer — no ? or # part";
  return null;
}

export function validateClientId(value: string): string | null {
  if (!value) return "required";
  if (/\s/.test(value)) return "no spaces";
  return null;
}

/**
 * The redirect uris to register with the identity provider: proxmox sends
 * people back to whichever node they logged in on, at its web ui.
 */
export function oidcRedirectUris(nodes: NodeInfo[], hostnameSuffix: string): string[] {
  return nodes.map((node) => {
    const label = node.network.hostLabel || node.name;
    return `https://${hostnameSuffix ? `${label}.${hostnameSuffix}` : label}:8006`;
  });
}

// ── hints ────────────────────────────────────────────────────────────────

export function passwordSshHint(disablePasswordSsh: boolean): Hint | null {
  if (disablePasswordSsh) return null;
  return {
    tone: "warning",
    glyph: "!",
    text: "ssh keeps taking passwords, so anything that reaches port 22 can try to guess root's. with a key set, there's little reason to leave it on.",
  };
}

/** one password on every node means one leak opens all of them */
export function sharedRootPasswordHint(plan: AccessPlan, nodeCount: number): Hint | null {
  if (nodeCount < 2) return null;
  const passwords = Array.from({ length: nodeCount }, (_, i) => rootPasswordFor(plan, i));
  if (passwords.some((p) => !p) || new Set(passwords).size > 1) return null;
  return {
    tone: "info",
    glyph: "#",
    text: "every node has the same root password — one that leaks opens all of them. \"generate\" gives each its own.",
  };
}
