import { describe, expect, it } from "vitest";
import {
  activeStoragePurposes,
  addressableBridgeKeys,
  applyNetworkStructure,
  applyStorageRoles,
  defaultAdditionalDisk,
  buildAddressConflicts,
  buildPlaceholderTable,
  clusterStorageDisksAvailable,
  collectAddressClaims,
  collectNodeNames,
  defaultHardware,
  defaultNode,
  deriveExampleSubnet,
  deriveGateway,
  deriveNodeCidr,
  effectiveClusterStorage,
  interfaceIdsFor,
  isDedicatedStorageBondPurpose,
  maxBondsForCluster,
  minAdditionalDisks,
  nextFreeHostInNetwork,
  nextVmbrName,
  nonCollidingPlaceholderSubnet,
  resizeArray,
  resyncNetworkForNics,
  siblingVlanTagsFor,
  withoutPurposes,
} from "./derive";
import { bond, bridge, cluster, disks, network, nics, node } from "./test-fixtures";

describe("cluster storage availability", () => {
  it("is set by the worst-equipped node, not an average", () => {
    const nodes = cluster(3);
    nodes[1].additionalDisks = [];
    expect(minAdditionalDisks(nodes)).toBe(0);
    expect(clusterStorageDisksAvailable(nodes)).toBe(false);
  });

  it("is available once every node has a disk beyond boot", () => {
    expect(clusterStorageDisksAvailable(cluster(3))).toBe(true);
  });

  it("reports 0 for an empty cluster rather than Infinity", () => {
    expect(minAdditionalDisks([])).toBe(0);
    expect(maxBondsForCluster([])).toBe(0);
  });

  it("caps the shared bond control at the node with the fewest nics", () => {
    const nodes = cluster(2);
    nodes[0].nicCount = "4";
    nodes[1].nicCount = "2";
    expect(maxBondsForCluster(nodes)).toBe(2);
  });
});

describe("effectiveClusterStorage", () => {
  const both = { ceph: true, zfs: true };
  const cephOnly = { ceph: true, zfs: false };
  const zfsOnly = { ceph: false, zfs: true };
  const neither = { ceph: false, zfs: false };

  // the choice is remembered but not honored while its prerequisites are
  // missing — add them back and it re-applies itself
  it("turns everything off below 2 nodes without discarding the choice", () => {
    expect(effectiveClusterStorage(both, cluster(1))).toEqual(neither);
  });

  it("turns everything off when a node has no spare disk", () => {
    const nodes = cluster(3);
    nodes[2].additionalDisks = [];
    expect(effectiveClusterStorage(cephOnly, nodes)).toEqual(neither);
    expect(effectiveClusterStorage(zfsOnly, nodes)).toEqual(neither);
  });

  it("honors either mode on its own with one spare disk per node", () => {
    expect(effectiveClusterStorage(cephOnly, cluster(3))).toBe(cephOnly);
    expect(effectiveClusterStorage(zfsOnly, cluster(2))).toBe(zfsOnly);
  });

  // ceph takes each osd disk whole, so zfs needs one of its own
  it("runs both only with two spare disks on every node", () => {
    expect(effectiveClusterStorage(both, cluster(3, { additionalDisks: disks(1000, 1000) }))).toBe(both);
  });

  // with one disk only one fits, and ceph is the one guests' disks live on
  it("keeps ceph and drops zfs when there's only room for one", () => {
    expect(effectiveClusterStorage(both, cluster(3))).toEqual(cephOnly);
  });

  it("returns the same object when nothing needs dropping", () => {
    expect(effectiveClusterStorage(neither, cluster(3))).toBe(neither);
  });

  it("names the nic purposes the enabled storage needs, ceph first", () => {
    expect(activeStoragePurposes(both)).toEqual(["ceph", "zfs"]);
    expect(activeStoragePurposes(zfsOnly)).toEqual(["zfs"]);
    expect(activeStoragePurposes(neither)).toEqual([]);
  });
});

describe("interfaceIdsFor", () => {
  it("lists unbonded nics then bonds", () => {
    expect(interfaceIdsFor(3, [bond({ nicIndices: [0, 1] })])).toEqual(["nic-2", "bond-0"]);
  });

  it("ignores a half-assembled bond", () => {
    expect(interfaceIdsFor(2, [bond({ nicIndices: [0] })])).toEqual(["nic-0", "nic-1"]);
  });
});

