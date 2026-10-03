import { describe, expect, it } from "vitest";
import { answerBootDisk, bootDiskFor, bootDiskTypeHint, defaultInstallPlan, validateBootDiskName, withNodeBootDisk } from "./boot-disk";
import { installPlan } from "./test-fixtures";

describe("validateBootDiskName", () => {
  it("takes whole disks as lsblk names them", () => {
    for (const name of ["sda", "sdz", "sdaa", "hda", "vda", "xvda", "nvme0n1", "nvme10n2", "mmcblk0"]) {
      expect(validateBootDiskName(name)).toBeNull();
    }
  });

  it("ignores surrounding space", () => {
    expect(validateBootDiskName("  nvme0n1 ")).toBeNull();
  });

  it("treats empty as not answered yet", () => {
    expect(validateBootDiskName("")).toBeNull();
    expect(validateBootDiskName("   ")).toBeNull();
  });

  it("wants the name without /dev/", () => {
    expect(validateBootDiskName("/dev/sda")).toMatch(/without \/dev\//);
    expect(validateBootDiskName("/dev/disk/by-id/ata-x")).toMatch(/without \/dev\//);
  });

  it("refuses a partition", () => {
    for (const name of ["sda1", "vdb2", "nvme0n1p1", "mmcblk0p2"]) expect(validateBootDiskName(name)).toMatch(/partition/);
  });

  it("refuses anything lsblk wouldn't print as a disk", () => {
    for (const name of ["SDA", "disk0", "nvme0", "nvme0n", "enp3s0", "sda/", "CHANGE-ME"]) {
      expect(validateBootDiskName(name)).toMatch(/not a disk name lsblk prints/);
    }
  });
});

describe("bootDiskFor", () => {
  const plan = installPlan({ bootDisk: "sda", bootDisks: ["nvme0n1", " nvme1n1 "] });

  it("reads each node's own while the hardware differs", () => {
    expect(bootDiskFor({ identicalHardware: false, install: plan }, 0)).toBe("nvme0n1");
    expect(bootDiskFor({ identicalHardware: false, install: plan }, 1)).toBe("nvme1n1");
  });

  it("reads past the end as empty", () => {
    expect(bootDiskFor({ identicalHardware: false, install: plan }, 2)).toBe("");
  });

  it("reads the shared one for every node while the hardware is identical — keeping the per-node ones", () => {
    expect([0, 1, 5].map((i) => bootDiskFor({ identicalHardware: true, install: plan }, i))).toEqual(["sda", "sda", "sda"]);
    expect(plan.bootDisks).toEqual(["nvme0n1", " nvme1n1 "]);
  });
});

describe("answerBootDisk", () => {
  it("is the name when it's valid", () => {
    expect(answerBootDisk({ identicalHardware: false, install: installPlan({ bootDisks: ["nvme0n1"] }) }, 0)).toBe("nvme0n1");
  });

  it("is null while empty or invalid, so the file keeps its placeholder", () => {
    expect(answerBootDisk({ identicalHardware: false, install: defaultInstallPlan() }, 0)).toBeNull();
    expect(answerBootDisk({ identicalHardware: true, install: installPlan({ bootDisk: "sda1" }) }, 0)).toBeNull();
  });
});

describe("withNodeBootDisk", () => {
  it("sets one node's disk and leaves the others", () => {
    expect(withNodeBootDisk(installPlan({ bootDisks: ["sda", "sdb", "sdc"] }), 1, "nvme0n1").bootDisks).toEqual(["sda", "nvme0n1", "sdc"]);
  });

  it("pads the list up to that node", () => {
    expect(withNodeBootDisk(installPlan(), 2, "sda").bootDisks).toEqual(["", "", "sda"]);
  });

  it("leaves the shared one alone", () => {
    expect(withNodeBootDisk(installPlan({ bootDisk: "vda" }), 0, "sda").bootDisk).toBe("vda");
  });
});

describe("bootDiskTypeHint", () => {
  it("fires for a sata/sas name on a disk declared nvme", () => {
    expect(bootDiskTypeHint("sda", "nvme")).toMatch(/^step 2 says this boot disk is nvme, but sda is a sata\/sas name/);
  });

  it("fires for an nvme name on a disk declared ssd or hdd", () => {
    expect(bootDiskTypeHint("nvme0n1", "ssd")).toBe("step 2 says this boot disk is an ssd, but nvme0n1 is an nvme disk");
    expect(bootDiskTypeHint("nvme0n1", "hdd")).toBe("step 2 says this boot disk is an hdd, but nvme0n1 is an nvme disk");
  });

  it("stays quiet when the name fits", () => {
    expect(bootDiskTypeHint("nvme0n1", "nvme")).toBeNull();
    expect(bootDiskTypeHint("sda", "ssd")).toBeNull();
    expect(bootDiskTypeHint("sdb", "hdd")).toBeNull();
  });

  // virtual and sd-card disks don't say what they're backed by
  it("stays quiet for names that don't tell the type", () => {
    expect(bootDiskTypeHint("vda", "nvme")).toBeNull();
    expect(bootDiskTypeHint("mmcblk0", "ssd")).toBeNull();
  });

  it("stays quiet while the name is empty or invalid — the validator speaks then", () => {
    expect(bootDiskTypeHint("", "nvme")).toBeNull();
    expect(bootDiskTypeHint("/dev/sda", "nvme")).toBeNull();
  });
});
