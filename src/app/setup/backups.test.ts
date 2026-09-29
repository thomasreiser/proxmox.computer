import { describe, expect, it } from "vitest";
import {
  BACKUP_TARGET_OPTIONS,
  backupNicHint,
  backupSizeHint,
  maxGuestDataGb,
  backupTargetLabel,
  defaultBackupPlan,
  encryptionHint,
  maxBackupsKept,
  noBackupHint,
  offsiteHint,
  retentionHint,
  retentionReach,
  sameHardwareHint,
  usesPbs,
  validateExportPath,
  validateHostAddress,
  validateRetention,
  validateScheduleTime,
} from "./backups";
import { backupPlan, bridge, cluster, disks, network } from "./test-fixtures";
import { defaultStoragePlan } from "./derive";

// nodes whose second bridge carries backup traffic
const withBackupNic = (count: number) =>
  cluster(count, {
    network: network({
      bridgeCounts: { "nic-0": "1", "nic-1": "1" },
      bridges: {
        "nic-0#0": bridge({ name: "vmbr0" }),
        "nic-1#0": bridge({ name: "vmbr1", purposes: ["backup"], ip: "10.0.30.11/24" }),
      },
    }),
  });

describe("backup targets", () => {
  it("offers every target, a separate pbs first", () => {
    expect(BACKUP_TARGET_OPTIONS.map((o) => o.value)).toEqual(["pbs-external", "pbs-vm", "nfs", "none"]);
    expect(backupTargetLabel("pbs-external")).toMatch(/recommended/);
  });

  it("knows which targets are pbs", () => {
    expect(usesPbs("pbs-external")).toBe(true);
    expect(usesPbs("pbs-vm")).toBe(true);
    expect(usesPbs("nfs")).toBe(false);
    expect(usesPbs("none")).toBe(false);
  });

  it("defaults to a separate pbs with a sane retention", () => {
    const plan = defaultBackupPlan();
    expect(plan.target).toBe("pbs-external");
    expect(plan.verify).toBe(true);
    expect(validateScheduleTime(plan.schedule)).toBeNull();
    expect(maxBackupsKept(plan)).toBe(20);
  });
});

describe("retention", () => {
  // the upper bound: rules overlap, so the real count is often lower
  it("sums every rule for the most backups kept", () => {
    expect(maxBackupsKept(backupPlan({ keepLast: "1", keepDaily: "2", keepWeekly: "3", keepMonthly: "4" }))).toBe(10);
  });

  it("counts a blank rule as nothing", () => {
    expect(maxBackupsKept(backupPlan({ keepLast: "", keepDaily: "0", keepWeekly: "0", keepMonthly: "0" }))).toBe(0);
  });

  it("reaches back as far as its longest rule", () => {
    expect(retentionReach(backupPlan())).toBe("about 6 months");
    expect(retentionReach(backupPlan({ keepMonthly: "1" }))).toBe("about 1 month");
    expect(retentionReach(backupPlan({ keepMonthly: "0" }))).toBe("about 4 weeks");
    expect(retentionReach(backupPlan({ keepMonthly: "0", keepWeekly: "0" }))).toBe("about 7 days");
    expect(retentionReach(backupPlan({ keepMonthly: "0", keepWeekly: "0", keepDaily: "0" }))).toBe(
      "only the latest few runs",
    );
  });
});

describe("validation", () => {
  it.each(["02:00", "0:30", "23:59"])("accepts the time %s", (t) => {
    expect(validateScheduleTime(t)).toBeNull();
  });

  it.each(["24:00", "12:60", "2am", "0200", "12:5"])("rejects the time %s", (t) => {
    expect(validateScheduleTime(t)).toMatch(/24h time/);
  });

  it("requires a time", () => {
    expect(validateScheduleTime("")).toBe("required");
  });

  it.each(["10.0.10.50", "pbs", "pbs.homelab.lan", "backup-01.example.com"])("accepts the address %s", (a) => {
    expect(validateHostAddress(a)).toBeNull();
  });

  // all-numeric input is a mistyped ip, not a hostname
  it("rejects a malformed ip as an ip", () => {
    expect(validateHostAddress("10.0.10.300")).toBe("not a valid ip address");
    expect(validateHostAddress("10.0.10")).toBe("not a valid ip address");
  });

  it.each(["pbs_01", "-pbs", "pbs..lan", "pbs lan", "http://pbs"])("rejects the address %s", (a) => {
    expect(validateHostAddress(a)).toMatch(/hostname/);
  });

  it("requires an address", () => {
    expect(validateHostAddress("")).toBe("required");
  });

  it("wants an absolute export path without spaces", () => {
    expect(validateExportPath("/volume1/proxmox")).toBeNull();
    expect(validateExportPath("volume1")).toMatch(/absolute/);
    expect(validateExportPath("/my share")).toBe("no spaces");
    expect(validateExportPath("")).toBe("required");
  });

  it("takes a whole retention count from 0 to 1000", () => {
    expect(validateRetention("0")).toBeNull();
    expect(validateRetention("1000")).toBeNull();
    expect(validateRetention("1001")).not.toBeNull();
    expect(validateRetention("-1")).not.toBeNull();
    expect(validateRetention("1.5")).not.toBeNull();
    expect(validateRetention("")).not.toBeNull();
  });
});