describe("siblingVlanTagsFor", () => {
  // a bridge must not be compared against itself, or every tag would read
  // as a duplicate of itself the moment it's typed.
  it("excludes the bridge being edited", () => {
    const bridges = {
      "nic-0#0": bridge({ vlanTag: "" }),
      "nic-0#1": bridge({ vlanTag: "20" }),
      "nic-0#2": bridge({ vlanTag: "30" }),
    };
    expect(siblingVlanTagsFor(bridges, 3, "nic-0", 1)).toEqual(["30"]);
  });

  it("ignores bridges on a different interface", () => {
    const bridges = { "nic-0#1": bridge({ vlanTag: "20" }), "nic-1#1": bridge({ vlanTag: "20" }) };
    expect(siblingVlanTagsFor(bridges, 2, "nic-0", 1)).toEqual([]);
  });
});

describe("collectNodeNames", () => {
  // disks and interfaces are separate namespaces — calling a disk "ceph"
  // and a nic "ceph" is fine, and must not read as a collision.
  it("keeps disk and interface names in separate namespaces", () => {
    const n = node({
      bootDiskName: "boot",
      additionalDisks: disks({ name: "ceph" }),
      nics: nics({ name: "ceph" }),
      network: network({ bonds: [bond({ name: "bond0" })], bridges: { "nic-0#0": bridge({ name: "vmbr0" }) } }),
    });
    const names = collectNodeNames(n);
    expect(names.disks).toEqual(["boot", "ceph"]);
    expect(names.interfaces).toEqual(expect.arrayContaining(["ceph", "bond0", "vmbr0"]));
  });
});

describe("address derivation", () => {
  it("numbers nodes from .11 on the global subnet", () => {
    expect(deriveNodeCidr("10.0.0.0/24", 0)).toBe("10.0.0.11/24");
    expect(deriveNodeCidr("10.0.0.0/24", 2)).toBe("10.0.0.13/24");
  });

  it("suggests .1 on the global subnet as the gateway", () => {
    expect(deriveGateway("10.0.0.0/24")).toBe("10.0.0.1");
    expect(deriveGateway("192.168.50.0/24")).toBe("192.168.50.1");
  });

  it("returns empty for a global cidr it can't parse", () => {
    expect(deriveNodeCidr("", 0)).toBe("");
    expect(deriveGateway("nonsense")).toBe("");
  });

  it("shifts the third octet to build an example subnet", () => {
    expect(deriveExampleSubnet("10.0.0.0/24", 10)).toEqual({ network: "10.0.10.0/24", host: "10.0.10.11/24" });
  });

  // the third octet wraps rather than overflowing into an invalid address.
  it("wraps the third octet past 255", () => {
    expect(deriveExampleSubnet("10.0.250.0/24", 10)?.network).toBe("10.0.4.0/24");
  });

  it("clamps the host octet into the usable range", () => {
    expect(deriveExampleSubnet("10.0.0.0/24", 0, 300)?.host).toBe("10.0.0.254/24");
    expect(deriveExampleSubnet("10.0.0.0/24", 0, 0)?.host).toBe("10.0.0.1/24");
  });
});

describe("nonCollidingPlaceholderSubnet", () => {
  it("steps past a subnet the node already uses", () => {
    const n = node({
      network: network({
        bridges: {
          "nic-0#0": bridge({ purposes: ["ceph"], ip: "10.0.10.11/24" }),
          "nic-1#0": bridge({ purposes: ["backup"], ip: "" }),
        },
      }),
    });
    const suggestion = nonCollidingPlaceholderSubnet(n, "10.0.0.0/24", 0, 0);
    expect(suggestion?.network).not.toBe("10.0.10.0/24");
  });

  it("returns null when the global cidr can't be parsed", () => {
    expect(nonCollidingPlaceholderSubnet(node(), "", 0, 0)).toBeNull();
  });
});

