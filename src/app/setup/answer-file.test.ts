import { describe, expect, it } from "vitest";
import {
  DISK_PLACEHOLDER,
  STATE_MARKER,
  readAnswerToml,
  stateBlock,
  answerFileName,
  buildAnswerToml,
  countryFor,
  keyboardFor,
  nodeFqdn,
  tomlDataUrl,
  tomlString,
} from "./answer-file";
import { bond, network, nics, node, persistedState } from "./test-fixtures";

const ctx = {
  hostnameSuffix: "lab.lan",
  gateway: "10.0.10.1",
  dns: "10.0.10.53",
  timezone: "Europe/Vienna",
  locale: "de-AT",
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

describe("keyboardFor", () => {
  it.each([
    ["de-AT", "de"],
    ["de-CH", "de-ch"],
    ["en-GB", "en-gb"],
    ["en-US", "en-us"],
    ["fr-CA", "fr-ca"],
    ["pt_BR", "pt-br"],
    ["sv-SE", "se"],
    ["da", "dk"],
    ["ja-JP", "jp"],
    ["nb-NO", "no"],
  ])("maps %s to %s", (locale, layout) => {
    expect(keyboardFor(locale)).toBe(layout);
  });

  // only layouts the installer accepts, or it rejects the file
  it("falls back to en-us for anything the installer doesn't know", () => {
    expect(keyboardFor("zh-CN")).toBe("en-us");
    expect(keyboardFor("")).toBe("en-us");
  });
});

describe("countryFor", () => {
  it("takes the locale's region", () => {
    expect(countryFor("de-AT")).toBe("at");
    expect(countryFor("en_GB")).toBe("gb");
  });

  it("falls back to us without a usable region", () => {
    expect(countryFor("de")).toBe("us");
    expect(countryFor("es-419")).toBe("us");
  });
});

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

describe("buildAnswerToml", () => {
  it("fills in everything the wizard knows", () => {
    const k = keys(buildAnswerToml(pve01(), ctx));
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
    const toml = buildAnswerToml(pve01(), ctx);
    for (const section of ["[global]", "[network]", "[disk-setup]"]) expect(toml).toContain(section);
    expect(toml).toContain("disk-list = ");
    expect(toml).not.toMatch(/^[a-z]+_[a-z]+ = /m);
  });

  // a guessed disk would get wiped: the placeholder matches nothing
  it("never names the boot disk, but describes it", () => {
    const toml = buildAnswerToml(pve01(), ctx);
    expect(keys(toml)["disk-list"]).toBe(`["${DISK_PLACEHOLDER}"]`);
    expect(toml).toContain("the boot disk you declared: nvme, 512 gb");
  });

  // a guessed password would install fine and lock you out
  it("leaves the root password out, so the file won't validate without one", () => {
    const k = keys(buildAnswerToml(pve01(), ctx));
    expect(k).not.toHaveProperty("root-password");
    expect(k).not.toHaveProperty("root-password-hashed");
  });

  it("never pins a nic — the wizard doesn't know its mac", () => {
    expect(keys(buildAnswerToml(pve01(), ctx))).not.toHaveProperty("filter.ID_NET_NAME_MAC");
  });

  it("explains that a management bond is built later", () => {
    const n = node({
      nics: nics("10gbe", "10gbe"),
      network: network({ bonds: [bond({ nicIndices: [0, 1] })], bondCount: "1", managementInterfaceId: "bond-0" }),
    });
    expect(buildAnswerToml(n, ctx)).toMatch(/management is a bond/);
    expect(buildAnswerToml(pve01(), ctx)).not.toMatch(/management is a bond/);
  });

  it("falls back sensibly without a domain or timezone", () => {
    const k = keys(buildAnswerToml(pve01(), { ...ctx, hostnameSuffix: "", timezone: "" }));
    expect(k.fqdn).toBe('"pve01"');
    expect(k.mailto).toBe('"root@localhost"');
    expect(k.timezone).toBe('"UTC"');
  });
});

describe("tomlDataUrl", () => {
  it("round-trips the text as a toml download", () => {
    const toml = buildAnswerToml(pve01(), ctx);
    const url = tomlDataUrl(toml);
    expect(url.startsWith("data:application/toml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.slice(url.indexOf(",") + 1))).toBe(toml);
  });
});

describe("the embedded setup", () => {
  it("round-trips the whole setup through an answer file", () => {
    const state = persistedState({ currentStep: "backups" });
    const toml = buildAnswerToml(state.nodes[0], ctx, state);
    expect(toml).toContain(STATE_MARKER);
    expect(readAnswerToml(toml)).toEqual({ state });
  });

  it("carries non-ascii text intact", () => {
    const state = persistedState({ hostnameSuffix: "zürich.lan" });
    expect(readAnswerToml(stateBlock(state))).toEqual({ state });
  });

  // base64: nothing typed into the wizard can break out of the comment
  it("keeps the state on one comment line", () => {
    const state = persistedState({ hostnameSuffix: 'a"b\nc' });
    const line = stateBlock(state).split("\n").find((l) => l.startsWith(STATE_MARKER)) ?? "";
    expect(line).toMatch(/^# proxmox\.computer-state: [A-Za-z0-9+/=]+$/);
  });

  it("leaves the setup out of a bare answer file", () => {
    expect(buildAnswerToml(pve01(), ctx)).not.toContain(STATE_MARKER);
  });

  // the visitor fills in the password and disk before installing — those
  // edits (and windows line endings) mustn't stop the file reopening
  it("still reads a file the visitor has edited", () => {
    const state = persistedState();
    const edited = buildAnswerToml(state.nodes[0], ctx, state)
      .replace('# root-password-hashed = "$y$j9T$..."', 'root-password-hashed = "$y$j9T$abc"')
      .replace(`["${DISK_PLACEHOLDER}"]`, '["nvme0n1"]')
      .replace(/\n/g, "\r\n");
    expect(readAnswerToml(edited)).toEqual({ state });
  });

  it("says when a file has no setup in it", () => {
    const result = readAnswerToml(buildAnswerToml(pve01(), ctx));
    expect(result).toEqual({ error: expect.stringMatching(/no proxmox\.computer setup in it/) });
  });

  it("says when the setup line is damaged", () => {
    expect(readAnswerToml(`${STATE_MARKER} not-base64!!`)).toEqual({ error: expect.stringMatching(/damaged/) });
    expect(readAnswerToml(`${STATE_MARKER} ${btoa("{}")}`)).toEqual({ error: expect.stringMatching(/damaged/) });
  });

  // a mismatched version is discarded, never migrated (see isPersistedState)
  it("says when the file came from another version", () => {
    const old = { ...persistedState(), version: 7 };
    expect(readAnswerToml(`${STATE_MARKER} ${btoa(JSON.stringify(old))}`)).toEqual({
      error: expect.stringMatching(/different version/),
    });
  });
});
