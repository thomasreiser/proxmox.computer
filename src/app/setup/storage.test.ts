import { describe, expect, it } from "vitest";
import {
  cephDiskTypeHint,
  cephRawWithoutLargestNodeGb,
  cephReplicaHint,
  cephUsableGb,
  MAX_CEPH_REPLICAS,
  MIN_CEPH_REPLICAS,
  minReplicaChoices,
  replicaChoices,
  effectiveCephPlan,
  diskRoleLabel,
  diskRoleOptions,
  disksWithRole,
  formatGb,
  formatMinutes,
  hasLocalDisks,
  effectiveRaidLevel,
  minPoolMembers,
  mixedDiskSizeHint,
  raidLevelChoices,
  nodesContributing,
  nodesWithoutZfsRedundancy,
  poolMembershipHint,
  replicationWindowHint,
  soleDiskMode,
  totalGb,
  withEffectiveDiskRoles,
  effectiveDiskRole,
  validatePoolName,
  zfsLayoutHint,
  zfsRaidInfo,
  zfsUsableGb,
  ZFS_RAID_OPTIONS,
} from "./storage";
import { defaultStoragePlan } from "./derive";
import { cluster, disk, disks, node } from "./test-fixtures";

describe("diskRoleOptions", () => {
  const values = (modes: ("ceph" | "zfs")[], count = 2) => diskRoleOptions(modes, count).map((o) => o.value);

  it("offers one role per enabled mode, ceph first, then local and unused", () => {
    expect(values(["ceph"])).toEqual(["ceph", "local", "unused"]);
    expect(values(["zfs"])).toEqual(["zfs", "local", "unused"]);
    expect(values(["ceph", "zfs"])).toEqual(["ceph", "zfs", "local", "unused"]);
  });

  it("offers only local and unused without cluster storage", () => {
    expect(values([])).toEqual(["local", "unused"]);
  });

  // a node's only spare disk has to go to the one mode that's on, or the
  // node stores nothing for the storage chosen in step 2
  it.each([["ceph"], ["zfs"]] as const)("offers only %s for a sole disk when it's the one mode on", (mode) => {
    expect(values([mode], 1)).toEqual([mode]);
  });

  it("still offers local and unused for a sole disk without cluster storage", () => {
    expect(values([], 1)).toEqual(["local", "unused"]);
  });

  it("labels each role for display", () => {
    expect(diskRoleLabel("ceph")).toBe("ceph osd");
    expect(diskRoleLabel("zfs")).toBe("zfs pool member");
    expect(diskRoleLabel("unused")).toBe("leave unused");
  });
});

describe("soleDiskMode", () => {
  it("names the mode a sole disk is forced into", () => {
    expect(soleDiskMode(["ceph"], 1)).toBe("ceph");
    expect(soleDiskMode(["zfs"], 1)).toBe("zfs");
  });

  // with both on, every node has two disks or more (effectiveClusterStorage)
  // and nothing is forced
  it("forces nothing with two disks, both modes, or no mode", () => {
    expect(soleDiskMode(["ceph"], 2)).toBeNull();
    expect(soleDiskMode(["ceph", "zfs"], 1)).toBeNull();
    expect(soleDiskMode([], 1)).toBeNull();
    expect(soleDiskMode(["ceph"], 0)).toBeNull();
  });
});

describe("effectiveDiskRole / withEffectiveDiskRoles", () => {
  // a new disk is almost always added for the cluster storage picked
  it("puts an unchosen disk in the first enabled mode, ceph before zfs", () => {
    expect(effectiveDiskRole(disk({ role: "" }), ["ceph", "zfs"], 2)).toBe("ceph");
    expect(effectiveDiskRole(disk({ role: "" }), ["zfs"], 2)).toBe("zfs");
  });

  it("makes an unchosen disk local without cluster storage", () => {
    expect(effectiveDiskRole(disk({ role: "" }), [], 2)).toBe("local");
  });

  it("keeps a choice that's on offer", () => {
    expect(effectiveDiskRole(disk({ role: "zfs" }), ["ceph", "zfs"], 2)).toBe("zfs");
    expect(effectiveDiskRole(disk({ role: "unused" }), ["ceph"], 2)).toBe("unused");
  });

  // read-side only: unticking zfs doesn't forget the disk was meant for it
  it("falls back when the chosen mode is switched off, without forgetting the choice", () => {
    const chosen = disk({ role: "zfs" });
    expect(effectiveDiskRole(chosen, ["ceph"], 2)).toBe("ceph");
    expect(chosen.role).toBe("zfs");
    expect(effectiveDiskRole(chosen, ["ceph", "zfs"], 2)).toBe("zfs");
  });

  it("forces a sole disk into the one mode on, whatever was chosen", () => {
    expect(effectiveDiskRole(disk({ role: "local" }), ["ceph"], 1)).toBe("ceph");
  });

  it("resolves every disk on every node", () => {
    const nodes = cluster(2, { additionalDisks: disks({ role: "" }, { role: "local" }) });
    const out = withEffectiveDiskRoles(nodes, ["zfs"]);
    expect(out.map((n) => n.additionalDisks.map((d) => d.role))).toEqual([
      ["zfs", "local"],
      ["zfs", "local"],
    ]);
    // the stored choices are untouched
    expect(nodes[0].additionalDisks[0].role).toBe("");
  });
});

