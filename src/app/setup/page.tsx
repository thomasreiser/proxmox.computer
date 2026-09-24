"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import wizardSteps from "@/data/wizard-steps.json";
import nicSpeedsData from "@/data/nic-speeds.json";
import cpuVendorsData from "@/data/cpu-vendors.json";
import cpuFamiliesData from "@/data/cpu-families.json";

type CpuVendor = "intel" | "amd";
type DiskType = "nvme" | "ssd" | "hdd";
type NicSpeed = "1gbe" | "2.5gbe" | "10gbe" | "25gbe" | "other";
type WizardStepId = "hardware" | "network";

interface NicInfo {
  speed: NicSpeed;
  name: string;
}

interface AdditionalDisk {
  type: DiskType;
  sizeGb: string;
  name: string;
}

interface HardwareSpec {
  cpuVendor: CpuVendor;
  cpuFamily: string;
  cpuCount: string;
  coresPerCpu: string;
  ramGb: string;
  bootDiskType: DiskType;
  bootDiskSizeGb: string;
  bootDiskName: string;
  additionalDiskCount: string;
  additionalDisks: AdditionalDisk[];
  nicCount: string;
  nics: NicInfo[];
}

const DISK_NAME_PRESETS = ["boot", "vm-storage", "backup", "iso", "storage-1", "storage-2", "ceph-osd-1", "ceph-osd-2"];
const NIC_NAME_PRESETS = ["onboard", "lan", "wan", "management", "storage", "cluster", "vmotion", "corosync"];

function defaultNicName(index: number): string {
  return `nic-${index + 1}`;
}

function defaultAdditionalDisk(index: number): AdditionalDisk {
  return { type: "hdd", sizeGb: "", name: `storage-${index + 1}` };
}

type InterfacePurpose = "vm" | "ceph" | "backup" | "cluster" | "other";

interface PurposeInfo {
  value: InterfacePurpose;
  label: string;
  // true = this purpose always needs a real host address; false = never
  // (pure vm/ct switch); null = "other" — ask the visitor directly.
  needsHostIp: boolean | null;
  hint: string;
}

const INTERFACE_PURPOSE_OPTIONS: PurposeInfo[] = [
  {
    value: "vm",
    label: "vm / container traffic",
    needsHostIp: false,
    hint: "a pure switch — vms and cts get their own ips, the host doesn't need one here",
  },
  {
    value: "ceph",
    label: "ceph / storage traffic",
    needsHostIp: true,
    hint: "the host's ceph client (and osds, if this node runs any) need a real address here",
  },
  {
    value: "backup",
    label: "backups",
    needsHostIp: true,
    hint: "the host needs an address here to reach the backup target",
  },
  {
    value: "cluster",
    label: "cluster sync (corosync)",
    needsHostIp: true,
    hint: "the host needs an address here for corosync ring traffic",
  },
  {
    value: "other",
    label: "other",
    needsHostIp: null,
    hint: "pick whether the node itself needs an address here",
  },
];

function purposeInfoFor(purpose: InterfacePurpose): PurposeInfo {
  return INTERFACE_PURPOSE_OPTIONS.find((p) => p.value === purpose) ?? INTERFACE_PURPOSE_OPTIONS[0];
}

// a real nic/bridge often earns its keep serving more than one purpose at
// once (vm traffic + corosync is a completely normal homelab setup) — so
// this is a set, not a single choice. it's still enforced to be non-empty
// in the UI (there's always at least one reason a bridge exists).
function needsHostIpForPurposes(purposes: InterfacePurpose[], otherNeedsHostIp: boolean): boolean {
  return purposes.some((p) => purposeInfoFor(p).needsHostIp ?? otherNeedsHostIp);
}

// combines the "why" from every selected purpose that actually requires a
// host address, so the field hint reflects all of them, not just one.
function requiredIpHintFor(purposes: InterfacePurpose[], otherNeedsHostIp: boolean): string {
  return purposes
    .map((p) => purposeInfoFor(p))
    .filter((info) => info.needsHostIp === true || (info.needsHostIp === null && otherNeedsHostIp))
    .map((info) => info.hint)
    .join("; ");
}

interface BridgeConfig {
  enabled: boolean;
  name: string;
  purposes: InterfacePurpose[];
  // only meaningful when purposes includes "other" — the answer to "does
  // the node itself need an address here?" for that one ambiguous case.
  otherNeedsHostIp: boolean;
  // a required host ip+cidr when any selected purpose needs one (ceph,
  // backups, cluster, or "other" answered yes); an optional bare
  // network/cidr — just documenting the intended vm subnet — otherwise.
  ip: string;
}

type BondMode = "active-backup" | "lacp" | "balance-alb" | "balance-rr";

interface BondConfig {
  name: string;
  mode: BondMode;
  // indices into node.nics; a bond isn't "real" until it has 2+
  nicIndices: number[];
}

const BOND_MODE_OPTIONS: { value: BondMode; label: string; hint: string }[] = [
  {
    value: "active-backup",
    label: "active-backup",
    hint: "one link active, the other cold for failover — no switch config needed",
  },
  {
    value: "lacp",
    label: "lacp (802.3ad)",
    hint: "combines bandwidth from every link — needs lacp configured on the switch port",
  },
  {
    value: "balance-alb",
    label: "balance-alb",
    hint: "load-balances outgoing traffic across links — no switch config needed, but fewer guarantees than lacp",
  },
  {
    value: "balance-rr",
    label: "balance-rr",
    hint: "round-robins packets across every link, the only mode that speeds up a single connection — but only reliable on a direct link between two hosts, most switches mishandle it",
  },
];

function bondModeLabel(mode: BondMode): string {
  return BOND_MODE_OPTIONS.find((o) => o.value === mode)?.label ?? mode;
}

function defaultBondName(index: number): string {
  return `bond${index}`;
}

// A bond needs 2+ member nics to actually be an interface — fewer than
// that and it's still being assembled, so it doesn't count yet.
function validBonds(bonds: BondConfig[]): BondConfig[] {
  return bonds.filter((b) => b.nicIndices.length >= 2);
}

interface InterfaceRef {
  id: string; // "nic-<i>" or "bond-<i>", <i> is the index in nics/bonds
  label: string;
}

// Every selectable network interface on a node: each nic not claimed by
// a (valid) bond, plus each valid bond itself. This is what "management
// interface" and "bridge" pickers choose from — a bonded nic disappears
// from the list on its own, since it's part of its bond now, not a
// standalone interface.
function interfacesFor(nics: NicInfo[], bonds: BondConfig[]): InterfaceRef[] {
  const bonded = new Set(validBonds(bonds).flatMap((b) => b.nicIndices));
  const nicRefs: InterfaceRef[] = nics
    .map((nic, i) => ({ nic, i }))
    .filter(({ i }) => !bonded.has(i))
    .map(({ nic, i }) => ({ id: `nic-${i}`, label: `nic ${i + 1} — ${nicSpeedLabel(nic.speed)}` }));
  const bondRefs: InterfaceRef[] = bonds
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.nicIndices.length >= 2)
    .map(({ b, i }) => ({
      id: `bond-${i}`,
      label: `${b.name} — ${b.nicIndices.map((idx) => `nic ${idx + 1}`).join(" + ")} (${bondModeLabel(b.mode)})`,
    }));
  return [...nicRefs, ...bondRefs];
}

// Same as interfacesFor, but only the ids — used for resync bookkeeping
// where we don't have (or need) real NicInfo, just the count.
function interfaceIdsFor(nicCount: number, bonds: BondConfig[]): string[] {
  const usable = bonds.map((b, i) => ({ b, i })).filter(({ b }) => b.nicIndices.length >= 2);
  const bonded = new Set(usable.flatMap(({ b }) => b.nicIndices));
  const nicIds = Array.from({ length: nicCount }, (_, i) => i)
    .filter((i) => !bonded.has(i))
    .map((i) => `nic-${i}`);
  const bondIds = usable.map(({ i }) => `bond-${i}`);
  return [...nicIds, ...bondIds];
}

interface NodeNetwork {
  // just the label, e.g. "pve01" — the domain suffix is never stored
  // per node, only ever read live from the global hostname suffix, so a
  // node's fqdn can't drift out of sync with the domain you set.
  hostLabel: string;
  cidr: string;
  bondCount: string;
  bonds: BondConfig[];
  managementInterfaceId: string;
  // keyed by interface id (nic-<i> or bond-<i>); the entry for
  // managementInterfaceId is unused in the ui but harmless to keep.
  bridges: Record<string, BridgeConfig>;
}

interface NodeInfo extends HardwareSpec {
  name: string;
  network: NodeNetwork;
}

const nicSpeedOptions = nicSpeedsData as { value: NicSpeed; label: string; hint?: string }[];
const cpuVendorOptions = cpuVendorsData as { value: CpuVendor; label: string }[];

function nicSpeedLabel(speed: NicSpeed): string {
  return nicSpeedOptions.find((o) => o.value === speed)?.label ?? speed;
}

