import { describe, expect, it } from "vitest";
import {
  DISK_PLACEHOLDER,
  LSBLK_COMMAND,
  STATE_MARKER,
  openAnswerSetup,
  prepareAnswerFiles,
  readAnswerToml,
  answerFileName,
  buildAnswerToml,
  nodeFqdn,
  tomlDataUrl,
  tomlString,
} from "./answer-file";
import { ED25519_KEY, RSA_KEY, accessPlan, bond, installPlan, network, nics, node, persistedState } from "./test-fixtures";
import { sha512Crypt } from "./password-hash";

const ctx = {
  hostnameSuffix: "lab.lan",
  gateway: "10.0.10.1",
  dns: "10.0.10.53",
  location: { country: "at", keyboard: "de", timezone: "Europe/Vienna" },
};
const pve01 = () => node({ network: network({ hostLabel: "pve01", cidr: "10.0.10.11/24" }), bootDiskSizeGb: "512" });
/** every uncommented `key = value` line, as a map */
const keys = (toml: string) =>
  Object.fromEntries(
    toml
      .split("\n")
      .filter((l) => /^[a-z.A-Z_-]+ = /.test(l))
      .map((l) => [l.slice(0, l.indexOf(" = ")), l.slice(l.indexOf(" = ") + 3)]),
  );