describe("disksWithRole / totalGb", () => {
  it("picks out only the disks in the named role", () => {
    const n = node({ additionalDisks: disks({ role: "ceph", sizeGb: "500" }, { role: "local", sizeGb: "250" }, { role: "unused" }) });
    expect(disksWithRole(n, "ceph")).toHaveLength(1);
    expect(disksWithRole(n, "local")).toHaveLength(1);
    expect(disksWithRole(n, "unused")).toHaveLength(1);
  });

  it("sums sizes, treating a blank size as nothing rather than NaN", () => {
    expect(totalGb(disks(500, 250))).toBe(750);
    expect(totalGb([disk({ sizeGb: "" })])).toBe(0);
  });

  it("counts how many nodes actually contribute to a mode", () => {
    const nodes = cluster(3, { additionalDisks: disks({ role: "ceph" }) });
    nodes[1].additionalDisks = disks({ role: "local" });
    expect(nodesContributing(nodes, "ceph")).toBe(2);
    expect(nodesContributing(nodes, "zfs")).toBe(0);
  });
});

describe("zfsUsableGb", () => {
  it("adds every disk on a stripe — no parity, no redundancy", () => {
    expect(zfsUsableGb(disks(500, 250, 1000), "stripe")).toBe(1750);
  });

  // the surprise worth encoding: a mirror is the size of ONE disk, however
  // many you put in it.
  it("gives a mirror the size of its smallest member, not the sum", () => {
    expect(zfsUsableGb(disks(1000, 1000), "mirror")).toBe(1000);
    expect(zfsUsableGb(disks(1000, 1000, 1000), "mirror")).toBe(1000);
  });

  it("charges raidz1 one disk of parity and raidz2 two", () => {
    expect(zfsUsableGb(disks(1000, 1000, 1000), "raidz1")).toBe(2000);
    expect(zfsUsableGb(disks(1000, 1000, 1000, 1000), "raidz2")).toBe(2000);
  });

  // zfs sizes a vdev by its smallest member, so the big disk's extra is
  // simply unavailable — this is what mixedDiskSizeHint warns about.
  it("sizes a mixed raidz by the smallest member", () => {
    expect(zfsUsableGb(disks(1000, 1000, 4000), "raidz1")).toBe(2000);
  });

  it("returns nothing for no disks, and ignores unsized ones", () => {
    expect(zfsUsableGb([], "mirror")).toBe(0);
    expect(zfsUsableGb([disk({ sizeGb: "" })], "mirror")).toBe(0);
  });

  it("never goes negative when there are fewer disks than parity", () => {
    expect(zfsUsableGb(disks(1000), "raidz2")).toBe(0);
  });
});

// capacity and layout rules read effective roles, as the wizard does —
// these resolve a fixture's unchosen disks the same way
const underCeph = (nodes: ReturnType<typeof cluster>) => withEffectiveDiskRoles(nodes, ["ceph"]);
const underZfs = (nodes: ReturnType<typeof cluster>) => withEffectiveDiskRoles(nodes, ["zfs"]);