describe("buildPlaceholderTable", () => {
  const cephBridges = {
    "nic-0#0": bridge({ name: "vmbr0", purposes: ["vm"] }),
    "nic-1#0": bridge({ name: "vmbr1", purposes: ["ceph"], ip: "" }),
  };

  it("suggests a distinct host per node on one shared storage subnet", () => {
    const nodes = cluster(3).map((n) => ({ ...n, network: { ...n.network, bridges: { ...cephBridges } } }));
    const table = buildPlaceholderTable(nodes, "10.0.0.0/24");
    const hosts = [0, 1, 2].map((i) => table.get(`${i}#nic-1#0`)?.host);
    expect(new Set(hosts).size).toBe(3);
  });

  // once one node has committed to a subnet, the others are suggested
  // addresses on that same subnet rather than three unrelated ones.
  it("follows a subnet a sibling node already committed to", () => {
    const nodes = cluster(2).map((n) => ({ ...n, network: { ...n.network, bridges: { ...cephBridges } } }));
    nodes[0].network.bridges["nic-1#0"] = bridge({ name: "vmbr1", purposes: ["ceph"], ip: "172.16.9.5/24" });
    const table = buildPlaceholderTable(nodes, "10.0.0.0/24");
    expect(table.get("1#nic-1#0")?.host).toMatch(/^172\.16\.9\./);
  });

  it("never suggests a host already claimed by another node", () => {
    const nodes = cluster(2).map((n) => ({ ...n, network: { ...n.network, bridges: { ...cephBridges } } }));
    nodes[0].network.bridges["nic-1#0"] = bridge({ name: "vmbr1", purposes: ["ceph"], ip: "172.16.9.11/24" });
    const table = buildPlaceholderTable(nodes, "10.0.0.0/24");
    expect(table.get("1#nic-1#0")?.host).not.toBe("172.16.9.11/24");
  });

  it("skips a bridge that already has an address", () => {
    const nodes = cluster(1).map((n) => ({
      ...n,
      network: { ...n.network, bridges: { "nic-1#0": bridge({ purposes: ["ceph"], ip: "10.9.9.9/24" }) } },
    }));
    expect(buildPlaceholderTable(nodes, "10.0.0.0/24").has("0#nic-1#0")).toBe(false);
  });

  it("skips a disabled bridge", () => {
    const nodes = cluster(1).map((n) => ({
      ...n,
      network: { ...n.network, bridges: { "nic-1#0": bridge({ enabled: false, purposes: ["ceph"] }) } },
    }));
    expect(buildPlaceholderTable(nodes, "10.0.0.0/24").has("0#nic-1#0")).toBe(false);
  });
});

describe("addressableBridgeKeys", () => {
  it("skips the management bridge, whose address is asked for elsewhere", () => {
    const n = node({
      network: network({
        managementInterfaceId: "nic-0",
        bridgeCounts: { "nic-0": "1", "nic-1": "1" },
        bridges: { "nic-0#0": bridge(), "nic-1#0": bridge({ purposes: ["ceph"] }) },
      }),
    });
    expect(addressableBridgeKeys(n)).toEqual(["nic-1#0"]);
  });
});

describe("buildAddressConflicts", () => {
  it("finds nothing wrong with distinct addresses", () => {
    expect(buildAddressConflicts(cluster(3)).size).toBe(0);
  });

  // two nodes answering on the same address is the failure this exists
  // to catch — it only surfaces across nodes, so nothing local can see it.
  it("flags two nodes claiming the same management ip", () => {
    const nodes = cluster(2);
    nodes[1].network.cidr = nodes[0].network.cidr;
    expect(buildAddressConflicts(nodes).size).toBeGreaterThan(0);
  });

  it("flags a bridge ip colliding with another node's management ip", () => {
    const nodes = cluster(2);
    nodes[1].network.bridges = { "nic-1#0": bridge({ purposes: ["ceph"], ip: nodes[0].network.cidr }) };
    expect(buildAddressConflicts(nodes).size).toBeGreaterThan(0);
  });

  it("collects a claim per real address", () => {
    const claims = collectAddressClaims(cluster(2));
    expect(claims.filter((c) => c.key === "mgmt")).toHaveLength(2);
    expect(claims.every((c) => c.isReal || !c.isReal)).toBe(true);
  });
});

describe("resyncNetworkForNics", () => {
  it("drops bond members past the new nic count", () => {
    const net = network({ bonds: [bond({ nicIndices: [0, 1, 2] })] });
    expect(resyncNetworkForNics(net, 2).bonds[0].nicIndices).toEqual([0, 1]);
  });

  // a management choice pointing at an interface that no longer exists
  // would leave the node unreachable, so it falls back to the first one.
  it("reassigns management when its interface disappears", () => {
    const net = network({ managementInterfaceId: "nic-5" });
    expect(resyncNetworkForNics(net, 2).managementInterfaceId).toBe("nic-0");
  });

  it("keeps a management choice that survives", () => {
    const net = network({ managementInterfaceId: "nic-1" });
    expect(resyncNetworkForNics(net, 2).managementInterfaceId).toBe("nic-1");
  });

  it("carries forward bridge counts for surviving interfaces and defaults new ones", () => {
    const net = network({ bridgeCounts: { "nic-0": "3" } });
    const out = resyncNetworkForNics(net, 2);
    expect(out.bridgeCounts).toEqual({ "nic-0": "3", "nic-1": "1" });
  });
});

