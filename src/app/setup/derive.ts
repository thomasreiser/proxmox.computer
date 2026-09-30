// Everything the wizard computes rather than asks for: the defaults a new
// node starts from, the example addresses each field offers, the conflicts
// between addresses across nodes, and the rules for keeping one node's
// structure in sync with the others under "identical network setup".
//
// All pure — given the same nodes it produces the same answer — which is
// what lets the address maths (buildPlaceholderTable, buildAddressConflicts)
// be checked directly instead of inferred from what the form renders.

import {
  bridgeCountFor,
  bridgeKey,
  interfacesFor,
  isStorageLink,
  isStoragePurpose,
  needsHostIpForPurposes,
  type AdditionalDisk,
  type BondConfig,
  type BridgeConfig,
  type HardwareSpec,
  type InterfacePurpose,
  type NicInfo,
  type NodeInfo,
  type NodeNetwork,
  type ClusterStorage,
  enabledStorageModes,
  type StoragePlan,
} from "./wizard-state";
import { DEFAULT_CPU_FAMILY, defaultCoresFor } from "./cpu";
import { parseIpv4, subnetDetails } from "./validation";

export function defaultNicName(index: number): string {
  return `nic-${index + 1}`;
}

// a new disk starts in the cluster pool rather than unused: someone
// adding a disk beyond boot is almost always adding it *for* the cluster
// storage they picked, and step 4 is where they'd say otherwise.
export function defaultNic(index: number): NicInfo {
  return { speed: "1gbe", name: defaultNicName(index), port: "" };
}

export function defaultAdditionalDisk(index: number): AdditionalDisk {
  return { type: "hdd", sizeGb: "", name: `storage-${index + 1}`, role: "" };
}

export function defaultStoragePlan(): StoragePlan {
  return {
    ceph: { poolName: "ceph-vm", replicas: "3", minReplicas: "2" },
    zfs: { poolName: "tank", raidLevel: "mirror", replicationMinutes: "15" },
    local: { kind: "zfs", name: "local-zfs" },
  };
}

/**
 * Copies one node's disk roles onto every other node, for "identical
 * storage". Roles are matched by position, which is the only thing the
 * nodes reliably share — a node with fewer disks simply takes as many
 * roles as it has, and a node with more leaves its extras alone rather
 * than inventing a role for a disk the template doesn't describe.
 */
export function applyStorageRoles(nodes: NodeInfo[], template: AdditionalDisk[]): NodeInfo[] {
  return nodes.map((node) => ({
    ...node,
    additionalDisks: node.additionalDisks.map((disk, i) =>
      template[i] ? { ...disk, role: template[i].role } : disk,
    ),
  }));
}

// the cluster's effective disk budget for ceph/zfs is set by its worst-
// equipped node, not any average or sum — 2 nodes with 4 disks and 1 with
// only 1 still means "1 disk" everywhere, since every node needs to pull
// the same minimal setup.
export function minAdditionalDisks(nodes: NodeInfo[]): number {
  if (nodes.length === 0) return 0;
  return Math.min(...nodes.map((n) => n.additionalDisks.length));
}

// same worst-equipped-node logic as minAdditionalDisks above — a node's
// bonds are cut from its own nic pool, but the "number of bonds" field is
// one shared control, so its ceiling has to fit every node at once, not
// just the one currently being edited.
export function maxBondsForCluster(nodes: NodeInfo[]): number {
  if (nodes.length === 0) return 0;
  return Math.min(...nodes.map((n) => Number(n.nicCount) || 1));
}

// both ceph (osds) and a replicated zfs pool want storage dedicated to
// them, not the boot/root disk doing double duty — so either is only
// offered once every node has at least one disk beyond its boot disk.
export function clusterStorageDisksAvailable(nodes: NodeInfo[]): boolean {
  return minAdditionalDisks(nodes) >= 1;
}

/**
 * The cluster storage actually in effect. Each mode needs at least 2 nodes
 * and a disk beyond boot on every node; both at once need two such disks,
 * because ceph takes each osd disk whole and zfs can't share it. When only
 * one fits, ceph stays — it's the one guests' disks live on, where zfs
 * replication is the add-on.
 *
 * Read-side only: the visitor's choice is never overwritten, so adding
 * the disks back brings a dropped mode back.
 */
