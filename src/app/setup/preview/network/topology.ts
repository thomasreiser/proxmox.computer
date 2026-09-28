// Turns the wizard's raw NodeInfo[] into the shape the network preview
// actually draws: one physical cable per nic, grouped under whichever
// logical interface (a lone nic, or a bond) it belongs to, each carrying
// the bridges/vlans configured on that interface.

import {
  bondModeLabel,
  bridgeCountFor,
  bridgeKey,
  interfacesFor,
  needsHostIpForPurposes,
  nicIndicesForInterface,
  type InterfacePurpose,
  type NicSpeed,
  type NodeInfo,
} from "../../wizard-state";

// what a bridge's slot actually carries: the interface's one plain
// untagged/native bridge (index 0, when its bond has no vlan override of
// its own — homelabVlan is the cluster-wide "main homelab vlan", already
// resolved by the time this is built, or null if that's unset too); a
// bridge properly stacked on a real vlan via 802.1q — either an extra
// bridge (index 1+) or index 0 itself when its own bond was given a vlan
// tag, since that makes the bond's own link tagged rather than native; or
// an extra bridge the visitor has added but not yet given a vlan tag,
// which is a distinct, in-progress state from "untagged" and shouldn't be
// silently drawn as if it were the native one.
export type BridgeVlan =
  | { kind: "native"; homelabVlan: number | null }
  | { kind: "tagged"; tag: number }
  | { kind: "unset" };

// the one addressing fact worth drawing per bridge — and which of the two
// very different things it is. "host" is an address the node itself
// answers on; "network" is only the subnet the bridge switches for its
// vms/cts, where no host address exists at all. drawing a subnet as if it
// were the node's ip would be actively misleading, so the kind travels
// with the value rather than being re-derived at render time.
export type BridgeAddressKind = "host" | "network";

export interface BridgeAddress {
  kind: BridgeAddressKind;
  // "" until the visitor fills it in — still worth drawing as a labelled,
  // obviously-empty slot, since a missing address is a real gap in the
  // plan rather than something to hide.
  cidr: string;
}

export interface BridgeSummary {
  name: string;
  vlan: BridgeVlan;
  purposes: InterfacePurpose[];
  address: BridgeAddress;
}

export interface InterfaceTopology {
  id: string; // "nic-<i>" or "bond-<i>", matches interfacesFor's ids
  nicIndices: number[];
  bond: { name: string; modeLabel: string } | null;
  // a css color() value — a distinct hue per bond so its member cables
  // (and this card's header) visibly match; the neutral border color for
  // a plain, unbonded nic.
  colorVar: string;
  bridges: BridgeSummary[];
  isManagement: boolean;
  // this link carries ceph replication traffic, which is the one purpose
  // with a physical-layout consequence the diagram can actually show: every
  // ceph port in the cluster has to land on one switch (see cephNote in
  // ./page.tsx), so the drawing marks them at both ends of the cable.
  carriesCeph: boolean;
}

export interface CableInfo {
  id: string;
  nodeIndex: number;
  nicIndex: number;
  nicName: string;
  nicSpeed: NicSpeed;
  iface: InterfaceTopology;
}

export interface NodeTopology {
  nodeIndex: number;
  node: NodeInfo;
  // hostLabel + the cluster's domain suffix, already joined — falls back
  // to the bare label (or the node's name) when no suffix is set.
  fqdn: string;
  // the address you actually reach this box at: proxmox's web ui and ssh,
  // on the management bridge. kept at the node level because it's the one
  // number a visitor scans the diagram for.
  managementAddress: string;
  interfaces: InterfaceTopology[];
  // one entry per physical nic, in nic order — what the preview actually
  // draws a separate cable for, bonded or not.
  cables: CableInfo[];
}

