import { describe, expect, it } from "vitest";
import {
  applyK8sLayout,
  cephReachHint,
  currentK8sLayout,
  defaultK8sLayout,
  effectiveK8sPlacement,
  k8sGuests,
  k8sLayoutHints,
  placeK8s,
  separatePossible,
  slotsByNode,
  workerChoices,
  type K8sLayout,
} from "./kubernetes";
import { effectiveGuestCpuType, newGuest, type GuestContext } from "./software";
import { defaultStoragePlan } from "./derive";
import { bridge, cluster, disks, network } from "./test-fixtures";

// n nodes, one 1000 gb disk each — ceph by default
const ctx = (n = 3, overrides: Partial<GuestContext> = {}): GuestContext => ({
  nodes: cluster(n, { ramGb: "64", additionalDisks: disks(1000) }),
  clusterStorage: { ceph: true, zfs: false },
  storage: defaultStoragePlan(),
  kubernetes: { cephVolumes: true, volumeGb: "200" },
  ...overrides,
});
const layout = (controlPlanes: number, workers: number, placement: K8sLayout["placement"] = "shared"): K8sLayout => ({
  controlPlanes,
  workers,
  placement,
});
const where = (l: K8sLayout, n: number) => placeK8s(l, n).map((s) => `${s.role === "control-plane" ? "cp" : "w"}@${s.node}`);

describe("the proposed layout", () => {
  it("puts a control plane and a worker on each of three nodes", () => {
    expect(defaultK8sLayout(3)).toEqual(layout(3, 3, "shared"));
  });

  it("keeps one control plane below three nodes", () => {
    expect(defaultK8sLayout(1)).toEqual(layout(1, 1));
    expect(defaultK8sLayout(2)).toEqual(layout(1, 2));
    // no nodes yet reads as one
    expect(defaultK8sLayout(0)).toEqual(layout(1, 1));
  });

  it("shares nodes up to five, and separates the control planes from six", () => {
    expect(defaultK8sLayout(5)).toEqual(layout(3, 5, "shared"));
    expect(defaultK8sLayout(6)).toEqual(layout(3, 3, "separate"));
    expect(defaultK8sLayout(8)).toEqual(layout(3, 5, "separate"));
  });
});