export function effectiveClusterStorage(chosen: ClusterStorage, nodes: NodeInfo[]): ClusterStorage {
  const disks = nodes.length < 2 ? 0 : minAdditionalDisks(nodes);
  const ceph = chosen.ceph && disks >= 1;
  const zfs = chosen.zfs && disks >= (ceph ? 2 : 1);
  if (ceph === chosen.ceph && zfs === chosen.zfs) return chosen;
  return { ceph, zfs };
}

/** the nic purposes the enabled cluster storage needs — named the same */
export function activeStoragePurposes(cs: ClusterStorage): InterfacePurpose[] {
  return enabledStorageModes(cs);
}

export function defaultBondName(index: number): string {
  return `bond${index}`;
}

// Same as interfacesFor, but only the ids — used for resync bookkeeping
// where we don't have (or need) real NicInfo, just the count.
export function interfaceIdsFor(nicCount: number, bonds: BondConfig[]): string[] {
  const usable = bonds.map((b, i) => ({ b, i })).filter(({ b }) => b.nicIndices.length >= 2);
  const bonded = new Set(usable.flatMap(({ b }) => b.nicIndices));
  const nicIds = Array.from({ length: nicCount }, (_, i) => i)
    .filter((i) => !bonded.has(i))
    .map((i) => `nic-${i}`);
  const bondIds = usable.map(({ i }) => `bond-${i}`);
  return [...nicIds, ...bondIds];
}

// every other vlan tag already in use on the same interface's bridges —
// used to catch two siblings accidentally claiming the same vlan.
export function siblingVlanTagsFor(
  bridges: Record<string, BridgeConfig>,
  count: number,
  interfaceId: string,
  excludeIndex: number,
): string[] {
  const tags: string[] = [];
  for (let idx = 0; idx < count; idx++) {
    if (idx === excludeIndex) continue;
    const tag = bridges[bridgeKey(interfaceId, idx)]?.vlanTag;
    if (tag) tags.push(tag);
  }
  return tags;
}

// a node's names, grouped by the namespace each one actually lands in.
// they're kept apart rather than pooled, so calling a disk "ceph" and a
// nic "ceph" is fine — nothing downstream ever confuses the two.
export interface NodeNames {
  // boot + additional disk friendly names, which become proxmox storage ids.
  disks: string[];
  // nic friendly names, bond names and bridge names all become real linux
  // interface names, and the kernel keeps exactly one namespace for those
  // — a bond and a bridge really can't both be "vmbr0" — so they're
  // checked against each other, not separately.
  interfaces: string[];
}

export function collectNodeNames(node: NodeInfo): NodeNames {
  const disks: string[] = [];
  if (node.bootDiskName) disks.push(node.bootDiskName);
  for (const d of node.additionalDisks) if (d.name) disks.push(d.name);

  const interfaces: string[] = [];
  for (const n of node.nics) if (n.name) interfaces.push(n.name);
  for (const b of node.network.bonds) if (b.name) interfaces.push(b.name);
  for (const [key, b] of Object.entries(node.network.bridges)) {
    // a storage link has no bridge, so its kept name claims nothing
    if (b.name && !isStorageLink(node.network, key)) interfaces.push(b.name);
  }

  return { disks, interfaces };
}

export function defaultHardware(): HardwareSpec {
  return {
    cpuVendor: "intel",
    cpuFamily: DEFAULT_CPU_FAMILY.intel,
    cpuCount: "1",
    coresPerCpu: String(defaultCoresFor("intel", DEFAULT_CPU_FAMILY.intel)),
    ramGb: "",
    bootDiskType: "nvme",
    bootDiskSizeGb: "",
    bootDiskName: "boot",
    additionalDiskCount: "0",
    additionalDisks: [],
    nicCount: "2",
    nics: [
      defaultNic(0),
      defaultNic(1),
    ],
  };
}

// Rough per-node defaults, derived from the global cidr — starts at .11
// so .1-.10 stay free for the gateway and other fixed infra.
// A static ip carries its network's prefix: 10.0.10.11/24 is "this node is
// .11, and 10.0.10.0/24 is on its link" — how proxmox and
// /etc/network/interfaces write an interface address. /32 would leave the
// node alone on its link, with no route to its gateway or its peers.
export function deriveNodeCidr(globalCidr: string, nodeIndex: number): string {
  const [ip, prefix] = globalCidr.split("/");
  const octets = parseIpv4(ip ?? "");
  if (!octets) return "";
  octets[3] = Math.min(254, 11 + nodeIndex);
  return `${octets.join(".")}/${prefix || "24"}`;
}