// a handful of distinct, non-semantic hues for telling bonds apart on
// sight — kept separate from brand/accent/warning/danger, which already
// mean something else (primary/highlight/caution/error) elsewhere in
// this app. sized for the actual worst case: a bond needs 2+ nics, and a
// node can have at most MAX_NICS_PER_NODE (8) of them, so no single node
// ever has more than floor(8 / 2) = 4 bonds needing a color at once —
// this palette resets per node (see buildClusterTopology) specifically so
// 4 is always enough, never a coincidence.
const BOND_COLORS = ["--cable-a", "--cable-b", "--cable-c", "--cable-d"];

export const NEUTRAL_CABLE_COLOR = "var(--border-strong)";

// dropped entirely when a bridge's only purpose is plain vm/ct traffic —
// that's the default, expected case, and spelling it out on every single
// bridge (of up to MAX_BRIDGES_PER_INTERFACE) just buries the purposes
// that are actually worth a second look.
const PURPOSE_SHORT: Record<InterfacePurpose, string> = {
  vm: "vm",
  ceph: "ceph",
  zfs: "zfs",
  backup: "backup",
  cluster: "corosync",
  other: "other",
};

export function bridgePurposesLabel(purposes: InterfacePurpose[]): string {
  if (purposes.length === 1 && purposes[0] === "vm") return "";
  return purposes.map((p) => PURPOSE_SHORT[p]).join("+");
}

export function vlanLabel(vlan: BridgeVlan): string {
  if (vlan.kind === "tagged") return `vlan ${vlan.tag}`;
  if (vlan.kind === "unset") return "vlan not set";
  return vlan.homelabVlan ? `vlan ${vlan.homelabVlan} (native)` : "native";
}

// names what the address next to it actually is, so a served subnet can't
// be misread as an address the node answers on.
export function addressKindLabel(kind: BridgeAddressKind): string {
  return kind === "host" ? "node ip" : "serves";
}

// every distinct real vlan number in play on this interface — a tagged
// extra bridge's own vlan, or (just as real a vlan, once it's resolved) a
// native bridge's homelabVlan, from either the bond's own override or the
// cluster-wide default. only a bare, unnumbered "native" contributes
// nothing here, since there's no actual vlan id to count.
export function distinctVlanTags(iface: InterfaceTopology): number[] {
  const tags = new Set<number>();
  for (const b of iface.bridges) {
    if (b.vlan.kind === "tagged") tags.add(b.vlan.tag);
    else if (b.vlan.kind === "native" && b.vlan.homelabVlan !== null) tags.add(b.vlan.homelabVlan);
  }
  return [...tags].sort((a, b) => a - b);
}

// a bare vlan id, 1-4094, or null for "blank/invalid" — shared by a
// bridge's own tag and (elsewhere in this file) a bond's optional
// override of the native vlan.
function parseVlanNumber(raw: string): number | null {
  const n = Number(raw);
  return raw && Number.isInteger(n) && n >= 1 && n <= 4094 ? n : null;
}

function parseVlanTag(raw: string): BridgeVlan {
  const n = parseVlanNumber(raw);
  return n === null ? { kind: "unset" } : { kind: "tagged", tag: n };
}

// the cluster-wide settings a single node's drawing still depends on —
// both live outside NodeInfo, on the wizard's top-level state.
export interface ClusterContext {
  // the vlan the untagged/native segment rides, or null for "unnumbered"
  homelabVlan: number | null;
  // the domain every node's hostLabel gets suffixed with, or ""
  hostnameSuffix: string;
}