interface CpuFamily {
  name: string;
  qemuType: string;
  from: number;
  to: number | null;
  defaultCores: number;
  note?: string;
}

interface CpuFamiliesData {
  architectures: Record<CpuVendor, CpuFamily[]>;
  cpu_types: Record<string, Record<CpuVendor, string[]>>;
}

const cpuFamilies = cpuFamiliesData as CpuFamiliesData;

function familiesByDate(vendor: CpuVendor): CpuFamily[] {
  return [...cpuFamilies.architectures[vendor]].sort((a, b) => a.from - b.from);
}

// Some display names (real chip generations, e.g. "Alder Lake") have no
// dedicated qemu cpu model — they map to the closest native qemu type.
// Resolve to that native type before comparing nodes for compatibility.
function qemuTypeFor(vendor: CpuVendor, familyName: string): string {
  const entry = cpuFamilies.architectures[vendor].find((f) => f.name === familyName);
  return entry?.qemuType ?? familyName;
}

// qemuType values carry security-mitigation suffixes (-noTSX, -IBRS,
// -IBPB) that don't represent a later hardware generation — just a
// different feature-flag preset for the same silicon. Strip them to find
// the entry that actually carries this generation's real launch dates.
function stripMitigationSuffix(qemuType: string): string {
  return qemuType.replace(/-(noTSX-IBRS|noTSX|IBRS|IBPB)$/, "");
}

function nativeEntryFor(vendor: CpuVendor, qemuType: string): CpuFamily | undefined {
  const base = stripMitigationSuffix(qemuType);
  return cpuFamilies.architectures[vendor].find((f) => f.name === base);
}

// A rough, "better than nothing" per-cpu core-count guess for a family —
// real SKUs in any given generation range widely, so this is only a
// sane starting point the visitor is expected to correct.
function defaultCoresFor(vendor: CpuVendor, familyName: string): number {
  const entry = cpuFamilies.architectures[vendor].find((f) => f.name === familyName);
  return entry?.defaultCores ?? 4;
}

// A common, broadly-compatible baseline per vendor — not the newest chip,
// but one whose migration target list (cpu_types[x]) still covers most
// hardware someone is likely to add to the cluster later.
const DEFAULT_CPU_FAMILY: Record<CpuVendor, string> = {
  intel: "Skylake-Server",
  amd: "EPYC-Rome",
};

function defaultHardware(): HardwareSpec {
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
      { speed: "1gbe", name: defaultNicName(0) },
      { speed: "1gbe", name: defaultNicName(1) },
    ],
  };
}

function isValidIPv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

function parseIpv4(ip: string): number[] | null {
  if (!isValidIPv4(ip)) return null;
  return ip.split(".").map(Number);
}

function validateCidr(value: string): string | null {
  if (!value) return null;
  const [ip, prefix] = value.split("/");
  if (!ip || !prefix || !isValidIPv4(ip) || !/^\d{1,2}$/.test(prefix) || Number(prefix) > 32) {
    return "not a valid cidr — try 10.0.10.11/24";
  }
  return null;
}

interface SubnetInfo {
  network: string;
  netmask: string;
  prefix: number;
  broadcast: string;
  firstHost: string;
  lastHost: string;
  usableHosts: number;
}

function subnetDetails(cidr: string): SubnetInfo | null {
  const [ip, prefixStr] = cidr.split("/");
  const octets = parseIpv4(ip ?? "");
  const prefix = Number(prefixStr);
  if (!octets || !prefixStr || Number.isNaN(prefix) || prefix < 0 || prefix > 32) return null;

  const toUint = (a: number, b: number, c: number, d: number) => ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  const toIp = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

  const ipNum = toUint(octets[0], octets[1], octets[2], octets[3]);
  const maskNum = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const networkNum = (ipNum & maskNum) >>> 0;
  const broadcastNum = (networkNum | (~maskNum >>> 0)) >>> 0;

  let firstHostNum = networkNum;
  let lastHostNum = broadcastNum;
  let usableHosts: number;
  if (prefix >= 31) {
    // /31 is a point-to-point link (RFC 3021, both addresses usable);
    // /32 is a single host — neither has a separate network/broadcast.
    usableHosts = prefix === 32 ? 1 : 2;
  } else {
    firstHostNum = networkNum + 1;
    lastHostNum = broadcastNum - 1;
    usableHosts = Math.max(0, lastHostNum - firstHostNum + 1);
  }

  return {
    network: toIp(networkNum),
    netmask: toIp(maskNum),
    prefix,
    broadcast: toIp(broadcastNum),
    firstHost: toIp(firstHostNum),
    lastHost: toIp(lastHostNum),
    usableHosts,
  };
}

function validateIp(value: string): string | null {
  if (!value) return null;
  if (!isValidIPv4(value)) return "not a valid ip — try 10.0.10.1";
  return null;
}

// For purposes that need a real host address (ceph, backups, cluster
// sync, or "other" answered yes) — required, and catches the common
// mistake of typing the network's own address instead of a host on it.
function validateHostCidr(value: string): string | null {
  if (!value) return "required for this purpose — enter this node's address here";
  const basic = validateCidr(value);
  if (basic) return basic;
  const [ip] = value.split("/");
  const info = subnetDetails(value);
  if (info && ip === info.network) {
    return `that's the network address, not a host — try ${info.firstHost}/${info.prefix}`;
  }
  if (info && ip === info.broadcast && info.prefix < 31) {
    return `that's the broadcast address, not a host — try ${info.lastHost}/${info.prefix}`;
  }
  return null;
}

function validateHostnameSuffix(value: string): string | null {
  if (!value) return null;
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(value)) {
    return "not a valid domain — try homelab.lan";
  }
  return null;
}

function validateHostLabel(value: string): string | null {
  if (!value) return null;
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(value)) {
    return "lowercase letters, numbers and hyphens only";
  }
  return null;
}

