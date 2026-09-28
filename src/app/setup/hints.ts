// Every advisory the wizard shows about a configuration that parses fine
// but would bite later: mixed cpu generations that block live migration,
// a ceph link too slow to carry it, a node with no vm bridge at all.
//
// A Hint is deliberately not an error — nothing here blocks progress. The
// tone is the whole signal, so these are kept together (and tested
// together) rather than scattered through the form that renders them.

import {
  isFastNic,
  isSlowNic,
  nicSpeedLabel,
  type BridgeConfig,
  type InterfacePurpose,
  type NicSpeed,
  type NodeInfo,
} from "./wizard-state";
import { nativeEntryFor, qemuTypeFor, type CpuFamily } from "./cpu";

export interface Hint {
  tone: "info" | "success" | "warning" | "danger";
  glyph: string;
  text: string;
}

export function quorumHintFor(nodeCountValue: number): Hint {
  if (nodeCountValue <= 1) {
    return { tone: "info", glyph: "#", text: "1 node runs standalone — no cluster, so quorum doesn't apply." };
  }
  if (nodeCountValue === 2) {
    return {
      tone: "warning",
      glyph: "!",
      text: "2 nodes doesn't get automatic quorum. Add a qdevice on a third machine, or plan on a real 3rd node.",
    };
  }
  return { tone: "success", glyph: "✓", text: `${nodeCountValue} nodes gets automatic quorum.` };
}

export function cpuHintFor(nodes: NodeInfo[]): Hint | null {
  if (nodes.length < 2) return null;

  const vendors = new Set(nodes.map((n) => n.cpuVendor));
  if (vendors.size > 1) {
    return {
      tone: "warning",
      glyph: "!",
      text: "Nodes mix intel and amd cpus. Most vm cpu types can't live-migrate across vendors — pin those vms to matching-vendor nodes, or use a generic baseline like qemu64 if you need full mobility.",
    };
  }

  const vendor = nodes[0].cpuVendor;
  // Different display names can still be the same effective cpu — "Alder
  // Lake" and "Rocket Lake" both resolve to the qemu type Icelake-Client —
  // so compare on the resolved type, not the raw selection.
  const resolvedTypes = Array.from(new Set(nodes.map((n) => qemuTypeFor(n.cpuVendor, n.cpuFamily))));
  if (resolvedTypes.length === 1) {
    return {
      tone: "success",
      glyph: "✓",
      text: `All ${nodes.length} nodes resolve to the same effective cpu type (${resolvedTypes[0]}) — live migration works everywhere.`,
    };
  }

  const dated = resolvedTypes
    .map((t) => nativeEntryFor(vendor, t))
    .filter((f): f is CpuFamily => Boolean(f))
    .sort((a, b) => a.from - b.from);
  const oldest = dated[0];
  const newest = dated[dated.length - 1];
  return {
    tone: "warning",
    glyph: "!",
    text: `Effective cpu types range from ${oldest.name} (${oldest.from}) to ${newest.name} (${newest.from}). Set vm cpu type to ${oldest.name} so vms can migrate to every node.`,
  };
}

// not every combination of purposes on one bridge makes sense — ceph in
// particular wants a dedicated, uncontended link, so flag it the moment
// it's sharing with anything else rather than silently accepting it.
export function purposeComboHint(purposes: InterfacePurpose[]): Hint | null {
  if (purposes.length < 2) return null;
  if (purposes.includes("ceph")) {
    return {
      tone: "warning",
      glyph: "!",
      text: "it's recommended to not share the ceph nic with any other service — no corosync, no vm traffic, no backups. ceph is latency- and bandwidth-sensitive, and contention here shows up as cluster-wide storage slowdowns.",
    };
  }
  if (purposes.includes("zfs")) {
    return {
      tone: "warning",
      glyph: "!",
      text: "it's recommended to not share the zfs replication nic with any other service — a replication job can saturate the link and delay whatever else depends on it.",
    };
  }
  if (purposes.includes("cluster") && purposes.includes("backup")) {
    return {
      tone: "warning",
      glyph: "!",
      text: "corosync is latency-sensitive — a large backup transfer saturating this same link can delay corosync heartbeats enough to trigger a false quorum loss.",
    };
  }
  return null;
}

