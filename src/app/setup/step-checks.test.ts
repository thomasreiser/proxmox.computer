import { describe, expect, it } from "vitest";
import { backupProblems, hardwareProblems, networkProblems, problemsUpTo, storageProblems } from "./step-checks";
import { required } from "./validation";
import { backupPlan, bond, bridge, cluster, disks, network, nics, persistedState } from "./test-fixtures";

// a node whose every required field is filled
const complete = () => persistedState({ nodes: cluster(3, { ramGb: "64", bootDiskSizeGb: "512" }) });

describe("required", () => {
  it("rejects blank and whitespace", () => {
    expect(required("", () => null)).toBe("required");
    expect(required("   ", () => null)).toBe("required");
  });

  it("defers to the validator once there's a value", () => {
    expect(required("x", () => "bad")).toBe("bad");
    expect(required("x", () => null)).toBeNull();
  });
});

describe("hardwareProblems", () => {
  it("finds nothing wrong with a complete cluster", () => {
    expect(hardwareProblems(complete())).toEqual([]);
  });

  // the reported bug: an empty memory field was accepted
  it("blocks on missing memory, naming the node and field", () => {
    const state = complete();
    state.nodes[1].ramGb = "";
    expect(hardwareProblems(state)).toEqual([
      { step: "hardware", where: "node 02 — pve02", field: "memory (gb)", message: "1-16384" },
    ]);
  });

  it("blocks on every other required hardware field", () => {
    const state = complete();
    const n = state.nodes[0];
    Object.assign(n, { name: "", cpuCount: "", coresPerCpu: "", bootDiskSizeGb: "", nicCount: "" });
    const fields = hardwareProblems(state).map((p) => p.field);
    expect(fields).toEqual(
      expect.arrayContaining(["node name", "number of cpus", "cores per cpu", "boot disk size (gb)", "number of nics"]),
    );
  });

  it("blocks on a spare disk without a size", () => {
    const state = complete();
    state.nodes[0].additionalDisks = disks({ sizeGb: "" });
    expect(hardwareProblems(state).map((p) => p.field)).toContain("disk 1 size (gb)");
  });

  it("blocks on duplicate names within a node", () => {
    const state = complete();
    state.nodes[0].nics = nics({ name: "lan" }, { name: "lan" });
    expect(hardwareProblems(state).filter((p) => p.field.startsWith("nic"))).toHaveLength(2);
  });

  it("blocks on a node count outside 1–16", () => {
    expect(hardwareProblems({ ...complete(), nodeCount: "17" }).map((p) => p.field)).toContain("number of nodes");
  });
});

