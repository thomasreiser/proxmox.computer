import { describe, expect, it } from "vitest";
import {
  bridgeOptions,
  bridgeSubnet,
  effectiveGuestNode,
  effectiveDiskStorage,
  nicSubnetHint,
  haAvailable,
  haQuorumHint,
  imagesFor,
  cephVolumeGb,
  effectiveCephVolumes,
  isKubernetesNode,
  normalizeGuest,
  validateVolumeGb,
  memoryHint,
  newGuest,
  nextGuestName,
  nextVmid,
  nodeLoads,
  storageHint,
  storageOptions,
  storageUse,
  validateDiskGb,
  validateGuestName,
  validateMemoryGb,
  validateVmid,
  type GuestContext,
} from "./software";
import { defaultStoragePlan } from "./derive";
import { bridge, cluster, disks, network, guestWith } from "./test-fixtures";

// three nodes, one 1000 gb disk each — ceph by default
const ctx = (overrides: Partial<GuestContext> = {}): GuestContext => ({
  nodes: cluster(3, { ramGb: "64", cpuCount: "1", coresPerCpu: "8", additionalDisks: disks(1000) }),
  clusterStorage: { ceph: true, zfs: false },
  storage: defaultStoragePlan(),
  ...overrides,
});
const ids = (options: { id: string }[]) => options.map((o) => o.id);

describe("storage options", () => {
  it("offers the pools step 4 builds, plus local-lvm on the boot disk", () => {
    expect(ids(storageOptions(ctx(), 0))).toEqual(["ceph-vm", "local-lvm"]);
  });

  it("offers the zfs pool only on a node that has one", () => {
    const nodes = cluster(2, { additionalDisks: disks(1000, 1000) });
    nodes[1] = { ...nodes[1], additionalDisks: [], additionalDiskCount: "0" };
    const c = ctx({ nodes, clusterStorage: { ceph: false, zfs: true } });
    // zfs needs a spare disk on every node, so with node 2 bare it's off
    // everywhere — and node 1's disks fall back to local storage
    expect(ids(storageOptions(c, 0))).toEqual(["local-zfs", "local-lvm"]);
    const both = ctx({ nodes: cluster(2, { additionalDisks: disks(1000, 1000) }), clusterStorage: { ceph: false, zfs: true } });
    expect(ids(storageOptions(both, 1))).toEqual(["tank", "local-lvm"]);
  });

  it("offers local storage on the node whose disks it's on", () => {
    const nodes = cluster(2, { additionalDisks: disks({ role: "local" }) });
    const c = ctx({ nodes, clusterStorage: { ceph: false, zfs: false } });
    expect(ids(storageOptions(c, 0))).toEqual(["local-zfs", "local-lvm"]);
  });

  // read-side: a choice the node doesn't offer resolves to its first option
  it("resolves a storage the node doesn't have to its first option", () => {
    const guest = guestWith(newGuest("vm", [], ctx()), { storage: "gone" });
    expect(effectiveDiskStorage(guest.disks[0], guest, ctx()).id).toBe("ceph-vm");
  });

  it("clamps a guest's node to the nodes that exist", () => {
    expect(effectiveGuestNode(newGuest("vm", [], ctx(), { node: "5" }), 3)).toBe(0);
    expect(effectiveGuestNode(newGuest("vm", [], ctx(), { node: "2" }), 3)).toBe(2);
  });
});

describe("high availability", () => {
  it("needs storage every node reaches, and another node", () => {
    expect(haAvailable(newGuest("vm", [], ctx()), ctx())).toBe(true);
    expect(haAvailable(guestWith(newGuest("vm", [], ctx()), { storage: "local-lvm" }), ctx())).toBe(false);
    const single = ctx({ nodes: cluster(1, { additionalDisks: disks(1000) }) });
    expect(haAvailable(newGuest("vm", [], single), single)).toBe(false);
  });

  it("warns about ha on two nodes", () => {
    const g = newGuest("vm", [], ctx(), { ha: true });
    expect(haQuorumHint([g], 2)?.text).toMatch(/qdevice/);
    expect(haQuorumHint([g], 3)).toBeNull();
    expect(haQuorumHint([{ ...g, ha: false }], 2)).toBeNull();
  });
});