describe("tomlString", () => {
  it("quotes and escapes", () => {
    expect(tomlString("plain")).toBe('"plain"');
    expect(tomlString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(tomlString("a\nb\tc\u0001")).toBe('"a\\nb\\tc\\u0001"');
  });
});

describe("naming", () => {
  it("joins the label and the domain", () => {
    expect(nodeFqdn(pve01(), "lab.lan")).toBe("pve01.lab.lan");
    expect(nodeFqdn(pve01(), "")).toBe("pve01");
  });

  it("names the download after the node", () => {
    expect(answerFileName(pve01())).toBe("answer-pve01.toml");
  });
});

// what a file carries beyond the plan, for tests that don't care
const bare = { passwordHash: null, sshKeys: [] };

describe("buildAnswerToml", () => {
  // step 1's answers, not the browser the file happens to be made in
  it("takes keyboard, country and timezone from step 2", () => {
    const k = keys(buildAnswerToml(pve01(), { ...ctx, location: { country: "ch", keyboard: "fr-ch", timezone: "Europe/Zurich" } }, bare));
    expect(k).toMatchObject({ keyboard: '"fr-ch"', country: '"ch"', timezone: '"Europe/Zurich"' });
  });

  it("fills in everything the wizard knows", () => {
    const k = keys(buildAnswerToml(pve01(), ctx, bare));
    expect(k).toMatchObject({
      keyboard: '"de"',
      country: '"at"',
      timezone: '"Europe/Vienna"',
      fqdn: '"pve01.lab.lan"',
      mailto: '"root@lab.lan"',
      source: '"from-answer"',
      cidr: '"10.0.10.11/24"',
      gateway: '"10.0.10.1"',
      // its own field — not assumed to be the gateway
      dns: '"10.0.10.53"',
      filesystem: '"ext4"',
    });
  });

  it("uses the installer's kebab-case keys and sections", () => {
    const toml = buildAnswerToml(pve01(), ctx, { passwordHash: "$6$s$h", sshKeys: [ED25519_KEY] });
    for (const section of ["[global]", "[network]", "[disk-setup]"]) expect(toml).toContain(section);
    expect(toml).toContain("disk-list = ");
    expect(toml).toContain("root-password-hashed = ");
    expect(toml).toContain("root-ssh-keys = ");
    expect(toml).not.toMatch(/^[a-z]+_[a-z]+ = /m);
  });

  // a guessed disk would get wiped: the placeholder matches nothing
  it("never names the boot disk, but describes it", () => {
    const toml = buildAnswerToml(pve01(), ctx, bare);
    expect(keys(toml)["disk-list"]).toBe(`["${DISK_PLACEHOLDER}"]`);
    expect(toml).toContain("the boot disk you declared: nvme, 512 gb");
  });

  it("says how to find the boot disk, and how to write it in", () => {
    const toml = buildAnswerToml(pve01(), ctx, bare);
    const diskSetup = toml.slice(toml.indexOf("[disk-setup]"));
    expect(diskSetup).toContain(`#   ${LSBLK_COMMAND}`);
    expect(diskSetup).toContain('# then put its NAME here, without /dev/ — e.g. disk-list = ["nvme0n1"]');
    expect(diskSetup).toContain('#   filter.ID_SERIAL = "*S5GXNF0R123456*"');
  });

  // the serial filter is an example: live, it would replace the placeholder's safe failure
  it("leaves the serial filter commented out", () => {
    const k = keys(buildAnswerToml(pve01(), ctx, bare));
    expect(Object.keys(k).filter((key) => key.startsWith("filter"))).toEqual([]);
  });

  it("writes in the boot disk named in step 8", () => {
    const toml = buildAnswerToml(pve01(), ctx, { ...bare, bootDisk: "nvme0n1" });
    expect(keys(toml)["disk-list"]).toBe('["nvme0n1"]');
    expect(toml).toContain("#   1. check nvme0n1 in [disk-setup] is this node's boot disk: the installer wipes it");
    expect(toml).toContain("# named in step 8, from lsblk on this machine");
    // nothing left that tells you to replace it, or how to find it
    expect(toml).not.toContain(DISK_PLACEHOLDER);
    expect(toml).not.toContain(LSBLK_COMMAND);
    // the serial alternative is still offered
    expect(toml).toContain('#   filter.ID_SERIAL = "*S5GXNF0R123456*"');
  });

  it("keeps the placeholder, and says why, without a boot disk", () => {
    for (const bootDisk of [undefined, null, ""]) {
      const toml = buildAnswerToml(pve01(), ctx, { ...bare, bootDisk });
      expect(keys(toml)["disk-list"]).toBe(`["${DISK_PLACEHOLDER}"]`);
      expect(toml).toContain(`#   1. replace ${DISK_PLACEHOLDER} in [disk-setup] with this node's boot disk`);
      expect(toml).toContain("# no boot disk was named in step 8, so this won't match anything until you change it");
    }
  });

  it("is written for proxmox ve 9.2, and builds from its iso", () => {
    const toml = buildAnswerToml(pve01(), ctx, bare);
    expect(toml.split("\n")[0]).toBe("# answer file for pve01.lab.lan — proxmox ve 9.2 unattended install");
    expect(toml).toContain("prepare-iso proxmox-ve_9.2-1.iso --fetch-from iso");
  });

  it("names its own file in the commands at the top", () => {
    const toml = buildAnswerToml(pve01(), ctx, bare);
    expect(toml).toContain("#   2. proxmox-auto-install-assistant validate-answer answer-pve01.toml");
    expect(toml).toContain("--fetch-from iso --answer-file answer-pve01.toml");
  });

  it("writes the root password's hash, never a password", () => {
    const k = keys(buildAnswerToml(pve01(), ctx, { passwordHash: "$6$salt$hash", sshKeys: [] }));
    expect(k["root-password-hashed"]).toBe('"$6$salt$hash"');
    expect(k).not.toHaveProperty("root-password");
  });

  // no password, no key — prepare-iso refuses the file rather than installing a node nobody can log in to
  it("leaves the password key out when there's no hash", () => {
    const k = keys(buildAnswerToml(pve01(), ctx, bare));
    expect(k).not.toHaveProperty("root-password-hashed");
    expect(k).not.toHaveProperty("root-password");
  });

  it("lists every ssh key for root", () => {
    const k = keys(buildAnswerToml(pve01(), ctx, { passwordHash: null, sshKeys: [ED25519_KEY, RSA_KEY] }));
    expect(k["root-ssh-keys"]).toBe(`[${tomlString(ED25519_KEY)}, ${tomlString(RSA_KEY)}]`);
  });

  it("leaves root-ssh-keys out without keys", () => {
    expect(keys(buildAnswerToml(pve01(), ctx, bare))).not.toHaveProperty("root-ssh-keys");
  });

  it("never pins a nic — the wizard doesn't know its mac", () => {
    expect(keys(buildAnswerToml(pve01(), ctx, bare))).not.toHaveProperty("filter.ID_NET_NAME_MAC");
  });

  it("explains that a management bond is built later", () => {
    const n = node({
      nics: nics("10gbe", "10gbe"),
      network: network({ bonds: [bond({ nicIndices: [0, 1] })], bondCount: "1", managementInterfaceId: "bond-0" }),
    });
    expect(buildAnswerToml(n, ctx, bare)).toMatch(/management is a bond/);
    expect(buildAnswerToml(pve01(), ctx, bare)).not.toMatch(/management is a bond/);
  });

  it("falls back sensibly without a domain or timezone", () => {
    const k = keys(buildAnswerToml(pve01(), { ...ctx, hostnameSuffix: "", location: { ...ctx.location, timezone: "" } }, bare));
    expect(k.fqdn).toBe('"pve01"');
    expect(k.mailto).toBe('"root@localhost"');
    expect(k.timezone).toBe('"UTC"');
  });
});

describe("tomlDataUrl", () => {
  it("round-trips the text as a toml download", () => {
    const toml = buildAnswerToml(pve01(), ctx, bare);
    const url = tomlDataUrl(toml);
    expect(url.startsWith("data:application/toml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.slice(url.indexOf(",") + 1))).toBe(toml);
  });
});

describe("prepareAnswerFiles", () => {
  it("writes each node's own boot disk into its file", async () => {
    const state = persistedState({ install: installPlan({ bootDisks: ["nvme0n1", "", "/dev/sdc"] }) });
    const disks = (await prepareAnswerFiles(state, ctx)).map((f) => keys(f.toml)["disk-list"]);
    // pve02 has none yet; pve03's isn't valid — both keep the placeholder
    expect(disks).toEqual(['["nvme0n1"]', `["${DISK_PLACEHOLDER}"]`, `["${DISK_PLACEHOLDER}"]`]);
  });

  it("writes the shared boot disk into every file while the hardware is identical", async () => {
    const state = persistedState({ identicalHardware: true, install: installPlan({ bootDisk: "sda", bootDisks: ["nvme0n1"] }) });
    const disks = (await prepareAnswerFiles(state, ctx)).map((f) => keys(f.toml)["disk-list"]);
    expect(disks).toEqual(['["sda"]', '["sda"]', '["sda"]']);
  });

  it("writes one file per node, each with its own password's hash", async () => {
    const state = persistedState();
    const files = await prepareAnswerFiles(state, ctx);
    expect(files.map((f) => f.fileName)).toEqual(["answer-pve01.toml", "answer-pve02.toml", "answer-pve03.toml"]);
    const hashes = files.map((f) => keys(f.toml)["root-password-hashed"]);
    expect(hashes.every((h) => /^"\$6\$[./0-9A-Za-z]{16}\$[./0-9A-Za-z]{86}"$/.test(h))).toBe(true);
    expect(new Set(hashes).size).toBe(3);
  });

  // the whole point of hashing and sealing
  it("never carries a password in the clear", async () => {
    const state = persistedState();
    for (const file of await prepareAnswerFiles(state, ctx)) {
      for (const password of state.access.rootPasswords) expect(file.toml).not.toContain(password);
      expect(file.toml).not.toContain("root-password =");
    }
  });

  it("hashes the password the installer will check", async () => {
    const state = persistedState();
    const [first] = await prepareAnswerFiles(state, ctx);
    const hash = JSON.parse(keys(first.toml)["root-password-hashed"]) as string;
    const salt = hash.split("$")[2];
    expect(await sha512Crypt(state.access.rootPasswords[0], salt)).toBe(hash);
  });

  it("gives every node the ssh keys", async () => {
    const files = await prepareAnswerFiles(persistedState(), ctx);
    for (const file of files) expect(keys(file.toml)["root-ssh-keys"]).toBe(`[${tomlString(ED25519_KEY)}]`);
  });
});

describe("the embedded setup", () => {
  const withSetup = async (state = persistedState({ currentStep: "backups" })) => {
    const [first] = await prepareAnswerFiles(state, ctx);
    return { state, toml: first.toml };
  };
  const reopen = async (toml: string, passphrase = "test passphrase") => {
    const read = readAnswerToml(toml);
    if ("error" in read) return read;
    const opened = await openAnswerSetup(read.envelope, passphrase);
    return "error" in opened ? opened : { state: opened.state };
  };

  it("round-trips the whole setup through an answer file", async () => {
    const { state, toml } = await withSetup();
    expect(toml).toContain(STATE_MARKER);
    expect(await reopen(toml)).toEqual({ state });
  });

  // it holds root passwords and the oidc secret — sealed, never readable
  it("seals the setup, so nothing in it reads in the clear", async () => {
    const { state, toml } = await withSetup(
      persistedState({ access: accessPlan({ oidc: { ...accessPlan().oidc, enabled: true, clientSecret: "oidc-secret-xyz" } }) }),
    );
    const line = toml.split("\n").find((l) => l.startsWith(STATE_MARKER)) ?? "";
    const decoded = atob(line.slice(STATE_MARKER.length).trim());
    expect(decoded).not.toContain("oidc-secret-xyz");
    expect(decoded).not.toContain(state.access.rootPasswords[0]);
    expect(decoded).not.toContain("pve01");
  });

  it("wants the passphrase it was sealed with", async () => {
    const { toml } = await withSetup();
    expect(await reopen(toml, "not the passphrase")).toEqual({ error: expect.stringMatching(/not the passphrase/) });
  });

  // base64: nothing in the envelope can break out of the comment
  it("keeps the setup on one comment line", async () => {
    const { toml } = await withSetup(persistedState({ hostnameSuffix: 'a"b\nc' }));
    const line = toml.split("\n").find((l) => l.startsWith(STATE_MARKER)) ?? "";
    expect(line).toMatch(/^# proxmox\.computer-state: [A-Za-z0-9+/=]+$/);
  });

  it("leaves the setup out of a bare answer file", () => {
    expect(buildAnswerToml(pve01(), ctx, bare)).not.toContain(STATE_MARKER);
  });

  // the visitor fills in the disk before installing — that edit (and
  // windows line endings) mustn't stop the file reopening
  it("still reads a file the visitor has edited", async () => {
    const { state, toml } = await withSetup();
    const edited = toml.replace(`["${DISK_PLACEHOLDER}"]`, '["nvme0n1"]').replace(/\n/g, "\r\n");
    expect(await reopen(edited)).toEqual({ state });
  });

  it("says when a file has no setup in it", () => {
    expect(readAnswerToml(buildAnswerToml(pve01(), ctx, bare))).toEqual({
      error: expect.stringMatching(/no proxmox\.computer setup in it/),
    });
  });

  it("says when the setup line is damaged or unencrypted", () => {
    expect(readAnswerToml(`${STATE_MARKER} not-base64!!`)).toEqual({ error: expect.stringMatching(/damaged/) });
    expect(readAnswerToml(`${STATE_MARKER} ${btoa("{}")}`)).toEqual({ error: expect.stringMatching(/damaged/) });
    // a plain setup, as files carried before encryption
    expect(readAnswerToml(`${STATE_MARKER} ${btoa(JSON.stringify(persistedState()))}`)).toEqual({
      error: expect.stringMatching(/older version/),
    });
  });

  // a step this build changed starts over; the ones before it are kept
  it("reopens an older setup up to the step this build changed", async () => {
    const state = persistedState({ currentStep: "software", hostnameSuffix: "lab.lan" });
    const { toml } = await withSetup({ ...state, stepVersions: { ...state.stepVersions, access: 0 } });
    const read = readAnswerToml(toml);
    if ("error" in read) throw new Error(read.error);
    const opened = await openAnswerSetup(read.envelope, "test passphrase");
    if ("error" in opened) throw new Error(opened.error);
    expect(opened.startedOverFrom).toBe("access");
    expect(opened.state).toMatchObject({ currentStep: "access", hostnameSuffix: "lab.lan", backups: state.backups });
    expect(opened.state.access.sshKeys).toBe("");
  });

  // another layout altogether is discarded, never migrated (see restoreSaved)
  it("says when the sealed setup came from another version", async () => {
    const { toml } = await withSetup({ ...persistedState(), version: 7 });
    expect(await reopen(toml)).toEqual({ error: expect.stringMatching(/different version/) });
  });
});
