// Builders for the shapes the wizard's pure logic takes. Every field has a
// sane default so a test only states the part it actually cares about —
// which keeps the assertions about the rule under test, not about the
// twenty unrelated fields a NodeInfo happens to carry.

import { defaultAccessPlan } from "./access";
import { defaultBackupPlan } from "./backups";
import { defaultKubernetesPlan, type GuestDisk, type GuestNic, type GuestPlan, type KubernetesPlan, type SoftwarePlan } from "./software";
import { defaultStoragePlan } from "./derive";
import { STEP_VERSIONS, STORAGE_VERSION } from "./wizard-state";
import type {
  AccessPlan,
  AdditionalDisk,
  BackupPlan,
  BondConfig,
  BridgeConfig,
  InterfacePurpose,
  NicInfo,
  NicSpeed,
  NodeInfo,
  NodeNetwork,
  InstallPlan,
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

// real public keys (the private halves were thrown away) — the wizard
// checks a key's structure, so a made-up string wouldn't pass
export const ED25519_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKgffwrQPlGF7TvHtY8FYkP3YoGx5zmEzomfKgJNU/+n test@fixture";
// what `ssh-keygen -lf` prints for it
export const ED25519_FINGERPRINT = "SHA256:VMMWq9t47lABbhcxXIznOTQavhqT0SxN8GlNKpiX1mw";
export const RSA_KEY =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC/eECohZQWJuZFZb5HSW9sFazmSHSTsA+28JXx9nT6eFMLagbbdsPJslY6tMzWdiB6A0iJHOkir75AG1vmulQLgmveyNSZUloA4wSD3ClG4/1d9iEJKvqX4oWcU22zV+u+RocDQvWMvf8JAQN6sp79PPepZzC/zkUqdVddjH1Ou+Uh5eRyIZ3tjpvLURmEWRS7OrBL22q37+3HLD0S2sqvt/1PGVU2L/GE2Di2g5CHVrrjY0n/pRkG9o8qqVvNa/K+ioGUU9sSRMvxEL/JVy4cLffKyOTzAV4/YGpBEHyHrlySu+4p1RDbaBISN0hVjRblfTB6DpRbf0q23pYIpbvv+mlWVDq4PrYwz1moZy1S918oCsFxGeq/RGo3EE+3RIktMLRbWYV9vxUnaACzoUIMWdY3vLxdjaMKg4yXsbZ3wNs1ylAVD0rd41zPThLSEZC9AGEkxmhUFCQebzwTUDyLpOEYf9NhdEgmVmEzu8BB8sd9x40iCKDg168Pefmt0tM= rsa@fixture";

/** a complete access plan: a key, and a distinct root password per node */
export function accessPlan(overrides: Partial<AccessPlan> = {}, nodeCount = 3): AccessPlan {
  return {
    ...defaultAccessPlan(),
    sshKeys: ED25519_KEY,
    rootPasswords: Array.from({ length: nodeCount }, (_, i) => `root-password-${i + 1}-long`),
    ...overrides,
  };
}

/**
 * A complete, valid saved state — what the wizard itself would write. For
 * tests that start from a save (the preview routes, restore paths) rather
 * than driving the form to build one.
 */
export function persistedState(overrides: Partial<PersistedState> = {}): PersistedState {
  return {
    version: STORAGE_VERSION,
    stepVersions: { ...STEP_VERSIONS },
    currentStep: "storage",
    location: { country: "at", keyboard: "de", timezone: "Europe/Vienna" },
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
    access: accessPlan(),
    software: softwarePlan(),
    install: installPlan(),
    identicalStorage: false,
    ...overrides,
  };
}

/** step 8's plan: no boot disk named yet, unless stated */
export function installPlan(overrides: Partial<InstallPlan> = {}): InstallPlan {
  return { bootDisk: "", bootDisks: [], ...overrides };
}

/** step 7's plan: these guests, and kubernetes' defaults unless stated */
export function softwarePlan(guests: GuestPlan[] = [], kubernetes: Partial<KubernetesPlan> = {}): SoftwarePlan {
  return { guests, kubernetes: { ...defaultKubernetesPlan(), ...kubernetes } };
}

/** a guest whose first disk and first nic carry these — how most tests shape one */
export function guestWith(guest: GuestPlan, disk: Partial<GuestDisk> = {}, nic: Partial<GuestNic> = {}): GuestPlan {
  return {
    ...guest,
    disks: guest.disks.map((d, i) => (i === 0 ? { ...d, ...disk } : d)),
    nics: guest.nics.map((n, i) => (i === 0 ? { ...n, ...nic } : n)),
  };
}
