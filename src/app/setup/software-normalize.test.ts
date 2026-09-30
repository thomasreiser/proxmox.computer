import { describe, expect, it } from "vitest";
import { newDisk, newGuest, normalizeGuest, type GuestContext } from "./software";
import { defaultStoragePlan } from "./derive";
import { bridge, cluster, disks, guestWith, network } from "./test-fixtures";

const ctx = (overrides: Partial<GuestContext> = {}): GuestContext => ({
  nodes: cluster(3, { additionalDisks: disks(1000) }),
  clusterStorage: { ceph: true, zfs: false },
  storage: defaultStoragePlan(),
  ...overrides,
});

// every edit goes through this: the guest keeps only what its node offers
describe("normalizeGuest", () => {
  it("leaves a valid guest as it is", () => {
    const g = newGuest("vm", [], ctx());
    expect(normalizeGuest(g, ctx())).toEqual(g);
  });

  it("re-picks storage the node doesn't have", () => {
    const g = guestWith(newGuest("vm", [], ctx()), { storage: "gone" });
    expect(normalizeGuest(g, ctx()).disks[0].storage).toBe("ceph-vm");
  });

  // ha needs every disk to follow the guest
  it("drops ha once a disk is on this node only", () => {
    const g = { ...newGuest("vm", [], ctx()), ha: true };
    g.disks = [...g.disks, newDisk("local-lvm")];
    expect(normalizeGuest(g, ctx()).ha).toBe(false);
    expect(normalizeGuest({ ...g, disks: [g.disks[0]] }, ctx()).ha).toBe(true);
  });

  it("re-picks a bridge the node doesn't carry", () => {
    const g = guestWith(newGuest("vm", [], ctx()), {}, { bridge: "vmbr9" });
    expect(normalizeGuest(g, ctx()).nics[0].bridge).toBe("vmbr0");
  });

  // an ha guest may wake up anywhere: only bridges every node has
  it("re-picks a bridge only one node has once the guest is ha", () => {
    const nodes = cluster(2, { additionalDisks: disks(1000) });
    nodes[0] = {
      ...nodes[0],
      network: network({
        bridgeCounts: { "nic-0": "1", "nic-1": "1" },
        bridges: { "nic-0#0": bridge({ name: "vmbr0" }), "nic-1#0": bridge({ name: "vmbr1", purposes: ["vm"] }) },
      }),
    };
    const c = ctx({ nodes });
    const g = guestWith(newGuest("vm", [], c), {}, { bridge: "vmbr1" });
    expect(normalizeGuest(g, c).nics[0].bridge).toBe("vmbr1");
    expect(normalizeGuest({ ...g, ha: true }, c).nics[0].bridge).toBe("vmbr0");
  });

  it("turns off what a disk's bus can't do", () => {
    const g = newGuest("vm", [], ctx());
    const sata = normalizeGuest(guestWith(g, { bus: "sata" }), ctx()).disks[0];
    expect(sata.iothread).toBe(false);
    expect(sata.ssd).toBe(true);
    const virtio = normalizeGuest(guestWith(g, { bus: "virtio" }), ctx()).disks[0];
    expect(virtio.ssd).toBe(false);
    expect(virtio.iothread).toBe(true);
    // scsi's io threads need the single-queue controller
    const pci = normalizeGuest({ ...g, scsiController: "virtio-scsi-pci" }, ctx()).disks[0];
    expect(pci.iothread).toBe(false);
  });

  it("drops keyctl from a privileged container", () => {
    const ct = { ...newGuest("container", [], ctx()), keyctl: true };
    expect(normalizeGuest(ct, ctx()).keyctl).toBe(true);
    expect(normalizeGuest({ ...ct, unprivileged: false }, ctx()).keyctl).toBe(false);
  });
});