describe("cephUsableGb", () => {
  it("divides the cluster's raw osd capacity by the replica count", () => {
    const nodes = underCeph(cluster(3, { additionalDisks: disks(1000) }));
    expect(cephUsableGb(nodes, 3)).toBe(1000);
    expect(cephUsableGb(nodes, 2)).toBe(1500);
  });

  it("counts only disks assigned to the pool", () => {
    const nodes = underCeph(cluster(3, { additionalDisks: disks(1000, { role: "local", sizeGb: "1000" }) }));
    expect(cephUsableGb(nodes, 3)).toBe(1000);
  });

  it("refuses to divide by a replica count of zero", () => {
    expect(cephUsableGb(cluster(3), 0)).toBe(0);
  });

  // with the host failure domain this is the number that actually matters
  // for staying writable through a rebuild.
  it("reports raw capacity surviving the largest node going away", () => {
    const nodes = underCeph(cluster(3, { additionalDisks: disks(1000) }));
    expect(cephRawWithoutLargestNodeGb(nodes)).toBe(2000);
  });

  it("subtracts the biggest node, not an average one", () => {
    const nodes = cluster(3, { additionalDisks: disks(1000) });
    nodes[2].additionalDisks = disks(4000);
    expect(cephRawWithoutLargestNodeGb(underCeph(nodes))).toBe(2000);
  });
});

describe("formatting", () => {
  // drive sizes are decimal gb, so tb is ×1000 — never mix in 1024
  it.each([
    [0, "—"],
    [512, "512 gb"],
    [999, "999 gb"],
    [1000, "1.0 tb"],
    [1500, "1.5 tb"],
    [3000, "3.0 tb"],
    [20000, "20 tb"],
  ])("formats %i gb as %s", (gb, expected) => {
    expect(formatGb(gb)).toBe(expected);
  });

  it.each([
    [1, "1 minute"],
    [15, "15 minutes"],
    [60, "1 hour"],
    [120, "2 hours"],
    [90, "1.5 hours"],
  ])("formats %i minutes as %s", (minutes, expected) => {
    expect(formatMinutes(minutes)).toBe(expected);
  });
});

describe("poolMembershipHint", () => {
  // the rule reads effective roles, as the wizard does — resolve them the
  // same way here
  const as = (mode: "ceph" | "zfs", nodes: ReturnType<typeof cluster>) => withEffectiveDiskRoles(nodes, [mode]);

  it("is quiet once every node contributes", () => {
    expect(poolMembershipHint(as("ceph", cluster(3)), "ceph")).toBeNull();
  });

  it("is danger-toned when nothing anywhere is assigned", () => {
    const nodes = cluster(3, { additionalDisks: disks({ role: "unused" }, { role: "unused" }) });
    expect(poolMembershipHint(as("ceph", nodes), "ceph")).toMatchObject({ tone: "danger" });
  });

  // a node with no osd can't take over a guest's disk, which defeats the
  // point of running ceph at all.
  it("flags a partial cluster and says how many nodes are missing", () => {
    const nodes = cluster(3, { additionalDisks: disks(1000, 1000) });
    nodes[2].additionalDisks = disks({ role: "local" }, { role: "local" });
    const hint = poolMembershipHint(as("ceph", nodes), "ceph");
    expect(hint?.tone).toBe("danger");
    expect(hint?.text).toMatch(/1 of 3 nodes/);
  });

  it("explains a partial zfs cluster in replication terms, not osd terms", () => {
    const nodes = cluster(3, { additionalDisks: disks(1000, 1000) });
    nodes[2].additionalDisks = disks({ role: "local" }, { role: "local" });
    expect(poolMembershipHint(as("zfs", nodes), "zfs")?.text).toMatch(/replication has nowhere to land/);
  });

  // with both on, each mode is checked on its own: ceph getting every
  // disk leaves zfs with none
  it("checks each mode separately when both are on", () => {
    const nodes = withEffectiveDiskRoles(cluster(2, { additionalDisks: disks({ role: "ceph" }, { role: "ceph" }) }), ["ceph", "zfs"]);
    expect(poolMembershipHint(nodes, "ceph")).toBeNull();
    expect(poolMembershipHint(nodes, "zfs")).toMatchObject({ tone: "danger" });
  });
});

describe("replicaChoices / minReplicaChoices", () => {
  // the host failure domain puts at most one copy on each node, so more
  // replicas than nodes can never be placed — and is never offered.
  it("offers from 2 up to the node count", () => {
    expect(replicaChoices(2)).toEqual([2]);
    expect(replicaChoices(3)).toEqual([2, 3]);
    expect(replicaChoices(5)).toEqual([2, 3, 4, 5]);
  });

  // a single copy has no redundancy at all — never offered.
  it("never offers a single replica", () => {
    for (const n of [1, 2, 3, 16]) expect(replicaChoices(n)).not.toContain(1);
  });

  it("caps at ceph's own maximum on a very large cluster", () => {
    expect(replicaChoices(16)).toEqual(Array.from({ length: MAX_CEPH_REPLICAS - 1 }, (_, i) => i + 2));
  });

  it("still offers the floor below 2 nodes, where ceph isn't available anyway", () => {
    expect(replicaChoices(0)).toEqual([MIN_CEPH_REPLICAS]);
    expect(replicaChoices(1)).toEqual([MIN_CEPH_REPLICAS]);
  });

  // min_size 1 accepts writes that exist in one place only.
  it("offers min_size from 2 up to size", () => {
    expect(minReplicaChoices(3)).toEqual([2, 3]);
    expect(minReplicaChoices(2)).toEqual([2]);
  });
});

