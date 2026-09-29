import { describe, expect, it } from "vitest";
import {
  addressKindLabel,
  bridgePurposesLabel,
  buildClusterTopology,
  cephCableCount,
  distinctVlanTags,
  lagGroups,
  portLagLabel,
  switchLagFor,
  portVlanDescription,
  portVlanLabel,
  vlanLabel,
} from "./topology";
import { bond, bridge, cluster, network, nics, node } from "../../test-fixtures";

const ctx = { homelabVlan: null, hostnameSuffix: "lab.lan" };

describe("buildClusterTopology", () => {
  it("draws one cable per physical nic, bonded or not", () => {
    const nodes = cluster(1, {
      nics: nics("1gbe", "1gbe", "10gbe"),
      network: network({ bonds: [bond({ nicIndices: [0, 1] })], bridges: { "nic-2#0": bridge() } }),
    });
    expect(buildClusterTopology(nodes, ctx)[0].cables).toHaveLength(3);
  });

  it("joins the host label and the cluster domain into an fqdn", () => {
    expect(buildClusterTopology(cluster(1), ctx)[0].fqdn).toBe("pve01.lab.lan");
  });

  it("falls back to the bare label when no domain is set", () => {
    expect(buildClusterTopology(cluster(1), { ...ctx, hostnameSuffix: "" })[0].fqdn).toBe("pve01");
  });

  // bond hues are per node so the palette can never run out: a node has
  // at most 8 nics, so at most 4 bonds.
  it("gives each bond on a node its own color, resetting per node", () => {
    const nodes = cluster(2, {
      nics: nics("1gbe", "1gbe", "1gbe", "1gbe"),
      network: network({
        bonds: [bond({ name: "bond0", nicIndices: [0, 1] }), bond({ name: "bond1", nicIndices: [2, 3] })],
        bridges: { "bond-0#0": bridge(), "bond-1#0": bridge() },
      }),
    });
    const [first, second] = buildClusterTopology(nodes, ctx);
    const colors = first.interfaces.map((i) => i.colorVar);
    expect(new Set(colors).size).toBe(colors.length);
    expect(second.interfaces.map((i) => i.colorVar)).toEqual(colors);
  });

  it("marks the management interface", () => {
    const topo = buildClusterTopology(cluster(1), ctx)[0];
    expect(topo.interfaces.filter((i) => i.isManagement)).toHaveLength(1);
  });

  it("reads the management address off the node, not its bridge ip", () => {
    expect(buildClusterTopology(cluster(1), ctx)[0].managementAddress).toBe("10.0.0.11/24");
  });
});