describe("networkProblems", () => {
  it("finds nothing wrong with a complete cluster", () => {
    expect(networkProblems(complete())).toEqual([]);
  });

  // blank passes these validators while typing, but step 2 can't finish
  // without them
  it("requires the homelab subnet, the gateway and each management address", () => {
    const state = { ...complete(), globalCidr: "", gateway: "" };
    state.nodes[0].network = { ...state.nodes[0].network, cidr: "" };
    const fields = networkProblems(state).map((p) => `${p.where}/${p.field}`);
    expect(fields).toEqual(
      expect.arrayContaining(["cluster/homelab cidr", "cluster/gateway", "node 01 — pve01/static ip"]),
    );
  });

  it("rejects the network address as a management ip", () => {
    const state = complete();
    state.nodes[0].network = { ...state.nodes[0].network, cidr: "10.0.0.0/24" };
    expect(networkProblems(state).find((p) => p.field === "static ip")?.message).toMatch(/network address/);
  });

  it("blocks on two nodes sharing an address", () => {
    const state = complete();
    state.nodes[1].network = { ...state.nodes[1].network, cidr: state.nodes[0].network.cidr };
    expect(networkProblems(state).some((p) => p.field === "static ip")).toBe(true);
  });

  it("requires a subnet on a vm bridge and an address on a host bridge", () => {
    const nodes = cluster(1, {
      nics: nics("1gbe", "1gbe", "1gbe"),
      network: network({
        bridgeCounts: { "nic-0": "1", "nic-1": "1", "nic-2": "1" },
        bridges: {
          "nic-0#0": bridge({ name: "vmbr0" }),
          "nic-1#0": bridge({ name: "vmbr1", purposes: ["vm"], ip: "" }),
          "nic-2#0": bridge({ name: "vmbr2", purposes: ["backup"], ip: "" }),
        },
      }),
    });
    const fields = networkProblems({ ...complete(), nodes }).map((p) => p.field);
    expect(fields).toContain("bridge vmbr1 network");
    expect(fields).toContain("bridge vmbr2 static ip");
  });

  // ceph/zfs off management is a storage link: the address sits on the
  // nic itself, so there's no bridge name to check and problems name the nic
  it("names a storage link after its nic and checks no bridge name", () => {
    const n = nics("1gbe", "10gbe");
    n[1].name = "storage";
    const nodes = cluster(1, {
      nics: n,
      network: network({
        bridgeCounts: { "nic-0": "1", "nic-1": "1" },
        bridges: { "nic-0#0": bridge({ name: "vmbr0" }), "nic-1#0": bridge({ name: "", purposes: ["ceph"], ip: "" }) },
      }),
    });
    const fields = networkProblems({ ...complete(), nodes }).map((p) => p.field);
    expect(fields).toContain("storage link storage static ip");
    expect(fields.some((f) => f.endsWith(" name") && f.includes("storage"))).toBe(false);
  });

  // the management bridge's address is the node's static ip, asked once
  it("never asks for the management bridge's own ip", () => {
    expect(networkProblems(complete()).some((p) => p.field.startsWith("bridge vmbr0"))).toBe(false);
  });

  it("ignores a disabled bridge", () => {
    const nodes = cluster(1, {
      network: network({
        bridgeCounts: { "nic-0": "1", "nic-1": "1" },
        bridges: { "nic-0#0": bridge(), "nic-1#0": bridge({ name: "vmbr1", enabled: false, ip: "" }) },
      }),
    });
    expect(networkProblems({ ...complete(), nodes })).toEqual([]);
  });

  it("requires a vlan tag on an extra bridge", () => {
    const nodes = cluster(1, {
      network: network({
        bridgeCounts: { "nic-0": "2" },
        bridges: { "nic-0#0": bridge(), "nic-0#1": bridge({ name: "vmbr1", ip: "10.0.40.0/24", vlanTag: "" }) },
      }),
    });
    expect(networkProblems({ ...complete(), nodes }).map((p) => p.field)).toContain("bridge vmbr1 vlan tag");
  });

  it("checks bond names", () => {
    const nodes = cluster(1, {
      nics: nics("1gbe", "1gbe", "1gbe"),
      network: network({ bondCount: "1", bonds: [bond({ name: "bad name", nicIndices: [1, 2] })] }),
    });
    expect(networkProblems({ ...complete(), nodes }).map((p) => p.field)).toContain("bond 1 name");
  });
});

describe("the dns server", () => {
  it("is required and must be an ip", () => {
    expect(networkProblems({ ...complete(), dns: "" }).map((p) => p.field)).toContain("dns server");
    expect(networkProblems({ ...complete(), dns: "dns.lan" }).map((p) => p.field)).toContain("dns server");
    expect(networkProblems(complete()).map((p) => p.field)).not.toContain("dns server");
  });
});