export function deriveGateway(globalCidr: string): string {
  const [ip] = globalCidr.split("/");
  const octets = parseIpv4(ip ?? "");
  if (!octets) return "";
  octets[3] = 1;
  return octets.join(".");
}

/**
 * The dns server after the gateway moves: most homelab routers answer dns
 * too, so it follows the gateway — until the visitor sets one of their
 * own, which is left alone.
 */
export function followGateway(dns: string, previousGateway: string, nextGateway: string): string {
  return dns === "" || dns === previousGateway ? nextGateway : dns;
}

// example placeholder text for a secondary bridge's network field — same
// base as the homelab cidr, but a different third octet, so it reads as
// "a different network from management" rather than a copy of it.
export function deriveExampleSubnet(
  globalCidr: string,
  thirdOctetOffset: number,
  hostOctet: number = 11,
): { network: string; host: string } | null {
  const [ip, prefix] = globalCidr.split("/");
  const octets = parseIpv4(ip ?? "");
  if (!octets) return null;
  const shifted = [...octets];
  shifted[2] = (shifted[2] + thirdOctetOffset) % 256;
  const p = prefix || "24";
  return {
    network: `${shifted[0]}.${shifted[1]}.${shifted[2]}.0/${p}`,
    host: `${shifted[0]}.${shifted[1]}.${shifted[2]}.${Math.min(254, Math.max(1, hostOctet))}/${p}`,
  };
}

// every bridge that needs an example ip/network placeholder, in a stable
// order — used to give each one a distinct subnet offset (10, 20, 30...)
// so two bridges on the same node never suggest the same placeholder.
// excludes the management interface's own bridge, which has its own
// dedicated "static ip" field instead.
export function addressableBridgeKeys(node: NodeInfo): string[] {
  const interfaces = interfacesFor(node.nics, node.network.bonds);
  const mgmtKey = bridgeKey(node.network.managementInterfaceId, 0);
  const keys: string[] = [];
  for (const iface of interfaces) {
    const count = bridgeCountFor(node.network.bridgeCounts, iface.id);
    for (let idx = 0; idx < count; idx++) {
      const key = bridgeKey(iface.id, idx);
      if (key !== mgmtKey) keys.push(key);
    }
  }
  return keys;
}

// a distinct example subnet for one bridge's ip placeholder — offset by
// its position among this node's other addressable bridges (so no two
// bridges on one node ever suggest the same subnet) and its host
// suggestion offset by the node's own index (so the same bridge position
// on different nodes doesn't suggest the exact same address either).
export function derivePlaceholderSubnet(
  globalCidr: string,
  position: number,
  nodeIndex: number,
): { network: string; host: string } | null {
  return deriveExampleSubnet(globalCidr, 10 + position * 10, 11 + nodeIndex);
}

// every subnet already claimed on this node by a real, typed-in value —
// the management ip and every bridge's own ip/network field. placeholders
// steer clear of these, so a suggested default can never coincide with a
// subnet the visitor already assigned to a sibling bridge by hand (the
// position-based offset above only avoids collisions between OTHER
// placeholders — it has no idea what's actually been typed anywhere).
export function usedNetworksForNode(node: NodeInfo): Set<string> {
  const used = new Set<string>();
  const mgmtInfo = subnetDetails(node.network.cidr);
  if (mgmtInfo) used.add(mgmtInfo.network);
  for (const bridge of Object.values(node.network.bridges)) {
    const info = subnetDetails(bridge.ip);
    if (info) used.add(info.network);
  }
  return used;
}

// derivePlaceholderSubnet's guess, nudged further along (30, 40, 50...
// more third-octet shift) past any subnet this node has already actually
// claimed, so an accepted suggestion is always genuinely free.
export function nonCollidingPlaceholderSubnet(
  node: NodeInfo,
  globalCidr: string,
  basePosition: number,
  nodeIndex: number,
): { network: string; host: string } | null {
  const used = usedNetworksForNode(node);
  for (let step = 0; step < 25; step++) {
    const candidate = derivePlaceholderSubnet(globalCidr, basePosition + step, nodeIndex);
    if (!candidate) return null;
    if (!used.has(candidate.network.split("/")[0])) return candidate;
  }
  return derivePlaceholderSubnet(globalCidr, basePosition, nodeIndex);
}