describe("bridge options", () => {
  // nic-1 carries vm traffic on node 1 only
  const withVmBridge = () => {
    const nodes = cluster(2);
    nodes[0] = {
      ...nodes[0],
      network: network({
        bridgeCounts: { "nic-0": "1", "nic-1": "1" },
        bridges: { "nic-0#0": bridge({ name: "vmbr0" }), "nic-1#0": bridge({ name: "vmbr1", purposes: ["vm"] }) },
      }),
    };
    return ctx({ nodes });
  };

  it("offers the node's bridges that carry vm traffic", () => {
    expect(bridgeOptions(withVmBridge(), 0, false)).toEqual(["vmbr0", "vmbr1"]);
    expect(bridgeOptions(withVmBridge(), 1, false)).toEqual(["vmbr0"]);
  });

  // it can wake up on any node
  it("offers an ha guest only the bridges every node has", () => {
    expect(bridgeOptions(withVmBridge(), 0, true)).toEqual(["vmbr0"]);
  });

  it("leaves out bridges without vm traffic and storage links", () => {
    const nodes = cluster(1);
    nodes[0] = {
      ...nodes[0],
      network: network({
        bridgeCounts: { "nic-0": "1", "nic-1": "1", "nic-2": "1" },
        bridges: {
          "nic-0#0": bridge({ name: "vmbr0" }),
          "nic-1#0": bridge({ name: "vmbr1", purposes: ["backup"] }),
          "nic-2#0": bridge({ name: "vmbr2", purposes: ["ceph"] }),
        },
      }),
    };
    expect(bridgeOptions(ctx({ nodes }), 0, false)).toEqual(["vmbr0"]);
  });

  it("knows the network a bridge carries", () => {
    const node = cluster(1)[0];
    expect(bridgeSubnet(node, "vmbr0")).toBe("10.0.0.0/24");
    expect(bridgeSubnet(node, "vmbr9")).toBeNull();
  });
});

describe("new guests", () => {
  it("numbers vmids from 100, filling gaps", () => {
    expect(nextVmid([])).toBe("100");
    const a = newGuest("vm", [], ctx(), { vmid: "100" });
    const b = newGuest("vm", [a], ctx(), { vmid: "102" });
    expect(nextVmid([a, b])).toBe("101");
  });

  it("names guests by kind, without repeats", () => {
    const a = newGuest("vm", [], ctx());
    expect(a.name).toBe("vm-01");
    expect(nextGuestName("vm", [a])).toBe("vm-02");
    expect(newGuest("container", [a], ctx()).name).toBe("ct-01");
  });

  it("starts a guest on valid choices for its kind", () => {
    const vm = newGuest("vm", [], ctx());
    expect(vm).toMatchObject({ kind: "vm", startOnBoot: true, ha: false, cpuType: "", machine: "q35", qemuAgent: true });
    expect(vm.disks).toHaveLength(1);
    expect(vm.disks[0]).toMatchObject({ storage: "ceph-vm", bus: "scsi", discard: true, iothread: true });
    expect(vm.nics).toHaveLength(1);
    expect(vm.nics[0]).toMatchObject({ bridge: "vmbr0", model: "virtio", firewall: true, ipMode: "dhcp" });
    expect(imagesFor("vm").map((i) => i.id)).toContain(vm.image);
    const ct = newGuest("container", [], ctx());
    expect(imagesFor("container").map((i) => i.id)).toContain(ct.image);
    expect(Number(ct.memoryGb)).toBeLessThan(Number(vm.memoryGb));
  });

  it("gives every guest its own form identity", () => {
    expect(newGuest("vm", [], ctx()).id).not.toBe(newGuest("vm", [], ctx()).id);
  });

  // uefi with a tpm for every vm: what current guests expect
  it("starts a vm on uefi with a tpm", () => {
    expect(newGuest("vm", [], ctx())).toMatchObject({ bios: "ovmf", tpm: true, k8sRole: "" });
  });
});

describe("kubernetes nodes", () => {
  const k8sNode = (c = ctx()) => newGuest("vm", [], c, { k8sRole: "worker" });

  // kubernetes reschedules pods itself
  it("never offers them high availability, even on shared storage", () => {
    expect(haAvailable(k8sNode(), ctx())).toBe(false);
    expect(normalizeGuest({ ...k8sNode(), ha: true }, ctx()).ha).toBe(false);
    expect(isKubernetesNode(k8sNode())).toBe(true);
    expect(isKubernetesNode(newGuest("vm", [], ctx()))).toBe(false);
  });

  it("puts persistent volumes on ceph while there's ceph and a kubernetes vm", () => {
    const c = ctx({ kubernetes: { cephVolumes: true, volumeGb: "300" } });
    expect(effectiveCephVolumes([k8sNode(c)], c)).toBe(true);
    expect(cephVolumeGb([k8sNode(c)], c)).toBe(300);
    // no kubernetes vm, nothing to hold volumes for
    expect(cephVolumeGb([newGuest("vm", [], c)], c)).toBe(0);
    // chosen off
    const off = ctx({ kubernetes: { cephVolumes: false, volumeGb: "300" } });
    expect(cephVolumeGb([k8sNode(off)], off)).toBe(0);
    // no ceph in step 4: the choice stays, the volumes go nowhere
    const noCeph = ctx({ clusterStorage: { ceph: false, zfs: false }, kubernetes: { cephVolumes: true, volumeGb: "300" } });
    expect(effectiveCephVolumes([k8sNode(noCeph)], noCeph)).toBe(false);
    // no plan in the context at all
    expect(cephVolumeGb([k8sNode()], ctx())).toBe(0);
  });

  it("counts the volumes against the ceph pool", () => {
    const c = ctx({ kubernetes: { cephVolumes: true, volumeGb: "900" } });
    const guest = guestWith(newGuest("vm", [], c, { k8sRole: "worker" }), { sizeGb: "200" });
    const [ceph] = storageUse([guest], c);
    expect(ceph).toEqual({ storage: "ceph-vm + k8s-volumes", usedGb: 1100, capacityGb: 1000 });
    expect(storageHint(ceph)?.tone).toBe("warning");
  });

  it("checks the space for volumes", () => {
    expect(validateVolumeGb("")).toBe("required");
    expect(validateVolumeGb("0")).not.toBeNull();
    expect(validateVolumeGb("1")).toBeNull();
    expect(validateVolumeGb("1000000")).toBeNull();
    expect(validateVolumeGb("1000001")).not.toBeNull();
  });
});

