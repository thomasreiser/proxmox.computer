import { describe, expect, it } from "vitest";
import { buildStorageOverview, ROLE_COLOR, roleLabel, storageLinkFor } from "./plan";
import { defaultStoragePlan } from "../../derive";
import { bond, bridge, cluster, disks, network, nics, node } from "../../test-fixtures";

const CEPH = { ceph: true, zfs: false };
const ZFS = { ceph: false, zfs: true };
const BOTH = { ceph: true, zfs: true };
const NEITHER = { ceph: false, zfs: false };

// a node whose ceph traffic runs over nic-1, alongside a plain vm bridge
function cephNode(speeds: Parameters<typeof nics>) {
  return node({
    nics: nics(...speeds),
    network: network({
      bridges: {
        "nic-0#0": bridge({ name: "vmbr0" }),
        "nic-1#0": bridge({ name: "vmbr1", purposes: ["ceph"], ip: "10.0.20.11/24" }),
      },
    }),
  });
}

describe("storageLinkFor", () => {
  it("reports the speed of the nic carrying ceph", () => {
    expect(storageLinkFor(cephNode(["1gbe", "10gbe"]), "ceph")).toEqual({ key: "ceph link", label: "10 gbe", warn: false, reason: null });
  });

  // the same threshold the wizard's ceph speed hint uses
  it("warns below 10 gbe, and says why", () => {
    const link = storageLinkFor(cephNode(["10gbe", "1gbe"]), "ceph");
    expect(link).toMatchObject({ label: "1 gbe", warn: true });
    expect(link.reason).toMatch(/below 10 gbe — ceph waits on this link for every write/);
  });

  it("ignores the speed of nics that don't carry ceph", () => {
    expect(storageLinkFor(cephNode(["1gbe", "25gbe"]), "ceph").warn).toBe(false);
  });

  it("describes a bond by its members and name", () => {
    const n = node({
      nics: nics("1gbe", "10gbe", "10gbe"),
      network: network({
        bonds: [bond({ name: "bond0", nicIndices: [1, 2] })],
        bridges: { "nic-0#0": bridge(), "bond-0#0": bridge({ purposes: ["ceph"] }) },
      }),
    });
    expect(storageLinkFor(n, "ceph")).toEqual({ key: "ceph link", label: "2 × 10 gbe (bond0)", warn: false, reason: null });
  });

  // a bond is only as fast as its slowest member
  it("flags a bond with one slow member", () => {
    const n = node({
      nics: nics("1gbe", "10gbe", "1gbe"),
      network: network({
        bonds: [bond({ name: "bond0", nicIndices: [1, 2] })],
        bridges: { "nic-0#0": bridge(), "bond-0#0": bridge({ purposes: ["ceph"] }) },
      }),
    });
    expect(storageLinkFor(n, "ceph")).toMatchObject({ label: "10 gbe + 1 gbe (bond0)", warn: true });
  });

  it("warns when no nic carries the mode at all, and says where to fix it", () => {
    const link = storageLinkFor(node(), "ceph");
    expect(link).toMatchObject({ key: "ceph link", label: "not set up", warn: true });
    expect(link.reason).toMatch(/no nic on this node carries ceph traffic — set one up in step 2/);
  });

  it("ignores a disabled bridge", () => {
    const n = cephNode(["1gbe", "10gbe"]);
    n.network.bridges["nic-1#0"] = { ...n.network.bridges["nic-1#0"], enabled: false };
    expect(storageLinkFor(n, "ceph").label).toBe("not set up");
  });

  it("reports the zfs replication link", () => {
    const n = node({
      nics: nics("1gbe", "10gbe"),
      network: network({ bridges: { "nic-0#0": bridge(), "nic-1#0": bridge({ purposes: ["zfs"] }) } }),
    });
    expect(storageLinkFor(n, "zfs")).toEqual({ key: "replication link", label: "10 gbe", warn: false, reason: null });
  });

  // replication is a scheduled background copy: a slower link only makes
  // each run take longer, so it isn't held to ceph's 10 gbe line
  it("doesn't flag a slow replication link", () => {
    const n = node({
      nics: nics("1gbe", "2.5gbe", "2.5gbe"),
      network: network({
        bonds: [bond({ name: "bond0", nicIndices: [1, 2] })],
        bridges: { "nic-0#0": bridge(), "bond-0#0": bridge({ purposes: ["zfs"] }) },
      }),
    });
    expect(storageLinkFor(n, "zfs")).toMatchObject({ label: "2 × 2.5 gbe (bond0)", warn: false, reason: null });
  });

  it("still flags a replication link that isn't set up", () => {
    const link = storageLinkFor(node(), "zfs");
    expect(link.warn).toBe(true);
    expect(link.reason).toMatch(/zfs replication traffic/);
  });

  it("does not report an unknown speed as slow", () => {
    expect(storageLinkFor(cephNode(["1gbe", "other"]), "ceph").warn).toBe(false);
  });
});

