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
  collectAddressClaims,
  collectNodeNames,
  effectiveClusterStorage,
  maxBondsForCluster,
  siblingVlanTagsFor,
} from "./derive";
import { hasLocalDisks, validatePoolName, withEffectiveDiskRoles } from "./storage";
import { validateCountry, validateKeyboard, validateTimezone } from "./location";
import {
  bridgeOptions,
  busProblems,
  effectiveGuestNode,
  haAvailable,
  imagesFor,
  takesCloudInit,
  validateCiUser,
  validateCores,
  validateCpuLimit,
  validateCpuUnits,
  validateDiskGb,
  validateGuestName,
  validateGuestVlan,
  validateMac,
  validateMemoryGb,
  validateMinMemoryGb,
  validateMountPath,
  validateMtu,
  validateNicGateway,
  validateNicIp,
  validateOptionalCount,
  validateOsSystem,
  validateRate,
  validateSockets,
  validateSwapGb,
  validateTags,
  validateVmid,
  validateVolumeGb,
  effectiveCephVolumes,
} from "./software";
import {
  rootPasswordFor,
  validateClientId,
  validateIssuerUrl,
  validateRealm,
  validateRootPassword,
  validateSshKeys,
} from "./access";
import { bootDiskFor, validateBootDiskName } from "./boot-disk";
import {
  RETENTION_FIELDS,
  maxBackupsKept,
  usesPbs,
  validateExportPath,
  validateHostAddress,
  validateRetention,
  validateScheduleTime,
} from "./backups";
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
  interfaceNameFor,
  interfacesFor,
  isStorageLink,
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
  | "location"
  | "nodeCount"
  | "nodes"
  | "identicalHardware"
  | "hostnameSuffix"
  | "globalCidr"
  | "gateway"
  | "dns"
  | "homelabVlan"
  | "clusterStorage"
  | "storage"
  | "backups"
  | "access"
  | "software"
  | "install"
>;

const STEP_ORDER: WizardStepId[] = ["location", "hardware", "network", "storage", "backups", "access", "software", "install"];

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