describe("validation", () => {
  it("checks names, vmids and sizes", () => {
    expect(validateGuestName("")).toBe("required");
    expect(validateGuestName("Web")).toMatch(/lowercase/);
    expect(validateGuestName("web-01")).toBeNull();
    expect(validateVmid("99")).toMatch(/between 100/);
    expect(validateVmid("100")).toBeNull();
    expect(validateDiskGb("0")).not.toBeNull();
    expect(validateDiskGb("32")).toBeNull();
  });

  it("takes memory in quarters of a gib", () => {
    expect(validateMemoryGb("0.5")).toBeNull();
    expect(validateMemoryGb("4")).toBeNull();
    expect(validateMemoryGb("0.3")).toMatch(/steps of 0.25/);
    expect(validateMemoryGb("0.1")).toMatch(/between/);
    expect(validateMemoryGb("lots")).toMatch(/a number/);
    expect(validateMemoryGb("")).toBe("required");
  });
});

describe("capacity", () => {
  it("adds up each node's guests", () => {
    const c = ctx();
    const guests = [
      newGuest("vm", [], c, { memoryGb: "8", cores: "4", node: "0" }),
      newGuest("container", [], c, { memoryGb: "0.5", cores: "1", node: "0" }),
      newGuest("vm", [], c, { memoryGb: "16", cores: "2", node: "1" }),
    ];
    const [first, second, third] = nodeLoads(guests, c.nodes);
    expect(first).toMatchObject({ memoryGb: 8.5, cores: 5, ramGb: 64, threads: 8 });
    expect(first.guests).toHaveLength(2);
    expect(second.memoryGb).toBe(16);
    expect(third.guests).toHaveLength(0);
  });

  it("flags memory past the node's ram, and close to it", () => {
    const load = { nodeIndex: 0, ramGb: 64, cores: 0, threads: 8, guests: [] };
    expect(memoryHint({ ...load, memoryGb: 80 }, "pve01")?.tone).toBe("danger");
    expect(memoryHint({ ...load, memoryGb: 56 }, "pve01")?.tone).toBe("warning");
    expect(memoryHint({ ...load, memoryGb: 32 }, "pve01")).toBeNull();
    // unknown ram can't be judged
    expect(memoryHint({ ...load, ramGb: 0, memoryGb: 80 }, "pve01")).toBeNull();
  });

  // 3 × 1000 gb of osds at 3 replicas: a 1000 gb pool
  it("holds the ceph pool's disks against its usable size", () => {
    const c = ctx();
    const guests = [guestWith(newGuest("vm", [], c), { sizeGb: "600" }), guestWith(newGuest("vm", [], c, { vmid: "101" }), { sizeGb: "600" })];
    const [ceph] = storageUse(guests, c);
    expect(ceph).toEqual({ storage: "ceph-vm", usedGb: 1200, capacityGb: 1000 });
    expect(storageHint(ceph)?.text).toMatch(/1\.2 tb, more than its 1\.0 tb/);
    expect(storageHint({ ...ceph, usedGb: 500 })).toBeNull();
  });

  // estimated from the installer's default carving of the boot disk
  it("judges local-lvm against what the installer leaves for it", () => {
    const c = ctx({ nodes: cluster(3, { ramGb: "64", bootDiskSizeGb: "512", additionalDisks: disks(1000) }) });
    const uses = storageUse([guestWith(newGuest("vm", [], c), { storage: "local-lvm", sizeGb: "500" })], c);
    const lvm = uses.find((u) => u.storage.startsWith("local-lvm"))!;
    expect(lvm.capacityGb).toBe(392);
    expect(storageHint(lvm)?.text).toMatch(/local-lvm on pve01/);
  });
});

describe("nicSubnetHint", () => {
  const staticGuest = (ip: string, vlanTag = "") => guestWith(newGuest("vm", [], ctx()), {}, { ipMode: "static", ip, vlanTag });
  const hint = (g: ReturnType<typeof newGuest>) => nicSubnetHint(g.nics[0], g, ctx());

  it("flags a static ip outside the bridge's network", () => {
    expect(hint(staticGuest("10.0.50.5/24"))?.text).toMatch(/isn't in vmbr0's network 10\.0\.0\.0\/24/);
  });

  it("stays quiet inside it, with a vlan, or on dhcp", () => {
    expect(hint(staticGuest("10.0.0.50/24"))).toBeNull();
    expect(hint(staticGuest("10.0.50.5/24", "50"))).toBeNull();
    expect(hint(newGuest("vm", [], ctx()))).toBeNull();
  });
});