describe("buildStorageOverview — ceph", () => {
  // decimal throughout: 3 × 1000 gb is 3.0 tb raw, 1.0 tb usable at 3×
  it("quotes the shared pool's capacity in decimal units", () => {
    const overview = buildStorageOverview(cluster(3, { additionalDisks: disks(1000) }), defaultStoragePlan(), CEPH, "");
    expect(overview.ceph).toMatchObject({ kind: "ceph", usable: "1.0 tb", raw: "3.0 tb", contributing: 3 });
    expect(overview.zfs).toBeNull();
  });

  // an unchosen disk lands in the mode that's on
  it("counts unchosen disks as osds", () => {
    const view = buildStorageOverview(cluster(1, { additionalDisks: disks(1000, 1000) }), defaultStoragePlan(), CEPH, "").nodes[0];
    expect(view.cephDisks).toHaveLength(2);
    expect(view.cephRawGb).toBe(2000);
  });

  it("attaches one link per enabled mode", () => {
    const nodes = [cephNode(["1gbe", "10gbe"]), cephNode(["1gbe", "1gbe"])];
    const overview = buildStorageOverview(nodes, defaultStoragePlan(), CEPH, "lab.lan");
    expect(overview.nodes.map((n) => n.storageLinks.map((l) => l.warn))).toEqual([[false], [true]]);
  });

  it("quotes the replica count in effect, not a stored one the cluster can't place", () => {
    const plan = defaultStoragePlan();
    plan.ceph = { ...plan.ceph, replicas: "3", minReplicas: "3" };
    const overview = buildStorageOverview(cluster(2), plan, CEPH, "");
    expect(overview.ceph?.facts).toContainEqual({ key: "replicas", value: "2× (min 2)" });
  });
});

describe("buildStorageOverview — zfs", () => {
  const zfsPlan = () => ({ ...defaultStoragePlan(), zfs: { poolName: "tank", raidLevel: "mirror" as const, replicationMinutes: "15" } });

  // every node holds the same guests, so usable is one node's pool — the
  // copies on the other nodes are the point, not extra room.
  it("quotes one node's usable capacity, not the sum", () => {
    const overview = buildStorageOverview(cluster(3, { additionalDisks: disks(1000, 1000) }), zfsPlan(), ZFS, "");
    expect(overview.zfs).toMatchObject({ kind: "zfs", name: "tank", usable: "1.0 tb", raw: "6.0 tb" });
    expect(overview.ceph).toBeNull();
  });

  it("uses the smallest node's pool when nodes differ", () => {
    const nodes = cluster(2, { additionalDisks: disks(2000, 2000) });
    nodes[1].additionalDisks = disks(1000, 1000);
    expect(buildStorageOverview(nodes, zfsPlan(), ZFS, "").zfs?.usable).toBe("1.0 tb");
  });

  it("states the layout, the interval and the copy count", () => {
    const overview = buildStorageOverview(cluster(3, { additionalDisks: disks(1000, 1000) }), zfsPlan(), ZFS, "");
    expect(overview.zfs?.facts).toEqual([
      { key: "layout", value: "mirror per node" },
      { key: "replicates every", value: "15 minutes" },
      { key: "copies", value: "3 (one per node)" },
    ]);
  });

  it("gives each node its own zfs pool figure", () => {
    const overview = buildStorageOverview(cluster(2, { additionalDisks: disks(1000, 1000) }), zfsPlan(), ZFS, "");
    expect(overview.nodes.map((n) => n.zfsUsableGb)).toEqual([1000, 1000]);
  });

  it("shows no usable capacity when no node contributes a disk", () => {
    const nodes = cluster(2, { additionalDisks: disks({ role: "local" }, { role: "local" }) });
    expect(buildStorageOverview(nodes, zfsPlan(), ZFS, "").zfs).toMatchObject({ usable: "—", contributing: 0 });
  });
});