export type PlaceholderSubnet = { network: string; host: string };

// an ip's network address at a GIVEN prefix, ignoring whatever prefix the
// value itself was typed with. a bare host route like a /32 has no
// meaningful "network" of its own (subnetDetails would just return the ip
// itself) — what we actually want is "the /lanPrefix block this address
// would sit in if it were on a normal subnet", so every /32 for the same
// purpose (corosync, backup, ceph...) normalizes to the same bucket
// regardless of the exact prefix each one happened to be typed with.
export function networkAtPrefix(ip: string, prefix: number): string | null {
  const octets = parseIpv4(ip);
  if (!octets) return null;
  const toUint = (a: number, b: number, c: number, d: number) => ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  const toIp = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  const maskNum = prefix <= 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return toIp((toUint(octets[0], octets[1], octets[2], octets[3]) & maskNum) >>> 0);
}

// the /lanPrefix block an earlier node already gave this exact bridge (by
// key) — a corosync/backup/ceph-style bridge only works when every node
// sits on the identical network, so once any node has a real address for
// it, every other node's placeholder for the same bridge must reuse that
// block instead of recomputing its own independent guess (which drifts
// the moment that node deviates from the suggested default — e.g. packing
// several purposes into one /24 as individual /32 host routes).
export function referenceNetworkForBridge(nodes: NodeInfo[], key: string, prefix: number): string | null {
  for (const n of nodes) {
    const [ip] = (n.network.bridges[key]?.ip ?? "").split("/");
    const net = ip ? networkAtPrefix(ip, prefix) : null;
    if (net) return net;
  }
  return null;
}

// the next free host address in a /lanPrefix block, skipping the network/
// broadcast ends (assumed /24-sized, same simplification the rest of this
// file's placeholder logic already makes) and anything already reserved.
export function nextFreeHostInNetwork(networkAddress: string, reserved: Set<string>): string {
  const [a, b, c] = networkAddress.split(".").map(Number);
  for (let host = 1; host <= 254; host++) {
    const candidate = `${a}.${b}.${c}.${host}`;
    if (candidate !== networkAddress && !reserved.has(candidate)) return candidate;
  }
  return `${a}.${b}.${c}.1`;
}

// one pass over every node's every bridge, computing a placeholder for
// anything left empty. a bridge whose key already has a real address on
// some node reuses that node's /lanPrefix block, handing out the next
// free host in it; everything else falls back to
// nonCollidingPlaceholderSubnet's own per-node position offset. host
// addresses are reserved as they're handed out — real values first, then
// placeholders in node/bridge order — so no two empty fields anywhere in
// the cluster, sharing a block or not, ever suggest the same address.
export function buildPlaceholderTable(nodes: NodeInfo[], globalCidr: string): Map<string, PlaceholderSubnet> {
  const prefix = subnetDetails(globalCidr)?.prefix ?? 24;
  const table = new Map<string, PlaceholderSubnet>();
  const reservedByNetwork = new Map<string, Set<string>>();
  const reserve = (networkAddress: string, host: string) => {
    let set = reservedByNetwork.get(networkAddress);
    if (!set) {
      set = new Set();
      reservedByNetwork.set(networkAddress, set);
    }
    set.add(host);
  };

  for (const n of nodes) {
    const [mgmtIp] = n.network.cidr.split("/");
    const mgmtNet = mgmtIp ? networkAtPrefix(mgmtIp, prefix) : null;
    if (mgmtNet) reserve(mgmtNet, mgmtIp);
    for (const bridge of Object.values(n.network.bridges)) {
      const [ip] = bridge.ip.split("/");
      const net = ip ? networkAtPrefix(ip, prefix) : null;
      if (net) reserve(net, ip);
    }
  }

  nodes.forEach((n, nodeIndex) => {
    addressableBridgeKeys(n).forEach((key, position) => {
      const bridge = n.network.bridges[key];
      if (!bridge || !bridge.enabled || bridge.ip) return;
      const reference = referenceNetworkForBridge(nodes, key, prefix);
      if (reference) {
        // a pure vm/ct switch's "network" field never shows a host
        // suggestion, so only reserve one when this bridge actually needs
        // a real address — otherwise it'd burn a host no field displays,
        // pushing every later bridge's suggestion further out than it
        // needs to be.
        const needsHost = needsHostIpForPurposes(bridge.purposes, bridge.otherNeedsHostIp);
        const host = needsHost ? nextFreeHostInNetwork(reference, reservedByNetwork.get(reference) ?? new Set<string>()) : "";
        if (needsHost) reserve(reference, host);
        table.set(`${nodeIndex}#${key}`, {
          network: `${reference}/${prefix}`,
          host: `${host || reference}/${prefix}`,
        });
        return;
      }
      const subnet = nonCollidingPlaceholderSubnet(n, globalCidr, position, nodeIndex);
      if (subnet) {
        const info = subnetDetails(subnet.host);
        if (info) reserve(info.network, subnet.host.split("/")[0]);
        table.set(`${nodeIndex}#${key}`, subnet);
      }
    });
  });

  return table;
}

