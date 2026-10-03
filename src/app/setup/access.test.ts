import { describe, expect, it } from "vitest";
import {
  MIN_ROOT_PASSWORD,
  defaultAccessPlan,
  generatePassword,
  oidcRedirectUris,
  parseSshPublicKey,
  passwordSshHint,
  rootPasswordFor,
  sharedRootPasswordHint,
  sshFingerprint,
  sshKeyLines,
  validateClientId,
  validateIssuerUrl,
  validateRealm,
  validateRootPassword,
  validateSshKeys,
} from "./access";
import { ED25519_FINGERPRINT, ED25519_KEY, RSA_KEY, accessPlan, cluster } from "./test-fixtures";

describe("defaults", () => {
  // the checkbox the visitor asked to start ticked
  it("turns password ssh off, and oidc stays off until asked for", () => {
    const plan = defaultAccessPlan();
    expect(plan.disablePasswordSsh).toBe(true);
    expect(plan.oidc.enabled).toBe(false);
    expect(plan.sshKeys).toBe("");
  });

  it("reads a node added since the passwords were set as having none", () => {
    expect(rootPasswordFor(accessPlan({}, 2), 1)).toBe("root-password-2-long");
    expect(rootPasswordFor(accessPlan({}, 2), 2)).toBe("");
  });
});