export function buildClusterTopology(nodes: NodeInfo[], ctx: ClusterContext): NodeTopology[] {
  const { homelabVlan, hostnameSuffix } = ctx;
  return nodes.map((node, nodeIndex) => {
    const refs = interfacesFor(node.nics, node.network.bonds);
    // reset per node, not across the cluster — see BOND_COLORS above for
    // why 4 colors is a proven bound only when scoped this way.
    let bondColorCount = 0;

    const interfaces: InterfaceTopology[] = refs.map((ref) => {
      const isBond = ref.id.startsWith("bond-");
      const bondIndex = isBond ? Number(ref.id.slice("bond-".length)) : -1;
      const bondConfig = isBond ? node.network.bonds[bondIndex] : undefined;
      const nicIndices = nicIndicesForInterface(ref.id, node.network.bonds);

      const colorVar = bondConfig ? `var(${BOND_COLORS[bondColorCount++ % BOND_COLORS.length]})` : NEUTRAL_CABLE_COLOR;
      // a bond's own vlan tag, when set, means this bond's link is itself
      // tagged (802.1q) at that vlan — not the plain untagged/native link
      // the cluster's homelabVlan describes. so it replaces the native
      // slot's "native" kind entirely rather than just attaching a number
      // to it; ungrouped nics have no such override and always fall back
      // to the cluster-wide native vlan.
      const bondVlanOverride = bondConfig ? parseVlanNumber(bondConfig.vlanTag) : null;

      const isManagement = node.network.managementInterfaceId === ref.id;

      const count = bridgeCountFor(node.network.bridgeCounts, ref.id);
      const bridges: BridgeSummary[] = [];
      for (let idx = 0; idx < count; idx++) {
        const bridge = node.network.bridges[bridgeKey(ref.id, idx)];
        if (!bridge || !bridge.enabled) continue;
        const vlan: BridgeVlan =
          idx === 0
            ? bondVlanOverride !== null
              ? { kind: "tagged", tag: bondVlanOverride }
              : { kind: "native", homelabVlan }
            : parseVlanTag(bridge.vlanTag);
        // the management bridge is the one exception to "a bridge's
        // address is its own ip field": the form asks for it once, up with
        // the hostname, and stores it on NodeNetwork.cidr — so its own ip
        // field is never filled in. it's always a host address by
        // definition (it's how you reach the web ui), never a bare subnet.
        const address: BridgeAddress =
          isManagement && idx === 0
            ? { kind: "host", cidr: node.network.cidr }
            : {
                kind: needsHostIpForPurposes(bridge.purposes, bridge.otherNeedsHostIp) ? "host" : "network",
                cidr: bridge.ip,
              };
        bridges.push({ name: bridge.name, vlan, purposes: bridge.purposes, address });
      }

      return {
        id: ref.id,
        nicIndices,
        bond: bondConfig ? { name: bondConfig.name, modeLabel: bondModeLabel(bondConfig.mode) } : null,
        colorVar,
        bridges,
        isManagement,
        carriesCeph: bridges.some((b) => b.purposes.includes("ceph")),
      };
    });

    const ifaceByNic = new Map<number, InterfaceTopology>();
    for (const iface of interfaces) {
      for (const nicIndex of iface.nicIndices) ifaceByNic.set(nicIndex, iface);
    }

    // every physical nic gets its own cable regardless of bonding — a
    // bond is several separate links to the same switch, not one thick
    // one, so this never collapses two nics into a single edge.
    const cables: CableInfo[] = node.nics.map((nic, nicIndex) => ({
      id: `${nodeIndex}-nic-${nicIndex}`,
      nodeIndex,
      nicIndex,
      nicName: nic.name,
      nicSpeed: nic.speed,
      // a nic can only be missing an interface transiently, between a
      // structural edit and its resync — fall back to an unbonded, empty
      // interface rather than crash the preview mid-edit.
      iface: ifaceByNic.get(nicIndex) ?? {
        id: `nic-${nicIndex}`,
        nicIndices: [nicIndex],
        bond: null,
        colorVar: NEUTRAL_CABLE_COLOR,
        bridges: [],
        isManagement: false,
        carriesCeph: false,
      },
    }));

    const label = node.network.hostLabel || node.name;
    return {
      nodeIndex,
      node,
      fqdn: hostnameSuffix ? `${label}.${hostnameSuffix}` : label,
      managementAddress: node.network.cidr,
      interfaces,
      cables,
    };
  });
}

// how many physical links in the whole cluster carry ceph — drives both
// the summary strip and whether the "keep these on one switch" note is
// worth showing at all.
export function cephCableCount(topologies: NodeTopology[]): number {
  return topologies.reduce((n, t) => n + t.cables.filter((c) => c.iface.carriesCeph).length, 0);
}