// an ip/cidr value's address range as [start, end] uint32s — lets two
// values of different prefixes (a /32 host route and a /24 network, say)
// be checked for overlap correctly, not just string-compared.
export function cidrRange(value: string): { start: number; end: number } | null {
  const info = subnetDetails(value);
  if (!info) return null;
  const octets = parseIpv4(info.network);
  if (!octets) return null;
  const start = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const hostBits = 32 - info.prefix;
  const size = hostBits <= 0 ? 0 : hostBits >= 32 ? 0xffffffff : 2 ** hostBits - 1;
  return { start, end: (start + size) >>> 0 };
}

export function rangesOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start <= b.end && b.start <= a.end;
}

export interface AddressClaim {
  nodeIndex: number;
  key: string;
  label: string;
  ip: string;
  range: { start: number; end: number };
  // false for a pure vm/ct bridge's declared network — under "identical
  // network setup" that value is deliberately the same on every node (see
  // applyNetworkStructure), so matching another node's claim there is
  // expected, not a conflict. true for anything the host itself actually
  // binds to: the management ip, or any bridge whose purpose needs one.
  isReal: boolean;
}

// every real (non-empty, valid) address claim across the whole cluster —
// the management ip and every bridge's own ip/network field, on every
// node. used to check for exact duplicates and same-node overlaps below.
export function collectAddressClaims(nodes: NodeInfo[]): AddressClaim[] {
  const claims: AddressClaim[] = [];
  nodes.forEach((n, nodeIndex) => {
    const [mgmtIp] = n.network.cidr.split("/");
    const mgmtRange = cidrRange(n.network.cidr);
    if (mgmtIp && mgmtRange) claims.push({ nodeIndex, key: "mgmt", label: "static ip", ip: mgmtIp, range: mgmtRange, isReal: true });
    for (const [key, bridge] of Object.entries(n.network.bridges)) {
      const [ip] = bridge.ip.split("/");
      const range = cidrRange(bridge.ip);
      if (ip && range) {
        const isReal = needsHostIpForPurposes(bridge.purposes, bridge.otherNeedsHostIp);
        claims.push({ nodeIndex, key, label: bridge.name, ip, range, isReal });
      }
    }
  });
  return claims;
}

// flags two kinds of real (not placeholder) address problems:
//  1. the exact same address claimed twice by two REAL per-node addresses,
//     anywhere in the cluster — two interfaces can never share one host
//     ip, full stop. a shared, non-real vm/ct network matching itself
//     across nodes is expected (see AddressClaim.isReal) and skipped here
//     — but still flagged same-node, since two of one node's own bridges
//     genuinely can't both sit on the same network.
//  2. two of the SAME node's own claims whose ranges overlap — one sitting
//     inside the other's declared network, say — because a single node
//     can't cleanly route between two interfaces both claiming the same
//     address space. sharing a subnet ACROSS different nodes for the same
//     bridge (corosync, backup, ceph...) is by design and left alone.
export function buildAddressConflicts(nodes: NodeInfo[]): Map<string, string> {
  const conflicts = new Map<string, string>();
  const claims = collectAddressClaims(nodes);
  const nodeLabel = (i: number) => nodes[i]?.network.hostLabel || `node ${i + 1}`;
  const setIfAbsent = (claimKey: string, message: string) => {
    if (!conflicts.has(claimKey)) conflicts.set(claimKey, message);
  };

  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i];
      const b = claims[j];
      if (a.ip === b.ip) {
        const onOtherNode = a.nodeIndex !== b.nodeIndex;
        // a non-real (network-only) claim never actually binds to
        // anything, so it landing on the same address as another node's
        // claim is no conflict — cross-node, only two REAL addresses
        // colliding is. same-node matches still always count: two of one
        // node's own bridges shouldn't numerically collide either way.
        if (!onOtherNode || (a.isReal && b.isReal)) {
          setIfAbsent(
            `${a.nodeIndex}#${a.key}`,
            `same address as ${b.label}${onOtherNode ? ` on ${nodeLabel(b.nodeIndex)}` : ""} — every interface needs its own`,
          );
          setIfAbsent(
            `${b.nodeIndex}#${b.key}`,
            `same address as ${a.label}${onOtherNode ? ` on ${nodeLabel(a.nodeIndex)}` : ""} — every interface needs its own`,
          );
        }
        continue;
      }
      if (a.nodeIndex !== b.nodeIndex) continue;
      if (rangesOverlap(a.range, b.range)) {
        setIfAbsent(`${a.nodeIndex}#${a.key}`, `overlaps ${b.label}'s network — give it its own, non-overlapping range`);
        setIfAbsent(`${b.nodeIndex}#${b.key}`, `overlaps ${a.label}'s network — give it its own, non-overlapping range`);
      }
    }
  }

  return conflicts;
}

