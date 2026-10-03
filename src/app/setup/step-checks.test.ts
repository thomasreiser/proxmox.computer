import { describe, expect, it } from "vitest";
import {
  accessProblems,
  backupProblems,
  hardwareProblems,
  installProblems,
  locationProblems,
  softwareProblems,
  networkProblems,
  problemsUpTo,
  storageProblems,
} from "./step-checks";
import { required } from "./validation";
import { newGuest } from "./software";
import { accessPlan, backupPlan, bond, bridge, cluster, disks, installPlan, network, nics, persistedState, guestWith, softwarePlan } from "./test-fixtures";

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

  it("labels its problems as step 5's", () => {
    expect(backupProblems({ ...complete(), backups: backupPlan({ pbsAddress: "" }) })[0].step).toBe("backups");
  });
});

describe("accessProblems", () => {
  const fields = (access: Parameters<typeof accessPlan>[0]) =>
    accessProblems({ ...complete(), access: accessPlan(access) }).map((p) => `${p.where}: ${p.field}`);

  it("finds nothing wrong with a key and a password per node", () => {
    expect(fields({})).toEqual([]);
  });

  it("requires a valid ssh key", () => {
    expect(fields({ sshKeys: "" })).toEqual(["cluster: ssh public key"]);
    expect(fields({ sshKeys: "ssh-ed25519 nope" })).toEqual(["cluster: ssh public key"]);
  });

  it("requires every node's root password, by node", () => {
    expect(fields({ rootPasswords: ["long-enough-pw-1", "short", ""] })).toEqual([
      "node 02 — pve02: root password",
      "node 03 — pve03: root password",
    ]);
  });

  it("checks oidc only once it's turned on", () => {
    const oidc = { ...accessPlan().oidc, realm: "pam", issuerUrl: "", clientId: "" };
    expect(fields({ oidc })).toEqual([]);
    expect(fields({ oidc: { ...oidc, enabled: true } })).toEqual([
      "cluster: oidc realm",
      "cluster: issuer url",
      "cluster: client id",
    ]);
  });

  // a public client has no secret
  it("never requires a client secret", () => {
    const oidc = { ...accessPlan().oidc, enabled: true, issuerUrl: "https://auth.lab.lan", clientId: "pve", clientSecret: "" };
    expect(fields({ oidc })).toEqual([]);
  });
});

describe("locationProblems", () => {
  it("finds nothing wrong with a complete location", () => {
    expect(locationProblems(complete())).toEqual([]);
  });

  // a save restored in a browser that lacks its timezone, say
  it("flags anything outside what the installer takes", () => {
    const state = { ...complete(), location: { country: "xx", keyboard: "dvorak", timezone: "Mars/Olympus_Mons" } };
    expect(locationProblems(state).map((p) => p.field)).toEqual(["country", "keyboard", "timezone"]);
    expect(locationProblems(state)[0].step).toBe("location");
  });
});