// A text field for anything in ip or ip/prefix notation, with a small
// toggle beside the input that expands a subnet breakdown (network,
// broadcast, usable range, host count) — collapsed by default so it
// doesn't clutter the form until someone actually wants it.
function CidrField({
  id,
  label,
  value,
  onChange,
  hint,
  error,
  placeholder,
  defaultPrefix = 24,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint: string;
  error: string | null;
  placeholder?: string;
  // if the visitor types a bare ip with no /prefix, we fill one in on
  // blur rather than leave it as a technically-different address. /32
  // would be the "literal" reading of a bare ip, but it means "no other
  // host shares this subnet" — wrong for a LAN-connected management ip
  // or bridge, so default to the real subnet size instead.
  defaultPrefix?: number;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const info = subnetDetails(value);

  function handleBlur() {
    if (isValidIPv4(value)) onChange(`${value}/${defaultPrefix}`);
  }

  return (
    <div className={`pc-field ${error ? "pc-field--error" : ""}`}>
      <label className="label pc-field__label" htmlFor={id}>
        {label}
      </label>
      <div className="pc-field__control">
        <span className="code pc-field__bracket">#</span>
        <input
          id={id}
          className="pc-field__input code"
          type="text"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={handleBlur}
        />
        <button
          type="button"
          className="pc-cmdline__copy"
          disabled={!info}
          onClick={() => setShowDetails((s) => !s)}
          title={info ? "show subnet details" : "enter a valid ip/prefix to see subnet details"}
        >
          i
        </button>
      </div>
      <span className="body-sm pc-field__hint">{error ?? hint}</span>
      {showDetails && info && (
        <div className="pc-table-wrap">
          <table className="pc-table">
            <tbody>
              <tr>
                <td className="body-sm">network</td>
                <td className="body-sm pc-table__num">{info.network}</td>
              </tr>
              <tr>
                <td className="body-sm">netmask</td>
                <td className="body-sm pc-table__num">
                  {info.netmask} (/{info.prefix})
                </td>
              </tr>
              <tr>
                <td className="body-sm">usable range</td>
                <td className="body-sm pc-table__num">
                  {info.firstHost} – {info.lastHost}
                </td>
              </tr>
              <tr>
                <td className="body-sm">broadcast</td>
                <td className="body-sm pc-table__num">{info.broadcast}</td>
              </tr>
              <tr>
                <td className="body-sm">usable hosts</td>
                <td className="body-sm pc-table__num">{info.usableHosts}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Rough per-node defaults, derived from the global cidr — starts at .11
// so .1-.10 stay free for the gateway and other fixed infra.
function deriveNodeCidr(globalCidr: string, nodeIndex: number): string {
  const [ip, prefix] = globalCidr.split("/");
  const octets = parseIpv4(ip ?? "");
  if (!octets) return "";
  octets[3] = Math.min(254, 11 + nodeIndex);
  return `${octets.join(".")}/${prefix || "24"}`;
}

function deriveGateway(globalCidr: string): string {
  const [ip] = globalCidr.split("/");
  const octets = parseIpv4(ip ?? "");
  if (!octets) return "";
  octets[3] = 1;
  return octets.join(".");
}

// vmbr0 is always the management bridge, by convention. Every other
// interface defaults to bridged too (vmbr1, vmbr2, ...) and defaults to
// "vm traffic" purpose — an unused interface does nothing for a wizard
// whose whole point is "get a working homelab with minimal back-and-
// forth", so bridging what's there is the useful default.
function defaultBridgesForIds(ids: string[], managementInterfaceId: string): Record<string, BridgeConfig> {
  let seq = 0;
  const result: Record<string, BridgeConfig> = {};
  for (const id of ids) {
    if (id === managementInterfaceId) {
      result[id] = { enabled: true, name: "vmbr0", purposes: ["vm"], otherNeedsHostIp: false, ip: "" };
    } else {
      seq += 1;
      result[id] = { enabled: true, name: `vmbr${seq}`, purposes: ["vm"], otherNeedsHostIp: false, ip: "" };
    }
  }
  return result;
}

function defaultNodeNetwork(nodeName: string, nicCount: number, globalCidr: string, nodeIndex: number): NodeNetwork {
  const ids = interfaceIdsFor(nicCount, []);
  const mgmt = ids[0] ?? "nic-0";
  return {
    hostLabel: nodeName,
    cidr: deriveNodeCidr(globalCidr, nodeIndex),
    bondCount: "0",
    bonds: [],
    managementInterfaceId: mgmt,
    bridges: defaultBridgesForIds(ids, mgmt),
  };
}

function defaultNode(index: number, globalCidr: string): NodeInfo {
  const name = `pve0${index + 1}`;
  const hardware = defaultHardware();
  return {
    name,
    ...hardware,
    network: defaultNodeNetwork(name, hardware.nics.length, globalCidr, index),
  };
}

function resizeArray<T>(arr: T[], length: number, make: (i: number) => T): T[] {
  if (length === arr.length) return arr;
  if (length < arr.length) return arr.slice(0, length);
  return [...arr, ...Array.from({ length: length - arr.length }, (_, i) => make(arr.length + i))];
}

// Keep a node's network config consistent after its nic count, bonds, or
// management interface change — drop bond members that no longer exist,
// reclamp the management interface, and regenerate bridge defaults for
// the resulting interface set. This intentionally regenerates bridges
// from scratch on every structural change (same policy the rest of this
// wizard already uses for hardware changes) rather than trying to
// preserve customizations across a change to what interfaces even exist.
function resyncNetworkForNics(
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
  return {
    ...network,
    bonds,
    bondCount: String(bonds.length),
    managementInterfaceId: mgmt,
    bridges: defaultBridgesForIds(ids, mgmt),
  };
}

// ceph only makes sense with at least 2 nodes — if the node count drops
// below that, strip any existing ceph selections rather than leave state
// the ui no longer offers a way to edit or explain.
function withoutCephPurpose(nodes: NodeInfo[]): NodeInfo[] {
  return nodes.map((node) => {
    let changed = false;
    const nextBridges: Record<string, BridgeConfig> = {};
    for (const [id, bridge] of Object.entries(node.network.bridges)) {
      if (!bridge.purposes.includes("ceph")) {
        nextBridges[id] = bridge;
        continue;
      }
      changed = true;
      const purposes = bridge.purposes.filter((p) => p !== "ceph");
      nextBridges[id] = { ...bridge, purposes: purposes.length > 0 ? purposes : ["vm"] };
    }
    return changed ? { ...node, network: { ...node.network, bridges: nextBridges } } : node;
  });
}

interface Hint {
  tone: "info" | "success" | "warning";
  glyph: string;
  text: string;
}

function quorumHintFor(nodeCountValue: number): Hint {
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

function cpuHintFor(nodes: NodeInfo[]): Hint | null {
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
function purposeComboHint(purposes: InterfacePurpose[]): Hint | null {
  if (purposes.length < 2) return null;
  if (purposes.includes("ceph")) {
    return {
      tone: "warning",
      glyph: "!",
      text: "it's recommended to not share the ceph nic with any other service — no corosync, no vm traffic, no backups. ceph is latency- and bandwidth-sensitive, and contention here shows up as cluster-wide storage slowdowns.",
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

function validateNodeName(value: string): string | null {
  if (!value) return null;
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(value)) {
    return "lowercase letters, numbers and hyphens only";
  }
  return null;
}

function DiskTypeRadioGroup({
  name,
  legend,
  value,
  onChange,
  hddHint,
}: {
  name: string;
  legend: string;
  value: DiskType;
  onChange: (type: DiskType) => void;
  hddHint?: string;
}) {
  return (
    <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
      <legend className="label pc-radio-group__legend">{legend}</legend>
      <label className="pc-radio">
        <input type="radio" name={name} checked={value === "nvme"} onChange={() => onChange("nvme")} />
        <span className="pc-radio__box" />
        <span className="code pc-radio__label">nvme</span>
      </label>
      <label className="pc-radio">
        <input type="radio" name={name} checked={value === "ssd"} onChange={() => onChange("ssd")} />
        <span className="pc-radio__box" />
        <span className="code pc-radio__label">sata ssd</span>
      </label>
      <label className="pc-radio">
        <input type="radio" name={name} checked={value === "hdd"} onChange={() => onChange("hdd")} />
        <span className="pc-radio__box" />
        {hddHint ? (
          <span>
            <span className="code pc-radio__label">hdd</span>
            <span className="body-sm pc-checkbox__hint">{hddHint}</span>
          </span>
        ) : (
          <span className="code pc-radio__label">hdd</span>
        )}
      </label>
    </fieldset>
  );
}

function HardwareFields({
  keyPrefix,
  values,
  onChange,
  onNicCountChange,
  onNicChange,
  onAdditionalDiskCountChange,
  onAdditionalDiskChange,
}: {
  keyPrefix: string;
  values: HardwareSpec;
  onChange: (patch: Partial<HardwareSpec>) => void;
  onNicCountChange: (value: string) => void;
  onNicChange: (nicIndex: number, patch: Partial<NicInfo>) => void;
  onAdditionalDiskCountChange: (value: string) => void;
  onAdditionalDiskChange: (diskIndex: number, patch: Partial<AdditionalDisk>) => void;
}) {
  const selectedFamily = familiesByDate(values.cpuVendor).find((f) => f.name === values.cpuFamily);

  return (
    <>
      <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="label pc-radio-group__legend">cpu vendor</legend>
        {cpuVendorOptions.map((opt) => (
          <label key={opt.value} className="pc-radio">
            <input
              type="radio"
              name={`cpu-${keyPrefix}`}
              checked={values.cpuVendor === opt.value}
              onChange={() =>
                onChange({
                  cpuVendor: opt.value,
                  cpuFamily: DEFAULT_CPU_FAMILY[opt.value],
                  coresPerCpu: String(defaultCoresFor(opt.value, DEFAULT_CPU_FAMILY[opt.value])),
                })
              }
            />
            <span className="pc-radio__box" />
            <span className="code pc-radio__label">{opt.label}</span>
          </label>
        ))}
      </fieldset>

      <div className="pc-field">
        <label className="label pc-field__label" htmlFor={`cpufamily-${keyPrefix}`}>
          cpu family
        </label>
        <div className="pc-field__control">
          <span className="code pc-field__bracket">--cpu</span>
          <select
            id={`cpufamily-${keyPrefix}`}
            className="pc-field__input code"
            value={values.cpuFamily}
            onChange={(e) =>
              onChange({
                cpuFamily: e.target.value,
                coresPerCpu: String(defaultCoresFor(values.cpuVendor, e.target.value)),
              })
            }
          >
            {familiesByDate(values.cpuVendor).map((fam) => (
              <option key={fam.name} value={fam.name}>
                {fam.name} ({fam.from}–{fam.to ?? "now"})
              </option>
            ))}
          </select>
        </div>
        <span className="body-sm pc-field__hint">
          {selectedFamily && selectedFamily.qemuType !== selectedFamily.name
            ? `${selectedFamily.note ? selectedFamily.note + " — " : ""}uses qemu type "${selectedFamily.qemuType}"`
            : "the physical cpu generation in this node — used to keep live migration working across the cluster"}
        </span>
      </div>

      <div className="pc-field">
        <label className="label pc-field__label" htmlFor={`cpucount-${keyPrefix}`}>
          number of cpus
        </label>
        <div className="pc-field__control">
          <input
            id={`cpucount-${keyPrefix}`}
            className="pc-field__input code"
            type="number"
            min={1}
            max={8}
            value={values.cpuCount}
            onChange={(e) => onChange({ cpuCount: e.target.value })}
          />
        </div>
        <span className="body-sm pc-field__hint">physical sockets — almost always 1 for a homelab node</span>
      </div>

      <div className="pc-field">
        <label className="label pc-field__label" htmlFor={`corespercpu-${keyPrefix}`}>
          cores per cpu
        </label>
        <div className="pc-field__control">
          <input
            id={`corespercpu-${keyPrefix}`}
            className="pc-field__input code"
            type="number"
            min={1}
            value={values.coresPerCpu}
            onChange={(e) => onChange({ coresPerCpu: e.target.value })}
          />
        </div>
        <span className="body-sm pc-field__hint">
          rough default for {selectedFamily?.name ?? "this family"} — check your actual spec sheet and correct it
        </span>
      </div>

      <div className="pc-field">
        <label className="label pc-field__label" htmlFor={`ram-${keyPrefix}`}>
          memory (gb)
        </label>
        <div className="pc-field__control">
          <input
            id={`ram-${keyPrefix}`}
            className="pc-field__input code"
            type="number"
            min={1}
            placeholder="64"
            value={values.ramGb}
            onChange={(e) => onChange({ ramGb: e.target.value })}
          />
        </div>
        <span className="body-sm pc-field__hint">total installed memory</span>
      </div>

      <DiskTypeRadioGroup
        name={`boot-${keyPrefix}`}
        legend="boot disk type"
        value={values.bootDiskType}
        onChange={(type) => onChange({ bootDiskType: type })}
        hddHint="works, but installs and updates will be slower"
      />

      <div className="pc-field">
        <label className="label pc-field__label" htmlFor={`bootsize-${keyPrefix}`}>
          boot disk size (gb)
        </label>
        <div className="pc-field__control">
          <input
            id={`bootsize-${keyPrefix}`}
            className="pc-field__input code"
            type="number"
            min={8}
            placeholder="256"
            value={values.bootDiskSizeGb}
            onChange={(e) => onChange({ bootDiskSizeGb: e.target.value })}
          />
        </div>
        <span className="body-sm pc-field__hint">just the proxmox install disk — storage pool disks come later</span>
      </div>

      <div className="pc-field">
        <label className="label pc-field__label" htmlFor={`bootname-${keyPrefix}`}>
          boot disk friendly name
        </label>
        <div className="pc-field__control">
          <span className="code pc-field__bracket">$</span>
          <input
            id={`bootname-${keyPrefix}`}
            className="pc-field__input code"
            type="text"
            list={`disk-presets-${keyPrefix}`}
            value={values.bootDiskName}
            onChange={(e) => onChange({ bootDiskName: e.target.value })}
          />
        </div>
        <span className="body-sm pc-field__hint">how this disk is labeled in later steps, instead of the raw device path</span>
      </div>

      <div className="pc-field">
        <label className="label pc-field__label" htmlFor={`extradiskcount-${keyPrefix}`}>
          number of additional disks
        </label>
        <div className="pc-field__control">
          <input
            id={`extradiskcount-${keyPrefix}`}
            className="pc-field__input code"
            type="number"
            min={0}
            max={12}
            value={values.additionalDiskCount}
            onChange={(e) => onAdditionalDiskCountChange(e.target.value)}
          />
        </div>
        <span className="body-sm pc-field__hint">disks beyond the boot disk — for a zfs/ceph storage pool later</span>
      </div>

      {values.additionalDisks.map((disk, j) => (
        <div key={j} className="flex flex-col" style={{ gap: "var(--space-3)" }}>
          <p className="label text-ink-muted">additional disk {j + 1}</p>
          <DiskTypeRadioGroup
            name={`extradisktype-${keyPrefix}-${j}`}
            legend="disk type"
            value={disk.type}
            onChange={(type) => onAdditionalDiskChange(j, { type })}
          />
          <div className="pc-field">
            <label className="label pc-field__label" htmlFor={`extradisksize-${keyPrefix}-${j}`}>
              size (gb)
            </label>
            <div className="pc-field__control">
              <input
                id={`extradisksize-${keyPrefix}-${j}`}
                className="pc-field__input code"
                type="number"
                min={1}
                placeholder="2000"
                value={disk.sizeGb}
                onChange={(e) => onAdditionalDiskChange(j, { sizeGb: e.target.value })}
              />
            </div>
            <span className="body-sm pc-field__hint">raw size — actual usable space depends on the storage layout you pick later</span>
          </div>
          <div className="pc-field">
            <label className="label pc-field__label" htmlFor={`extradiskname-${keyPrefix}-${j}`}>
              friendly name
            </label>
            <div className="pc-field__control">
              <span className="code pc-field__bracket">$</span>
              <input
                id={`extradiskname-${keyPrefix}-${j}`}
                className="pc-field__input code"
                type="text"
                list={`disk-presets-${keyPrefix}`}
                value={disk.name}
                onChange={(e) => onAdditionalDiskChange(j, { name: e.target.value })}
              />
            </div>
            <span className="body-sm pc-field__hint">how this disk is labeled in later steps, instead of the raw device path</span>
          </div>
        </div>
      ))}
      <datalist id={`disk-presets-${keyPrefix}`}>
        {DISK_NAME_PRESETS.map((preset) => (
          <option key={preset} value={preset} />
        ))}
      </datalist>

      <div className="pc-field">
        <label className="label pc-field__label" htmlFor={`niccount-${keyPrefix}`}>
          number of nics
        </label>
        <div className="pc-field__control">
          <input
            id={`niccount-${keyPrefix}`}
            className="pc-field__input code"
            type="number"
            min={1}
            max={8}
            value={values.nicCount}
            onChange={(e) => onNicCountChange(e.target.value)}
          />
        </div>
        <span className="body-sm pc-field__hint">physical network ports on this node</span>
      </div>

      {values.nics.map((nic, j) => (
        <div key={j} className="flex flex-col" style={{ gap: "var(--space-3)" }}>
          <p className="label text-ink-muted">nic {j + 1}</p>
          <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
            <legend className="label pc-radio-group__legend">speed</legend>
            {nicSpeedOptions.map((opt) => (
              <label key={opt.value} className="pc-radio">
                <input
                  type="radio"
                  name={`nic-${keyPrefix}-${j}`}
                  checked={nic.speed === opt.value}
                  onChange={() => onNicChange(j, { speed: opt.value })}
                />
                <span className="pc-radio__box" />
                {opt.hint ? (
                  <span>
                    <span className="code pc-radio__label">{opt.label}</span>
                    <span className="body-sm pc-checkbox__hint">{opt.hint}</span>
                  </span>
                ) : (
                  <span className="code pc-radio__label">{opt.label}</span>
                )}
              </label>
            ))}
          </fieldset>
          <div className="pc-field">
            <label className="label pc-field__label" htmlFor={`nicname-${keyPrefix}-${j}`}>
              friendly name
            </label>
            <div className="pc-field__control">
              <span className="code pc-field__bracket">$</span>
              <input
                id={`nicname-${keyPrefix}-${j}`}
                className="pc-field__input code"
                type="text"
                list={`nic-presets-${keyPrefix}`}
                value={nic.name}
                onChange={(e) => onNicChange(j, { name: e.target.value })}
              />
            </div>
            <span className="body-sm pc-field__hint">used to label this nic in later steps — rename to match its role</span>
          </div>
        </div>
      ))}
      <datalist id={`nic-presets-${keyPrefix}`}>
        {NIC_NAME_PRESETS.map((preset) => (
          <option key={preset} value={preset} />
        ))}
      </datalist>
    </>
  );
}

function BondFields({
  keyPrefix,
  node,
  onBondCountChange,
  onToggleBondNic,
  onUpdateBondMeta,
}: {
  keyPrefix: string;
  node: NodeInfo;
  onBondCountChange: (value: string) => void;
  onToggleBondNic: (bondIndex: number, nicIndex: number, checked: boolean) => void;
  onUpdateBondMeta: (bondIndex: number, patch: Partial<Pick<BondConfig, "name" | "mode">>) => void;
}) {
  return (
    <>
      <div className="pc-field">
        <label className="label pc-field__label" htmlFor={`bondcount-${keyPrefix}`}>
          number of bonds
        </label>
        <div className="pc-field__control">
          <input
            id={`bondcount-${keyPrefix}`}
            className="pc-field__input code"
            type="number"
            min={0}
            max={4}
            value={node.network.bondCount}
            onChange={(e) => onBondCountChange(e.target.value)}
          />
        </div>
        <span className="body-sm pc-field__hint">
          combine 2+ nics into one logical link for redundancy or more bandwidth — 0 if you don&apos;t need any
        </span>
      </div>

      {node.network.bonds.map((bond, bi) => (
        <div
          key={bi}
          className="flex flex-col border border-border bg-surface-100 p-5"
          style={{ gap: "var(--space-3)" }}
        >
          <p className="label text-ink-muted">bond {bi + 1}</p>

          <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
            <legend className="label pc-radio-group__legend">nics in this bond</legend>
            {node.nics.map((nic, ni) => {
              const claimedByOtherBond = node.network.bonds.some((b, bj) => bj !== bi && b.nicIndices.includes(ni));
              if (claimedByOtherBond) return null;
              return (
                <label key={ni} className="pc-checkbox">
                  <input
                    type="checkbox"
                    checked={bond.nicIndices.includes(ni)}
                    onChange={(e) => onToggleBondNic(bi, ni, e.target.checked)}
                  />
                  <span className="pc-checkbox__box" />
                  <span className="code pc-checkbox__label">
                    nic {ni + 1} — {nicSpeedLabel(nic.speed)}
                  </span>
                </label>
              );
            })}
          </fieldset>
          {bond.nicIndices.length < 2 && (
            <p className="body-sm pc-field__hint">select at least 2 nics to make this a real bond</p>
          )}

          <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
            <legend className="label pc-radio-group__legend">bond mode</legend>
            {BOND_MODE_OPTIONS.map((opt) => (
              <label key={opt.value} className="pc-radio">
                <input
                  type="radio"
                  name={`bondmode-${keyPrefix}-${bi}`}
                  checked={bond.mode === opt.value}
                  onChange={() => onUpdateBondMeta(bi, { mode: opt.value })}
                />
                <span className="pc-radio__box" />
                <span>
                  <span className="code pc-radio__label">{opt.label}</span>
                  <span className="body-sm pc-checkbox__hint">{opt.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="pc-field">
            <label className="label pc-field__label" htmlFor={`bondname-${keyPrefix}-${bi}`}>
              bond name
            </label>
            <div className="pc-field__control">
              <span className="code pc-field__bracket">$</span>
              <input
                id={`bondname-${keyPrefix}-${bi}`}
                className="pc-field__input code"
                type="text"
                value={bond.name}
                onChange={(e) => onUpdateBondMeta(bi, { name: e.target.value })}
              />
            </div>
            <span className="body-sm pc-field__hint">the linux bonding interface name — appears below as its own interface</span>
          </div>
        </div>
      ))}
    </>
  );
}

function NetworkFields({
  keyPrefix,
  node,
  hostnameSuffix,
  lanPrefix,
  cephAvailable,
  onChange,
  onBondCountChange,
  onToggleBondNic,
  onUpdateBondMeta,
  onManagementInterfaceChange,
  onBridgeChange,
}: {
  keyPrefix: string;
  node: NodeInfo;
  hostnameSuffix: string;
  lanPrefix: number;
  // ceph wants real redundancy — offering it as a purpose below 2 nodes
  // just invites a single-node "cluster" that can't actually do what
  // ceph is for.
  cephAvailable: boolean;
  onChange: (patch: Partial<NodeNetwork>) => void;
  onBondCountChange: (value: string) => void;
  onToggleBondNic: (bondIndex: number, nicIndex: number, checked: boolean) => void;
  onUpdateBondMeta: (bondIndex: number, patch: Partial<Pick<BondConfig, "name" | "mode">>) => void;
  onManagementInterfaceChange: (interfaceId: string) => void;
  onBridgeChange: (interfaceId: string, patch: Partial<BridgeConfig>) => void;
}) {
  const hostLabelError = validateHostLabel(node.network.hostLabel);
  const cidrError = validateCidr(node.network.cidr);
  const interfaces = interfacesFor(node.nics, node.network.bonds);
  const managementBridgeName = node.network.bridges[node.network.managementInterfaceId]?.name || "vmbr0";
  const purposeOptions = cephAvailable
    ? INTERFACE_PURPOSE_OPTIONS
    : INTERFACE_PURPOSE_OPTIONS.filter((opt) => opt.value !== "ceph");

  return (
    <>
      <div className={`pc-field ${hostLabelError ? "pc-field--error" : ""}`}>
        <label className="label pc-field__label" htmlFor={`hostname-${keyPrefix}`}>
          hostname (fqdn)
        </label>
        <div className="pc-field__control">
          <span className="code pc-field__bracket">$</span>
          <input
            id={`hostname-${keyPrefix}`}
            className="pc-field__input code"
            type="text"
            style={{ flex: "0 1 auto", width: `${Math.max(node.network.hostLabel.length, 6)}ch` }}
            value={node.network.hostLabel}
            onChange={(e) => onChange({ hostLabel: e.target.value })}
          />
          <span className="code" style={{ color: "var(--ink-dim)", flex: "none" }}>
            {hostnameSuffix ? `.${hostnameSuffix}` : ""}
          </span>
        </div>
        <span className="body-sm pc-field__hint">
          {hostLabelError ?? "the domain suffix is fixed to what you set above — only this part is editable"}
        </span>
      </div>

      <BondFields
        keyPrefix={keyPrefix}
        node={node}
        onBondCountChange={onBondCountChange}
        onToggleBondNic={onToggleBondNic}
        onUpdateBondMeta={onUpdateBondMeta}
      />

      <div className="flex flex-col border border-border bg-surface-100 p-5" style={{ gap: "var(--space-3)" }}>
        <p className="label text-ink-muted">management</p>
        <CidrField
          id={`nodecidr-${keyPrefix}`}
          label="static ip"
          value={node.network.cidr}
          onChange={(value) => onChange({ cidr: value })}
          placeholder="10.0.10.11/24"
          error={cidrError}
          hint={`for the web ui and ssh — assigned to the ${managementBridgeName} bridge below, not the raw nic or bond`}
          defaultPrefix={lanPrefix}
        />
        <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
          <legend className="label pc-radio-group__legend">interface</legend>
          {interfaces.map((iface) => (
            <label key={iface.id} className="pc-radio">
              <input
                type="radio"
                name={`mgmtnic-${keyPrefix}`}
                checked={node.network.managementInterfaceId === iface.id}
                onChange={() => onManagementInterfaceChange(iface.id)}
              />
              <span className="pc-radio__box" />
              <span className="code pc-radio__label">{iface.label}</span>
            </label>
          ))}
        </fieldset>
        <div className="pc-field">
          <label className="label pc-field__label" htmlFor={`mgmtbridge-${keyPrefix}`}>
            bridge name
          </label>
          <div className="pc-field__control">
            <span className="code pc-field__bracket">$</span>
            <input
              id={`mgmtbridge-${keyPrefix}`}
              className="pc-field__input code"
              type="text"
              value={node.network.bridges[node.network.managementInterfaceId]?.name ?? "vmbr0"}
              onChange={(e) => onBridgeChange(node.network.managementInterfaceId, { name: e.target.value })}
            />
          </div>
          <span className="body-sm pc-field__hint">
            carries the management ip above and, by default, vm traffic too — vmbr0 is the proxmox convention, but you can rename it
          </span>
        </div>
      </div>

      {interfaces
        .filter((iface) => iface.id !== node.network.managementInterfaceId)
        .map((iface) => {
          const bridge = node.network.bridges[iface.id];
          if (!bridge) return null;
          const needsHostIp = needsHostIpForPurposes(bridge.purposes, bridge.otherNeedsHostIp);
          const ipError = needsHostIp ? validateHostCidr(bridge.ip) : validateCidr(bridge.ip);
          const comboHint = purposeComboHint(bridge.purposes);
          return (
            <div
              key={iface.id}
              className="flex flex-col border border-border bg-surface-100 p-5"
              style={{ gap: "var(--space-3)" }}
            >
              <p className="label text-ink-muted">{iface.label}</p>
              <label className="pc-checkbox">
                <input
                  type="checkbox"
                  checked={bridge.enabled}
                  onChange={(e) => onBridgeChange(iface.id, { enabled: e.target.checked })}
                />
                <span className="pc-checkbox__box" />
                <span>
                  <span className="code pc-checkbox__label">bridge this interface</span>
                  <span className="body-sm pc-checkbox__hint">
                    a linux bridge on it — leave unchecked to keep it unused for now
                  </span>
                </span>
              </label>
              {bridge.enabled && (
                <>
                  <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
                    <legend className="label pc-radio-group__legend">used for (pick as many as apply)</legend>
                    {purposeOptions.map((opt) => {
                      const checked = bridge.purposes.includes(opt.value);
                      const isLastOne = checked && bridge.purposes.length === 1;
                      return (
                        <label key={opt.value} className="pc-checkbox">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={isLastOne}
                            onChange={(e) => {
                              const nextPurposes = e.target.checked
                                ? [...bridge.purposes, opt.value]
                                : bridge.purposes.filter((p) => p !== opt.value);
                              if (nextPurposes.length === 0) return;
                              onBridgeChange(iface.id, { purposes: nextPurposes });
                            }}
                          />
                          <span className="pc-checkbox__box" />
                          <span>
                            <span className="code pc-checkbox__label">{opt.label}</span>
                            <span className="body-sm pc-checkbox__hint">{opt.hint}</span>
                          </span>
                        </label>
                      );
                    })}
                    {!cephAvailable && (
                      <p className="body-sm pc-field__hint">
                        ceph needs at least 2 nodes for real redundancy — add another node to unlock it here
                      </p>
                    )}
                  </fieldset>

                  {comboHint && (
                    <div className={`pc-callout pc-callout--${comboHint.tone}`}>
                      <span className="code pc-callout__glyph">{comboHint.glyph}</span>
                      <div className="pc-callout__body">
                        <p className="body-sm pc-callout__text">{comboHint.text}</p>
                      </div>
                    </div>
                  )}

                  {bridge.purposes.includes("other") && (
                    <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
                      <legend className="label pc-radio-group__legend">does this node need an address here?</legend>
                      <label className="pc-radio">
                        <input
                          type="radio"
                          name={`otherip-${keyPrefix}-${iface.id}`}
                          checked={bridge.otherNeedsHostIp}
                          onChange={() => onBridgeChange(iface.id, { otherNeedsHostIp: true })}
                        />
                        <span className="pc-radio__box" />
                        <span className="code pc-radio__label">yes — give it a static ip</span>
                      </label>
                      <label className="pc-radio">
                        <input
                          type="radio"
                          name={`otherip-${keyPrefix}-${iface.id}`}
                          checked={!bridge.otherNeedsHostIp}
                          onChange={() => onBridgeChange(iface.id, { otherNeedsHostIp: false })}
                        />
                        <span className="pc-radio__box" />
                        <span className="code pc-radio__label">no — it&apos;s just a switch for vms</span>
                      </label>
                    </fieldset>
                  )}

                  <div className="pc-field">
                    <label className="label pc-field__label" htmlFor={`bridge-${keyPrefix}-${iface.id}`}>
                      bridge name
                    </label>
                    <div className="pc-field__control">
                      <span className="code pc-field__bracket">$</span>
                      <input
                        id={`bridge-${keyPrefix}-${iface.id}`}
                        className="pc-field__input code"
                        type="text"
                        value={bridge.name}
                        onChange={(e) => onBridgeChange(iface.id, { name: e.target.value })}
                      />
                    </div>
                    <span className="body-sm pc-field__hint">shown in the proxmox ui and used in vm/ct network config</span>
                  </div>

                  <CidrField
                    id={`bridgeip-${keyPrefix}-${iface.id}`}
                    label={needsHostIp ? "static ip for this node" : "network (optional)"}
                    value={bridge.ip}
                    onChange={(value) => onBridgeChange(iface.id, { ip: value })}
                    placeholder={needsHostIp ? "10.0.20.11/24" : "10.0.20.0/24"}
                    error={ipError}
                    hint={
                      needsHostIp
                        ? `required — ${requiredIpHintFor(bridge.purposes, bridge.otherNeedsHostIp)}`
                        : "the subnet vms/cts on this bridge should use — purely informational, the host won't have an address here"
                    }
                    defaultPrefix={lanPrefix}
                  />
                </>
              )}
            </div>
          );
        })}
    </>
  );
}

// bump this whenever the shape of PersistedState (or anything nested inside
// it) changes — a mismatched version is discarded wholesale rather than
// risking a crash or a half-applied state from an older save.
const STORAGE_KEY = "proxmox-computer:setup-wizard";
const STORAGE_VERSION = 2;

interface PersistedState {
  version: number;
  currentStep: WizardStepId;
  nodeCount: string;
  hostnameSuffix: string;
  globalCidr: string;
  gateway: string;
  nodes: NodeInfo[];
  identicalHardware: boolean;
}

// deliberately not exhaustive — every individual field getting checked would
// make this as brittle as the state it's guarding. the version check above
// is the real defense against a shape change; this just catches obviously
// corrupt or hand-edited data within the same version before it ever
// reaches setState.
function isPersistedState(value: unknown): value is PersistedState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.version !== STORAGE_VERSION) return false;
  if (v.currentStep !== "hardware" && v.currentStep !== "network") return false;
  if (typeof v.nodeCount !== "string") return false;
  if (typeof v.hostnameSuffix !== "string") return false;
  if (typeof v.globalCidr !== "string") return false;
  if (typeof v.gateway !== "string") return false;
  if (typeof v.identicalHardware !== "boolean") return false;
  if (!Array.isArray(v.nodes)) return false;

  for (const node of v.nodes) {
    if (!node || typeof node !== "object") return false;
    const n = node as Record<string, unknown>;
    if (typeof n.name !== "string") return false;
    if (typeof n.cpuVendor !== "string") return false;
    if (typeof n.cpuFamily !== "string") return false;
    if (!Array.isArray(n.nics)) return false;
    if (!Array.isArray(n.additionalDisks)) return false;

    if (!n.network || typeof n.network !== "object") return false;
    const net = n.network as Record<string, unknown>;
    if (typeof net.hostLabel !== "string") return false;
    if (typeof net.cidr !== "string") return false;
    if (typeof net.managementInterfaceId !== "string") return false;
    if (!Array.isArray(net.bonds)) return false;
    if (!net.bridges || typeof net.bridges !== "object") return false;
    for (const b of Object.values(net.bridges as Record<string, unknown>)) {
      if (!b || typeof b !== "object") return false;
      const bridge = b as Record<string, unknown>;
      if (typeof bridge.enabled !== "boolean") return false;
      if (typeof bridge.name !== "string") return false;
      if (!Array.isArray(bridge.purposes)) return false;
      if (typeof bridge.ip !== "string") return false;
    }
  }

  return true;
}

function loadPersistedState(): PersistedState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPersistedState(parsed) ? parsed : null;
  } catch {
    // corrupt json, storage unavailable (private browsing, disabled, etc.),
    // or anything else — treat exactly like "nothing saved".
    return null;
  }
}

export default function Setup() {
  const [currentStep, setCurrentStep] = useState<WizardStepId>("hardware");
  const [nodeCount, setNodeCount] = useState("1");
  const [hostnameSuffix, setHostnameSuffix] = useState("homelab.lan");
  const [globalCidr, setGlobalCidr] = useState("10.0.10.0/24");
  const [gateway, setGateway] = useState(() => deriveGateway("10.0.10.0/24"));
  const [nodes, setNodes] = useState<NodeInfo[]>([defaultNode(0, "10.0.10.0/24")]);
  const [identicalHardware, setIdenticalHardware] = useState(false);
  // gates the save effect below so it never fires with the initial default
  // state before the restore attempt (which may replace that state) has
  // actually run — otherwise a freshly-loaded save could get clobbered by
  // defaults on the very first render.
  const [hydrated, setHydrated] = useState(false);

  // restore-on-mount: only ever applied if it passes isPersistedState in
  // full; anything else (missing key, bad json, wrong shape, future schema
  // change) silently leaves the clean defaults already in state untouched.
  // localStorage doesn't exist during ssr, so this has to run post-mount —
  // reading it during render would desync client output from the server
  // html. that's exactly what useEffect is for here, so the set-state-in-
  // effect rule's general advice doesn't apply to this specific case.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const saved = loadPersistedState();
    if (saved) {
      setCurrentStep(saved.currentStep);
      setNodeCount(saved.nodeCount);
      setHostnameSuffix(saved.hostnameSuffix);
      setGlobalCidr(saved.globalCidr);
      setGateway(saved.gateway);
      setNodes(saved.nodes);
      setIdenticalHardware(saved.identicalHardware);
    }
    setHydrated(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // debounced autosave — only once hydrated, so this never overwrites a
  // save with the pre-restore defaults.
  useEffect(() => {
    if (!hydrated) return;
    const handle = setTimeout(() => {
      try {
        const payload: PersistedState = {
          version: STORAGE_VERSION,
          currentStep,
          nodeCount,
          hostnameSuffix,
          globalCidr,
          gateway,
          nodes,
          identicalHardware,
        };
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch {
        // storage full, disabled, or unavailable — just skip persisting.
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [hydrated, currentStep, nodeCount, hostnameSuffix, globalCidr, gateway, nodes, identicalHardware]);

  const quorumHint = useMemo(() => quorumHintFor(nodes.length), [nodes.length]);
  const cpuHint = useMemo(() => cpuHintFor(nodes), [nodes]);
  const stepIndex = wizardSteps.findIndex((s) => s.id === currentStep);
  // the real subnet size for this homelab — used to fill in a sane
  // /prefix when a visitor types a bare ip with none, instead of /32.
  const lanPrefix = subnetDetails(globalCidr)?.prefix ?? 24;

  function handleNodeCountChange(value: string) {
    setNodeCount(value);
    const n = parseInt(value, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= 16) {
      setNodes((prev) => {
        const resized = resizeArray(prev, n, (i) => defaultNode(i, globalCidr));
        return n < 2 ? withoutCephPurpose(resized) : resized;
      });
    }
  }

  function handleIdenticalHardwareChange(checked: boolean) {
    setIdenticalHardware(checked);
    if (checked) {
      setNodes((prev) => {
        if (prev.length === 0) return prev;
        const template = prev[0];
        return prev.map((node) => ({
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
        }));
      });
    }
  }

  function updateNode(index: number, patch: Partial<NodeInfo>) {
    setNodes((prev) =>
      prev.map((node, i) => {
        if (i !== index) return node;
        const next = { ...node, ...patch };
        // node name feeds the hostname label default — keep it in sync
        // unless the visitor already typed a label of their own (in
        // which case leave their edit alone).
        if (patch.name && node.network.hostLabel === node.name) {
          next.network = { ...next.network, hostLabel: patch.name };
        }
        return next;
      }),
    );
  }

  function handleNicCountChange(index: number, value: string) {
    const n = parseInt(value, 10);
    setNodes((prev) =>
      prev.map((node, i) => {
        if (i !== index) return node;
        const clamped = !Number.isNaN(n) && n >= 1 && n <= 8 ? n : node.nics.length;
        return {
          ...node,
          nicCount: value,
          nics: resizeArray(node.nics, clamped, (idx) => ({ speed: "1gbe" as NicSpeed, name: defaultNicName(idx) })),
          network: resyncNetworkForNics(node.network, clamped),
        };
      }),
    );
  }

  function updateNic(nodeIndex: number, nicIndex: number, patch: Partial<NicInfo>) {
    setNodes((prev) =>
      prev.map((node, i) =>
        i !== nodeIndex
          ? node
          : { ...node, nics: node.nics.map((nic, j) => (j === nicIndex ? { ...nic, ...patch } : nic)) },
      ),
    );
  }

  function handleAdditionalDiskCountChange(nodeIndex: number, value: string) {
    const n = parseInt(value, 10);
    setNodes((prev) =>
      prev.map((node, i) => {
        if (i !== nodeIndex) return node;
        const clamped = !Number.isNaN(n) && n >= 0 && n <= 12 ? n : node.additionalDisks.length;
        return {
          ...node,
          additionalDiskCount: value,
          additionalDisks: resizeArray(node.additionalDisks, clamped, (idx) => defaultAdditionalDisk(idx)),
        };
      }),
    );
  }

  function updateAdditionalDisk(nodeIndex: number, diskIndex: number, patch: Partial<AdditionalDisk>) {
    setNodes((prev) =>
      prev.map((node, i) =>
        i !== nodeIndex
          ? node
          : {
              ...node,
              additionalDisks: node.additionalDisks.map((d, j) => (j === diskIndex ? { ...d, ...patch } : d)),
            },
      ),
    );
  }

  function updateAllNodesHardware(patch: Partial<HardwareSpec>) {
    setNodes((prev) => prev.map((node) => ({ ...node, ...patch })));
  }

  function updateAllNodesNicCount(value: string) {
    const n = parseInt(value, 10);
    setNodes((prev) =>
      prev.map((node) => {
        const clamped = !Number.isNaN(n) && n >= 1 && n <= 8 ? n : node.nics.length;
        return {
          ...node,
          nicCount: value,
          nics: resizeArray(node.nics, clamped, (idx) => ({ speed: "1gbe" as NicSpeed, name: defaultNicName(idx) })),
          network: resyncNetworkForNics(node.network, clamped),
        };
      }),
    );
  }

  function updateAllNodesNic(nicIndex: number, patch: Partial<NicInfo>) {
    setNodes((prev) =>
      prev.map((node) => ({
        ...node,
        nics: node.nics.map((nic, j) => (j === nicIndex ? { ...nic, ...patch } : nic)),
      })),
    );
  }

  function updateAllNodesAdditionalDiskCount(value: string) {
    const n = parseInt(value, 10);
    setNodes((prev) =>
      prev.map((node) => {
        const clamped = !Number.isNaN(n) && n >= 0 && n <= 12 ? n : node.additionalDisks.length;
        return {
          ...node,
          additionalDiskCount: value,
          additionalDisks: resizeArray(node.additionalDisks, clamped, (idx) => defaultAdditionalDisk(idx)),
        };
      }),
    );
  }

  function updateAllNodesAdditionalDisk(diskIndex: number, patch: Partial<AdditionalDisk>) {
    setNodes((prev) =>
      prev.map((node) => ({
        ...node,
        additionalDisks: node.additionalDisks.map((d, j) => (j === diskIndex ? { ...d, ...patch } : d)),
      })),
    );
  }

  function handleGlobalCidrChange(value: string) {
    setGlobalCidr(value);
    setGateway(deriveGateway(value));
    setNodes((prev) =>
      prev.map((node, i) => ({
        ...node,
        network: { ...node.network, cidr: deriveNodeCidr(value, i) },
      })),
    );
  }

  function updateNodeNetwork(index: number, patch: Partial<NodeNetwork>) {
    setNodes((prev) =>
      prev.map((node, i) => (i === index ? { ...node, network: { ...node.network, ...patch } } : node)),
    );
  }

  function setManagementInterface(index: number, interfaceId: string) {
    setNodes((prev) =>
      prev.map((node, i) =>
        i === index
          ? { ...node, network: resyncNetworkForNics(node.network, node.nics.length, { managementInterfaceId: interfaceId }) }
          : node,
      ),
    );
  }

  function updateBridge(index: number, interfaceId: string, patch: Partial<BridgeConfig>) {
    setNodes((prev) =>
      prev.map((node, i) =>
        i === index
          ? {
              ...node,
              network: {
                ...node.network,
                bridges: {
                  ...node.network.bridges,
                  [interfaceId]: { ...node.network.bridges[interfaceId], ...patch },
                },
              },
            }
          : node,
      ),
    );
  }

  function handleBondCountChange(index: number, value: string) {
    const n = parseInt(value, 10);
    setNodes((prev) =>
      prev.map((node, i) => {
        if (i !== index) return node;
        const clamped = !Number.isNaN(n) && n >= 0 && n <= 4 ? n : node.network.bonds.length;
        const bonds = resizeArray(node.network.bonds, clamped, (idx) => ({
          name: defaultBondName(idx),
          mode: "active-backup" as BondMode,
          nicIndices: [],
        }));
        return { ...node, network: resyncNetworkForNics(node.network, node.nics.length, { bonds }) };
      }),
    );
  }

  function toggleBondNic(index: number, bondIndex: number, nicIndex: number, checked: boolean) {
    setNodes((prev) =>
      prev.map((node, i) => {
        if (i !== index) return node;
        const bonds = node.network.bonds.map((b, j) => {
          if (j !== bondIndex) return b;
          const nicIndices = checked
            ? [...b.nicIndices, nicIndex].sort((a, b2) => a - b2)
            : b.nicIndices.filter((idx) => idx !== nicIndex);
          return { ...b, nicIndices };
        });
        return { ...node, network: resyncNetworkForNics(node.network, node.nics.length, { bonds }) };
      }),
    );
  }

  function updateBondMeta(index: number, bondIndex: number, patch: Partial<Pick<BondConfig, "name" | "mode">>) {
    setNodes((prev) =>
      prev.map((node, i) => {
        if (i !== index) return node;
        // name/mode never change which interfaces exist, so patch bonds
        // directly rather than going through the full resync — that
        // would otherwise wipe out bridge customizations for no reason.
        const bonds = node.network.bonds.map((b, j) => (j === bondIndex ? { ...b, ...patch } : b));
        return { ...node, network: { ...node.network, bonds } };
      }),
    );
  }

  const hostnameSuffixError = validateHostnameSuffix(hostnameSuffix);
  const globalCidrError = validateCidr(globalCidr);
  const gatewayError = validateIp(gateway);

  return (
    <div className="pc-root flex min-h-full flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-5">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="code flex h-7 w-7 items-center justify-center bg-accent font-bold text-on-accent">
              {">"}
            </span>
            <span className="text-[15px] font-semibold tracking-tight">
              proxmox<span className="text-accent">.computer</span>
            </span>
          </Link>
          <Link href="/" className="meta text-ink-muted transition-colors hover:text-ink">
            ← back
          </Link>
        </div>
      </header>

      <main className="flex-1 px-6 py-12">
        <div className="pc-stepflow mx-auto">
          <div className="pc-stepflow__head">
            <div className="pc-steps">
              {wizardSteps.map((s, i) => (
                <div
                  key={s.id}
                  className={`pc-step ${i === stepIndex ? "pc-step--active" : i < stepIndex ? "pc-step--done" : ""}`}
                >
                  <div className="pc-step__marker">{i < stepIndex ? "✓" : String(i + 1).padStart(2, "0")}</div>
                  <span className="label pc-step__label">{s.label}</span>
                  {i < wizardSteps.length - 1 && <div className="pc-step__connector" />}
                </div>
              ))}
            </div>
          </div>

          {currentStep === "hardware" && (
            <div className="pc-stepflow__card">
              <p className="meta pc-stepflow__meta"># step 1 of 5</p>
              <h2 className="h2 pc-stepflow__title">hardware</h2>
              <p className="body pc-stepflow__intro">
                Tell us about every node. proxmox.computer uses this to plan
                networking, storage and cluster quorum in the next steps.
              </p>

              <div className="pc-stepflow__fields">
                <div className="pc-field">
                  <label className="label pc-field__label" htmlFor="node-count">
                    number of nodes
                  </label>
                  <div className="pc-field__control">
                    <input
                      id="node-count"
                      className="pc-field__input code"
                      type="number"
                      min={1}
                      max={16}
                      value={nodeCount}
                      onChange={(e) => handleNodeCountChange(e.target.value)}
                    />
                  </div>
                  <span className="body-sm pc-field__hint">1–16 physical hosts</span>
                </div>

                <div className={`pc-callout pc-callout--${quorumHint.tone}`}>
                  <span className="code pc-callout__glyph">{quorumHint.glyph}</span>
                  <div className="pc-callout__body">
                    <p className="body pc-callout__text">{quorumHint.text}</p>
                  </div>
                </div>

                <label className="pc-checkbox">
                  <input
                    type="checkbox"
                    checked={identicalHardware}
                    onChange={(e) => handleIdenticalHardwareChange(e.target.checked)}
                  />
                  <span className="pc-checkbox__box" />
                  <span>
                    <span className="code pc-checkbox__label">identical hardware across all nodes</span>
                    <span className="body-sm pc-checkbox__hint">fill in the specs once below, applied to every node</span>
                  </span>
                </label>

                {identicalHardware && nodes.length > 0 && (
                  <div
                    className="flex flex-col border border-border bg-surface-100 p-5"
                    style={{ gap: "var(--space-5)" }}
                  >
                    <p className="label text-ink-muted">hardware — all nodes</p>
                    <HardwareFields
                      keyPrefix="shared"
                      values={nodes[0]}
                      onChange={updateAllNodesHardware}
                      onNicCountChange={updateAllNodesNicCount}
                      onNicChange={updateAllNodesNic}
                      onAdditionalDiskCountChange={updateAllNodesAdditionalDiskCount}
                      onAdditionalDiskChange={updateAllNodesAdditionalDisk}
                    />
                  </div>
                )}

                {nodes.map((node, i) => {
                  const nameError = validateNodeName(node.name);

                  return (
                    <div
                      key={i}
                      className="flex flex-col border border-border bg-surface-100 p-5"
                      style={{ gap: "var(--space-5)" }}
                    >
                      <p className="label text-ink-muted">node {String(i + 1).padStart(2, "0")}</p>

                      <div className={`pc-field ${nameError ? "pc-field--error" : ""}`}>
                        <label className="label pc-field__label" htmlFor={`name-${i}`}>
                          node name
                        </label>
                        <div className="pc-field__control">
                          <span className="code pc-field__bracket">$</span>
                          <input
                            id={`name-${i}`}
                            className="pc-field__input code"
                            type="text"
                            value={node.name}
                            onChange={(e) => updateNode(i, { name: e.target.value })}
                          />
                        </div>
                        <span className="body-sm pc-field__hint">
                          {nameError ?? "short, lowercase — used across the cluster and in pvecm status"}
                        </span>
                      </div>

                      {!identicalHardware && (
                        <HardwareFields
                          keyPrefix={`node-${i}`}
                          values={node}
                          onChange={(patch) => updateNode(i, patch)}
                          onNicCountChange={(value) => handleNicCountChange(i, value)}
                          onNicChange={(nicIndex, patch) => updateNic(i, nicIndex, patch)}
                          onAdditionalDiskCountChange={(value) => handleAdditionalDiskCountChange(i, value)}
                          onAdditionalDiskChange={(diskIndex, patch) => updateAdditionalDisk(i, diskIndex, patch)}
                        />
                      )}
                    </div>
                  );
                })}

                {cpuHint && (
                  <div className={`pc-callout pc-callout--${cpuHint.tone}`}>
                    <span className="code pc-callout__glyph">{cpuHint.glyph}</span>
                    <div className="pc-callout__body">
                      <p className="body pc-callout__text">{cpuHint.text}</p>
                    </div>
                  </div>
                )}
              </div>

              <div className="pc-stepflow__nav">
                <Link href="/" className="pc-btn pc-btn--ghost">
                  ← back to overview
                </Link>
                <button type="button" className="pc-btn pc-btn--primary" onClick={() => setCurrentStep("network")}>
                  <span className="pc-btn__bracket">[</span>
                  next
                  <span className="pc-btn__bracket">]</span>
                </button>
              </div>
            </div>
          )}

          {currentStep === "network" && (
            <div className="pc-stepflow__card">
              <p className="meta pc-stepflow__meta"># step 2 of 5</p>
              <h2 className="h2 pc-stepflow__title">network</h2>
              <p className="body pc-stepflow__intro">
                Set the domain and address range for your homelab.
                proxmox.computer uses these to generate a hostname, ip and
                bridge layout for every node below.
              </p>

              <div className="pc-stepflow__fields">
                <div className={`pc-field ${hostnameSuffixError ? "pc-field--error" : ""}`}>
                  <label className="label pc-field__label" htmlFor="hostname-suffix">
                    hostname suffix
                  </label>
                  <div className="pc-field__control">
                    <span className="code pc-field__bracket">$</span>
                    <input
                      id="hostname-suffix"
                      className="pc-field__input code"
                      type="text"
                      placeholder="homelab.lan"
                      value={hostnameSuffix}
                      onChange={(e) => setHostnameSuffix(e.target.value)}
                    />
                  </div>
                  <span className="body-sm pc-field__hint">
                    {hostnameSuffixError ?? "appended to every node name to form its fqdn, e.g. pve01.homelab.lan"}
                  </span>
                </div>

                <CidrField
                  id="global-cidr"
                  label="homelab cidr"
                  value={globalCidr}
                  onChange={handleGlobalCidrChange}
                  placeholder="10.0.10.0/24"
                  error={globalCidrError}
                  hint="the network your nodes live on — used to generate each node's management ip"
                />

                <div className={`pc-field ${gatewayError ? "pc-field--error" : ""}`}>
                  <label className="label pc-field__label" htmlFor="gateway">
                    gateway
                  </label>
                  <div className="pc-field__control">
                    <span className="code pc-field__bracket">#</span>
                    <input
                      id="gateway"
                      className="pc-field__input code"
                      type="text"
                      placeholder="10.0.10.1"
                      value={gateway}
                      onChange={(e) => setGateway(e.target.value)}
                    />
                  </div>
                  <span className="body-sm pc-field__hint">
                    {gatewayError ?? "default route for every node — usually your router or firewall"}
                  </span>
                </div>

                <div className="pc-callout pc-callout--info">
                  <span className="code pc-callout__glyph">#</span>
                  <div className="pc-callout__body">
                    <p className="body pc-callout__text">
                      Proxmox bridges the management nic as vmbr0 by
                      default — that&apos;s the interface both the web ui
                      and vms reach the network through. Nics doing the
                      same job for redundancy or more bandwidth want
                      bonding — combine them into a bond below, then bridge
                      the bond, rather than bridging each nic separately.
                      Nics or bonds doing genuinely different jobs (say,
                      ceph vs. a separate vm vlan) each get their own
                      bridge below, and each one asks what it&apos;s for —
                      that decides whether it needs a static ip or just a
                      network.
                    </p>
                  </div>
                </div>

                {nodes.map((node, i) => (
                  <div
                    key={i}
                    className="flex flex-col border border-border bg-surface-100 p-5"
                    style={{ gap: "var(--space-5)" }}
                  >
                    <p className="label text-ink-muted">
                      node {String(i + 1).padStart(2, "0")} — {node.name}
                    </p>
                    <NetworkFields
                      keyPrefix={`node-${i}`}
                      node={node}
                      hostnameSuffix={hostnameSuffix}
                      lanPrefix={lanPrefix}
                      cephAvailable={nodes.length >= 2}
                      onChange={(patch) => updateNodeNetwork(i, patch)}
                      onBondCountChange={(value) => handleBondCountChange(i, value)}
                      onToggleBondNic={(bondIndex, nicIndex, checked) => toggleBondNic(i, bondIndex, nicIndex, checked)}
                      onUpdateBondMeta={(bondIndex, patch) => updateBondMeta(i, bondIndex, patch)}
                      onManagementInterfaceChange={(interfaceId) => setManagementInterface(i, interfaceId)}
                      onBridgeChange={(interfaceId, patch) => updateBridge(i, interfaceId, patch)}
                    />
                  </div>
                ))}
              </div>

              <div className="pc-stepflow__nav">
                <button type="button" className="pc-btn" onClick={() => setCurrentStep("hardware")}>
                  <span className="pc-btn__bracket">[</span>
                  back
                  <span className="pc-btn__bracket">]</span>
                </button>
                <button type="button" className="pc-btn" disabled title="steps 3–5 aren't built yet">
                  <span className="pc-btn__bracket">[</span>
                  next
                  <span className="pc-btn__bracket">]</span>
                </button>
              </div>
            </div>
          )}

          <p className="meta mt-3 text-ink-muted">
            steps 3–5 — storage, backups, install software — aren&apos;t built yet.
          </p>
        </div>
      </main>
    </div>
  );
}