describe("storageProblems", () => {
  it("finds nothing wrong with the defaults", () => {
    expect(storageProblems(complete())).toEqual([]);
  });

  it("checks the pool name of every pool actually built", () => {
    const state = { ...complete(), clusterStorage: { ceph: true, zfs: true } };
    state.nodes = cluster(3, { ramGb: "64", bootDiskSizeGb: "512", additionalDisks: disks(1000, 1000) });
    state.storage = {
      ...state.storage,
      ceph: { ...state.storage.ceph, poolName: "" },
      zfs: { ...state.storage.zfs, poolName: "mirror", replicationMinutes: "0" },
    };
    expect(storageProblems(state).map((p) => p.field)).toEqual(["ceph pool name", "zfs pool name", "replicate every"]);
  });

  // a pool that isn't built needs no name
  it("ignores the settings of a pool that isn't on", () => {
    const state = complete();
    state.storage = { ...state.storage, zfs: { ...state.storage.zfs, poolName: "" } };
    expect(storageProblems(state)).toEqual([]);
  });

  it("checks the local storage id only when some disk is local", () => {
    const state = complete();
    state.storage = { ...state.storage, local: { ...state.storage.local, name: "" } };
    expect(storageProblems(state)).toEqual([]);
    state.nodes = cluster(3, { ramGb: "64", bootDiskSizeGb: "512", additionalDisks: disks(1000, { role: "local" }) });
    expect(storageProblems(state).map((p) => p.field)).toEqual(["local storage id"]);
  });
});

describe("backupProblems", () => {
  const fields = (plan: Parameters<typeof backupPlan>[0]) =>
    backupProblems({ ...complete(), backups: backupPlan(plan) }).map((p) => p.field);

  it("finds nothing wrong with a complete plan", () => {
    expect(fields({})).toEqual([]);
  });

  // the defaults leave the one thing only the visitor knows blank
  it("requires the pbs address", () => {
    expect(fields({ pbsAddress: "" })).toEqual(["pbs address"]);
  });

  it("checks only the chosen target's own fields", () => {
    expect(fields({ target: "pbs-vm", pbsAddress: "" })).toEqual([]);
    expect(fields({ target: "pbs-vm", datastore: "" })).toEqual(["datastore"]);
    expect(fields({ target: "nfs", datastore: "" })).toEqual(["nfs server", "export path"]);
    expect(fields({ target: "nfs", nfsServer: "nas", nfsExport: "/volume1/pve" })).toEqual([]);
  });

  it("checks the time and every retention count", () => {
    expect(fields({ schedule: "25:00", keepDaily: "", keepWeekly: "-1" })).toEqual([
      "backup time",
      "keep daily",
      "keep weekly",
    ]);
  });

  it("won't take retention that keeps nothing", () => {
    expect(fields({ keepLast: "0", keepDaily: "0", keepWeekly: "0", keepMonthly: "0" })).toEqual(["retention"]);
  });

  it("needs the off-site address only with an off-site copy", () => {
    expect(fields({ offsite: true })).toEqual(["off-site pbs address"]);
    expect(fields({ offsite: true, offsiteAddress: "pbs.offsite.example" })).toEqual([]);
    // nfs has no pbs sync, so a leftover tick means nothing
    expect(fields({ target: "nfs", nfsServer: "nas", nfsExport: "/x", offsite: true })).toEqual([]);
  });

  // "no backups" is warned about, not blocked — it's the visitor's call
  it("blocks nothing with no backups", () => {
    expect(fields({ target: "none", pbsAddress: "", schedule: "" })).toEqual([]);
  });

  it("labels its problems as step 4's", () => {
    expect(backupProblems({ ...complete(), backups: backupPlan({ pbsAddress: "" }) })[0].step).toBe("backups");
  });
});

describe("problemsUpTo", () => {
  // a later step is built on the earlier ones
  it("includes every earlier step's problems", () => {
    const state = { ...complete(), gateway: "" };
    state.nodes[0].ramGb = "";
    expect(problemsUpTo("hardware", state).map((p) => p.step)).toEqual(["hardware"]);
    expect(problemsUpTo("network", state).map((p) => p.step)).toEqual(["hardware", "network"]);
    expect(problemsUpTo("storage", state).map((p) => p.step)).toEqual(["hardware", "network"]);
    state.backups = backupPlan({ pbsAddress: "" });
    expect(problemsUpTo("storage", state).map((p) => p.step)).toEqual(["hardware", "network"]);
    expect(problemsUpTo("backups", state).map((p) => p.step)).toEqual(["hardware", "network", "backups"]);
  });

  it("is empty for a complete plan", () => {
    expect(problemsUpTo("storage", complete())).toEqual([]);
    expect(problemsUpTo("backups", complete())).toEqual([]);
  });
});