describe("choices", () => {
  it("offers from no workers up to three per node, at least six", () => {
    expect(workerChoices(1)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(workerChoices(4).at(-1)).toBe(12);
  });

  it("separates only with a node per control plane and one left for workers", () => {
    expect(separatePossible(layout(3, 1), 4)).toBe(true);
    expect(separatePossible(layout(3, 1), 3)).toBe(false);
    expect(separatePossible(layout(3, 0), 6)).toBe(false);
  });

  // read-side: the choice stays, and comes back once it fits again
  it("falls back to shared where separate can't be", () => {
    expect(effectiveK8sPlacement(layout(3, 3, "separate"), 3)).toBe("shared");
    expect(effectiveK8sPlacement(layout(3, 3, "separate"), 6)).toBe("separate");
    expect(effectiveK8sPlacement(layout(3, 3, "shared"), 6)).toBe("shared");
  });
});

describe("placement", () => {
  it("spreads control planes over distinct nodes, then the workers", () => {
    expect(where(layout(3, 3), 3)).toEqual(["cp@0", "cp@1", "cp@2", "w@0", "w@1", "w@2"]);
    // the fourth node takes the first worker — it has nothing yet
    expect(where(layout(3, 4), 4)).toEqual(["cp@0", "cp@1", "cp@2", "w@3", "w@0", "w@1", "w@2"]);
  });

  it("keeps workers off the control planes' nodes when separate", () => {
    expect(where(layout(3, 4, "separate"), 5)).toEqual(["cp@0", "cp@1", "cp@2", "w@3", "w@4", "w@3", "w@4"]);
  });

  it("doubles up once there are more vms than nodes", () => {
    expect(where(layout(3, 1), 2)).toEqual(["cp@0", "cp@1", "cp@0", "w@1"]);
    expect(where(layout(1, 0), 1)).toEqual(["cp@0"]);
  });

  it("counts each node's roles", () => {
    expect(slotsByNode(placeK8s(layout(3, 1), 2), 2)).toEqual([
      { controlPlanes: 2, workers: 0 },
      { controlPlanes: 1, workers: 1 },
    ]);
  });
});

describe("the vms", () => {
  it("makes talos vms by role, named, tagged and sized", () => {
    const added = k8sGuests(layout(3, 3), [], ctx());
    expect(added.map((g) => g.name)).toEqual(["k8s-cp-01", "k8s-cp-02", "k8s-cp-03", "k8s-worker-01", "k8s-worker-02", "k8s-worker-03"]);
    expect(added.map((g) => g.node)).toEqual(["0", "1", "2", "0", "1", "2"]);
    expect(added.map((g) => g.vmid)).toEqual(["100", "101", "102", "103", "104", "105"]);
    expect(added.every((g) => g.image === "talos" && g.kind === "vm" && !g.ballooning)).toBe(true);
    expect(added[0]).toMatchObject({ k8sRole: "control-plane", tags: "k8s;control-plane", cores: "2", memoryGb: "4", bios: "ovmf", tpm: true });
    expect(added[3]).toMatchObject({ k8sRole: "worker", tags: "k8s;worker", cores: "4", memoryGb: "8" });
    expect(added[3].disks[0].sizeGb).toBe("64");
  });

  // never ha, so never on another node's cpu
  it("passes the node's own cpu through", () => {
    const added = k8sGuests(layout(1, 1), [], ctx());
    expect(added.map((g) => g.cpuType)).toEqual(["host", "host"]);
    expect(added.map((g) => effectiveGuestCpuType(g, ctx()))).toEqual(["host", "host"]);
  });

  // never ha, so nothing gained by replicating their disks — and etcd wants local latency
  it("keeps their disks on node-local storage, never ha", () => {
    const added = k8sGuests(layout(1, 1), [], ctx());
    expect(added.every((g) => g.disks[0].storage === "local-lvm" && !g.ha)).toBe(true);
    const withLocalPool = ctx(3, { nodes: cluster(3, { additionalDisks: disks(1000, { role: "local" }) }) });
    expect(k8sGuests(layout(1, 0), [], withLocalPool)[0].disks[0].storage).toBe(withLocalPool.storage.local.name);
  });

  it("numbers after the guests that stay", () => {
    const web = newGuest("vm", [], ctx(), { name: "k8s-cp-01" });
    const added = k8sGuests(layout(1, 1), [web], ctx());
    expect(added.map((g) => `${g.name}/${g.vmid}`)).toEqual(["k8s-cp-02/101", "k8s-worker-01/102"]);
  });

  it("replaces the kubernetes vms and keeps every other guest", () => {
    const web = newGuest("vm", [], ctx(), { name: "web" });
    const first = applyK8sLayout(layout(3, 3), [web], ctx());
    expect(first).toHaveLength(7);
    const second = applyK8sLayout(layout(1, 2), first, ctx());
    expect(second.map((g) => g.name)).toEqual(["web", "k8s-cp-01", "k8s-worker-01", "k8s-worker-02"]);
    expect(second[0]).toBe(web);
  });

  it("reads the layout back from the vms, for re-planning", () => {
    const c = ctx(6);
    expect(currentK8sLayout([], 6)).toEqual(defaultK8sLayout(6));
    expect(currentK8sLayout(applyK8sLayout(layout(3, 3, "separate"), [], c), 6)).toEqual(layout(3, 3, "separate"));
    expect(currentK8sLayout(applyK8sLayout(layout(3, 6), [], c), 6)).toEqual(layout(3, 6, "shared"));
    expect(currentK8sLayout(applyK8sLayout(layout(1, 0), [], c), 6)).toEqual(layout(1, 0, "shared"));
  });

  it("proposes an odd count when the vms were edited to an even one", () => {
    const [cp, ...rest] = applyK8sLayout(layout(3, 3), [], ctx());
    expect(currentK8sLayout(rest, 3).controlPlanes).toBe(3);
    expect(currentK8sLayout([cp, ...rest], 3).controlPlanes).toBe(3);
  });
});

describe("layout hints", () => {
  it("warns when control planes have to share a node", () => {
    expect(k8sLayoutHints(layout(3, 2), 2)[0]).toMatchObject({ tone: "warning" });
    expect(k8sLayoutHints(layout(3, 2), 2)[0].text).toMatch(/3 control planes on 2 nodes/);
    expect(k8sLayoutHints(layout(3, 3), 3)).toEqual([]);
  });

  it("notes a single control plane only where three would fit", () => {
    expect(k8sLayoutHints(layout(1, 3), 3)[0].text).toMatch(/one control plane/);
    expect(k8sLayoutHints(layout(1, 2), 2)).toEqual([]);
  });

  it("notes pods on the control planes without workers", () => {
    expect(k8sLayoutHints(layout(3, 0), 3).map((h) => h.text).join()).toMatch(/allowSchedulingOnControlPlanes/);
  });
});

describe("cephReachHint", () => {
  const withCeph = (bridges: Record<string, ReturnType<typeof bridge>>) =>
    ctx(3, {
      nodes: cluster(3, { additionalDisks: disks(1000), network: network({ bridgeCounts: { "nic-0": "1", "nic-1": "1" }, bridges }) }),
    });
  const k8s = (c: GuestContext) => applyK8sLayout(layout(1, 1), [], c);

  it("stays quiet when the vms share a bridge with ceph", () => {
    const c = withCeph({ "nic-0#0": bridge({ purposes: ["vm", "ceph"] }) });
    expect(cephReachHint(k8s(c), c)).toBeNull();
  });

  it("flags ceph on its own link, which vms can't join", () => {
    const c = withCeph({ "nic-0#0": bridge(), "nic-1#0": bridge({ name: "vmbr1", purposes: ["ceph"], ip: "10.0.20.11/24" }) });
    expect(cephReachHint(k8s(c), c)?.text).toMatch(/own link \(10\.0\.20\.0\/24\) with no bridge/);
  });

  it("flags a vm with no nic on ceph's bridge", () => {
    const c = withCeph({ "nic-0#0": bridge({ purposes: ["vm", "ceph"] }) });
    const guests = k8s(c).map((g) => ({ ...g, nics: g.nics.map((n) => ({ ...n, bridge: "vmbr9" })) }));
    expect(cephReachHint(guests, c)?.text).toMatch(/no nic on — add one on vmbr0/);
  });

  it("stays quiet without ceph volumes or kubernetes vms", () => {
    const c = withCeph({ "nic-0#0": bridge(), "nic-1#0": bridge({ name: "vmbr1", purposes: ["ceph"], ip: "10.0.20.11/24" }) });
    expect(cephReachHint([newGuest("vm", [], c)], c)).toBeNull();
    const off = { ...c, kubernetes: { cephVolumes: false, volumeGb: "200" } };
    expect(cephReachHint(k8s(off), off)).toBeNull();
  });
});