describe("applyNetworkStructure", () => {
  const template = network({
    managementInterfaceId: "nic-0",
    bridgeCounts: { "nic-0": "1", "nic-1": "1" },
    bridges: {
      "nic-0#0": bridge({ name: "vmbr0", purposes: ["vm", "cluster"] }),
      "nic-1#0": bridge({ name: "ceph0", purposes: ["ceph"], ip: "10.0.20.11/24" }),
    },
  });

  it("copies structure — names, purposes, enabled — to every node", () => {
    const out = applyNetworkStructure(cluster(3), template);
    for (const n of out) {
      expect(n.network.bridges["nic-1#0"].name).toBe("ceph0");
      expect(n.network.bridges["nic-1#0"].purposes).toEqual(["ceph"]);
      expect(n.network.managementInterfaceId).toBe("nic-0");
    }
  });

  // the whole point of the "identical network setup" split: structure is
  // shared, but an address a host actually answers on stays per-node.
  it("does not copy a host address across nodes", () => {
    const nodes = cluster(2);
    nodes[1].network.bridges = { "nic-1#0": bridge({ purposes: ["ceph"], ip: "10.0.20.99/24" }) };
    const out = applyNetworkStructure(nodes, template);
    expect(out[1].network.bridges["nic-1#0"].ip).toBe("10.0.20.99/24");
  });

  it("does copy a vm/ct subnet, which no host claims", () => {
    const vmTemplate = network({
      bridgeCounts: { "nic-0": "1", "nic-1": "1" },
      bridges: {
        "nic-0#0": bridge({ name: "vmbr0" }),
        "nic-1#0": bridge({ name: "vmbr1", purposes: ["vm"], ip: "10.0.40.0/24" }),
      },
    });
    const out = applyNetworkStructure(cluster(2), vmTemplate);
    expect(out[0].network.bridges["nic-1#0"].ip).toBe("10.0.40.0/24");
    expect(out[1].network.bridges["nic-1#0"].ip).toBe("10.0.40.0/24");
  });

  it("leaves hostname and management address untouched", () => {
    const out = applyNetworkStructure(cluster(3), template);
    expect(out.map((n) => n.network.hostLabel)).toEqual(["pve01", "pve02", "pve03"]);
    expect(out.map((n) => n.network.cidr)).toEqual(["10.0.0.11/24", "10.0.0.12/24", "10.0.0.13/24"]);
  });

  it("propagates an extra bridge added on the template node", () => {
    const withExtra = network({
      bridgeCounts: { "nic-0": "1", "nic-1": "2" },
      bridges: {
        "nic-0#0": bridge({ name: "vmbr0" }),
        "nic-1#0": bridge({ name: "vmbr1" }),
        "nic-1#1": bridge({ name: "vmbr2", vlanTag: "40" }),
      },
    });
    const out = applyNetworkStructure(cluster(2), withExtra);
    expect(out[1].network.bridges["nic-1#1"]).toMatchObject({ name: "vmbr2", vlanTag: "40" });
  });
});

describe("withoutPurposes", () => {
  // regression: it runs from an effect whose own setNodes re-triggers it,
  // so a fresh array when nothing was stripped looped the wizard forever
  it("returns the same array when no bridge carries a purpose being stripped", () => {
    const nodes = cluster(2);
    expect(withoutPurposes(nodes, ["ceph", "zfs"])).toBe(nodes);
  });

  it("returns the same array when nothing needs stripping", () => {
    const nodes = cluster(2);
    expect(withoutPurposes(nodes, [])).toBe(nodes);
  });

  it("removes a purpose that's no longer offered", () => {
    const nodes = cluster(1).map((n) => ({
      ...n,
      network: { ...n.network, bridges: { "nic-0#0": bridge({ purposes: ["vm", "ceph"] }) } },
    }));
    expect(withoutPurposes(nodes, ["ceph"])[0].network.bridges["nic-0#0"].purposes).toEqual(["vm"]);
  });

  // a bridge with no purpose at all isn't a valid state, so stripping the
  // last one falls back to plain vm traffic rather than leaving it empty.
  it("falls back to vm when the last purpose is stripped", () => {
    const nodes = cluster(1).map((n) => ({
      ...n,
      network: { ...n.network, bridges: { "nic-0#0": bridge({ purposes: ["ceph"] }) } },
    }));
    expect(withoutPurposes(nodes, ["ceph"])[0].network.bridges["nic-0#0"].purposes).toEqual(["vm"]);
  });
});

describe("nextVmbrName", () => {
  it("picks the lowest unused vmbrN", () => {
    expect(nextVmbrName({ a: bridge({ name: "vmbr0" }), b: bridge({ name: "vmbr2" }) })).toBe("vmbr1");
  });

  it("ignores names that aren't vmbrN", () => {
    expect(nextVmbrName({ a: bridge({ name: "ceph0" }) })).toBe("vmbr0");
  });
});

