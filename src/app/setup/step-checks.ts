// What stops the wizard moving on. Each step's "preview" button, and each
// preview's "next", refuses to continue while any problem listed here for
// that step (or an earlier one) remains — and says what they are.
//
// These call the same validators, with the same arguments, as the fields
// that show the errors, so the red fields and the blocking list agree.
// Only real field errors block: advisories (hints.ts, storage.ts) warn but
// never stop progress.

import {
  addressableBridgeKeys,
  buildAddressConflicts,
  collectNodeNames,
  effectiveClusterStorage,
  maxBondsForCluster,
  siblingVlanTagsFor,
} from "./derive";
import { hasLocalDisks, validatePoolName, withEffectiveDiskRoles } from "./storage";
import {
  required,
  validateCidr,
  validateFriendlyName,
  validateHostCidr,
  validateHostLabel,
  validateHostnameSuffix,
  validateIntRange,
  validateInterfaceName,
  validateIp,
  validateNetwork,
  validateOptionalVlanTag,
  validateUniqueName,
  validateVlanTag,
} from "./validation";
import {
  MAX_NICS_PER_NODE,
  bridgeCountFor,
  bridgeKey,
  enabledStorageModes,
  interfacesFor,
  needsHostIpForPurposes,
  type NodeInfo,
  type PersistedState,
  type WizardStepId,
} from "./wizard-state";

export interface StepProblem {
  step: WizardStepId;
  /** "cluster", or the node it's on, e.g. "node 02 — pve02" */
  where: string;
  /** the field's label, as the form shows it */
  field: string;
  message: string;
}

/** the parts of the wizard's state the checks read — a PersistedState, or the live form */
export type CheckedState = Pick<
  PersistedState,
  "nodeCount" | "nodes" | "hostnameSuffix" | "globalCidr" | "gateway" | "homelabVlan" | "clusterStorage" | "storage"
>;

const STEP_ORDER: WizardStepId[] = ["hardware", "network", "storage"];

function nodeLabel(node: NodeInfo, index: number): string {
  return `node ${String(index + 1).padStart(2, "0")} — ${node.name || "unnamed"}`;
}

/**
 * Collects problems for one step. `check` records one only when the
 * validator returns a message, which keeps each rule below to one line.
 */
function collector(step: WizardStepId) {
  const problems: StepProblem[] = [];
  const check = (where: string, field: string, message: string | null) => {
    if (message) problems.push({ step, where, field, message });
  };
  return { problems, check };
}

export function hardwareProblems(state: CheckedState): StepProblem[] {
  const { problems, check } = collector("hardware");
  check("cluster", "number of nodes", validateIntRange(state.nodeCount, 1, 16, { required: true }));

  state.nodes.forEach((node, i) => {
    const where = nodeLabel(node, i);
    const names = collectNodeNames(node);
    check(where, "node name", required(node.name, validateHostLabel));
    check(where, "number of cpus", validateIntRange(node.cpuCount, 1, 8, { required: true }));
    check(where, "cores per cpu", validateIntRange(node.coresPerCpu, 1, 256, { required: true }));
    check(where, "memory (gb)", validateIntRange(node.ramGb, 1, 16384, { required: true }));
    check(where, "boot disk size (gb)", validateIntRange(node.bootDiskSizeGb, 8, 1048576, { required: true }));
    check(where, "boot disk friendly name", validateFriendlyName(node.bootDiskName) ?? validateUniqueName(node.bootDiskName, names.disks));
    check(where, "number of additional disks", validateIntRange(node.additionalDiskCount, 0, 12));
    node.additionalDisks.forEach((disk, j) => {
      check(where, `disk ${j + 1} size (gb)`, validateIntRange(disk.sizeGb, 1, 1048576, { required: true }));
      check(where, `disk ${j + 1} friendly name`, validateFriendlyName(disk.name) ?? validateUniqueName(disk.name, names.disks));
    });
    check(where, "number of nics", validateIntRange(node.nicCount, 1, MAX_NICS_PER_NODE, { required: true }));
    node.nics.forEach((nic, j) => {
      check(where, `nic ${j + 1} friendly name`, validateInterfaceName(nic.name) ?? validateUniqueName(nic.name, names.interfaces));
    });
  });
  return problems;
}