describe("effectiveCephPlan", () => {
  const plan = (replicas: string, minReplicas: string) => ({ poolName: "ceph-vm", replicas, minReplicas });

  it("returns the same object when already valid", () => {
    const p = plan("3", "2");
    expect(effectiveCephPlan(p, 3)).toBe(p);
  });

  // the case that matters in practice: dropping from 3 nodes to 2 leaves a
  // saved size of 3 unplaceable.
  it("pulls size down to the node count", () => {
    expect(effectiveCephPlan(plan("3", "2"), 2)).toMatchObject({ replicas: "2", minReplicas: "2" });
  });

  it("pulls min_size down with it rather than leaving it above size", () => {
    expect(effectiveCephPlan(plan("3", "3"), 2)).toMatchObject({ replicas: "2", minReplicas: "2" });
  });

  it("caps min_size at size even when size itself was fine", () => {
    expect(effectiveCephPlan(plan("2", "3"), 3)).toMatchObject({ replicas: "2", minReplicas: "2" });
  });

  // a save from before the floor existed can hold 1 for either value.
  it("lifts a saved 1 to the floor of 2", () => {
    expect(effectiveCephPlan(plan("1", "1"), 3)).toMatchObject({ replicas: "2", minReplicas: "2" });
    expect(effectiveCephPlan(plan("3", "1"), 3)).toMatchObject({ replicas: "3", minReplicas: "2" });
  });

  it.each(["", "abc", "2.5"])("falls back to ceph's default size for %j", (raw) => {
    expect(effectiveCephPlan(plan(raw, "2"), 3)).toMatchObject({ replicas: "3", minReplicas: "2" });
  });

  it("falls back to a min_size of 2 when the saved one is garbage", () => {
    expect(effectiveCephPlan(plan("3", "x"), 3)).toMatchObject({ replicas: "3", minReplicas: "2" });
  });

  it("never falls back above what the cluster allows", () => {
    expect(effectiveCephPlan(plan("", ""), 2)).toMatchObject({ replicas: "2", minReplicas: "2" });
  });

  // the regression this design exists for: the wizard starts at one node,
  // and a clamp written back at that point would pin ceph at the floor.
  it("leaves the stored choice alone, so it re-applies once nodes are added", () => {
    const chosen = plan("3", "2");
    expect(effectiveCephPlan(chosen, 1)).toMatchObject({ replicas: "2", minReplicas: "2" });
    expect(chosen).toMatchObject({ replicas: "3", minReplicas: "2" });
    expect(effectiveCephPlan(chosen, 3)).toBe(chosen);
  });

  it("keeps the pool name and anything else it doesn't own", () => {
    expect(effectiveCephPlan(plan("5", "2"), 3).poolName).toBe("ceph-vm");
  });
});

describe("cephReplicaHint", () => {
  it("is quiet at the sane default", () => {
    expect(cephReplicaHint(3, 3)).toBeNull();
  });

  it("warns about 2 replicas on a cluster big enough for 3", () => {
    expect(cephReplicaHint(3, 2)?.tone).toBe("warning");
  });

  it("does not push for 3 replicas on a 2-node cluster that can't have them", () => {
    expect(cephReplicaHint(2, 2)).toBeNull();
  });
});

describe("zfsLayoutHint", () => {
  it("says nothing before any disk is assigned", () => {
    expect(zfsLayoutHint(0, "mirror")).toBeNull();
  });

  // too few disks for a layout can't happen any more — it isn't offered
  it("never escalates past the stripe warning", () => {
    for (const level of ["mirror", "raidz1", "raidz2"] as const) {
      expect(zfsLayoutHint(1, level)).toBeNull();
      expect(zfsLayoutHint(4, level)).toBeNull();
    }
  });

  it("warns that a stripe has no redundancy at all", () => {
    const hint = zfsLayoutHint(2, "stripe");
    expect(hint?.tone).toBe("warning");
    expect(hint?.text).toMatch(/no redundancy/);
  });

  it("knows the member floor for every offered layout", () => {
    for (const option of ZFS_RAID_OPTIONS) {
      expect(zfsRaidInfo(option.value).minDisks).toBe(option.minDisks);
    }
  });
});