describe("resizeArray", () => {
  it("grows with the factory and truncates without touching survivors", () => {
    expect(resizeArray([1, 2], 4, (i) => i * 10)).toEqual([1, 2, 20, 30]);
    expect(resizeArray([1, 2, 3], 2, () => 0)).toEqual([1, 2]);
  });
});

describe("applyStorageRoles", () => {
  it("copies roles onto every node by disk position", () => {
    const nodes = cluster(3, { additionalDisks: disks(1000, 1000) });
    const template = disks({ role: "local" }, { role: "unused" });
    const out = applyStorageRoles(nodes, template);
    for (const n of out) {
      expect(n.additionalDisks.map((d) => d.role)).toEqual(["local", "unused"]);
    }
  });

  // a node with fewer disks takes as many roles as it has slots, rather
  // than inventing a disk to hold the extra role.
  it("stops at the shorter of the two lists", () => {
    const nodes = cluster(1, { additionalDisks: disks(1000) });
    const out = applyStorageRoles(nodes, disks({ role: "local" }, { role: "unused" }));
    expect(out[0].additionalDisks).toHaveLength(1);
    expect(out[0].additionalDisks[0].role).toBe("local");
  });

  // ...and a node with more leaves its extras alone, since the template
  // says nothing about them.
  it("leaves disks the template doesn't describe untouched", () => {
    const nodes = cluster(1, { additionalDisks: disks(1000, { role: "unused" }) });
    const out = applyStorageRoles(nodes, disks({ role: "local" }));
    expect(out[0].additionalDisks.map((d) => d.role)).toEqual(["local", "unused"]);
  });

  it("copies nothing but roles — sizes and names stay per node", () => {
    const nodes = cluster(1, { additionalDisks: disks({ sizeGb: "4000", name: "big" }) });
    const out = applyStorageRoles(nodes, disks({ sizeGb: "500", name: "small", role: "local" }));
    expect(out[0].additionalDisks[0]).toMatchObject({ sizeGb: "4000", name: "big", role: "local" });
  });
});

describe("defaults", () => {
  // a new disk has no role chosen yet — it resolves to the cluster storage
  // in effect (see effectiveDiskRole), since that's almost always why a
  // disk beyond boot was added
  it("starts a new disk with no role chosen", () => {
    expect(defaultAdditionalDisk(0).role).toBe("");
  });

  it("starts a node with matching nic count and nics", () => {
    const n = defaultNode(0, "10.0.0.0/24");
    expect(n.nics).toHaveLength(Number(n.nicCount));
    expect(n.network.cidr).toBe("10.0.0.11/24");
    expect(n.name).toBe("pve01");
  });

  it("gives default hardware a boot disk and no spare disks", () => {
    const hw = defaultHardware();
    expect(hw.bootDiskName).toBeTruthy();
    expect(hw.additionalDisks).toHaveLength(Number(hw.additionalDiskCount));
  });

  it("treats ceph and zfs as bonds that want the whole interface", () => {
    expect(isDedicatedStorageBondPurpose(["ceph"])).toBe(true);
    expect(isDedicatedStorageBondPurpose(["zfs"])).toBe(true);
    expect(isDedicatedStorageBondPurpose(["vm", "cluster"])).toBe(false);
  });
});

describe("placeholder fallbacks when everything is taken", () => {
  // after 25 candidates the allocator gives up gracefully rather than
  // looping — it returns the first suggestion even though it collides.
  it("falls back to the first suggestion once every candidate subnet is used", () => {
    const bridges: Record<string, ReturnType<typeof bridge>> = {};
    for (let i = 0; i < 30; i++) {
      bridges[`nic-${i}#0`] = bridge({ purposes: ["ceph"], ip: `10.0.${10 + i * 10}.11/24` });
    }
    const n = node({ network: network({ bridges }) });
    expect(nonCollidingPlaceholderSubnet(n, "10.0.0.0/24", 0, 0)?.network).toBe("10.0.10.0/24");
  });

  it("suggests .1 when every host in the network is reserved", () => {
    const reserved = new Set(Array.from({ length: 254 }, (_, i) => `10.0.20.${i + 1}`));
    expect(nextFreeHostInNetwork("10.0.20.0", reserved)).toBe("10.0.20.1");
  });

  it("skips reserved hosts and the network address itself", () => {
    expect(nextFreeHostInNetwork("10.0.20.0", new Set(["10.0.20.1", "10.0.20.2"]))).toBe("10.0.20.3");
  });
});