export function networkProblems(state: CheckedState): StepProblem[] {
  const { problems, check } = collector("network");
  check("cluster", "hostname suffix", validateHostnameSuffix(state.hostnameSuffix));
  check("cluster", "homelab cidr", required(state.globalCidr, validateCidr));
  check("cluster", "main homelab vlan", validateOptionalVlanTag(state.homelabVlan));
  check("cluster", "gateway", required(state.gateway, validateIp));

  const conflicts = buildAddressConflicts(state.nodes);
  const maxBonds = maxBondsForCluster(state.nodes);

  state.nodes.forEach((node, i) => {
    const where = nodeLabel(node, i);
    const names = collectNodeNames(node);
    const net = node.network;
    check(where, "hostname", validateHostLabel(net.hostLabel));
    // the management address is the one the web ui and ssh answer on — a
    // real host address, not a network or broadcast address
    check(where, "static ip", validateHostCidr(net.cidr) ?? conflicts.get(`${i}#mgmt`) ?? null);

    check(where, "number of bonds", validateIntRange(net.bondCount, 0, maxBonds, { required: true }));
    net.bonds.forEach((bond, b) => {
      check(where, `bond ${b + 1} name`, validateInterfaceName(bond.name) ?? validateUniqueName(bond.name, names.interfaces));
      check(where, `bond ${b + 1} vlan tag`, validateOptionalVlanTag(bond.vlanTag));
    });

    const addressable = new Set(addressableBridgeKeys(node));
    for (const iface of interfacesFor(node.nics, net.bonds)) {
      const count = bridgeCountFor(net.bridgeCounts, iface.id);
      for (let idx = 0; idx < count; idx++) {
        const key = bridgeKey(iface.id, idx);
        const bridge = net.bridges[key];
        if (!bridge || !bridge.enabled) continue;
        const label = bridge.name || key;
        check(where, `bridge ${label} name`, validateInterfaceName(bridge.name) ?? validateUniqueName(bridge.name, names.interfaces));
        // an extra bridge shares its nic with a sibling, which linux only
        // allows when each is tagged with its own vlan
        if (idx > 0) {
          check(where, `bridge ${label} vlan tag`, validateVlanTag(bridge.vlanTag, siblingVlanTagsFor(net.bridges, count, iface.id, idx)));
        }
        if (addressable.has(key)) {
          const needsHost = needsHostIpForPurposes(bridge.purposes, bridge.otherNeedsHostIp);
          const address = needsHost ? validateHostCidr(bridge.ip) : validateNetwork(bridge.ip);
          check(where, `bridge ${label} ${needsHost ? "static ip" : "network"}`, address ?? conflicts.get(`${i}#${key}`) ?? null);
        }
      }
    }
  });
  return problems;
}

export function storageProblems(state: CheckedState): StepProblem[] {
  const { problems, check } = collector("storage");
  // the pools actually in effect — a pool that isn't built needs no name
  const active = effectiveClusterStorage(state.clusterStorage, state.nodes);
  const planNodes = withEffectiveDiskRoles(state.nodes, enabledStorageModes(active));
  if (active.ceph) check("cluster", "ceph pool name", validatePoolName(state.storage.ceph.poolName));
  if (active.zfs) {
    check("cluster", "zfs pool name", validatePoolName(state.storage.zfs.poolName));
    check("cluster", "replicate every", validateIntRange(state.storage.zfs.replicationMinutes, 1, 1440, { required: true }));
  }
  if (hasLocalDisks(planNodes)) check("cluster", "local storage id", validatePoolName(state.storage.local.name));
  return problems;
}

const CHECKS: Record<WizardStepId, (state: CheckedState) => StepProblem[]> = {
  hardware: hardwareProblems,
  network: networkProblems,
  storage: storageProblems,
};

/**
 * Everything blocking a step and every step before it — a later step is
 * built on the earlier ones, so a save restored at step 3 with a gap in
 * step 1 still can't move on.
 */
export function problemsUpTo(step: WizardStepId, state: CheckedState): StepProblem[] {
  const last = STEP_ORDER.indexOf(step);
  return STEP_ORDER.slice(0, last + 1).flatMap((s) => CHECKS[s](state));
}