describe("zfs layout choices", () => {
  it.each([
    [0, []],
    [1, ["stripe"]],
    [2, ["mirror", "stripe"]],
    [3, ["mirror", "raidz1", "stripe"]],
    [4, ["mirror", "raidz1", "raidz2", "stripe"]],
    [8, ["mirror", "raidz1", "raidz2", "stripe"]],
  ] as const)("offers only what %i pool disks can build", (count, expected) => {
    expect(raidLevelChoices(count)).toEqual(expected);
  });

  // one layout for the cluster, but every node builds its own pool — so
  // the thinnest contributing node decides
  it("takes the fewest pool disks on any contributing node", () => {
    const nodes = cluster(3, { additionalDisks: disks(1000, 1000, 1000) });
    nodes[1].additionalDisks = disks(1000, 1000);
    expect(minPoolMembers(underZfs(nodes))).toBe(2);
  });

  it("ignores a node with no pool disk, which is flagged separately", () => {
    const nodes = cluster(2, { additionalDisks: disks(1000, 1000) });
    nodes[1].additionalDisks = disks({ role: "local" }, { role: "local" });
    expect(minPoolMembers(underZfs(nodes))).toBe(2);
  });

  it("counts only disks in the pool", () => {
    expect(minPoolMembers(underZfs(cluster(1, { additionalDisks: disks(1000, 1000, { role: "local" }) })))).toBe(2);
  });

  it("is 0 when nothing anywhere is in the pool", () => {
    expect(minPoolMembers(underZfs(cluster(2, { additionalDisks: disks({ role: "unused" }, { role: "unused" }) })))).toBe(0);
  });

  it("keeps a choice every node can build", () => {
    expect(effectiveRaidLevel("raidz1", 3)).toBe("raidz1");
    expect(effectiveRaidLevel("stripe", 4)).toBe("stripe");
  });

  it("falls back to a mirror when the choice needs more disks", () => {
    expect(effectiveRaidLevel("raidz2", 3)).toBe("mirror");
  });

  it("falls back to a stripe when even a mirror won't fit", () => {
    expect(effectiveRaidLevel("mirror", 1)).toBe("stripe");
  });

  it("has nothing in effect with no pool disks", () => {
    expect(effectiveRaidLevel("mirror", 0)).toBeNull();
  });

  // read-side only: the choice survives, so it comes back with the disks
  it("brings the chosen layout back once there are disks for it", () => {
    expect(effectiveRaidLevel("raidz2", 2)).toBe("mirror");
    expect(effectiveRaidLevel("raidz2", 4)).toBe("raidz2");
  });
});

describe("mixedDiskSizeHint", () => {
  it("is quiet when every disk matches", () => {
    expect(mixedDiskSizeHint(disks(1000, 1000), "mirror")).toBeNull();
  });

  it("is quiet on a stripe, where the odd sizes are all usable", () => {
    expect(mixedDiskSizeHint(disks(1000, 4000), "stripe")).toBeNull();
  });

  it("quantifies what the mismatch costs", () => {
    const hint = mixedDiskSizeHint(disks(1000, 1000, 4000), "raidz1");
    expect(hint?.tone).toBe("warning");
    // 3000 gb of the 4tb disk is unreachable
    expect(hint?.text).toMatch(/3\.0 tb/);
  });

  it("needs at least two sized disks to have anything to compare", () => {
    expect(mixedDiskSizeHint(disks(1000), "mirror")).toBeNull();
    expect(mixedDiskSizeHint([disk({ sizeGb: "" }), disk({ sizeGb: "1000" })], "mirror")).toBeNull();
  });
});

describe("cephDiskTypeHint", () => {
  it("is quiet on ssd and nvme osds", () => {
    expect(cephDiskTypeHint(cluster(3, { additionalDisks: disks({ type: "nvme" }) }))).toBeNull();
  });

  it("warns as soon as any osd is a spinning disk", () => {
    const nodes = cluster(3, { additionalDisks: disks({ type: "ssd" }) });
    nodes[1].additionalDisks = disks({ type: "hdd" });
    expect(cephDiskTypeHint(underCeph(nodes))?.tone).toBe("warning");
  });

  // a slow disk that isn't an osd isn't ceph's problem.
  it("ignores an hdd that isn't in the pool", () => {
    expect(cephDiskTypeHint(cluster(3, { additionalDisks: disks({ type: "hdd", role: "local" }) }))).toBeNull();
  });
});