// ceph's floor is 10gbe, and it's a floor rather than a preference: every
// write is replicated to the other nodes and acknowledged only once they
// have it, so the slowest link in the storage path sets the latency of
// every single vm write. this fires on the actual nics behind the bridge,
// so it catches a slow member hiding inside an otherwise fine bond.
export function cephLinkSpeedHint(purposes: InterfacePurpose[], speeds: NicSpeed[]): Hint | null {
  if (!purposes.includes("ceph")) return null;
  const slow = speeds.filter(isSlowNic);
  if (slow.length === 0) return null;

  const labels = Array.from(new Set(slow.map(nicSpeedLabel))).join(" + ");
  // a bond of slow links is worth wording differently: it's the specific
  // mistake of assuming lacp fixes this, and it doesn't — aggregation buys
  // throughput across separate flows, never latency on one.
  const bonded = speeds.length > 1;
  return {
    tone: "warning",
    glyph: "!",
    text: bonded
      ? `this bond carries ceph over ${labels}. ceph wants 10 gbe or better: bonding adds throughput across separate connections but never lowers latency, and latency is the half ceph is actually bound by — every write waits for the other nodes to confirm it. a single 10 gbe link beats a bond of slower ones here.`
      : `this nic carries ceph at ${labels}. ceph wants 10 gbe or better — below that a single osd rebuild saturates the link, and because every write waits for the other nodes to confirm it, that shows up as every vm's disk stalling rather than as "storage is busy".`,
  };
}

// nodes with no 10gbe-or-better nic at all — ceph runs on every node, so
// one slow node degrades the whole cluster, not just itself. "other /
// not sure" counts as neither: it can't clear the warning, but it isn't
// evidence of a problem either (see isFastNic).
export function nodesWithoutFastNic(nodes: NodeInfo[]): NodeInfo[] {
  return nodes.filter((n) => !n.nics.some((nic) => isFastNic(nic.speed)));
}

export function bridgesWithPurpose(bridges: Record<string, BridgeConfig>, purpose: InterfacePurpose): boolean {
  return Object.values(bridges).some((b) => b.enabled && b.purposes.includes(purpose));
}

// without a vm/ct bridge this node literally can't host anything — that's
// a hard problem, not a style preference, so it gets the strongest tone.
export function vmTrafficHintFor(bridges: Record<string, BridgeConfig>): Hint | null {
  if (bridgesWithPurpose(bridges, "vm")) return null;
  return {
    tone: "danger",
    glyph: "✗",
    text: "no nic on this node is set up for vm/container traffic — it won't be able to host any vms or cts until one is.",
  };
}

export function backupHintFor(bridges: Record<string, BridgeConfig>): Hint | null {
  if (bridgesWithPurpose(bridges, "backup")) return null;
  return {
    tone: "warning",
    glyph: "!",
    text: "no nic on this node is set up for backups — decide how it'll reach a backup target (e.g. pbs) before it goes into production.",
  };
}

// corosync only matters once there's a cluster to sync — a single
// standalone node has nothing to warn about here.
export function corosyncHintFor(bridges: Record<string, BridgeConfig>, nodeCount: number): Hint | null {
  if (nodeCount < 2) return null;
  if (bridgesWithPurpose(bridges, "cluster")) return null;
  return {
    tone: "warning",
    glyph: "!",
    text: "no nic on this node is set up for cluster sync (corosync) — it'll fall back to riding on the management bridge, which works but gives corosync no isolation from vm traffic.",
  };
}

// enforces the storage/ha decision made at the top of this step — whichever
// of ceph/zfs was chosen needs an actual nic carrying it on every node, or
// the decision is meaningless.
export function storageHaHintFor(bridges: Record<string, BridgeConfig>, storagePurpose: InterfacePurpose | null): Hint | null {
  if (storagePurpose === null) return null;
  if (bridgesWithPurpose(bridges, storagePurpose)) return null;
  const label = storagePurpose === "ceph" ? "ceph" : "zfs replication";
  return {
    tone: "danger",
    glyph: "✗",
    text: `you chose ${label} for cluster storage above, but no nic on this node is set up for ${label} traffic — pick one below.`,
  };
}
