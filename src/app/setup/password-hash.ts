// SHA-512-crypt ("$6$…"), the hash /etc/shadow and proxmox's installer
// accept for `root-password-hashed`. WebCrypto has sha-512 but no crypt
// scheme, so this is Ulrich Drepper's reference algorithm
// (https://www.akkadia.org/drepper/SHA-crypt.txt) built on its digest —
// the answer file then never carries a root password in the clear.

const ITOA64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const DEFAULT_ROUNDS = 5000;

async function sha512(...parts: Uint8Array[]): Promise<Uint8Array> {
  const length = parts.reduce((n, p) => n + p.length, 0);
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-512", joined));
}

/** `source` repeated to exactly `length` bytes */
function stretch(source: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = source[i % source.length];
  return out;
}

/** 16 salt characters from crypt's own alphabet */
export function randomSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => ITOA64[b & 63]).join("");
}

export async function sha512Crypt(password: string, salt: string = randomSalt(), rounds = DEFAULT_ROUNDS): Promise<string> {
  const p = new TextEncoder().encode(password);
  const s = new TextEncoder().encode(salt.slice(0, 16));

  // digest B, then A — seeded with the password, salt, and B
  const b = await sha512(p, s, p);
  const aParts: Uint8Array[] = [p, s];
  let n = p.length;
  for (; n > 64; n -= 64) aParts.push(b);
  aParts.push(b.subarray(0, n));
  for (let bits = p.length; bits > 0; bits >>= 1) aParts.push(bits & 1 ? b : p);
  const a = await sha512(...aParts);

  // the p and s sequences mixed into every round
  const dp = await sha512(...Array.from({ length: p.length }, () => p));
  const pSeq = stretch(dp, p.length);
  const ds = await sha512(...Array.from({ length: 16 + a[0] }, () => s));
  const sSeq = ds.subarray(0, s.length);

  let c = a;
  for (let i = 0; i < rounds; i++) {
    const parts: Uint8Array[] = [];
    parts.push(i & 1 ? pSeq : c);
    if (i % 3) parts.push(sSeq);
    if (i % 7) parts.push(pSeq);
    parts.push(i & 1 ? c : pSeq);
    c = await sha512(...parts);
  }

  // crypt's own base64, over the digest bytes in the spec's shuffled order
  const order = [
    [0, 21, 42], [22, 43, 1], [44, 2, 23], [3, 24, 45], [25, 46, 4], [47, 5, 26], [6, 27, 48],
    [28, 49, 7], [50, 8, 29], [9, 30, 51], [31, 52, 10], [53, 11, 32], [12, 33, 54], [34, 55, 13],
    [56, 14, 35], [15, 36, 57], [37, 58, 16], [59, 17, 38], [18, 39, 60], [40, 61, 19], [62, 20, 41],
  ];
  let encoded = "";
  const put = (b2: number, b1: number, b0: number, chars: number) => {
    let w = (b2 << 16) | (b1 << 8) | b0;
    for (let k = 0; k < chars; k++) {
      encoded += ITOA64[w & 63];
      w >>= 6;
    }
  };
  for (const [x, y, z] of order) put(c[x], c[y], c[z], 4);
  put(0, 0, c[63], 2);

  const prefix = rounds === DEFAULT_ROUNDS ? "$6$" : `$6$rounds=${rounds}$`;
  return `${prefix}${salt.slice(0, 16)}$${encoded}`;
}