describe("bridge addressing", () => {
  it("labels a bridge the host answers on as a node ip", () => {
    const nodes = cluster(1, {
      network: network({
        managementInterfaceId: "nic-0",
        bridgeCounts: { "nic-0": "1", "nic-1": "1" },
        bridges: {
          "nic-0#0": bridge(),
          "nic-1#0": bridge({ purposes: ["ceph"], ip: "10.0.20.11/24" }),
        },
      }),
    });
    const iface = buildClusterTopology(nodes, ctx)[0].interfaces.find((i) => i.id === "nic-1");
    expect(iface?.bridges[0].address).toEqual({ kind: "host", cidr: "10.0.20.11/24" });
  });

  // ceph/zfs off management have no bridge: the address is the nic's own
  it("draws a storage link under its nic's name, not a bridge", () => {
    const n = nics("1gbe", "10gbe");
    n[1].name = "storage";
    const nodes = cluster(1, {
      nics: n,
      network: network({
        bridgeCounts: { "nic-0": "1", "nic-1": "1" },
        bridges: { "nic-0#0": bridge({ name: "vmbr0" }), "nic-1#0": bridge({ name: "vmbr1", purposes: ["ceph"] }) },
      }),
    });
    const [mgmt, storage] = buildClusterTopology(nodes, ctx)[0].interfaces;
    expect(storage.bridges[0]).toMatchObject({ name: "storage", storageLink: true });
    expect(mgmt.bridges[0]).toMatchObject({ name: "vmbr0", storageLink: false });
  });

  it("keeps the management bridge a bridge even when it carries ceph", () => {
    const nodes = cluster(1, { network: network({ bridges: { "nic-0#0": bridge({ name: "vmbr0", purposes: ["vm", "ceph"] }) } }) });
    expect(buildClusterTopology(nodes, ctx)[0].interfaces[0].bridges[0].storageLink).toBe(false);
  });

  // drawing a served subnet as if it were the node's own address would be
  // actively misleading, so the kind travels with the value.
  it("labels a pure vm bridge's value as a served subnet", () => {
    const nodes = cluster(1, {
      network: network({
        managementInterfaceId: "nic-0",
        bridgeCounts: { "nic-0": "1", "nic-1": "1" },
        bridges: { "nic-0#0": bridge(), "nic-1#0": bridge({ purposes: ["vm"], ip: "10.0.40.0/24" }) },
      }),
    });
    const iface = buildClusterTopology(nodes, ctx)[0].interfaces.find((i) => i.id === "nic-1");
    expect(iface?.bridges[0].address).toEqual({ kind: "network", cidr: "10.0.40.0/24" });
  });

  it("names the two kinds distinctly", () => {
    expect(addressKindLabel("host")).toBe("node ip");
    expect(addressKindLabel("network")).toBe("serves");
  });
});

describe("vlan resolution", () => {
  it("treats a bridge at index 0 as the interface's native one", () => {
    const iface = buildClusterTopology(cluster(1), ctx)[0].interfaces[0];
    expect(iface.bridges[0].vlan).toEqual({ kind: "native", homelabVlan: null });
  });

  it("carries the cluster-wide native vlan when one is numbered", () => {
    const iface = buildClusterTopology(cluster(1), { ...ctx, homelabVlan: 5 })[0].interfaces[0];
    expect(iface.bridges[0].vlan).toEqual({ kind: "native", homelabVlan: 5 });
  });

  // a bond with its own tag makes its link tagged rather than native, so
  // index 0 stops being the native slot.
  it("lets a bond's own tag override the native slot", () => {
    const nodes = cluster(1, {
      nics: nics("1gbe", "1gbe"),
      network: network({
        bonds: [bond({ nicIndices: [0, 1], vlanTag: "77" })],
        managementInterfaceId: "bond-0",
        bridges: { "bond-0#0": bridge() },
      }),
    });
    const iface = buildClusterTopology(nodes, ctx)[0].interfaces[0];
    expect(iface.bridges[0].vlan).toEqual({ kind: "tagged", tag: 77 });
  });

  it("distinguishes an untagged extra bridge from a native one", () => {
    const nodes = cluster(1, {
      network: network({
        bridgeCounts: { "nic-0": "2" },
        bridges: { "nic-0#0": bridge(), "nic-0#1": bridge({ vlanTag: "" }) },
      }),
    });
    const iface = buildClusterTopology(nodes, ctx)[0].interfaces[0];
    expect(iface.bridges[1].vlan).toEqual({ kind: "unset" });
  });

  it.each([["0"], ["4095"], ["abc"]])("treats an out-of-range tag %s as unset", (raw) => {
    const nodes = cluster(1, {
      network: network({
        bridgeCounts: { "nic-0": "2" },
        bridges: { "nic-0#0": bridge(), "nic-0#1": bridge({ vlanTag: raw }) },
      }),
    });
    expect(buildClusterTopology(nodes, ctx)[0].interfaces[0].bridges[1].vlan).toEqual({ kind: "unset" });
  });

  it("words each vlan state for the drawing", () => {
    expect(vlanLabel({ kind: "tagged", tag: 20 })).toBe("vlan 20");
    expect(vlanLabel({ kind: "unset" })).toBe("vlan not set");
    expect(vlanLabel({ kind: "native", homelabVlan: null })).toBe("native");
    expect(vlanLabel({ kind: "native", homelabVlan: 5 })).toBe("vlan 5 (native)");
  });

  it("counts a numbered native vlan as a real vlan in use", () => {
    const iface = buildClusterTopology(cluster(1), { ...ctx, homelabVlan: 5 })[0].interfaces[0];
    expect(distinctVlanTags(iface)).toEqual([5]);
  });

  it("counts an unnumbered native vlan as nothing", () => {
    expect(distinctVlanTags(buildClusterTopology(cluster(1), ctx)[0].interfaces[0])).toEqual([]);
  });
});

