// Turns the wizard's saved state into what the storage preview draws: per
// node, every disk grouped by the role it plays, and the cluster storage
// those roles add up to — a shared ceph pool, a replicated zfs pool, both,
// or neither.
//
// The parallel to ../network/topology.ts is deliberate — same shape of
// module, same job: everything derived here so the components only render.

import {
  cephRawWithoutLargestNodeGb,
  cephUsableGb,
  disksWithRole,
  effectiveCephPlan,
  effectiveRaidLevel,
  formatGb,
  formatMinutes,
  minPoolMembers,
  totalGb,
  withEffectiveDiskRoles,
  zfsRaidInfo,
  zfsUsableGb,
} from "../../storage";
import {
  enabledStorageModes,
  isSlowNic,
  nicIndicesForInterface,
  nicSpeedLabel,
  type AdditionalDisk,
  type ClusterStorage,
  type DiskRole,
  type NodeInfo,
  type StorageMode,
  type StoragePlan,
} from "../../wizard-state";

export interface DiskView {
  name: string;
  sizeGb: number;
  type: AdditionalDisk["type"];
  /** the role in effect — "boot" for the disk the installer owns */
  role: DiskRole | "boot";
}

export interface NodeStorageView {
  nodeIndex: number;
  /** hostLabel plus the cluster domain, already joined */
  fqdn: string;
  boot: DiskView;
  disks: DiskView[];
  cephDisks: DiskView[];
  zfsDisks: DiskView[];
  localDisks: DiskView[];
  /** raw capacity this node hands to the ceph pool */
  cephRawGb: number;
  /** what this node's own zfs pool holds */
  zfsUsableGb: number;
  localRawGb: number;
  /** one per enabled mode: the nics carrying that mode's traffic */
  storageLinks: StorageLinkView[];
}

export interface StorageLinkView {
  /** "ceph link" or "replication link" */
  key: string;
  /** e.g. "10 gbe", "2 × 1 gbe (bond0)", or "not set up" */
  label: string;
  /** true when there's a problem worth flagging — see `reason` */
  warn: boolean;
  /** why it's flagged, in one line for the card — null when it isn't */
  reason: string | null;
}

export interface ClusterPoolView {
  kind: StorageMode;
  name: string;
  /** the headline number, already formatted */
  usable: string;
  raw: string;
  /** one short "key: value" line per fact worth putting on the card */
  facts: { key: string; value: string }[];
  /** how many nodes actually contribute a disk */
  contributing: number;
  nodeCount: number;
}

export interface StorageOverview {
  nodes: NodeStorageView[];
  /** the shared pool every node's osds feed — drawn with cables */
  ceph: ClusterPoolView | null;
  /**
   * zfs replication: each node builds its own pool, so there's no shared
   * pool to cable into — just a summary of what's replicated where
   */
  zfs: ClusterPoolView | null;
  localKindLabel: string;
  localName: string;
}

/**
 * What one storage mode's traffic runs over on this node: every interface
 * carrying a bridge with that purpose, and the speed of the nics behind
 * it. It's the number that decides whether the storage performs, so it
 * belongs next to the disks rather than only in the network preview.
 *
 * Only ceph is held to 10 gbe — the same line the wizard draws in step 2.
 * Ceph waits on this link for every write, so a slow one slows every vm;
 * zfs replication is a scheduled copy in the background, where a slower
 * link only makes each run take longer. Both are flagged when no nic
 * carries them at all.
 */
export function storageLinkFor(node: NodeInfo, mode: StorageMode): StorageLinkView {
  const key = mode === "ceph" ? "ceph link" : "replication link";

  const interfaceIds = [
    ...new Set(
      Object.entries(node.network.bridges)
        .filter(([, bridge]) => bridge.enabled && bridge.purposes.includes(mode))
        .map(([bridgeId]) => bridgeId.split("#")[0]),
    ),
  ];
  if (interfaceIds.length === 0) {
    return {
      key,
      label: "not set up",
      warn: true,
      reason: `no nic on this node carries ${mode === "ceph" ? "ceph" : "zfs replication"} traffic — set one up in step 2`,
    };
  }

  let slow = false;
  const parts = interfaceIds.map((id) => {
    const speeds = nicIndicesForInterface(id, node.network.bonds)
      .map((i) => node.nics[i]?.speed)
      .filter((speed) => speed !== undefined);
    if (speeds.some(isSlowNic)) slow = true;
    const distinct = [...new Set(speeds)];
    const speedText =
      speeds.length > 1 && distinct.length === 1
        ? `${speeds.length} × ${nicSpeedLabel(distinct[0])}`
        : speeds.map(nicSpeedLabel).join(" + ");
    const bond = id.startsWith("bond-") ? node.network.bonds[Number(id.slice("bond-".length))] : undefined;
    return bond ? `${speedText} (${bond.name})` : speedText;
  });
  const warn = mode === "ceph" && slow;
  return {
    key,
    label: parts.join(", ") || "not set up",
    warn,
    reason: warn ? "below 10 gbe — ceph waits on this link for every write, so every vm's disk feels it" : null,
  };
}

