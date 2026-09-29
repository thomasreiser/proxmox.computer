import { describe, expect, it } from "vitest";
import { backupLinkFor, buildBackupOverview } from "./plan";
import { backupPlan, bond, bridge, cluster, network, nics, node } from "../../test-fixtures";

const backupNic = network({
  bridgeCounts: { "nic-0": "1", "nic-1": "1" },
  bridges: {
    "nic-0#0": bridge({ name: "vmbr0" }),
    "nic-1#0": bridge({ name: "vmbr1", purposes: ["backup"], ip: "10.0.30.11/24" }),
  },
});

const facts = (plan: Parameters<typeof backupPlan>[0]) =>
  Object.fromEntries(buildBackupOverview(cluster(3), backupPlan(plan), "").target!.facts.map((f) => [f.key, f.value]));

describe("backupLinkFor", () => {
  it("names the bridge step 2 set aside for backups", () => {
    expect(backupLinkFor(node({ nics: nics("1gbe", "10gbe"), network: backupNic }))).toEqual({
      label: "vmbr1",
      speed: "10 gbe",
      dedicated: true,
    });
  });

  it("falls back to the management link", () => {
    expect(backupLinkFor(node({ nics: nics("2.5gbe", "10gbe") }))).toEqual({
      label: "management link",
      speed: "2.5 gbe",
      dedicated: false,
    });
  });

  // a disabled bridge carries nothing
  it("ignores a disabled backup bridge", () => {
    const net = { ...backupNic, bridges: { ...backupNic.bridges, "nic-1#0": { ...backupNic.bridges["nic-1#0"], enabled: false } } };
    expect(backupLinkFor(node({ network: net })).dedicated).toBe(false);
  });
});

// a bond carries backups at the speed of every member together
it("reads a backup bond's speed off all its members", () => {
  const n = node({
    nics: nics("1gbe", "10gbe", "10gbe"),
    network: network({
      bondCount: "1",
      bonds: [bond({ nicIndices: [1, 2] })],
      bridgeCounts: { "nic-0": "1", "bond-0": "1" },
      bridges: { "nic-0#0": bridge(), "bond-0#0": bridge({ name: "vmbr1", purposes: ["backup"], ip: "10.0.30.11/24" }) },
    }),
  });
  expect(backupLinkFor(n).speed).toBe("2 × 10 gbe");
});

describe("buildBackupOverview", () => {
  it("names every node by its fqdn", () => {
    const overview = buildBackupOverview(cluster(2), backupPlan(), "lab.lan");
    expect(overview.nodes.map((n) => n.fqdn)).toEqual(["pve01.lab.lan", "pve02.lab.lan"]);
  });

  it("draws no target and no off-site copy for no backups", () => {
    const overview = buildBackupOverview(cluster(3), backupPlan({ target: "none", offsite: true }), "");
    expect(overview.target).toBeNull();
    expect(overview.offsite).toBeNull();
    expect(overview.nodes).toHaveLength(3);
  });

  it("titles each target by where the backups land", () => {
    const title = (plan: Parameters<typeof backupPlan>[0]) => buildBackupOverview(cluster(1), backupPlan(plan), "").target!.title;
    expect(title({})).toBe("10.0.10.50");
    expect(title({ pbsAddress: "" })).toBe("(no address)");
    expect(title({ target: "pbs-vm" })).toBe("pbs vm");
    expect(title({ target: "nfs", nfsServer: "nas", nfsExport: "/volume1/pve" })).toBe("nas:/volume1/pve");
    expect(title({ target: "nfs" })).toBe("(no share)");
  });

  it("lists pbs's datastore, schedule, retention and checks", () => {
    expect(facts({ encrypt: true })).toEqual({
      datastore: "backups",
      runs: "daily at 02:00",
      keeps: "up to 20 per guest",
      "reaches back": "about 6 months",
      verify: "weekly",
      encryption: "on, client-side",
    });
  });

  it("says nfs copies everything, and has no pbs features", () => {
    const nfs = facts({ target: "nfs", nfsServer: "nas", nfsExport: "/x" });
    expect(nfs.mode).toMatch(/no dedup/);
    expect(nfs).not.toHaveProperty("datastore");
    expect(nfs).not.toHaveProperty("verify");
  });

  it("marks a pbs vm as inside the cluster", () => {
    expect(buildBackupOverview(cluster(1), backupPlan({ target: "pbs-vm" }), "").target!.insideCluster).toBe(true);
    expect(buildBackupOverview(cluster(1), backupPlan(), "").target!.insideCluster).toBe(false);
  });

  it("draws an off-site copy only for pbs with sync on", () => {
    expect(buildBackupOverview(cluster(1), backupPlan({ offsite: true, offsiteAddress: "far.example" }), "").offsite).toEqual({
      address: "far.example",
    });
    expect(buildBackupOverview(cluster(1), backupPlan({ offsite: false }), "").offsite).toBeNull();
    expect(buildBackupOverview(cluster(1), backupPlan({ target: "nfs", offsite: true }), "").offsite).toBeNull();
  });
});