describe("hints", () => {
  it("warns loudly about no backups, and only then", () => {
    expect(noBackupHint("none")?.tone).toBe("danger");
    expect(noBackupHint("nfs")).toBeNull();
  });

  // a pbs vm dies with the cluster it backs up
  it("warns about pbs inside the cluster, more gently with an off-site copy", () => {
    expect(sameHardwareHint("pbs-vm", false)?.text).toMatch(/takes the backups with it/);
    expect(sameHardwareHint("pbs-vm", true)?.text).toMatch(/off-site copy/);
    expect(sameHardwareHint("pbs-external", false)).toBeNull();
  });

  it("suggests an off-site copy where there isn't one", () => {
    expect(offsiteHint("pbs-external", false)?.text).toMatch(/second pbs/);
    expect(offsiteHint("nfs", false)?.text).toMatch(/nas/);
    expect(offsiteHint("pbs-external", true)).toBeNull();
    expect(offsiteHint("none", false)).toBeNull();
    // the same-hardware warning already says it
    expect(offsiteHint("pbs-vm", false)).toBeNull();
  });

  it("reminds to keep the encryption key off the cluster", () => {
    expect(encryptionHint(backupPlan({ encrypt: true }))?.text).toMatch(/key/);
    expect(encryptionHint(backupPlan({ encrypt: false }))).toBeNull();
    // nfs has no pbs encryption to turn on
    expect(encryptionHint(backupPlan({ target: "nfs", encrypt: true }))).toBeNull();
  });

  it("flags retention that keeps nothing", () => {
    const none = { keepLast: "0", keepDaily: "0", keepWeekly: "0", keepMonthly: "0" };
    expect(retentionHint(backupPlan(none))?.tone).toBe("danger");
    expect(retentionHint(backupPlan())).toBeNull();
    expect(retentionHint(backupPlan({ ...none, target: "none" }))).toBeNull();
  });

  it("notes nodes without a backup nic", () => {
    expect(backupNicHint(cluster(2), "pbs-external")?.text).toMatch(/on any node/);
    expect(backupNicHint(withBackupNic(2), "pbs-external")).toBeNull();
    const mixed = [...withBackupNic(1), ...cluster(2).slice(1)];
    mixed[1].network.hostLabel = "pve02";
    expect(backupNicHint(mixed, "nfs")?.text).toMatch(/on pve02/);
  });

  // a pbs vm's traffic, and no traffic at all, need no backup nic
  it("says nothing about the nic for a pbs vm or no backups", () => {
    expect(backupNicHint(cluster(2), "pbs-vm")).toBeNull();
    expect(backupNicHint(cluster(2), "none")).toBeNull();
  });
});

describe("maxGuestDataGb", () => {
  const storage = defaultStoragePlan();

  // 3 nodes × 1000 gb of osds, 3 replicas: one pool of 1000 gb
  it("counts ceph once, after replicas", () => {
    const nodes = cluster(3, { additionalDisks: disks({ role: "ceph", sizeGb: "1000" }) });
    expect(maxGuestDataGb(nodes, { ceph: true, zfs: false }, storage)).toBe(1000);
  });

  // replication keeps the same guests on every node — backed up once
  it("counts one node's zfs pool, the largest", () => {
    const nodes = cluster(3, { additionalDisks: disks({ role: "zfs", sizeGb: "2000" }, { role: "zfs", sizeGb: "2000" }) });
    nodes[2] = { ...nodes[2], additionalDisks: disks({ role: "zfs", sizeGb: "4000" }, { role: "zfs", sizeGb: "4000" }) };
    // mirrors: 2000 on two nodes, 4000 on the third
    expect(maxGuestDataGb(nodes, { ceph: false, zfs: true }, { ...storage, zfs: { ...storage.zfs, raidLevel: "mirror" } })).toBe(
      4000,
    );
  });

  it("counts local disks on every node, since each holds different guests", () => {
    const nodes = cluster(2, { additionalDisks: disks({ role: "local", sizeGb: "500" }) });
    expect(maxGuestDataGb(nodes, { ceph: false, zfs: false }, storage)).toBe(1000);
  });

  it("adds the pools up when several are planned", () => {
    const nodes = cluster(3, {
      additionalDisks: disks({ role: "ceph", sizeGb: "1000" }, { role: "local", sizeGb: "100" }),
    });
    expect(maxGuestDataGb(nodes, { ceph: true, zfs: false }, storage)).toBe(1000 + 300);
  });

  // read through the same effective values step 3 shows
  it("drops a pool the nodes can't build", () => {
    // one node: no cluster storage in effect, so the disk counts as local
    const nodes = cluster(1, { additionalDisks: disks({ role: "ceph", sizeGb: "1000" }) });
    expect(maxGuestDataGb(nodes, { ceph: true, zfs: false }, storage)).toBe(1000);
  });

  it("is nothing without disks beyond boot", () => {
    const nodes = cluster(3, { additionalDiskCount: "0", additionalDisks: [] });
    expect(maxGuestDataGb(nodes, { ceph: true, zfs: false }, storage)).toBe(0);
  });
});

describe("backupSizeHint", () => {
  it("sizes a pbs datastore for one full copy plus changes", () => {
    const hint = backupSizeHint(1000, backupPlan());
    expect(hint?.text).toMatch(/up to 1\.0 tb/);
    expect(hint?.text).toMatch(/only what changed/);
  });

  // nfs has no dedup: every kept backup is a full copy
  it("multiplies a full copy by the kept backups on nfs", () => {
    const hint = backupSizeHint(1000, backupPlan({ target: "nfs" }));
    expect(hint?.text).toMatch(/20 kept backups can reach 20 tb/);
  });

  it("stays quiet with no backups or no storage planned", () => {
    expect(backupSizeHint(1000, backupPlan({ target: "none" }))).toBeNull();
    expect(backupSizeHint(0, backupPlan())).toBeNull();
  });
});