describe("buildStorageOverview — ceph and zfs together", () => {
  // ceph as the main ha storage, zfs replication alongside
  it("builds both pools from the disks each was given", () => {
    const nodes = cluster(3, { additionalDisks: disks({ role: "ceph", sizeGb: "2000" }, { role: "zfs" }, { role: "zfs" }) });
    const overview = buildStorageOverview(nodes, defaultStoragePlan(), BOTH, "");
    expect(overview.ceph).toMatchObject({ raw: "6.0 tb", usable: "2.0 tb" });
    expect(overview.zfs).toMatchObject({ usable: "1.0 tb", raw: "6.0 tb" });
    expect(overview.nodes[0].cephDisks).toHaveLength(1);
    expect(overview.nodes[0].zfsDisks).toHaveLength(2);
  });

  it("gives each node a link line for both modes", () => {
    const overview = buildStorageOverview(cluster(1, { additionalDisks: disks(1000, 1000) }), defaultStoragePlan(), BOTH, "");
    expect(overview.nodes[0].storageLinks.map((l) => l.key)).toEqual(["ceph link", "replication link"]);
  });
});

describe("buildStorageOverview without cluster storage", () => {
  it("draws no pool at all", () => {
    const overview = buildStorageOverview(cluster(2), defaultStoragePlan(), NEITHER, "");
    expect(overview.ceph).toBeNull();
    expect(overview.zfs).toBeNull();
  });

  // an unchosen disk has nowhere to go but local
  it("counts unchosen disks as local", () => {
    const view = buildStorageOverview(cluster(1), defaultStoragePlan(), NEITHER, "").nodes[0];
    expect(view.localDisks).toHaveLength(1);
    expect(view.storageLinks).toEqual([]);
  });

  it("joins the host label and domain, falling back to the bare label", () => {
    expect(buildStorageOverview(cluster(1), defaultStoragePlan(), NEITHER, "lab.lan").nodes[0].fqdn).toBe("pve01.lab.lan");
    expect(buildStorageOverview(cluster(1), defaultStoragePlan(), NEITHER, "").nodes[0].fqdn).toBe("pve01");
  });

  it("keeps the boot disk apart from the assignable disks", () => {
    const view = buildStorageOverview(cluster(1), defaultStoragePlan(), NEITHER, "").nodes[0];
    expect(view.boot).toMatchObject({ name: "boot", role: "boot" });
    expect(view.disks.every((d) => d.role !== "boot")).toBe(true);
  });
});

describe("roleLabel / ROLE_COLOR", () => {
  it("labels an osd and every other role by name", () => {
    expect(roleLabel("ceph")).toBe("osd");
    expect(roleLabel("zfs")).toBe("zfs");
    expect(roleLabel("local")).toBe("local");
    expect(roleLabel("unused")).toBe("unused");
    expect(roleLabel("boot")).toBe("boot");
  });

  it("has a distinct color for every role", () => {
    const colors = (["boot", "ceph", "zfs", "local", "unused"] as const).map((r) => ROLE_COLOR[r]);
    expect(colors.every(Boolean)).toBe(true);
    expect(new Set(colors).size).toBe(5);
  });
});
