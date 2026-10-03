import { describe, expect, it } from "vitest";
import {
  CEPH_MON_MEMORY_GB,
  CEPH_OSD_MEMORY_GB,
  HOST_MEMORY_GB,
  bootDiskMeter,
  cephMeter,
  localMeter,
  memoryMeter,
  zfsArcGb,
  zfsMeter,
} from "./capacity";
import { bootDiskLayout } from "./storage";
import { newGuest, type GuestContext } from "./software";
import { defaultStoragePlan } from "./derive";
import { cluster, disks, guestWith } from "./test-fixtures";

const ctx = (overrides: Partial<GuestContext> = {}): GuestContext => ({
  nodes: cluster(4, { ramGb: "64", bootDiskSizeGb: "512", additionalDisks: disks(1000, 1000) }),
  clusterStorage: { ceph: true, zfs: false },
  storage: defaultStoragePlan(),
  ...overrides,
});
const seg = (m: { segments: { key: string; gb: number }[] }, key: string) => m.segments.find((s) => s.key === key)?.gb ?? 0;

describe("zfs cache", () => {
  it("takes 10% of ram, at most 16 gib", () => {
    expect(zfsArcGb(64)).toBeCloseTo(6.4);
    expect(zfsArcGb(256)).toBe(16);
  });
});

describe("memoryMeter", () => {
  // two 1000 gb disks per node, both osds under ceph
  // memory has no redundancy: room is simply what's free
  it("has room equal to what's free", () => {
    const m = memoryMeter(0, [], ctx());
    expect(m.room).toEqual({ totalGb: 64, freeGb: m.freeGb, overGb: 0 });
  });

  it("counts proxmox, ceph's osds and monitor, then the guests", () => {
    const c = ctx();
    const guests = [newGuest("vm", [], c, { memoryGb: "8", node: "0" })];
    const m = memoryMeter(0, guests, c);
    expect(m.totalGb).toBe(64);
    expect(seg(m, "host")).toBe(HOST_MEMORY_GB);
    expect(seg(m, "ceph")).toBe(2 * CEPH_OSD_MEMORY_GB + CEPH_MON_MEMORY_GB);
    expect(seg(m, "zfs")).toBe(0);
    expect(seg(m, "guests")).toBe(8);
    expect(m.freeGb).toBe(64 - 2 - 9 - 8);
    expect(m.overGb).toBe(0);
  });

  // three monitors is proxmox's advice — the fourth node runs none
  it("puts a monitor on the first three nodes only", () => {
    expect(seg(memoryMeter(3, [], ctx()), "ceph")).toBe(2 * CEPH_OSD_MEMORY_GB);
  });

  it("counts the zfs cache on a node with a zfs pool", () => {
    const c = ctx({ clusterStorage: { ceph: false, zfs: true } });
    expect(seg(memoryMeter(0, [], c), "zfs")).toBeCloseTo(6.4);
    expect(seg(memoryMeter(0, [], c), "ceph")).toBe(0);
  });

  it("shows how far the guests overcommit the node", () => {
    const c = ctx();
    const m = memoryMeter(0, [newGuest("vm", [], c, { memoryGb: "60" })], c);
    expect(m.freeGb).toBe(0);
    expect(m.overGb).toBe(2 + 9 + 60 - 64);
  });

  // no spare disks: no ceph, no zfs pool, no local zfs — only proxmox
  it("drops the segments that take nothing", () => {
    const c = ctx({
      nodes: cluster(4, { ramGb: "64", additionalDiskCount: "0", additionalDisks: [] }),
      clusterStorage: { ceph: false, zfs: false },
    });
    expect(memoryMeter(0, [], c).segments.map((s) => s.key)).toEqual(["host"]);
  });
});

describe("the boot disk", () => {
  // root a quarter up to 96 gb, swap as ram between 4 and 8, an eighth free up to 16
  it("is carved the way the installer does it", () => {
    expect(bootDiskLayout(512, 64)).toEqual({ root: 96, swap: 8, reserved: 16, localLvm: 392 });
    expect(bootDiskLayout(128, 2)).toEqual({ root: 32, swap: 4, reserved: 16, localLvm: 76 });
    expect(bootDiskLayout(0, 64).localLvm).toBe(0);
  });

  it("puts guests on local-lvm into what's left", () => {
    const c = ctx();
    const m = bootDiskMeter(0, [guestWith(newGuest("vm", [], c), { storage: "local-lvm", sizeGb: "100" })], c);
    expect(m.totalGb).toBe(512);
    expect(seg(m, "root") + seg(m, "swap") + seg(m, "reserved")).toBe(120);
    expect(seg(m, "guests")).toBe(100);
    expect(m.freeGb).toBe(292);
    // guests only ever get local-lvm
    expect(m.room).toEqual({ totalGb: 392, freeGb: 292, overGb: 0 });
  });
});

