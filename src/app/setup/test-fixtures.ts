// Builders for the shapes the wizard's pure logic takes. Every field has a
// sane default so a test only states the part it actually cares about —
// which keeps the assertions about the rule under test, not about the
// twenty unrelated fields a NodeInfo happens to carry.

import { defaultBackupPlan } from "./backups";
import { defaultStoragePlan } from "./derive";
import { STORAGE_VERSION } from "./wizard-state";
import type {
  AdditionalDisk,
  BackupPlan,
  BondConfig,
  BridgeConfig,
  InterfacePurpose,
  NicInfo,
  NicSpeed,
  NodeInfo,
  NodeNetwork,
  PersistedState,
} from "./wizard-state";

export function nic(overrides: Partial<NicInfo> = {}): NicInfo {
  return { speed: "1gbe", name: "nic-1", port: "", ...overrides };
}

export function nics(...specs: (NicSpeed | Partial<NicInfo>)[]): NicInfo[] {
  return specs.map((spec, i) =>
    typeof spec === "string" ? nic({ speed: spec, name: `nic-${i + 1}` }) : nic({ name: `nic-${i + 1}`, ...spec }),
  );
}

export function disk(overrides: Partial<AdditionalDisk> = {}): AdditionalDisk {
  // role "" = unchosen, which resolves to the first enabled storage mode
  // (see effectiveDiskRole) — so a fixture disk lands in ceph or zfs,
  // whichever the test switched on
  return { type: "ssd", sizeGb: "1000", name: "storage-1", role: "", ...overrides };
}

/**
 * Disks from a compact spec: a number is a size in GB at the default type
 * and role, an object overrides whatever it names. Keeps a capacity test
 * reading as `disks(1000, 1000, 2000)` rather than three object literals.
 */
export function disks(...specs: (number | Partial<AdditionalDisk>)[]): AdditionalDisk[] {
  return specs.map((spec, i) =>
    typeof spec === "number"
      ? disk({ sizeGb: String(spec), name: `storage-${i + 1}` })
      : disk({ name: `storage-${i + 1}`, ...spec }),
  );
}

export function bridge(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    enabled: true,
    name: "vmbr0",
    purposes: ["vm"] as InterfacePurpose[],
    otherNeedsHostIp: false,
    ip: "",
    vlanTag: "",
    ...overrides,
  };
}

export function bond(overrides: Partial<BondConfig> = {}): BondConfig {
  return { name: "bond0", mode: "active-backup", nicIndices: [0, 1], vlanTag: "", ...overrides };
}

export function network(overrides: Partial<NodeNetwork> = {}): NodeNetwork {
  return {
    hostLabel: "pve01",
    cidr: "10.0.0.11/24",
    bondCount: "0",
    bonds: [],
    managementInterfaceId: "nic-0",
    bridgeCounts: {},
    bridges: { "nic-0#0": bridge() },
    ...overrides,
  };
}

export function node(overrides: Partial<NodeInfo> = {}): NodeInfo {
  const { network: netOverride, ...rest } = overrides;
  return {
    name: "pve01",
    cpuVendor: "intel",
    cpuFamily: "SandyBridge",
    cpuCount: "1",
    coresPerCpu: "8",
    ramGb: "64",
    bootDiskType: "nvme",
    bootDiskSizeGb: "500",
    bootDiskName: "boot",
    additionalDiskCount: "1",
    additionalDisks: disks(1000),
    nicCount: "2",
    nics: nics("1gbe", "1gbe"),
    network: netOverride ?? network(),
    ...rest,
  };
}

// n nodes, numbered pve01.. with matching host labels and addresses —
// the shape most cluster-wide rules are actually checked against.
export function cluster(count: number, overrides: Partial<NodeInfo> = {}): NodeInfo[] {
  return Array.from({ length: count }, (_, i) => {
    const label = `pve0${i + 1}`;
    const base = node(overrides);
    return {
      ...base,
      name: label,
      network: { ...base.network, hostLabel: label, cidr: `10.0.0.${11 + i}/24` },
    };
  });
}

/** a complete backup plan: the defaults, plus the pbs address they leave blank */
export function backupPlan(overrides: Partial<BackupPlan> = {}): BackupPlan {
  return { ...defaultBackupPlan(), pbsAddress: "10.0.10.50", ...overrides };
}

/**
 * A complete, valid saved state — what the wizard itself would write. For
 * tests that start from a save (the preview routes, restore paths) rather
 * than driving the form to build one.
 */
export function persistedState(overrides: Partial<PersistedState> = {}): PersistedState {
  return {
    version: STORAGE_VERSION,
    currentStep: "storage",
    nodeCount: "3",
    hostnameSuffix: "lab.lan",
    globalCidr: "10.0.10.0/24",
    gateway: "10.0.10.1",
    dns: "10.0.10.1",
    homelabVlan: "",
    nodes: cluster(3),
    identicalHardware: false,
    identicalNetwork: false,
    clusterStorage: { ceph: true, zfs: false },
    storage: defaultStoragePlan(),
    backups: backupPlan(),
    identicalStorage: false,
    ...overrides,
  };
}