// vmbr0 is always the management bridge, by convention. Every other
// interface defaults to bridged too (vmbr1, vmbr2, ...) and defaults to
// "vm traffic" purpose — an unused interface does nothing for a wizard
// whose whole point is "get a working homelab with minimal back-and-
// forth", so bridging what's there is the useful default.
// numbers every bridge slot (management #0 gets vmbr0; everything else —
// including a second/third bridge on the same interface — is numbered in
// order) and defaults index 0 of each interface to untagged, index 1+ to
// an empty (still-to-fill-in) vlan tag.
export function defaultBridgesForIds(
  ids: string[],
  managementInterfaceId: string,
  bridgeCounts: Record<string, string>,
): Record<string, BridgeConfig> {
  let seq = 0;
  const result: Record<string, BridgeConfig> = {};
  for (const id of ids) {
    const count = bridgeCountFor(bridgeCounts, id);
    for (let index = 0; index < count; index++) {
      const key = bridgeKey(id, index);
      const name = id === managementInterfaceId && index === 0 ? "vmbr0" : `vmbr${++seq}`;
      result[key] = { enabled: true, name, purposes: ["vm"], otherNeedsHostIp: false, ip: "", vlanTag: "" };
    }
  }
  return result;
}

export function defaultNodeNetwork(nodeName: string, nicCount: number, globalCidr: string, nodeIndex: number): NodeNetwork {
  const ids = interfaceIdsFor(nicCount, []);
  const mgmt = ids[0] ?? "nic-0";
  const bridgeCounts = Object.fromEntries(ids.map((id) => [id, "1"]));
  return {
    hostLabel: nodeName,
    cidr: deriveNodeCidr(globalCidr, nodeIndex),
    bondCount: "0",
    bonds: [],
    managementInterfaceId: mgmt,
    bridgeCounts,
    bridges: defaultBridgesForIds(ids, mgmt, bridgeCounts),
  };
}

export function defaultNode(index: number, globalCidr: string): NodeInfo {
  const name = `pve0${index + 1}`;
  const hardware = defaultHardware();
  return {
    name,
    ...hardware,
    network: defaultNodeNetwork(name, hardware.nics.length, globalCidr, index),
  };
}

export function resizeArray<T>(arr: T[], length: number, make: (i: number) => T): T[] {
  if (length === arr.length) return arr;
  if (length < arr.length) return arr.slice(0, length);
  return [...arr, ...Array.from({ length: length - arr.length }, (_, i) => make(arr.length + i))];
}

/**
 * A node with the template's hardware — what "identical hardware" applies.
 * Its network is resynced to the template's nic count; its name and
 * addresses stay its own.
 */
export function withHardwareOf(node: NodeInfo, template: HardwareSpec): NodeInfo {
  return {
    ...node,
    cpuVendor: template.cpuVendor,
    cpuFamily: template.cpuFamily,
    cpuCount: template.cpuCount,
    coresPerCpu: template.coresPerCpu,
    ramGb: template.ramGb,
    bootDiskType: template.bootDiskType,
    bootDiskSizeGb: template.bootDiskSizeGb,
    bootDiskName: template.bootDiskName,
    additionalDiskCount: template.additionalDiskCount,
    additionalDisks: template.additionalDisks.map((d) => ({ ...d })),
    nicCount: template.nicCount,
    nics: template.nics.map((n) => ({ ...n })),
    network: resyncNetworkForNics(node.network, template.nics.length),
  };
}