describe("cephMeter", () => {
  // 4 nodes × 2 × 1000 gb raw, 3 replicas
  it("stores every guest disk once per replica", () => {
    const c = ctx();
    const m = cephMeter([guestWith(newGuest("vm", [], c), { sizeGb: "500" })], c)!;
    expect(m.totalGb).toBe(8000);
    expect(seg(m, "guests")).toBe(500);
    expect(seg(m, "replicas")).toBe(1000);
    expect(m.marker).toEqual({ at: 0.8, label: "keep below 80%" });
    expect(m.note).toMatch(/2667 gb of it is usable/);
  });

  // what's left for guests, not raw space: every disk is stored 3×
  it("counts the room left in usable space", () => {
    const c = ctx();
    const m = cephMeter([guestWith(newGuest("vm", [], c), { sizeGb: "500" })], c)!;
    expect(m.room.totalGb).toBeCloseTo(8000 / 3);
    expect(m.room.freeGb).toBeCloseTo(8000 / 3 - 500);
    expect(m.freeGb).toBe(8000 - 1500);
    const full = cephMeter([guestWith(newGuest("vm", [], c), { sizeGb: "3000" })], c)!;
    expect(full.room.overGb).toBeCloseTo(3000 - 8000 / 3);
  });

  // the persistent volumes' own pool shares the osds, replicated alike
  it("holds kubernetes' persistent volumes alongside the guest disks", () => {
    const c = ctx({ kubernetes: { cephVolumes: true, volumeGb: "300" } });
    const m = cephMeter([guestWith(newGuest("vm", [], c, { k8sRole: "worker" }), { sizeGb: "500" })], c)!;
    expect(seg(m, "guests")).toBe(500);
    expect(seg(m, "volumes")).toBe(300);
    expect(seg(m, "replicas")).toBe(1600);
    expect(m.room.freeGb).toBeCloseTo(8000 / 3 - 800);
    // no kubernetes vm, no volumes
    expect(seg(cephMeter([guestWith(newGuest("vm", [], c), { sizeGb: "500" })], c)!, "volumes")).toBe(0);
  });

  it("is absent without ceph", () => {
    expect(cephMeter([], ctx({ clusterStorage: { ceph: false, zfs: true } }))).toBeNull();
  });
});

describe("zfsMeter", () => {
  // two 1000 gb disks as a mirror: 1000 gb usable, 1000 gb redundancy
  it("shows the pool's redundancy, the guests, and a line at 80% of what's usable", () => {
    const c = ctx({ clusterStorage: { ceph: false, zfs: true }, storage: { ...defaultStoragePlan(), zfs: { ...defaultStoragePlan().zfs, raidLevel: "mirror" } } });
    const m = zfsMeter(0, [guestWith(newGuest("vm", [], c), { storage: "tank", sizeGb: "200" })], c)!;
    expect(m.totalGb).toBe(2000);
    expect(seg(m, "redundancy")).toBe(1000);
    expect(seg(m, "guests")).toBe(200);
    expect(m.marker?.at).toBeCloseTo(0.9);
    // room is the usable 1000 gb, not the raw 2000
    expect(m.room).toEqual({ totalGb: 1000, freeGb: 800, overGb: 0 });
  });

  it("is absent without zfs", () => {
    expect(zfsMeter(0, [], ctx())).toBeNull();
  });
});

describe("localMeter", () => {
  it("fills a node's local pool with its own guests only", () => {
    const c = ctx({ clusterStorage: { ceph: false, zfs: false } });
    const guests = [
      guestWith(newGuest("vm", [], c, { node: "0" }), { storage: "local-zfs", sizeGb: "300" }),
      guestWith(newGuest("vm", [], c, { node: "1" }), { storage: "local-zfs", sizeGb: "700" }),
    ];
    expect(localMeter(0, guests, c)).toMatchObject({ totalGb: 2000, freeGb: 1700 });
  });

  it("is absent without local disks", () => {
    expect(localMeter(0, [], ctx())).toBeNull();
  });
});