function toView(disk: AdditionalDisk): DiskView {
  // withEffectiveDiskRoles has already resolved every role, so "" can't
  // reach here — the fallback only satisfies the type
  return { name: disk.name, sizeGb: Number(disk.sizeGb) || 0, type: disk.type, role: disk.role || "local" };
}

/**
 * @param storage the cluster storage in effect (effectiveClusterStorage),
 *   not the raw choice
 */
export function buildStorageOverview(
  nodes: NodeInfo[],
  plan: StoragePlan,
  storage: ClusterStorage,
  hostnameSuffix: string,
): StorageOverview {
  const modes = enabledStorageModes(storage);
  // every disk with the role it actually plays under those modes
  const planNodes = withEffectiveDiskRoles(nodes, modes);
  // the zfs layout in effect — the choice only where every node can build it
  const raidLevel = effectiveRaidLevel(plan.zfs.raidLevel, minPoolMembers(planNodes)) ?? plan.zfs.raidLevel;

  const nodeViews: NodeStorageView[] = planNodes.map((node, nodeIndex) => {
    const cephDisks = disksWithRole(node, "ceph");
    const zfsDisks = disksWithRole(node, "zfs");
    const localDisks = disksWithRole(node, "local");
    const label = node.network.hostLabel || node.name;
    return {
      nodeIndex,
      fqdn: hostnameSuffix ? `${label}.${hostnameSuffix}` : label,
      boot: {
        name: node.bootDiskName,
        sizeGb: Number(node.bootDiskSizeGb) || 0,
        type: node.bootDiskType,
        role: "boot",
      },
      disks: node.additionalDisks.map(toView),
      cephDisks: cephDisks.map(toView),
      zfsDisks: zfsDisks.map(toView),
      localDisks: localDisks.map(toView),
      cephRawGb: totalGb(cephDisks),
      zfsUsableGb: storage.zfs ? zfsUsableGb(zfsDisks, raidLevel) : 0,
      localRawGb: totalGb(localDisks),
      storageLinks: modes.map((mode) => storageLinkFor(node, mode)),
    };
  });

  let ceph: ClusterPoolView | null = null;
  if (storage.ceph) {
    const effective = effectiveCephPlan(plan.ceph, nodes.length);
    const replicas = Number(effective.replicas);
    const osds = nodeViews.reduce((sum, n) => sum + n.cephDisks.length, 0);
    ceph = {
      kind: "ceph",
      name: plan.ceph.poolName,
      usable: formatGb(cephUsableGb(planNodes, replicas)),
      raw: formatGb(nodeViews.reduce((sum, n) => sum + n.cephRawGb, 0)),
      facts: [
        { key: "osds", value: String(osds) },
        { key: "replicas", value: `${effective.replicas}× (min ${effective.minReplicas})` },
        { key: "failure domain", value: "host" },
        {
          key: "one node down",
          value: replicas > 0 ? formatGb(cephRawWithoutLargestNodeGb(planNodes) / replicas) : "—",
        },
      ],
      contributing: nodeViews.filter((n) => n.cephDisks.length > 0).length,
      nodeCount: nodes.length,
    };
  }

  let zfs: ClusterPoolView | null = null;
  if (storage.zfs) {
    const info = zfsRaidInfo(raidLevel);
    const contributing = nodeViews.filter((n) => n.zfsDisks.length > 0).length;
    // every node builds the same pool, so the cluster's effective usable
    // capacity is one node's — the copies on the others are the point,
    // not extra room
    const perNode = nodeViews.map((n) => n.zfsUsableGb).filter((n) => n > 0);
    zfs = {
      kind: "zfs",
      name: plan.zfs.poolName,
      usable: perNode.length > 0 ? formatGb(Math.min(...perNode)) : "—",
      raw: formatGb(nodeViews.reduce((sum, n) => sum + n.zfsDisks.reduce((t, d) => t + d.sizeGb, 0), 0)),
      facts: [
        { key: "layout", value: `${info.label} per node` },
        { key: "replicates every", value: formatMinutes(Number(plan.zfs.replicationMinutes) || 0) },
        { key: "copies", value: `${contributing} (one per node)` },
      ],
      contributing,
      nodeCount: nodes.length,
    };
  }

  return {
    nodes: nodeViews,
    ceph,
    zfs,
    localKindLabel: plan.local.kind,
    localName: plan.local.name,
  };
}

/** a css var per role, so a disk reads the same on its card and its pool */
export const ROLE_COLOR: Record<DiskView["role"], string> = {
  boot: "var(--ink-dim)",
  ceph: "var(--brand)",
  zfs: "var(--cable-b)",
  local: "var(--cable-a)",
  unused: "var(--border-strong)",
};

export function roleLabel(role: DiskView["role"]): string {
  return role === "ceph" ? "osd" : role;
}