/**
 * The node list at a new length. A node added while hardware or network
 * is shared across nodes starts as a copy of node 1's, not as a default:
 * under "identical" there's no per-node form to fill its blanks in, so a
 * default node would block the step with fields nobody can see.
 */
export function resizeNodes(
  nodes: NodeInfo[],
  length: number,
  globalCidr: string,
  shared: { hardware: boolean; network: boolean },
): NodeInfo[] {
  const next = resizeArray(nodes, length, (i) => defaultNode(i, globalCidr));
  if (next.length <= nodes.length || nodes.length === 0) return next;
  const template = nodes[0];
  let added = next.slice(nodes.length);
  if (shared.hardware) added = added.map((node) => withHardwareOf(node, template));
  if (shared.network) added = applyNetworkStructure(added, template.network);
  return [...nodes, ...added];
}

// Keep a node's network config consistent after its nic count, bonds, or
// management interface change — drop bond members that no longer exist,
// reclamp the management interface, and regenerate bridge defaults for
// the resulting interface set. This intentionally regenerates bridges
// from scratch on every structural change (same policy the rest of this
// wizard already uses for hardware changes) rather than trying to
// preserve customizations across a change to what interfaces even exist.
export function resyncNetworkForNics(
  network: NodeNetwork,
  nicCount: number,
  opts?: { managementInterfaceId?: string; bonds?: BondConfig[] },
): NodeNetwork {
  const bonds = (opts?.bonds ?? network.bonds).map((b) => ({
    ...b,
    nicIndices: b.nicIndices.filter((idx) => idx < nicCount),
  }));
  const ids = interfaceIdsFor(nicCount, bonds);
  const requested = opts?.managementInterfaceId ?? network.managementInterfaceId;
  const mgmt = ids.includes(requested) ? requested : (ids[0] ?? "nic-0");
  // carries forward how many bridges each surviving interface id had;
  // an id that's new (or didn't exist before) starts at 1.
  const bridgeCounts = Object.fromEntries(ids.map((id) => [id, network.bridgeCounts[id] ?? "1"]));
  return {
    ...network,
    bonds,
    bondCount: String(bonds.length),
    managementInterfaceId: mgmt,
    bridgeCounts,
    bridges: defaultBridgesForIds(ids, mgmt, bridgeCounts),
  };
}

// copies the *structural* shape of one node's network onto every node —
// bond composition/mode/names, which interface is management, and each
// bridge's purposes/enabled/name/otherNeedsHostIp/vlanTag. hostLabel and
// cidr are never touched here; those stay unique per node even when
// "identical network setup" is on. a bridge's ip splits in two: a real
// per-node static ip (any purpose that needs a host address) stays this
// node's own, but a pure vm/ct bridge's declared subnet is itself part of
// the shared structure — no node claims an address on it, so there's
// nothing that needs to stay unique, and copying it saves re-typing the
// same subnet once per node.
export function applyNetworkStructure(nodes: NodeInfo[], template: NodeNetwork): NodeInfo[] {
  return nodes.map((node) => {
    const resynced = resyncNetworkForNics(node.network, node.nics.length, {
      managementInterfaceId: template.managementInterfaceId,
      bonds: template.bonds.map((b) => ({ ...b })),
    });
    // resyncNetworkForNics only carries forward this node's own prior
    // bridge counts — re-derive from the template's instead (for
    // whichever interface ids this node actually has), so an extra
    // bridge set up on the template node gets created here too.
    const ids = Object.keys(resynced.bridgeCounts);
    const bridgeCounts = Object.fromEntries(ids.map((id) => [id, template.bridgeCounts[id] ?? "1"]));
    const bridges = Object.fromEntries(
      Object.entries(defaultBridgesForIds(ids, resynced.managementInterfaceId, bridgeCounts)).map(([key, bridge]) => {
        const t = template.bridges[key];
        if (!t) return [key, bridge];
        const needsHost = needsHostIpForPurposes(t.purposes, t.otherNeedsHostIp);
        // resyncNetworkForNics rebuilds bridges from scratch (same as
        // every other structural change in this wizard), so this node's
        // own prior value has to be read from its pre-resync bridges,
        // not from `bridge` above — that's already a blank default.
        const ip = needsHost ? (node.network.bridges[key]?.ip ?? "") : t.ip;
        return [
          key,
          {
            ...bridge,
            purposes: [...t.purposes],
            enabled: t.enabled,
            name: t.name,
            otherNeedsHostIp: t.otherNeedsHostIp,
            vlanTag: t.vlanTag,
            ip,
          },
        ];
      }),
    );
    return { ...node, network: { ...resynced, bridgeCounts, bridges } };
  });
}