describe("ssh keys", () => {
  it("parses a public key line into type, data and comment", () => {
    expect(parseSshPublicKey(ED25519_KEY)).toEqual({
      type: "ssh-ed25519",
      data: ED25519_KEY.split(" ")[1],
      comment: "test@fixture",
    });
    expect(parseSshPublicKey(RSA_KEY)?.type).toBe("ssh-rsa");
  });

  it("takes a key without a comment", () => {
    expect(parseSshPublicKey(ED25519_KEY.replace(" test@fixture", ""))?.comment).toBe("");
  });

  // the blob names its own type: a mangled paste doesn't pass for a key
  it("rejects a key whose data doesn't match its type", () => {
    expect(parseSshPublicKey(`ssh-rsa ${ED25519_KEY.split(" ")[1]}`)).toBeNull();
    expect(parseSshPublicKey(`ssh-ed25519 ${ED25519_KEY.split(" ")[1].slice(0, 20)}`)).toBeNull();
    expect(parseSshPublicKey("ssh-ed25519 not*base64")).toBeNull();
    expect(parseSshPublicKey("ssh-dss AAAAB3NzaC1kc3M=")).toBeNull();
    expect(parseSshPublicKey("")).toBeNull();
  });

  it("reads one key per non-blank line", () => {
    expect(sshKeyLines(`\n${ED25519_KEY}\r\n\n  ${RSA_KEY}  \n`)).toEqual([ED25519_KEY, RSA_KEY]);
  });

  it("accepts one or several valid keys", () => {
    expect(validateSshKeys(ED25519_KEY)).toBeNull();
    expect(validateSshKeys(`${ED25519_KEY}\n${RSA_KEY}`)).toBeNull();
  });

  it("requires at least one", () => {
    expect(validateSshKeys("")).toMatch(/required/);
    expect(validateSshKeys("  \n ")).toMatch(/required/);
  });

  it("says which line isn't a key", () => {
    expect(validateSshKeys("hello")).toMatch(/^that isn't a public key/);
    expect(validateSshKeys(`${ED25519_KEY}\nhello`)).toMatch(/^line 2 isn't a public key/);
  });

  // the one paste that must never happen
  it("flags a pasted private key", () => {
    const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----";
    expect(validateSshKeys(privateKey)).toMatch(/private key — never paste it/);
    expect(validateSshKeys(`${ED25519_KEY}\n${privateKey}`)).toMatch(/private key/);
  });

  it("flags the same key twice", () => {
    expect(validateSshKeys(`${ED25519_KEY}\n${ED25519_KEY.replace("test@fixture", "other")}`)).toMatch(/twice/);
  });

  // what `ssh-keygen -lf` prints for the fixture key
  it("fingerprints a key the way ssh-keygen does", async () => {
    expect(await sshFingerprint(parseSshPublicKey(ED25519_KEY)!)).toBe(ED25519_FINGERPRINT);
  });
});

describe("root passwords", () => {
  it("wants one of at least 12 characters", () => {
    expect(validateRootPassword("")).toMatch(/required/);
    expect(validateRootPassword("x".repeat(MIN_ROOT_PASSWORD - 1))).toMatch(/at least 12/);
    expect(validateRootPassword("x".repeat(MIN_ROOT_PASSWORD))).toBeNull();
  });

  // letters and digits only: typeable at a console with an unexpected layout
  it("generates 24 unambiguous letters and digits", () => {
    const password = generatePassword();
    expect(password).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{24}$/);
    expect(validateRootPassword(password)).toBeNull();
  });

  it("generates a different one every time", () => {
    const passwords = new Set(Array.from({ length: 20 }, () => generatePassword()));
    expect(passwords.size).toBe(20);
  });

  it("generates the length asked for", () => {
    expect(generatePassword(40)).toHaveLength(40);
  });
});

describe("oidc", () => {
  it.each(["oidc", "authentik", "sso.lab", "my-idp_2"])("takes the realm %s", (realm) => {
    expect(validateRealm(realm)).toBeNull();
  });

  it("rejects a malformed realm", () => {
    expect(validateRealm("")).toBe("required");
    expect(validateRealm("2fa")).toMatch(/starting with a letter/);
    expect(validateRealm("a")).toMatch(/2–32/);
    expect(validateRealm("sso-")).toMatch(/2–32/);
    expect(validateRealm("a".repeat(33))).toMatch(/2–32/);
  });

  // proxmox's own realms can't be redefined
  it("won't take pam or pve", () => {
    expect(validateRealm("pam")).toMatch(/proxmox's own/);
    expect(validateRealm("PVE")).toMatch(/proxmox's own/);
  });

  it("wants an https issuer, and just the issuer", () => {
    expect(validateIssuerUrl("https://auth.example.com/realms/homelab")).toBeNull();
    expect(validateIssuerUrl("")).toBe("required");
    expect(validateIssuerUrl("auth.example.com")).toMatch(/a url/);
    expect(validateIssuerUrl("http://auth.example.com")).toMatch(/https only/);
    expect(validateIssuerUrl("https://auth.example.com/?x=1")).toMatch(/no \? or #/);
  });

  it("wants a client id without spaces", () => {
    expect(validateClientId("proxmox")).toBeNull();
    expect(validateClientId("")).toBe("required");
    expect(validateClientId("prox mox")).toMatch(/no spaces/);
  });

  it("lists every node's web ui as a redirect uri", () => {
    expect(oidcRedirectUris(cluster(2), "lab.lan")).toEqual(["https://pve01.lab.lan:8006", "https://pve02.lab.lan:8006"]);
    expect(oidcRedirectUris(cluster(1), "")).toEqual(["https://pve01:8006"]);
  });
});

describe("hints", () => {
  it("warns while ssh still takes passwords, and only then", () => {
    expect(passwordSshHint(false)?.tone).toBe("warning");
    expect(passwordSshHint(true)).toBeNull();
  });

  it("notes one root password shared by every node", () => {
    const same = accessPlan({ rootPasswords: ["same-password-123", "same-password-123", "same-password-123"] });
    expect(sharedRootPasswordHint(same, 3)?.text).toMatch(/same root password/);
  });

  it("stays quiet for distinct, missing, or a single node's password", () => {
    expect(sharedRootPasswordHint(accessPlan(), 3)).toBeNull();
    expect(sharedRootPasswordHint(accessPlan({ rootPasswords: ["", ""] }), 2)).toBeNull();
    expect(sharedRootPasswordHint(accessPlan({ rootPasswords: ["only-one-password"] }), 1)).toBeNull();
  });
});