describe("bridgePurposesLabel", () => {
  // plain vm traffic is the expected default; spelling it out on every
  // bridge would bury the purposes actually worth a second look.
  it("stays empty for a plain vm bridge", () => {
    expect(bridgePurposesLabel(["vm"])).toBe("");
  });

  it("shortens corosync and joins the rest", () => {
    expect(bridgePurposesLabel(["vm", "cluster"])).toBe("vm+corosync");
    expect(bridgePurposesLabel(["ceph"])).toBe("ceph");
  });
});

describe("cephCableCount", () => {
  const withCeph = (count: number) =>
    cluster(count, {
      nics: nics("10gbe", "10gbe", "10gbe"),
      network: network({
        managementInterfaceId: "nic-0",
        bonds: [bond({ nicIndices: [1, 2] })],
        bridgeCounts: { "nic-0": "1", "bond-0": "1" },
        bridges: { "nic-0#0": bridge(), "bond-0#0": bridge({ purposes: ["ceph"], ip: "10.0.20.11/24" }) },
      }),
    });

  it("counts every physical link behind a ceph bridge, not just the bridge", () => {
    expect(cephCableCount(buildClusterTopology(withCeph(3), ctx))).toBe(6);
  });

  it("counts nothing when no bridge carries ceph", () => {
    expect(cephCableCount(buildClusterTopology(cluster(3), ctx))).toBe(0);
  });

  it("marks the interface itself so both cable ends can agree", () => {
    const topo = buildClusterTopology(withCeph(1), ctx)[0];
    expect(topo.interfaces.find((i) => i.id === "bond-0")?.carriesCeph).toBe(true);
    expect(topo.interfaces.find((i) => i.id === "nic-0")?.carriesCeph).toBe(false);
  });
});

describe("resilience to mid-edit state", () => {
  // a node mid-edit can have nics with no bridges configured at all —
  // every nic still gets a cable and an interface to hang it off.
  it("draws a cable for every nic even with no bridges configured", () => {
    const nodes = [node({ nics: nics("1gbe", "1gbe"), network: network({ bonds: [], bridges: {} }) })];
    const topo = buildClusterTopology(nodes, ctx)[0];
    expect(topo.cables).toHaveLength(2);
    expect(topo.cables.every((c) => c.iface !== undefined)).toBe(true);
  });
});

