// The encrypted store behind the wizard. Once the access step holds root
// passwords and an oidc client secret, the saved state is a secret too, so
// it never touches localStorage (or an answer file) in the clear:
//
//   passphrase ──PBKDF2-SHA256──▶ AES-GCM-256 key ──▶ { salt, iv, data }
//
// The derived key lives in memory only, for this page session: moving
// between the wizard and its previews keeps it (client-side navigation),
// a reload asks for the passphrase again. Nothing is ever sent anywhere.

export const STORAGE_KEY = "proxmox-computer:setup-wizard";

const FORMAT = "proxmox.computer/vault";

// OWASP's 2023 floor for PBKDF2-SHA256. Stored in every envelope, so it
// can rise later without breaking what's already saved.
const DEFAULT_ITERATIONS = 600_000;
let iterations = DEFAULT_ITERATIONS;

/** tests only: a full-strength derivation would make every test slow */
export function setKdfIterationsForTests(n: number): void {
  iterations = n;
}

export interface Envelope {
  format: typeof FORMAT;
  v: 1;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string; // base64
  iv: string; // base64, fresh for every encryption
  data: string; // base64 AES-GCM ciphertext + tag
}

// the passphrase is all that stands between a copied browser profile (or
// an answer file) and the root passwords inside — and there's no recovery
export const MIN_PASSPHRASE = 12;

export function validateNewPassphrase(passphrase: string, confirm: string): string | null {
  if (!passphrase) return "required";
  if (passphrase.length < MIN_PASSPHRASE) return `at least ${MIN_PASSPHRASE} characters — a few words make a good one`;
  if (confirm !== passphrase) return "the two don't match";
  return null;
}

export class WrongPassphraseError extends Error {
  constructor() {
    super("wrong passphrase");
  }
}

interface Session {
  key: CryptoKey;
  salt: string;
  iterations: number;
}

let session: Session | null = null;

// ── encoding ─────────────────────────────────────────────────────────────

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── keys ─────────────────────────────────────────────────────────────────

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, rounds: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: rounds },
    material,
    { name: "AES-GCM", length: 256 },
    false, // never extractable — the key can't leave this page
    ["encrypt", "decrypt"],
  );
}

/** a new vault: fresh salt, key derived from the passphrase, held in memory */
export async function startSession(passphrase: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  session = { key: await deriveKey(passphrase, salt, iterations), salt: toBase64(salt), iterations };
}

export function lock(): void {
  session = null;
}

// ── envelopes ────────────────────────────────────────────────────────────

export function parseEnvelope(value: unknown): Envelope | null {
  if (!value || typeof value !== "object") return null;
  const e = value as Record<string, unknown>;
  if (e.format !== FORMAT || e.v !== 1 || e.kdf !== "PBKDF2-SHA256") return null;
  if (typeof e.iterations !== "number" || e.iterations < 1) return null;
  if (typeof e.salt !== "string" || typeof e.iv !== "string" || typeof e.data !== "string") return null;
  return e as unknown as Envelope;
}

/** encrypts with the session key — a fresh iv every time */
export async function seal(value: unknown): Promise<Envelope> {
  // taken once: the vault can lock (or switch keys) while this awaits
  const current = session;
  if (!current) throw new Error("the vault is locked");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    current.key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return {
    format: FORMAT,
    v: 1,
    kdf: "PBKDF2-SHA256",
    iterations: current.iterations,
    salt: current.salt,
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(data)),
  };
}

async function decryptWith(key: CryptoKey, envelope: Envelope): Promise<unknown> {
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(envelope.iv) }, key, fromBase64(envelope.data));
  } catch {
    // aes-gcm authenticates: a wrong key and a tampered file fail alike
    throw new WrongPassphraseError();
  }
  return JSON.parse(new TextDecoder().decode(plain));
}

export interface Opened {
  value: unknown;
  // hand this to adopt() to keep working under the same passphrase
  session: Session;
}

/** decrypts with a passphrase, without touching the current session */
export async function open(envelope: Envelope, passphrase: string): Promise<Opened> {
  const key = await deriveKey(passphrase, fromBase64(envelope.salt), envelope.iterations);
  const value = await decryptWith(key, envelope);
  return { value, session: { key, salt: envelope.salt, iterations: envelope.iterations } };
}

/** makes an opened envelope's key the session key */
export function adopt(opened: Opened): void {
  session = opened.session;
}

// ── the stored copy ──────────────────────────────────────────────────────

/** the envelope saved in this browser, if any — reading it needs no key */
export function storedEnvelope(): Envelope | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? parseEnvelope(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/**
 * Whether the session can read and write what's stored: unlocked, and
 * either nothing is stored or it was sealed under this same key. A save
 * from another passphrase (another tab, an import) locks us out rather
 * than being silently overwritten.
 */
export function isUnlocked(): boolean {
  if (!session) return false;
  const stored = storedEnvelope();
  return !stored || stored.salt === session.salt;
}

/** unlocks the stored envelope with a passphrase and adopts its key */
export async function unlockStored(passphrase: string): Promise<unknown> {
  const stored = storedEnvelope();
  if (!stored) throw new Error("nothing is stored");
  const opened = await open(stored, passphrase);
  adopt(opened);
  return opened.value;
}

/** the stored state, decrypted with the session key — null if locked or unreadable */
export async function readStored(): Promise<unknown> {
  const stored = storedEnvelope();
  if (!session || !stored || stored.salt !== session.salt) return null;
  try {
    return await decryptWith(session.key, stored);
  } catch {
    return null;
  }
}

// saves can overlap (encryption is async): only the newest one may write,
// or a slow older save could land last and roll the state back
let saveSeq = 0;

/** seals the value and stores it — false if locked or storage refuses */
export async function writeStored(value: unknown): Promise<boolean> {
  if (!session) return false;
  const seq = ++saveSeq;
  const envelope = await seal(value);
  if (seq !== saveSeq) return true;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
    return true;
  } catch {
    return false;
  }
}

export function clearStored(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // unavailable storage has nothing to clear
  }
}