describe("softwareProblems", () => {
  const base = () => complete();
  const guestCtx = () => ({ nodes: base().nodes, clusterStorage: base().clusterStorage, storage: base().storage });
  const fields = (guests: ReturnType<typeof newGuest>[]) =>
    softwareProblems({ ...base(), software: softwarePlan(guests) }).map((p) => `${p.where}: ${p.field}`);

  // step 7 is optional
  it("finds nothing wrong with no guests at all", () => {
    expect(fields([])).toEqual([]);
  });

  it("wants space for kubernetes volumes on ceph, only while they're there", () => {
    const k8s = newGuest("vm", [], guestCtx(), { k8sRole: "worker" });
    const check = (guests: ReturnType<typeof newGuest>[], volumeGb: string, cephVolumes = true) =>
      softwareProblems({ ...base(), software: softwarePlan(guests, { volumeGb, cephVolumes }) }).map((p) => `${p.where}: ${p.field}`);
    expect(check([k8s], "")).toEqual(["kubernetes: space for volumes"]);
    expect(check([k8s], "0")).toEqual(["kubernetes: space for volumes"]);
    expect(check([k8s], "200")).toEqual([]);
    expect(check([k8s], "", false)).toEqual([]);
    expect(check([newGuest("vm", [], guestCtx())], "")).toEqual([]);
  });

  it("finds nothing wrong with a fresh guest", () => {
    expect(fields([newGuest("vm", [], guestCtx())])).toEqual([]);
  });

  it("wants every name and vmid unique", () => {
    const a = newGuest("vm", [], guestCtx());
    const b = { ...newGuest("vm", [a], guestCtx()), name: a.name, vmid: a.vmid };
    expect(fields([a, b])).toEqual(["guest vm-01: name", "guest vm-01: vmid", "guest vm-01: name", "guest vm-01: vmid"]);
  });

  it("checks a static address, and that it's not taken", () => {
    const a = guestWith(newGuest("vm", [], guestCtx()), {}, { ipMode: "static", ip: "10.0.0.50/24" });
    const b = guestWith(newGuest("vm", [a], guestCtx()), {}, { ipMode: "static", ip: "10.0.0.50/24" });
    expect(fields([a, b])).toEqual(["guest vm-01: nic 1 ip address", "guest vm-02: nic 1 ip address"]);
    // node 1's own management address
    expect(fields([guestWith(newGuest("vm", [], guestCtx()), {}, { ipMode: "static", ip: "10.0.0.11/24" })])).toEqual([
      "guest vm-01: nic 1 ip address",
    ]);
    expect(fields([guestWith(newGuest("vm", [], guestCtx()), {}, { ipMode: "static", ip: "" })])).toEqual(["guest vm-01: nic 1 ip address"]);
  });

  it("wants a bridge the node offers, and valid sizes", () => {
    const g = guestWith(newGuest("vm", [], guestCtx(), { cores: "0", memoryGb: "0.3", ballooning: false }), { sizeGb: "" }, { bridge: "vmbr9" });
    expect(fields([g])).toEqual(["guest vm-01: cores", "guest vm-01: memory", "guest vm-01: disk 1 size", "guest vm-01: nic 1 bridge"]);
  });

  // the balloon's floor can't sit above the memory it balloons
  it("keeps ballooning's minimum under the memory", () => {
    const g = newGuest("vm", [], guestCtx(), { memoryGb: "2", minMemoryGb: "4" });
    expect(fields([g])).toEqual(["guest vm-01: minimum memory"]);
    expect(fields([{ ...g, ballooning: false }])).toEqual([]);
  });

  // an iso vm sets its address in its own installer — nothing to check here
  it("checks a vm's address only where cloud-init sets it", () => {
    const iso = guestWith(newGuest("vm", [], guestCtx(), { image: "iso" }), {}, { ipMode: "static", ip: "" });
    expect(fields([iso])).toEqual([]);
  });

  it("wants a gateway on the interface's own network", () => {
    const g = guestWith(newGuest("vm", [], guestCtx()), {}, { ipMode: "static", ip: "10.0.0.50/24", gateway: "10.9.9.1" });
    expect(fields([g])).toEqual(["guest vm-01: nic 1 gateway"]);
  });

  it("checks a mac, a rate limit and an mtu", () => {
    const g = guestWith(newGuest("vm", [], guestCtx()), {}, { macAddress: "01:00:00:00:00:01", rateMbps: "0", mtu: "100" });
    expect(fields([g])).toEqual(["guest vm-01: nic 1 mac address", "guest vm-01: nic 1 rate limit", "guest vm-01: nic 1 mtu"]);
  });

  it("wants windows 11 on uefi with a tpm", () => {
    // a new vm already is
    const g = newGuest("vm", [], guestCtx(), { image: "iso", osType: "win11" });
    expect(fields([g])).toEqual([]);
    expect(fields([{ ...g, bios: "seabios" }])).toEqual(["guest vm-01: system"]);
    expect(fields([{ ...g, tpm: false }])).toEqual(["guest vm-01: system"]);
  });

  it("holds each bus to the disks it takes", () => {
    const base = newGuest("vm", [], guestCtx());
    const ide = { ...base, disks: [1, 2, 3, 4].map(() => ({ ...base.disks[0], bus: "ide" as const })) };
    expect(fields([ide])).toEqual(["guest vm-01: disks"]);
  });

  it("wants a container's mount points on their own absolute paths", () => {
    const ct = newGuest("container", [], guestCtx());
    const disks = [ct.disks[0], { ...ct.disks[0], id: "m1", mountPath: "data" }, { ...ct.disks[0], id: "m2", mountPath: "/srv" }, { ...ct.disks[0], id: "m3", mountPath: "/srv" }];
    expect(fields([{ ...ct, disks }])).toEqual([
      "guest ct-01: mount point 1 path",
      "guest ct-01: mount point 2 path",
      "guest ct-01: mount point 3 path",
    ]);
  });
});

describe("installProblems", () => {
  const fields = (overrides: Parameters<typeof persistedState>[0]) =>
    installProblems({ ...complete(), ...overrides }).map((p) => `${p.where}: ${p.field}`);

  // an unnamed disk keeps the placeholder, which stops the install safely
  it("finds nothing wrong with no boot disk named yet", () => {
    expect(fields({})).toEqual([]);
    expect(fields({ identicalHardware: true })).toEqual([]);
  });

  it("finds nothing wrong with valid names", () => {
    expect(fields({ install: installPlan({ bootDisks: ["nvme0n1", "sda", ""] }) })).toEqual([]);
  });

  it("flags each node whose name lsblk wouldn't print", () => {
    expect(fields({ install: installPlan({ bootDisks: ["/dev/sda", "nvme0n1", "sdb1"] }) })).toEqual([
      "node 01 — pve01: boot disk",
      "node 03 — pve03: boot disk",
    ]);
  });

  it("checks only the shared name while the hardware is identical", () => {
    expect(fields({ identicalHardware: true, install: installPlan({ bootDisk: "sda1", bootDisks: ["nvme0n1"] }) })).toEqual(["cluster: boot disk"]);
    expect(fields({ identicalHardware: true, install: installPlan({ bootDisk: "sda", bootDisks: ["/dev/x"] }) })).toEqual([]);
  });

  it("is step 8's", () => {
    expect(installProblems({ ...complete(), install: installPlan({ bootDisks: ["x"] }) })[0].step).toBe("install");
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
    expect(problemsUpTo("location", complete())).toEqual([]);
    expect(problemsUpTo("install", complete())).toEqual([]);
    expect(problemsUpTo("backups", complete())).toEqual([]);
    expect(problemsUpTo("access", complete())).toEqual([]);
  });
});
