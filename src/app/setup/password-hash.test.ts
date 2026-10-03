import { describe, expect, it } from "vitest";
import { randomSalt, sha512Crypt } from "./password-hash";

// reference outputs from `openssl passwd -6 -salt <salt> <password>`, and
// the spec's own rounds vector — each exercises a different branch
describe("sha512Crypt", () => {
  it.each([
    ["saltstring", "Hello world!", "$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1"],
    [
      "abcdefghijklmnop",
      "correct horse battery staple",
      "$6$abcdefghijklmnop$UY4jc6.rVibJ9tqDqiG0GMdZRHkv1j4sPRRH2eUSo3Kszltzbk30CmYcWPNRTD/KsYFHF7WTtNkAxF3dZ3zPE.",
    ],
    // longer than one 64-byte digest
    [
      "ab/cd.EF01234567",
      "p".repeat(130),
      "$6$ab/cd.EF01234567$vSIEO8jE40IJts5OYNlU5iG3gIOaKqfRf1Oz0J0dvYF.ftzM1mj6hqeZKNB5DkEdYxBsiquYpifyiIDZ1BlgY0",
    ],
    // hashed as utf-8, the way the system hashes what's typed at login
    ["saltsalt", "pässwörd", "$6$saltsalt$TQjRhpJdqmLx0U8it3EsUajwkmOMMvw5vhUFc7mohzFFoj/QHrfYUHU1oSkwyCEoTUCDOiAOW135nel3bqtKe."],
  ])("matches openssl for salt %s", async (salt, password, expected) => {
    expect(await sha512Crypt(password, salt)).toBe(expected);
  });

  it("writes a non-default round count into the hash", async () => {
    expect(await sha512Crypt("Hello world!", "saltstringsaltstring", 10000)).toBe(
      "$6$rounds=10000$saltstringsaltst$OW1/O6BYHV6BcXZu8QVeXbDWra3Oeqh0sbHbbMCVNSnCM/UrjmM0Dp8vOuZeHBy/YTBmSK6H9qs/y3RnOaw5v.",
    );
  });

  it("salts every hash differently by default", async () => {
    const [a, b] = await Promise.all([sha512Crypt("same"), sha512Crypt("same")]);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^\$6\$[./0-9A-Za-z]{16}\$[./0-9A-Za-z]{86}$/);
  });
});

describe("randomSalt", () => {
  it("is 16 characters of crypt's alphabet", () => {
    expect(randomSalt()).toMatch(/^[./0-9A-Za-z]{16}$/);
  });
});
