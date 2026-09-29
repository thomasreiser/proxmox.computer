// What the backups preview draws, derived from the saved wizard state.
// Pure data — no react flow — so the rules are tested directly
// (plan.test.ts) and the page only lays the result out.

import { maxBackupsKept, retentionReach, usesPbs } from "../../backups";
import {
  linkSpeedLabel,
  nicSpeedsForInterface,
  type BackupPlan,
  type BackupTarget,
  type NodeInfo,
} from "../../wizard-state";

export interface BackupLinkView {
  // the bridge step 2 set aside for backups, or the management link
  label: string;
  // the nics behind it, e.g. "2 × 10 gbe" — "" if none are known
  speed: string;
  // false when backups share the management link
  dedicated: boolean;
}

export interface BackupNodeView {
  nodeIndex: number;
  fqdn: string;
  link: BackupLinkView;
}

export interface BackupTargetView {
  kind: BackupTarget;
  // where the backups land — an address, a share, or the in-cluster vm
  title: string;
  subtitle: string;
  facts: { key: string; value: string }[];
  // pbs as a vm: the backups sit on the hardware they protect
  insideCluster: boolean;
}

export interface OffsiteView {
  address: string;
}

export interface BackupOverview {
  nodes: BackupNodeView[];
  // null when the visitor chose no backups
  target: BackupTargetView | null;
  // only pbs syncs off-site on its own
  offsite: OffsiteView | null;
}

/** the bridge a node sends its backups over, if step 2 gave it one */
export function backupLinkFor(node: NodeInfo): BackupLinkView {
  const speedOf = (interfaceId: string) =>
    linkSpeedLabel(nicSpeedsForInterface(interfaceId, node.nics, node.network.bonds));
  const entry = Object.entries(node.network.bridges).find(([, b]) => b.enabled && b.purposes.includes("backup"));
  if (entry) {
    const [key, bridge] = entry;
    return { label: bridge.name || "backup bridge", speed: speedOf(key.split("#")[0]), dedicated: true };
  }
  return { label: "management link", speed: speedOf(node.network.managementInterfaceId), dedicated: false };
}

function targetTitle(plan: BackupPlan): string {
  switch (plan.target) {
    case "pbs-external":
      return plan.pbsAddress || "(no address)";
    case "pbs-vm":
      return "pbs vm";
    case "nfs":
      return plan.nfsServer || plan.nfsExport ? `${plan.nfsServer || "?"}:${plan.nfsExport || "?"}` : "(no share)";
    case "none":
      return "";
  }
}

const SUBTITLE: Record<BackupTarget, string> = {
  "pbs-external": "proxmox backup server",
  "pbs-vm": "pbs · vm in this cluster",
  nfs: "nfs share",
  none: "",
};

export function buildBackupOverview(nodes: NodeInfo[], plan: BackupPlan, hostnameSuffix: string): BackupOverview {
  const nodeViews = nodes.map((node, nodeIndex) => {
    const label = node.network.hostLabel || node.name;
    return {
      nodeIndex,
      fqdn: hostnameSuffix ? `${label}.${hostnameSuffix}` : label,
      link: backupLinkFor(node),
    };
  });

  if (plan.target === "none") return { nodes: nodeViews, target: null, offsite: null };

  const pbs = usesPbs(plan.target);
  const facts: { key: string; value: string }[] = [];
  if (pbs) facts.push({ key: "datastore", value: plan.datastore || "—" });
  facts.push({ key: "runs", value: `daily at ${plan.schedule || "—"}` });
  facts.push({ key: "keeps", value: `up to ${maxBackupsKept(plan)} per guest` });
  facts.push({ key: "reaches back", value: retentionReach(plan) });
  if (pbs) {
    facts.push({ key: "verify", value: plan.verify ? "weekly" : "off" });
    facts.push({ key: "encryption", value: plan.encrypt ? "on, client-side" : "off" });
  } else {
    facts.push({ key: "mode", value: "full copies, no dedup" });
  }

  return {
    nodes: nodeViews,
    target: {
      kind: plan.target,
      title: targetTitle(plan),
      subtitle: SUBTITLE[plan.target],
      facts,
      insideCluster: plan.target === "pbs-vm",
    },
    offsite: pbs && plan.offsite ? { address: plan.offsiteAddress || "(no address)" } : null,
  };
}