// strips any of the given purposes from every bridge on every node —
// used when something upstream (node count dropping below 2, switching
// the storage/ha decision, zfs losing its disks) makes a purpose no
// longer offered, so state doesn't silently keep a selection the ui has
// no way left to show or edit.
// Returns the same array when nothing was stripped. It runs from an effect
// whose own setNodes re-triggers it, so a fresh array every time would
// re-render forever.
export function withoutPurposes(nodes: NodeInfo[], toStrip: InterfacePurpose[]): NodeInfo[] {
  if (toStrip.length === 0) return nodes;
  let anyChanged = false;
  const next = nodes.map((node) => {
    let changed = false;
    const nextBridges: Record<string, BridgeConfig> = {};
    for (const [id, bridge] of Object.entries(node.network.bridges)) {
      if (!bridge.purposes.some((p) => toStrip.includes(p))) {
        nextBridges[id] = bridge;
        continue;
      }
      changed = true;
      const purposes = bridge.purposes.filter((p) => !toStrip.includes(p));
      nextBridges[id] = { ...bridge, purposes: purposes.length > 0 ? purposes : ["vm"] };
    }
    if (!changed) return node;
    anyChanged = true;
    return { ...node, network: { ...node.network, bridges: nextBridges } };
  });
  return anyChanged ? next : nodes;
}

// the lowest-numbered vmbrN not already in use — for naming a freshly
// added bridge without colliding with any existing one.
export function nextVmbrName(bridges: Record<string, BridgeConfig>): string {
  const used = new Set(
    Object.values(bridges)
      .map((b) => /^vmbr(\d+)$/.exec(b.name)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number),
  );
  let n = 0;
  while (used.has(n)) n++;
  return `vmbr${n}`;
}

/**
 * Holds a node's network to the storage-link rules (see isStorageLink):
 * ceph and zfs live only on an interface's native slot, a storage link
 * carries nothing but storage traffic, and it has no extra vlan-tagged
 * bridges, since there's no bridge to tag. Run after every bridge edit.
 * Returns the same object when nothing had to change.
 */
export function enforceStorageLinks(network: NodeNetwork): NodeNetwork {
  let bridges = network.bridges;
  let bridgeCounts = network.bridgeCounts;
  const patchBridge = (key: string, bridge: BridgeConfig) => {
    if (bridges === network.bridges) bridges = { ...bridges };
    bridges[key] = bridge;
  };

  for (const [key, bridge] of Object.entries(network.bridges)) {
    const [interfaceId, index] = key.split("#");
    if (!bridge.purposes.some(isStoragePurpose)) continue;
    // an extra bridge is a bridge — storage traffic doesn't ride one
    if (index !== "0") {
      const rest = bridge.purposes.filter((p) => !isStoragePurpose(p));
      patchBridge(key, { ...bridge, purposes: rest.length > 0 ? rest : ["vm"] });
      continue;
    }
    if (interfaceId === network.managementInterfaceId) continue;
    // storage mixed with bridge purposes: keep the bridge, the guests on
    // it are the harder thing to lose
    const rest = bridge.purposes.filter((p) => !isStoragePurpose(p));
    if (rest.length > 0) {
      patchBridge(key, { ...bridge, purposes: rest });
      continue;
    }
    // a storage link: the interface is its alone
    const count = bridgeCountFor(network.bridgeCounts, interfaceId);
    if (count > 1) {
      if (bridgeCounts === network.bridgeCounts) bridgeCounts = { ...bridgeCounts };
      bridgeCounts[interfaceId] = "1";
      if (bridges === network.bridges) bridges = { ...bridges };
      for (let idx = 1; idx < count; idx++) delete bridges[bridgeKey(interfaceId, idx)];
    }
  }
  if (bridges === network.bridges && bridgeCounts === network.bridgeCounts) return network;
  return { ...network, bridges, bridgeCounts };
}