describe("switch port labels", () => {
  const ifaceWith = (bridges: ReturnType<typeof bridge>[], homelabVlan: number | null = null) => {
    const counts = { "nic-0": String(bridges.length) };
    const map = Object.fromEntries(bridges.map((b, i) => [`nic-0#${i}`, b]));
    const nodes = cluster(1, { network: network({ bridgeCounts: counts, bridges: map }) });
    return buildClusterTopology(nodes, { ...ctx, homelabVlan })[0].interfaces[0];
  };

  it("marks a plain untagged port", () => {
    expect(portVlanLabel(ifaceWith([bridge()]))).toBe("u");
    expect(portVlanDescription(ifaceWith([bridge()]))).toBe("untagged");
  });

  it("names the native vlan when the homelab numbers it", () => {
    expect(portVlanLabel(ifaceWith([bridge()], 5))).toBe("u5");
  });

  it("lists tagged vlans after the native one, sorted", () => {
    const iface = ifaceWith([bridge(), bridge({ vlanTag: "30" }), bridge({ vlanTag: "20" })]);
    expect(portVlanLabel(iface)).toBe("u t20,30");
    expect(portVlanDescription(iface)).toBe("untagged · tagged: vlan 20, 30");
  });

  // a port can't be configured until every bridge on it has its tag
  it("flags a tagged bridge still missing its tag", () => {
    const iface = ifaceWith([bridge(), bridge({ vlanTag: "" })]);
    expect(portVlanLabel(iface)).toBe("u t?");
    expect(portVlanDescription(iface)).toMatch(/no vlan set yet/);
  });

  it("says there's nothing to configure without bridges", () => {
    const iface = buildClusterTopology([node({ network: network({ bridges: {} }) })], ctx)[0].interfaces[0];
    expect(portVlanLabel(iface)).toBe("—");
  });

  it("carries each nic's connector onto its cable", () => {
    const nodes = cluster(1, { nics: nics({ speed: "10gbe" }, { speed: "10gbe", port: "rj45" }, "other") });
    const ports = buildClusterTopology(nodes, ctx)[0].cables.map((c) => c.nicPort);
    expect(ports).toEqual(["sfp+", "rj45", null]);
  });
});

describe("switch lags", () => {
  it("knows which bond modes need the switch's help", () => {
    expect(switchLagFor("lacp")).toBe("lacp");
    expect(switchLagFor("balance-rr")).toBe("static");
    expect(switchLagFor("active-backup")).toBeNull();
    expect(switchLagFor("balance-alb")).toBeNull();
  });

  // two lacp bonds on one node, like a management bond plus a ceph bond
  const twoLacpBonds = () => {
    const n = nics("2.5gbe", "2.5gbe", "10gbe", "10gbe");
    ["proxmox-1", "proxmox-2", "ceph-1", "ceph-2"].forEach((name, i) => (n[i].name = name));
    return cluster(1, {
      nics: n,
      network: network({
        bondCount: "2",
        bonds: [
          bond({ name: "bond0", mode: "lacp", nicIndices: [0, 1] }),
          bond({ name: "bond1", mode: "lacp", nicIndices: [2, 3] }),
        ],
        managementInterfaceId: "bond-0",
        bridgeCounts: { "bond-0": "1", "bond-1": "1" },
        bridges: { "bond-0#0": bridge({ name: "vmbr0" }), "bond-1#0": bridge({ purposes: ["ceph"] }) },
      }),
    });
  };

  it("lists every bond whose ports form a lag, with its ports", () => {
    expect(lagGroups(buildClusterTopology(twoLacpBonds(), ctx))).toEqual([
      { fqdn: "pve01.lab.lan", bondName: "bond0", lag: "lacp", ports: ["proxmox-1", "proxmox-2"] },
      { fqdn: "pve01.lab.lan", bondName: "bond1", lag: "lacp", ports: ["ceph-1", "ceph-2"] },
    ]);
  });

  it("tags each member port with its lag", () => {
    const [bond0, bond1] = buildClusterTopology(twoLacpBonds(), ctx)[0].interfaces;
    expect(portLagLabel(bond0)).toBe("lacp bond0");
    expect(portLagLabel(bond1)).toBe("lacp bond1");
  });

  it("asks nothing of the switch for an active-backup bond or a plain nic", () => {
    const nodes = cluster(1, {
      nics: nics("1gbe", "1gbe", "1gbe"),
      network: network({
        bondCount: "1",
        bonds: [bond({ nicIndices: [1, 2] })],
        bridgeCounts: { "nic-0": "1", "bond-0": "1" },
        bridges: { "nic-0#0": bridge(), "bond-0#0": bridge({ name: "vmbr1" }) },
      }),
    });
    const topology = buildClusterTopology(nodes, ctx);
    expect(lagGroups(topology)).toEqual([]);
    expect(topology[0].interfaces.map(portLagLabel)).toEqual(["", ""]);
  });
});
