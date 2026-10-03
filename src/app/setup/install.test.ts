import { describe, expect, it } from "vitest";
import {
  ISO_FILE,
  ISO_SHA256,
  ISO_URL,
  checksumCommand,
  bootDiskLookalikes,
  diskTypeClue,
  exampleDiskName,
  lsblkSize,
  nodeInstalls,
  nodeIsoName,
  prepareIsoCommand,
  validateCommand,
  webUiUrl,
} from "./install";
import { cluster, disks, installPlan, network, node } from "./test-fixtures";

describe("the iso", () => {
  it("is proxmox ve 9.2, straight from proxmox", () => {
    expect(ISO_FILE).toBe("proxmox-ve_9.2-1.iso");
    expect(ISO_URL).toBe("https://enterprise.proxmox.com/iso/proxmox-ve_9.2-1.iso");
  });

  it("is checked against its published sha256, in the two-space format both tools read", () => {
    expect(ISO_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(checksumCommand("sha256sum")).toBe(`echo "${ISO_SHA256}  proxmox-ve_9.2-1.iso" | sha256sum -c`);
    expect(checksumCommand("shasum")).toBe(`echo "${ISO_SHA256}  proxmox-ve_9.2-1.iso" | shasum -a 256 -c`);
  });
});

describe("diskTypeClue", () => {
  it("tells nvme by its name", () => {
    expect(diskTypeClue("nvme")).toMatch(/^NAME starts with nvme/);
  });

  it("tells an ssd from an hdd by ROTA", () => {
    expect(diskTypeClue("ssd")).toContain("ROTA 0");
    expect(diskTypeClue("hdd")).toContain("ROTA 1");
  });
});

describe("exampleDiskName", () => {
  it("is an nvme name for nvme, and an sd name otherwise", () => {
    expect(exampleDiskName("nvme")).toBe("nvme0n1");
    expect(exampleDiskName("ssd")).toBe("sda");
    expect(exampleDiskName("hdd")).toBe("sda");
  });
});

// disks are sold in decimal gb; lsblk prints binary units
describe("lsblkSize", () => {
  it("converts to what lsblk prints", () => {
    expect(lsblkSize("512")).toBe("477G");
    expect(lsblkSize("1000")).toBe("931G");
    expect(lsblkSize("2000")).toBe("1.8T");
  });

  it("switches to terabytes at 1024 GiB", () => {
    // 1099 gb = 1023.5 GiB, 1100 gb = 1024.4 GiB
    expect(lsblkSize("1099")).toBe("1024G");
    expect(lsblkSize("1100")).toBe("1.0T");
  });

  it("is null while no usable size is set", () => {
    for (const value of ["", "  ", "0", "-5", "abc"]) expect(lsblkSize(value)).toBeNull();
  });
});

describe("bootDiskLookalikes", () => {
  it("is 0 when no other disk has the boot disk's type and size", () => {
    expect(bootDiskLookalikes(node({ bootDiskType: "nvme", bootDiskSizeGb: "500", additionalDisks: disks(500, { type: "nvme", sizeGb: "1000" }) }))).toBe(0);
  });

  it("counts disks of the same type and size", () => {
    const twins = node({
      bootDiskType: "ssd",
      bootDiskSizeGb: "500",
      additionalDisks: disks({ type: "ssd", sizeGb: "500" }, { type: "ssd", sizeGb: "500.0" }, { type: "hdd", sizeGb: "500" }),
    });
    expect(bootDiskLookalikes(twins)).toBe(2);
  });

  it("ignores disks with no size yet", () => {
    expect(bootDiskLookalikes(node({ bootDiskType: "ssd", bootDiskSizeGb: "", additionalDisks: disks({ type: "ssd", sizeGb: "" }) }))).toBe(0);
  });

  it("is 0 for a node with only its boot disk", () => {
    expect(bootDiskLookalikes(node({ additionalDiskCount: "0", additionalDisks: [] }))).toBe(0);
  });
});

describe("commands", () => {
  const pve02 = node({ name: "pve02", network: network({ hostLabel: "pve02" }) });

  it("names the iso after the node, like its answer file", () => {
    expect(nodeIsoName(pve02)).toBe("proxmox-ve-pve02.iso");
  });

  it("validates the node's own answer file", () => {
    expect(validateCommand(pve02)).toBe("proxmox-auto-install-assistant validate-answer answer-pve02.toml");
  });

  it("bakes the answer file into a copy of the downloaded iso", () => {
    expect(prepareIsoCommand(pve02)).toBe(
      `proxmox-auto-install-assistant prepare-iso ${ISO_FILE} --fetch-from iso --answer-file answer-pve02.toml --output proxmox-ve-pve02.iso`,
    );
  });

  it("falls back to the node's name without a host label", () => {
    const unnamed = node({ name: "pve07", network: network({ hostLabel: "" }) });
    expect(prepareIsoCommand(unnamed)).toContain("--answer-file answer-pve07.toml --output proxmox-ve-pve07.iso");
  });
});

describe("webUiUrl", () => {
  it("is the management address on port 8006, without its prefix", () => {
    expect(webUiUrl(node({ network: network({ cidr: "10.0.10.11/24" }) }))).toBe("https://10.0.10.11:8006");
  });

  it("brackets an ipv6 address", () => {
    expect(webUiUrl(node({ network: network({ cidr: "fd00::11/64" }) }))).toBe("https://[fd00::11]:8006");
  });

  it("is null while the node has no address", () => {
    expect(webUiUrl(node({ network: network({ cidr: "" }) }))).toBeNull();
  });
});

describe("nodeInstalls", () => {
  it("gives one row per node, in order, with everything the guide shows", () => {
    const rows = nodeInstalls({
      nodes: cluster(3, { bootDiskType: "nvme", bootDiskSizeGb: "512" }),
      hostnameSuffix: "lab.lan",
      identicalHardware: false,
      install: installPlan({ bootDisks: ["nvme0n1", "nvme1n1"] }),
    });
    expect(rows.map((r) => r.fqdn)).toEqual(["pve01.lab.lan", "pve02.lab.lan", "pve03.lab.lan"]);
    expect(rows[1]).toEqual({
      fqdn: "pve02.lab.lan",
      answerFile: "answer-pve02.toml",
      iso: "proxmox-ve-pve02.iso",
      bootDisk: { type: "nvme", sizeGb: "512", lsblkSize: "477G", clue: diskTypeClue("nvme"), lookalikes: 0, name: "nvme1n1" },
      validate: "proxmox-auto-install-assistant validate-answer answer-pve02.toml",
      prepareIso: `proxmox-auto-install-assistant prepare-iso ${ISO_FILE} --fetch-from iso --answer-file answer-pve02.toml --output proxmox-ve-pve02.iso`,
      webUi: "https://10.0.0.12:8006",
    });
    // pve03 has no boot disk named yet: its file keeps the placeholder
    expect(rows[2].bootDisk.name).toBeNull();
  });

  it("gives every node the shared boot disk while the hardware is identical", () => {
    const rows = nodeInstalls({
      nodes: cluster(2),
      hostnameSuffix: "",
      identicalHardware: true,
      install: installPlan({ bootDisk: "sda", bootDisks: ["nvme0n1"] }),
    });
    expect(rows.map((r) => r.bootDisk.name)).toEqual(["sda", "sda"]);
  });

  it("leaves an invalid name out of the file", () => {
    const rows = nodeInstalls({ nodes: cluster(1), hostnameSuffix: "", identicalHardware: false, install: installPlan({ bootDisks: ["/dev/sda"] }) });
    expect(rows[0].bootDisk.name).toBeNull();
  });

  it("is empty with no nodes", () => {
    expect(nodeInstalls({ nodes: [], hostnameSuffix: "", identicalHardware: false, install: installPlan() })).toEqual([]);
  });
});
