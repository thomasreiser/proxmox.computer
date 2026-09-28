// Builders for the shapes the wizard's pure logic takes. Every field has a
// sane default so a test only states the part it actually cares about —
// which keeps the assertions about the rule under test, not about the
// twenty unrelated fields a NodeInfo happens to carry.

import type {
  BondConfig,
  BridgeConfig,
  InterfacePurpose,
  NicInfo,
  NicSpeed,
  NodeInfo,
  NodeNetwork,
} from "./wizard-state";

export function nic(overrides: Partial<NicInfo> = {}): NicInfo {
  return { speed: "1gbe", name: "nic-1", ...overrides };
}

export function nics(...specs: (NicSpeed | Partial<NicInfo>)[]): NicInfo[] {
  return specs.map((spec, i) =>
    typeof spec === "string" ? nic({ speed: spec, name: `nic-${i + 1}` }) : nic({ name: `nic-${i + 1}`, ...spec }),
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
    additionalDisks: [{ type: "ssd", sizeGb: "1000", name: "storage-1" }],
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