export function locationProblems(state: CheckedState): StepProblem[] {
  const { problems, check } = collector("location");
  check("cluster", "country", validateCountry(state.location.country));
  check("cluster", "keyboard", validateKeyboard(state.location.keyboard));
  check("cluster", "timezone", validateTimezone(state.location.timezone));
  return problems;
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
  check("cluster", "dns server", required(state.dns, validateIp));

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
        // a storage link has no bridge — no name to check, and its problems
        // are named after the nic or bond that carries the address
        const storageLink = isStorageLink(net, key);
        const label = storageLink
          ? `storage link ${interfaceNameFor(iface.id, node.nics, net.bonds)}`
          : `bridge ${bridge.name || key}`;
        if (!storageLink) {
          check(where, `${label} name`, validateInterfaceName(bridge.name) ?? validateUniqueName(bridge.name, names.interfaces));
        }
        // an extra bridge shares its nic with a sibling, which linux only
        // allows when each is tagged with its own vlan
        if (idx > 0) {
          check(where, `${label} vlan tag`, validateVlanTag(bridge.vlanTag, siblingVlanTagsFor(net.bridges, count, iface.id, idx)));
        }
        if (addressable.has(key)) {
          const needsHost = needsHostIpForPurposes(bridge.purposes, bridge.otherNeedsHostIp);
          const address = needsHost ? validateHostCidr(bridge.ip) : validateNetwork(bridge.ip);
          check(where, `${label} ${needsHost ? "static ip" : "network"}`, address ?? conflicts.get(`${i}#${key}`) ?? null);
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

export function backupProblems(state: CheckedState): StepProblem[] {
  const { problems, check } = collector("backups");
  const plan = state.backups;
  if (plan.target === "none") return problems;
  // each target only needs its own fields — the others are kept, unread
  if (plan.target === "pbs-external") check("cluster", "pbs address", validateHostAddress(plan.pbsAddress));
  if (usesPbs(plan.target)) check("cluster", "datastore", validatePoolName(plan.datastore));
  if (plan.target === "nfs") {
    check("cluster", "nfs server", validateHostAddress(plan.nfsServer));
    check("cluster", "export path", validateExportPath(plan.nfsExport));
  }
  check("cluster", "backup time", validateScheduleTime(plan.schedule));
  for (const field of RETENTION_FIELDS) check("cluster", field.label, validateRetention(plan[field.key]));
  // retention that keeps nothing deletes each backup as it's made
  if (RETENTION_FIELDS.every((f) => !validateRetention(plan[f.key])) && maxBackupsKept(plan) === 0) {
    check("cluster", "retention", "keeps nothing — keep at least one backup");
  }
  if (usesPbs(plan.target) && plan.offsite) check("cluster", "off-site pbs address", validateHostAddress(plan.offsiteAddress));
  return problems;
}

export function accessProblems(state: CheckedState): StepProblem[] {
  const { problems, check } = collector("access");
  const { access } = state;
  check("cluster", "ssh public key", validateSshKeys(access.sshKeys));
  state.nodes.forEach((node, i) => {
    check(nodeLabel(node, i), "root password", validateRootPassword(rootPasswordFor(access, i)));
  });
  if (access.oidc.enabled) {
    check("cluster", "oidc realm", validateRealm(access.oidc.realm));
    check("cluster", "issuer url", validateIssuerUrl(access.oidc.issuerUrl));
    check("cluster", "client id", validateClientId(access.oidc.clientId));
  }
  return problems;
}

/** step 7 is optional — no guests at all is a complete step */
export function softwareProblems(state: CheckedState): StepProblem[] {
  const { problems, check } = collector("software");
  const ctx = { nodes: state.nodes, clusterStorage: state.clusterStorage, storage: state.storage, kubernetes: state.software.kubernetes };
  const guests = state.software.guests;
  if (effectiveCephVolumes(guests, ctx)) check("kubernetes", "space for volumes", validateVolumeGb(state.software.kubernetes.volumeGb));
  const count = (values: string[], v: string) => values.filter((x) => x === v).length;
  const names = guests.map((g) => g.name);
  const vmids = guests.map((g) => g.vmid);
  const staticIps = guests.flatMap((g) => g.nics.filter((n) => n.ipMode === "static").map((n) => n.ip.split("/")[0]));
  const nodeIps = new Set(collectAddressClaims(state.nodes).map((c) => c.ip));

  guests.forEach((guest, i) => {
    const where = `guest ${guest.name || guest.vmid || i + 1}`;
    const vm = guest.kind === "vm";
    check(where, "name", validateGuestName(guest.name) ?? (count(names, guest.name) > 1 ? "another guest has this name" : null));
    check(where, "vmid", validateVmid(guest.vmid) ?? (count(vmids, guest.vmid) > 1 ? "another guest has this vmid" : null));
    check(where, "image", imagesFor(guest.kind).some((img) => img.id === guest.image) ? null : "pick an image");
    check(where, "tags", validateTags(guest.tags));
    check(where, "startup order", validateOptionalCount(guest.startupOrder, 1000));
    check(where, "startup delay", validateOptionalCount(guest.startupDelay, 3600));
    check(where, "shutdown timeout", validateOptionalCount(guest.shutdownTimeout, 86_400));
    if (vm) check(where, "sockets", validateSockets(guest.sockets));
    check(where, "cores", validateCores(guest.cores));
    check(where, "cpu limit", validateCpuLimit(guest));
    check(where, "cpu weight", validateCpuUnits(guest.cpuUnits));
    check(where, "memory", validateMemoryGb(guest.memoryGb));
    check(where, "minimum memory", validateMinMemoryGb(guest));
    if (!vm) check(where, "swap", validateSwapGb(guest.swapGb));
    check(where, "system", validateOsSystem(guest));
    check(where, "cloud-init user", validateCiUser(guest));
    check(where, "disks", guest.disks.length === 0 ? "needs a disk" : busProblems(guest));

    const paths = guest.disks.map((d) => d.mountPath);
    guest.disks.forEach((disk, d) => {
      const label = vm ? `disk ${d + 1}` : d === 0 ? "root disk" : `mount point ${d}`;
      check(where, `${label} size`, validateDiskGb(disk.sizeGb));
      if (!vm) {
        check(where, `${label} path`, validateMountPath(disk, d) ?? (d > 0 && count(paths, disk.mountPath) > 1 ? "two mount points share this path" : null));
      }
    });

    const nodeIndex = effectiveGuestNode(guest, state.nodes.length);
    const bridges = bridgeOptions(ctx, nodeIndex, guest.ha && haAvailable(guest, ctx));
    const cloud = takesCloudInit(guest);
    guest.nics.forEach((nic, n) => {
      const label = `nic ${n + 1}`;
      check(where, `${label} bridge`, bridges.includes(nic.bridge) ? null : bridges.length ? "pick a bridge" : "no bridge on this node carries vm traffic — add one in step 3");
      check(where, `${label} vlan tag`, validateGuestVlan(nic.vlanTag));
      check(where, `${label} mac address`, validateMac(nic.macAddress));
      check(where, `${label} rate limit`, validateRate(nic.rateMbps));
      check(where, `${label} mtu`, validateMtu(nic.mtu));
      // a vm's address only matters where cloud-init can set it
      if (vm && !cloud) return;
      const ip = nic.ip.split("/")[0];
      check(
        where,
        `${label} ip address`,
        validateNicIp(nic) ??
          (nic.ipMode === "static" && count(staticIps, ip) > 1 ? "another guest has this address" : null) ??
          (nic.ipMode === "static" && nodeIps.has(ip) ? "a node already has this address" : null),
      );
      check(where, `${label} gateway`, validateNicGateway(nic));
    });
  });
  return problems;
}

/**
 * Step 8 only checks what's typed: a node with no boot disk yet still gets
 * its file, with the placeholder the installer stops at.
 */
export function installProblems(state: CheckedState): StepProblem[] {
  const { problems, check } = collector("install");
  if (state.identicalHardware) {
    check("cluster", "boot disk", validateBootDiskName(state.install.bootDisk));
  } else {
    state.nodes.forEach((node, i) => check(nodeLabel(node, i), "boot disk", validateBootDiskName(bootDiskFor(state, i))));
  }
  return problems;
}

const CHECKS: Record<WizardStepId, (state: CheckedState) => StepProblem[]> = {
  location: locationProblems,
  hardware: hardwareProblems,
  network: networkProblems,
  storage: storageProblems,
  backups: backupProblems,
  access: accessProblems,
  software: softwareProblems,
  install: installProblems,
};

/**
 * Everything blocking a step and every step before it — a later step is
 * built on the earlier ones, so a save restored at step 4 with a gap in
 * step 2 still can't move on.
 */
export function problemsUpTo(step: WizardStepId, state: CheckedState): StepProblem[] {
  const last = STEP_ORDER.indexOf(step);
  return STEP_ORDER.slice(0, last + 1).flatMap((s) => CHECKS[s](state));
}