describe("nodesWithoutZfsRedundancy", () => {
  // one spare disk can only ever be a single-disk stripe
  it("returns every node with a single spare disk", () => {
    expect(nodesWithoutZfsRedundancy(cluster(3, { additionalDisks: disks(1000) }))).toHaveLength(3);
  });

  it("returns none once every node has two", () => {
    expect(nodesWithoutZfsRedundancy(cluster(3, { additionalDisks: disks(1000, 1000) }))).toHaveLength(0);
  });

  it("names only the nodes that are short", () => {
    const nodes = cluster(3, { additionalDisks: disks(1000, 1000) });
    nodes[1].additionalDisks = disks(1000);
    expect(nodesWithoutZfsRedundancy(nodes).map((n) => n.name)).toEqual(["pve02"]);
  });

  // a node with no spare disk can't build a redundant pool either
  it("counts a node with no spare disk at all", () => {
    expect(nodesWithoutZfsRedundancy(cluster(1, { additionalDisks: [] }))).toHaveLength(1);
  });
});

describe("hasLocalDisks", () => {
  it("is false when no disk anywhere is local", () => {
    expect(hasLocalDisks(cluster(3))).toBe(false);
  });

  it("is true as soon as one node has a local disk", () => {
    const nodes = cluster(3, { additionalDisks: disks(1000, 1000) });
    nodes[2].additionalDisks[1] = { ...nodes[2].additionalDisks[1], role: "local" };
    expect(hasLocalDisks(nodes)).toBe(true);
  });
});

describe("replicationWindowHint", () => {
  it("says nothing at a middling interval", () => {
    expect(replicationWindowHint(15)).toBeNull();
  });

  it("notes that very frequent runs can overlap", () => {
    expect(replicationWindowHint(5)).toMatchObject({ tone: "info" });
  });

  // the window IS the data loss, so a long one deserves to be named.
  it("warns about a long window and quotes it back", () => {
    const hint = replicationWindowHint(120);
    expect(hint?.tone).toBe("warning");
    expect(hint?.text).toMatch(/2 hours/);
  });

  it("ignores a blank or nonsensical interval", () => {
    expect(replicationWindowHint(0)).toBeNull();
    expect(replicationWindowHint(NaN)).toBeNull();
  });
});

describe("validatePoolName", () => {
  it("requires a value", () => {
    expect(validatePoolName("")).toBe("can't be empty");
  });

  it.each(["tank", "ceph-vm", "local_zfs", "pool1"])("accepts %s", (name) => {
    expect(validatePoolName(name)).toBeNull();
  });

  // zfs reserves names that could be read as a pool id, so a leading
  // digit is out.
  it.each(["1tank", "Tank", "my pool", "pool/one", "-tank"])("rejects %s", (name) => {
    expect(validatePoolName(name)).toMatch(/start with a lowercase letter/);
  });

  it("caps the length", () => {
    expect(validatePoolName("a".repeat(32))).toBeNull();
    expect(validatePoolName("a".repeat(33))).toBe("32 characters max");
  });

  // better to say so here than to have `zpool create` fail on a name this
  // wizard handed over.
  it.each(["mirror", "raidz1", "raidz2", "spare", "cache", "log"])("rejects the zfs keyword %s", (name) => {
    expect(validatePoolName(name)).toMatch(/reserved by zfs/);
  });
});

describe("defaultStoragePlan", () => {
  it("starts from ceph's own defaults", () => {
    const plan = defaultStoragePlan();
    expect(plan.ceph.replicas).toBe("3");
    expect(plan.ceph.minReplicas).toBe("2");
  });

  it("produces names that pass its own validation", () => {
    const plan = defaultStoragePlan();
    for (const name of [plan.ceph.poolName, plan.zfs.poolName, plan.local.name]) {
      expect(validatePoolName(name)).toBeNull();
    }
  });

  it("defaults to a layout that raises no complaint at two disks", () => {
    const plan = defaultStoragePlan();
    expect(zfsLayoutHint(2, plan.zfs.raidLevel)).toBeNull();
  });
});
