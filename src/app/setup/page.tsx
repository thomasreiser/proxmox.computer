"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import wizardSteps from "@/data/wizard-steps.json";
import {
  BOND_MODE_OPTIONS,
  bridgeCountFor,
  bridgeKey,
  interfacesFor,
  loadPersistedState,
  MAX_BRIDGES_PER_INTERFACE,
  MAX_NICS_PER_NODE,
  needsHostIpForPurposes,
  nicSpeedLabel,
  nicSpeedsForInterface,
  nicSpeedOptions,
  PURPOSE_NEEDS_HOST_IP,
  STORAGE_KEY,
  STORAGE_VERSION,
  type AdditionalDisk,
  type BondConfig,
  type BondMode,
  type BridgeConfig,
  type DiskType,
  type HardwareSpec,
  type InterfacePurpose,
  type NicInfo,
  type NicSpeed,
  type NodeInfo,
  type NodeNetwork,
  type PersistedState,
  type StorageHaMode,
  type WizardStepId,
} from "./wizard-state";
import {
  isValidIPv4,
  subnetDetails,
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
  DEFAULT_CPU_FAMILY,
  cpuVendorOptions,
  defaultCoresFor,
  familiesByDate,
} from "./cpu";
import {
  backupHintFor,
  cephLinkSpeedHint,
  corosyncHintFor,
  cpuHintFor,
  nodesWithoutFastNic,
  purposeComboHint,
  quorumHintFor,
  storageHaHintFor,
  vmTrafficHintFor,
  type Hint,
} from "./hints";
import {
  activeStoragePurpose,
  addressableBridgeKeys,
  applyNetworkStructure,
  buildAddressConflicts,
  buildPlaceholderTable,
  collectNodeNames,
  defaultAdditionalDisk,
  defaultBondName,
  defaultNicName,
  defaultNode,
  deriveGateway,
  deriveNodeCidr,
  effectiveStorageHaMode,
  isDedicatedStorageBondPurpose,
  maxBondsForCluster,
  minAdditionalDisks,
  nextVmbrName,
  nonCollidingPlaceholderSubnet,
  resizeArray,
  resyncNetworkForNics,
  siblingVlanTagsFor,
  withoutPurposes,
  type NodeNames,
  type PlaceholderSubnet,
} from "./derive";

const DISK_NAME_PRESETS = ["boot", "vm-storage", "backup", "iso", "storage-1", "storage-2", "ceph-osd-1", "ceph-osd-2"];
const NIC_NAME_PRESETS = ["onboard", "lan", "wan", "management", "storage", "cluster", "vmotion", "corosync"];



interface PurposeInfo {
  value: InterfacePurpose;
  label: string;
  hint: string;
}

// whether each of these needs a host address isn't repeated here — it's
// PURPOSE_NEEDS_HOST_IP in wizard-state, shared with the preview.
const INTERFACE_PURPOSE_OPTIONS: PurposeInfo[] = [
  {
    value: "vm",
    label: "vm / container traffic",
    hint: "a pure switch — vms and cts get their own ips, the host doesn't need one here",
  },
  {
    value: "ceph",
    label: "ceph / storage traffic",
    hint: "the host's ceph client (and osds, if this node runs any) need a real address here",
  },
  {
    value: "zfs",
    label: "zfs replication traffic",
    hint: "the host needs an address here for zfs send/receive replication to the other nodes",
  },
  {
    value: "backup",
    label: "backups",
    hint: "the host needs an address here to reach the backup target",
  },
  {
    value: "cluster",
    label: "cluster sync (corosync)",
    hint: "the host needs an address here for corosync ring traffic",
  },
  {
    value: "other",
    label: "other",
    hint: "pick whether the node itself needs an address here",
  },
];

function purposeInfoFor(purpose: InterfacePurpose): PurposeInfo {
  return INTERFACE_PURPOSE_OPTIONS.find((p) => p.value === purpose) ?? INTERFACE_PURPOSE_OPTIONS[0];
}

// the same wording the "used for" checkboxes above already use — shown
// again as a small sub-headline on this bridge's own ip/network field, so
// a field far from those checkboxes (or, under "identical network
// setup", in an entirely different section) still says what it's for.
function purposesUsedForLabel(purposes: InterfacePurpose[]): string {
  return purposes.map((p) => purposeInfoFor(p).label).join(", ");
}

// combines the "why" from every selected purpose that actually requires a
// host address, so the field hint reflects all of them, not just one.
function requiredIpHintFor(purposes: InterfacePurpose[], otherNeedsHostIp: boolean): string {
  return purposes
    .filter((p) => PURPOSE_NEEDS_HOST_IP[p] ?? otherNeedsHostIp)
    .map((p) => purposeInfoFor(p).hint)
    .join("; ");
}

interface StorageHaInfo {
  value: StorageHaMode;
  label: string;
  hint: string;
}

const STORAGE_HA_OPTIONS: StorageHaInfo[] = [
  {
    value: "ceph",
    label: "ceph (recommended)",
    hint: "distributed storage built into proxmox — vm disks live on every node, live-migrate freely, survive a node going down",
  },
  {
    value: "zfs-replication",
    label: "zfs with replication",
    hint: "local zfs storage per node, periodically synced to the others — cheaper and simpler than ceph, but replication is scheduled, not instant, so a failover can lose a few minutes of writes",
  },
  {
    value: "none",
    label: "no ha / sync",
    hint: "each node's storage is its own island — simplest setup, but a vm doesn't survive its node going down",
  },
];






































// A text field for anything in ip or ip/prefix notation, with a small
// toggle beside the input that expands a subnet breakdown (network,
// broadcast, usable range, host count) — collapsed by default so it
// doesn't clutter the form until someone actually wants it.
function CidrField({
  id,
  label,
  usedFor,
  value,
  onChange,
  hint,
  error,
  placeholder,
  defaultPrefix = 24,
  required = false,
}: {
  id: string;
  label: string;
  // a small sub-headline under the label — what this bridge is actually
  // for (e.g. "ceph / storage traffic, backups"). NetworkAddressFields'
  // per-node address fields are often the only place a bridge shows up
  // once "identical network setup" moves its purpose checkboxes into the
  // shared section, so a field like "vmbr3 — static ip for this node"
  // otherwise gives no clue what vmbr3 even is without scrolling back up.
  usedFor?: string;
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
  required?: boolean;
}) {
  const [showDetails, setShowDetails] = useState(false);
  // an empty field's placeholder is just an example, not a value it
  // already has — flagging it "required" in red before the visitor has
  // ever touched it reads as "this is already wrong," when really
  // nothing's been entered yet. hold off on error styling until they've
  // actually left the field once.
  const [touched, setTouched] = useState(false);
  const info = subnetDetails(value);
  const showError = touched && error;

  function handleBlur() {
    setTouched(true);
    if (isValidIPv4(value)) onChange(`${value}/${defaultPrefix}`);
  }

  return (
    <div className={`pc-field ${showError ? "pc-field--error" : ""}`}>
      <label className="label pc-field__label" htmlFor={id}>
        {label}
        {required && <span className="pc-field__required"> *</span>}
      </label>
      {usedFor && <p className="meta pc-field__usedfor">used for: {usedFor}</p>}
      <div className="pc-field__control">
        <span className="code pc-field__bracket">#</span>
        <input
          id={id}
          className="pc-field__input code"
          type="text"
          placeholder={placeholder ? `e.g. ${placeholder}` : undefined}
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
      <span className="body-sm pc-field__hint">{showError ? error : hint}</span>
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
  names,
  onChange,
  onNicCountChange,
  onNicChange,
  onAdditionalDiskCountChange,
  onAdditionalDiskChange,
}: {
  keyPrefix: string;
  values: HardwareSpec;
  // the names already in use on this node, per namespace — including this
  // node's own current values, so a field can tell whether ITS value
  // collides with another of the same kind, itself included.
  names: NodeNames;
  onChange: (patch: Partial<HardwareSpec>) => void;
  onNicCountChange: (value: string) => void;
  onNicChange: (nicIndex: number, patch: Partial<NicInfo>) => void;
  onAdditionalDiskCountChange: (value: string) => void;
  onAdditionalDiskChange: (diskIndex: number, patch: Partial<AdditionalDisk>) => void;
}) {
  const selectedFamily = familiesByDate(values.cpuVendor).find((f) => f.name === values.cpuFamily);
  const cpuCountError = validateIntRange(values.cpuCount, 1, 8, { required: true });
  const coresPerCpuError = validateIntRange(values.coresPerCpu, 1, 256, { required: true });
  const ramGbError = validateIntRange(values.ramGb, 1, 16384, { required: true });
  const bootDiskSizeError = validateIntRange(values.bootDiskSizeGb, 8, 1048576, { required: true });
  const bootDiskNameError = validateFriendlyName(values.bootDiskName) ?? validateUniqueName(values.bootDiskName, names.disks);
  const additionalDiskCountError = validateIntRange(values.additionalDiskCount, 0, 12);
  const nicCountError = validateIntRange(values.nicCount, 1, MAX_NICS_PER_NODE, { required: true });
  // bootDiskSizeGb and each additional disk's sizeGb start out empty and
  // are now required — flagging that red before the visitor has typed
  // anything would repeat the same "already wrong" confusion CidrField
  // had, so hold off on error styling until each field's been left once.
  const [sizeTouched, setSizeTouched] = useState<Record<string, boolean>>({});
  const markSizeTouched = (field: string) => setSizeTouched((t) => ({ ...t, [field]: true }));
  const showRamGbError = sizeTouched.ram && ramGbError;
  const showBootDiskSizeError = sizeTouched.boot && bootDiskSizeError;

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

      <div className={`pc-field ${cpuCountError ? "pc-field--error" : ""}`}>
        <label className="label pc-field__label" htmlFor={`cpucount-${keyPrefix}`}>
          number of cpus
          <span className="pc-field__required"> *</span>
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
        <span className="body-sm pc-field__hint">
          {cpuCountError ?? "physical sockets — almost always 1 for a homelab node"}
        </span>
      </div>

      <div className={`pc-field ${coresPerCpuError ? "pc-field--error" : ""}`}>
        <label className="label pc-field__label" htmlFor={`corespercpu-${keyPrefix}`}>
          cores per cpu
          <span className="pc-field__required"> *</span>
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
          {coresPerCpuError ??
            `rough default for ${selectedFamily?.name ?? "this family"} — check your actual spec sheet and correct it`}
        </span>
      </div>

      <div className={`pc-field ${showRamGbError ? "pc-field--error" : ""}`}>
        <label className="label pc-field__label" htmlFor={`ram-${keyPrefix}`}>
          memory (gb)
          <span className="pc-field__required"> *</span>
        </label>
        <div className="pc-field__control">
          <input
            id={`ram-${keyPrefix}`}
            className="pc-field__input code"
            type="number"
            min={1}
            placeholder="e.g. 64"
            value={values.ramGb}
            onChange={(e) => onChange({ ramGb: e.target.value })}
            onBlur={() => markSizeTouched("ram")}
          />
        </div>
        <span className="body-sm pc-field__hint">{showRamGbError ? ramGbError : "total installed memory"}</span>
      </div>

      <DiskTypeRadioGroup
        name={`boot-${keyPrefix}`}
        legend="boot disk type"
        value={values.bootDiskType}
        onChange={(type) => onChange({ bootDiskType: type })}
        hddHint="works, but installs and updates will be slower"
      />

      <div className={`pc-field ${showBootDiskSizeError ? "pc-field--error" : ""}`}>
        <label className="label pc-field__label" htmlFor={`bootsize-${keyPrefix}`}>
          boot disk size (gb)
          <span className="pc-field__required"> *</span>
        </label>
        <div className="pc-field__control">
          <input
            id={`bootsize-${keyPrefix}`}
            className="pc-field__input code"
            type="number"
            min={8}
            placeholder="e.g. 256"
            value={values.bootDiskSizeGb}
            onChange={(e) => onChange({ bootDiskSizeGb: e.target.value })}
            onBlur={() => markSizeTouched("boot")}
          />
        </div>
        <span className="body-sm pc-field__hint">
          {showBootDiskSizeError ? bootDiskSizeError : "just the proxmox install disk — storage pool disks come later"}
        </span>
      </div>

      <div className={`pc-field ${bootDiskNameError ? "pc-field--error" : ""}`}>
        <label className="label pc-field__label" htmlFor={`bootname-${keyPrefix}`}>
          boot disk friendly name
          <span className="pc-field__required"> *</span>
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
        <span className="body-sm pc-field__hint">
          {bootDiskNameError ?? "how this disk is labeled in later steps, instead of the raw device path"}
        </span>
      </div>

      <div className={`pc-field ${additionalDiskCountError ? "pc-field--error" : ""}`}>
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
            onBlur={() => {
              if (!values.additionalDiskCount) onAdditionalDiskCountChange("0");
            }}
          />
        </div>
        <span className="body-sm pc-field__hint">
          {additionalDiskCountError ?? "disks beyond the boot disk — for a zfs/ceph storage pool later — 0 if none"}
        </span>
      </div>

      {values.additionalDisks.map((disk, j) => {
        const diskSizeError = validateIntRange(disk.sizeGb, 1, 1048576, { required: true });
        const showDiskSizeError = sizeTouched[`disk-${j}`] && diskSizeError;
        const diskNameError = validateFriendlyName(disk.name) ?? validateUniqueName(disk.name, names.disks);
        return (
          <div key={j} className="flex flex-col" style={{ gap: "var(--space-3)" }}>
            <p className="label text-ink-muted">additional disk {j + 1}</p>
            <DiskTypeRadioGroup
              name={`extradisktype-${keyPrefix}-${j}`}
              legend="disk type"
              value={disk.type}
              onChange={(type) => onAdditionalDiskChange(j, { type })}
            />
            <div className={`pc-field ${showDiskSizeError ? "pc-field--error" : ""}`}>
              <label className="label pc-field__label" htmlFor={`extradisksize-${keyPrefix}-${j}`}>
                size (gb)
                <span className="pc-field__required"> *</span>
              </label>
              <div className="pc-field__control">
                <input
                  id={`extradisksize-${keyPrefix}-${j}`}
                  className="pc-field__input code"
                  type="number"
                  min={1}
                  placeholder="e.g. 2000"
                  value={disk.sizeGb}
                  onChange={(e) => onAdditionalDiskChange(j, { sizeGb: e.target.value })}
                  onBlur={() => markSizeTouched(`disk-${j}`)}
                />
              </div>
              <span className="body-sm pc-field__hint">
                {showDiskSizeError ? diskSizeError : "raw size — actual usable space depends on the storage layout you pick later"}
              </span>
            </div>
            <div className={`pc-field ${diskNameError ? "pc-field--error" : ""}`}>
              <label className="label pc-field__label" htmlFor={`extradiskname-${keyPrefix}-${j}`}>
                friendly name
                <span className="pc-field__required"> *</span>
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
              <span className="body-sm pc-field__hint">
                {diskNameError ?? "how this disk is labeled in later steps, instead of the raw device path"}
              </span>
            </div>
          </div>
        );
      })}
      <datalist id={`disk-presets-${keyPrefix}`}>
        {DISK_NAME_PRESETS.map((preset) => (
          <option key={preset} value={preset} />
        ))}
      </datalist>

      <div className={`pc-field ${nicCountError ? "pc-field--error" : ""}`}>
        <label className="label pc-field__label" htmlFor={`niccount-${keyPrefix}`}>
          number of nics
          <span className="pc-field__required"> *</span>
        </label>
        <div className="pc-field__control">
          <input
            id={`niccount-${keyPrefix}`}
            className="pc-field__input code"
            type="number"
            min={1}
            max={MAX_NICS_PER_NODE}
            value={values.nicCount}
            onChange={(e) => onNicCountChange(e.target.value)}
          />
        </div>
        <span className="body-sm pc-field__hint">{nicCountError ?? "physical network ports on this node"}</span>
      </div>

      {values.nics.map((nic, j) => {
        // unlike disk names (which map to a storage id — zfs/lvm/proxmox
        // all tolerate 32+ chars), a nic's friendly name is exactly the
        // kind of label that ends up as a real `ip link` rename or a
        // udev .link Name= — so it's held to the actual linux ifname
        // limit, not the looser storage-id one.
        const nicNameError = validateInterfaceName(nic.name) ?? validateUniqueName(nic.name, names.interfaces);
        return (
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
            <div className={`pc-field ${nicNameError ? "pc-field--error" : ""}`}>
              <label className="label pc-field__label" htmlFor={`nicname-${keyPrefix}-${j}`}>
                friendly name
                <span className="pc-field__required"> *</span>
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
              <span className="body-sm pc-field__hint">
                {nicNameError ?? "used to label this nic in later steps — rename to match its role"}
              </span>
            </div>
          </div>
        );
      })}
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
  maxBonds,
  onBondCountChange,
  onToggleBondNic,
  onUpdateBondMeta,
}: {
  keyPrefix: string;
  node: NodeInfo;
  // capped by the cluster's least-equipped node, not this node's own nic
  // count — see maxBondsForCluster.
  maxBonds: number;
  onBondCountChange: (value: string) => void;
  onToggleBondNic: (bondIndex: number, nicIndex: number, checked: boolean) => void;
  onUpdateBondMeta: (bondIndex: number, patch: Partial<Pick<BondConfig, "name" | "mode" | "vlanTag">>) => void;
}) {
  const bondCountError = validateIntRange(node.network.bondCount, 0, maxBonds);
  const names = collectNodeNames(node);

  return (
    <>
      <div className={`pc-field ${bondCountError ? "pc-field--error" : ""}`}>
        <label className="label pc-field__label" htmlFor={`bondcount-${keyPrefix}`}>
          number of bonds
        </label>
        <div className="pc-field__control">
          <input
            id={`bondcount-${keyPrefix}`}
            className="pc-field__input code"
            type="number"
            min={0}
            max={maxBonds}
            value={node.network.bondCount}
            onChange={(e) => onBondCountChange(e.target.value)}
            onBlur={() => {
              if (!node.network.bondCount) onBondCountChange("0");
            }}
          />
        </div>
        <span className="body-sm pc-field__hint">
          {bondCountError ??
            "combine 2+ nics into one logical link for redundancy or more bandwidth — 0 if you don't need any"}
        </span>
      </div>

      {node.network.bonds.map((bond, bi) => {
        const bondNameError = validateInterfaceName(bond.name) ?? validateUniqueName(bond.name, names.interfaces);
        const bondVlanError = validateOptionalVlanTag(bond.vlanTag);
        return (
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
                    nic {ni + 1} — {nic.name} — {nicSpeedLabel(nic.speed)}
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

          <div className={`pc-field ${bondNameError ? "pc-field--error" : ""}`}>
            <label className="label pc-field__label" htmlFor={`bondname-${keyPrefix}-${bi}`}>
              bond name
              <span className="pc-field__required"> *</span>
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
            <span className="body-sm pc-field__hint">
              {bondNameError ?? "the linux bonding interface name — appears below as its own interface"}
            </span>
          </div>

          <div className={`pc-field ${bondVlanError ? "pc-field--error" : ""}`}>
            <label className="label pc-field__label" htmlFor={`bondvlan-${keyPrefix}-${bi}`}>
              vlan tag
            </label>
            <div className="pc-field__control">
              <span className="code pc-field__bracket">#</span>
              <input
                id={`bondvlan-${keyPrefix}-${bi}`}
                className="pc-field__input code"
                type="number"
                min={1}
                max={4094}
                placeholder="e.g. 30"
                value={bond.vlanTag}
                onChange={(e) => onUpdateBondMeta(bi, { vlanTag: e.target.value })}
              />
            </div>
            <span className="body-sm pc-field__hint">
              {bondVlanError ??
                "tags this bond's own link at that vlan instead of leaving it native/untagged — leave blank for a plain native link on the main homelab vlan"}
            </span>
          </div>
        </div>
        );
      })}
    </>
  );
}

// a bridge at index 1+ of some interface — sharing a nic/bond with a
// sibling bridge only works in linux if each one is vlan-tagged, so this
// always shows a vlan field and never the "bridge this interface" toggle
// (its existence is already opt-in via the interface's bridge count).
// `address`, when given, also renders this bridge's own ip field — used
// by the combined (not-"identical network") NetworkFields; omitted by
// NetworkStructureFields, which leaves every ip field to
// NetworkAddressFields instead.
function ExtraBridgeCard({
  keyPrefix,
  bridgeId,
  heading,
  bridge,
  siblingVlanTags,
  names,
  purposeOptions,
  storagePurpose,
  storagePurposeMissingHint,
  nicSpeeds,
  onBridgeChange,
  address,
  conflictError,
}: {
  keyPrefix: string;
  bridgeId: string;
  heading: string;
  bridge: BridgeConfig;
  siblingVlanTags: string[];
  names: NodeNames;
  purposeOptions: PurposeInfo[];
  storagePurpose: InterfacePurpose | null;
  storagePurposeMissingHint: ReactNode;
  // the physical nics behind this bridge's interface — only used to check
  // whether a ceph purpose here is riding a fast enough link.
  nicSpeeds: NicSpeed[];
  onBridgeChange: (bridgeId: string, patch: Partial<BridgeConfig>) => void;
  address?: { lanPrefix: number; secondarySubnet: { host: string; network: string } | null };
  // a real address problem for this bridge (see buildAddressConflicts) —
  // omitted by NetworkStructureFields, which has no per-node addresses to
  // check yet.
  conflictError?: string | null;
}) {
  const bridgeNameError = validateInterfaceName(bridge.name) ?? validateUniqueName(bridge.name, names.interfaces);
  const comboHint = purposeComboHint(bridge.purposes);
  const cephSpeedHint = cephLinkSpeedHint(bridge.purposes, nicSpeeds);
  const vlanError = validateVlanTag(bridge.vlanTag, siblingVlanTags);
  const needsHostIp = needsHostIpForPurposes(bridge.purposes, bridge.otherNeedsHostIp);
  const ipError = (needsHostIp ? validateHostCidr(bridge.ip) : validateNetwork(bridge.ip)) ?? conflictError ?? null;
  // the vlan tag starts empty on a freshly-added extra bridge — same
  // "don't flag it red before the visitor has touched it" reasoning as
  // CidrField and the disk-size fields in HardwareFields.
  const [vlanTouched, setVlanTouched] = useState(false);
  const showVlanError = vlanTouched && vlanError;

  return (
    <div className="flex flex-col border border-border bg-surface-100 p-5" style={{ gap: "var(--space-3)" }}>
      <p className="label text-ink-muted">{heading}</p>
      <div className={`pc-field ${showVlanError ? "pc-field--error" : ""}`}>
        <label className="label pc-field__label" htmlFor={`vlan-${keyPrefix}-${bridgeId}`}>
          vlan tag
          <span className="pc-field__required"> *</span>
        </label>
        <div className="pc-field__control">
          <span className="code pc-field__bracket">#</span>
          <input
            id={`vlan-${keyPrefix}-${bridgeId}`}
            className="pc-field__input code"
            type="number"
            min={1}
            max={4094}
            value={bridge.vlanTag}
            onChange={(e) => onBridgeChange(bridgeId, { vlanTag: e.target.value })}
            onBlur={() => setVlanTouched(true)}
          />
        </div>
        <span className="body-sm pc-field__hint">
          {showVlanError
            ? vlanError
            : "separates this bridge's traffic from its sibling(s) sharing the same nic/bond — must match a vlan configured on your switch"}
        </span>
      </div>

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
                  onBridgeChange(bridgeId, { purposes: nextPurposes });
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
        {storagePurpose === null && storagePurposeMissingHint}
      </fieldset>

      {[comboHint, cephSpeedHint]
        .filter((hint): hint is Hint => hint !== null)
        .map((hint, i) => (
          <div key={i} className={`pc-callout pc-callout--${hint.tone}`}>
            <span className="code pc-callout__glyph">{hint.glyph}</span>
            <div className="pc-callout__body">
              <p className="body-sm pc-callout__text">{hint.text}</p>
            </div>
          </div>
        ))}

      {bridge.purposes.includes("other") && (
        <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
          <legend className="label pc-radio-group__legend">does this node need an address here?</legend>
          <label className="pc-radio">
            <input
              type="radio"
              name={`otherip-${keyPrefix}-${bridgeId}`}
              checked={bridge.otherNeedsHostIp}
              onChange={() => onBridgeChange(bridgeId, { otherNeedsHostIp: true })}
            />
            <span className="pc-radio__box" />
            <span className="code pc-radio__label">yes — give it a static ip</span>
          </label>
          <label className="pc-radio">
            <input
              type="radio"
              name={`otherip-${keyPrefix}-${bridgeId}`}
              checked={!bridge.otherNeedsHostIp}
              onChange={() => onBridgeChange(bridgeId, { otherNeedsHostIp: false })}
            />
            <span className="pc-radio__box" />
            <span className="code pc-radio__label">no — it&apos;s just a switch for vms</span>
          </label>
        </fieldset>
      )}

      <div className={`pc-field ${bridgeNameError ? "pc-field--error" : ""}`}>
        <label className="label pc-field__label" htmlFor={`bridge-${keyPrefix}-${bridgeId}`}>
          bridge name
          <span className="pc-field__required"> *</span>
        </label>
        <div className="pc-field__control">
          <span className="code pc-field__bracket">$</span>
          <input
            id={`bridge-${keyPrefix}-${bridgeId}`}
            className="pc-field__input code"
            type="text"
            value={bridge.name}
            onChange={(e) => onBridgeChange(bridgeId, { name: e.target.value })}
          />
        </div>
        <span className="body-sm pc-field__hint">
          {bridgeNameError ?? "shown in the proxmox ui and used in vm/ct network config"}
        </span>
      </div>

      {address && (
        <CidrField
          id={`bridgeip-${keyPrefix}-${bridgeId}`}
          label={needsHostIp ? "static ip for this node" : "network"}
          usedFor={purposesUsedForLabel(bridge.purposes)}
          value={bridge.ip}
          onChange={(value) => onBridgeChange(bridgeId, { ip: value })}
          placeholder={
            needsHostIp
              ? (address.secondarySubnet?.host ?? "10.0.20.11/24")
              : (address.secondarySubnet?.network ?? "10.0.20.0/24")
          }
          error={ipError}
          hint={
            needsHostIp
              ? requiredIpHintFor(bridge.purposes, bridge.otherNeedsHostIp)
              : "the subnet vms/cts on this bridge should use — the host itself still won't have an address here"
          }
          defaultPrefix={address.lanPrefix}
          required
        />
      )}
    </div>
  );
}

// a "number of bridges on this interface" count field — 1 is just that
// interface's native bridge (today's default); raise it to add vlan-
// tagged siblings sharing the same underlying nic or bond.
function BridgeCountField({
  keyPrefix,
  interfaceId,
  count,
  onBridgeCountChange,
}: {
  keyPrefix: string;
  interfaceId: string;
  count: string;
  onBridgeCountChange: (interfaceId: string, value: string) => void;
}) {
  const error = validateIntRange(count, 1, MAX_BRIDGES_PER_INTERFACE, { required: true });
  return (
    <div className={`pc-field ${error ? "pc-field--error" : ""}`}>
      <label className="label pc-field__label" htmlFor={`bridgecount-${keyPrefix}-${interfaceId}`}>
        bridges on this interface
        <span className="pc-field__required"> *</span>
      </label>
      <div className="pc-field__control">
        <input
          id={`bridgecount-${keyPrefix}-${interfaceId}`}
          className="pc-field__input code"
          type="number"
          min={1}
          max={MAX_BRIDGES_PER_INTERFACE}
          value={count}
          onChange={(e) => onBridgeCountChange(interfaceId, e.target.value)}
        />
      </div>
      <span className="body-sm pc-field__hint">
        {error ??
          "1 = just this interface's own bridge — raise it to split off extra, vlan-tagged bridges sharing the same nic/bond"}
      </span>
    </div>
  );
}

// everything about a node's network EXCEPT addresses: bonds, which
// interface is management, and every bridge's purposes/enabled/name.
// used as a single shared block when "identical network setup" is on,
// instead of repeating it per node — hostname and every ip address still
// come from NetworkAddressFields, always rendered per node.
function NetworkStructureFields({
  keyPrefix,
  node,
  nodeCount,
  maxBonds,
  storageHaMode,
  storagePurpose,
  globalCidr,
  lanPrefix,
  placeholders,
  onBondCountChange,
  onToggleBondNic,
  onUpdateBondMeta,
  onManagementInterfaceChange,
  onBridgeChange,
  onBridgeCountChange,
}: {
  keyPrefix: string;
  node: NodeInfo;
  nodeCount: number;
  maxBonds: number;
  storageHaMode: StorageHaMode;
  storagePurpose: InterfacePurpose | null;
  // used only for a pure vm/ct bridge's declared network — the one bridge
  // field that lives here rather than in NetworkAddressFields, since it's
  // shared structure now, not a per-node address (see applyNetworkStructure).
  globalCidr: string;
  lanPrefix: number;
  placeholders: Map<string, PlaceholderSubnet>;
  onBondCountChange: (value: string) => void;
  onToggleBondNic: (bondIndex: number, nicIndex: number, checked: boolean) => void;
  onUpdateBondMeta: (bondIndex: number, patch: Partial<Pick<BondConfig, "name" | "mode" | "vlanTag">>) => void;
  onManagementInterfaceChange: (interfaceId: string) => void;
  onBridgeChange: (bridgeId: string, patch: Partial<BridgeConfig>) => void;
  onBridgeCountChange: (interfaceId: string, value: string) => void;
}) {
  const interfaces = interfacesFor(node.nics, node.network.bonds);
  const names = collectNodeNames(node);
  // NetworkStructureFields only ever renders the "all nodes" template —
  // the real per-node instances go through NetworkFields instead — so
  // every placeholder lookup below is pinned to node index 0.
  const addressKeys = addressableBridgeKeys(node);
  const mgmtBridgeKey = bridgeKey(node.network.managementInterfaceId, 0);
  const managementBridge = node.network.bridges[mgmtBridgeKey];
  const managementBridgeNameError =
    validateInterfaceName(managementBridge?.name || "vmbr0") ??
    validateUniqueName(managementBridge?.name || "vmbr0", names.interfaces);
  const purposeOptions = INTERFACE_PURPOSE_OPTIONS.filter(
    (opt) => (opt.value !== "ceph" && opt.value !== "zfs") || opt.value === storagePurpose,
  );
  const managementComboHint = purposeComboHint(managementBridge?.purposes ?? []);
  const vmTrafficHint = vmTrafficHintFor(node.network.bridges);
  const backupHint = backupHintFor(node.network.bridges);
  const corosyncHint = corosyncHintFor(node.network.bridges, nodeCount);
  const storageHaHint = storageHaHintFor(node.network.bridges, storagePurpose);
  const storagePurposeMissingHint = (
    <p className="body-sm pc-field__hint">
      {nodeCount < 2
        ? "ceph and zfs replication need at least 2 nodes for real redundancy — add another node to unlock a cluster storage option here"
        : storageHaMode === "none"
          ? 'you chose "no ha / sync" above — pick ceph or zfs with replication there to unlock a matching nic purpose here'
          : "ceph and zfs replication both need at least 1 disk beyond the boot disk on every node — add one in step 1, or the choice above falls back to \"no ha / sync\" until then"}
    </p>
  );

  return (
    <>
      <BondFields
        keyPrefix={keyPrefix}
        node={node}
        maxBonds={maxBonds}
        onBondCountChange={onBondCountChange}
        onToggleBondNic={onToggleBondNic}
        onUpdateBondMeta={onUpdateBondMeta}
      />

      <div className="flex flex-col border border-border bg-surface-100 p-5" style={{ gap: "var(--space-3)" }}>
        <p className="label text-ink-muted">management</p>
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
        <div className={`pc-field ${managementBridgeNameError ? "pc-field--error" : ""}`}>
          <label className="label pc-field__label" htmlFor={`mgmtbridge-${keyPrefix}`}>
            bridge name
            <span className="pc-field__required"> *</span>
          </label>
          <div className="pc-field__control">
            <span className="code pc-field__bracket">$</span>
            <input
              id={`mgmtbridge-${keyPrefix}`}
              className="pc-field__input code"
              type="text"
              value={managementBridge?.name ?? "vmbr0"}
              onChange={(e) => onBridgeChange(mgmtBridgeKey, { name: e.target.value })}
            />
          </div>
          <span className="body-sm pc-field__hint">
            {managementBridgeNameError ??
              "carries the management ip and, by default, vm traffic too — vmbr0 is the proxmox convention, but you can rename it"}
          </span>
        </div>

        {managementBridge && (
          <>
            <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
              <legend className="label pc-radio-group__legend">also used for (pick as many as apply, or none)</legend>
              {purposeOptions
                .filter((opt) => opt.value !== "other")
                .map((opt) => {
                  const checked = managementBridge.purposes.includes(opt.value);
                  return (
                    <label key={opt.value} className="pc-checkbox">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const nextPurposes = e.target.checked
                            ? [...managementBridge.purposes, opt.value]
                            : managementBridge.purposes.filter((p) => p !== opt.value);
                          onBridgeChange(mgmtBridgeKey, { purposes: nextPurposes });
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
              {managementBridge.purposes.length === 0 && (
                <p className="body-sm pc-field__hint">
                  nothing checked — this bridge carries only the management ip above, no vm/container/backup/corosync
                  traffic
                </p>
              )}
              {storagePurpose === null && storagePurposeMissingHint}
            </fieldset>

            {managementComboHint && (
              <div className={`pc-callout pc-callout--${managementComboHint.tone}`}>
                <span className="code pc-callout__glyph">{managementComboHint.glyph}</span>
                <div className="pc-callout__body">
                  <p className="body-sm pc-callout__text">{managementComboHint.text}</p>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {interfaces.map((iface) => {
        const isManagement = iface.id === node.network.managementInterfaceId;
        const count = bridgeCountFor(node.network.bridgeCounts, iface.id);
        const bridge = node.network.bridges[bridgeKey(iface.id, 0)];
        // ceph/zfs get the whole bond — no extra vlan-tagged bridges to
        // split its bandwidth or latency budget with anything else.
        const isDedicatedStorageBond = iface.id.startsWith("bond-") && isDedicatedStorageBondPurpose(bridge?.purposes ?? []);

        return (
          <div key={iface.id} className="flex flex-col border border-border bg-surface-100 p-5" style={{ gap: "var(--space-3)" }}>
            <p className="label text-ink-muted">{iface.label}</p>

            {!isManagement &&
              bridge &&
              (() => {
                const bridgeNameError = validateInterfaceName(bridge.name) ?? validateUniqueName(bridge.name, names.interfaces);
                const comboHint = purposeComboHint(bridge.purposes);
                const cephSpeedHint = cephLinkSpeedHint(
                  bridge.purposes,
                  nicSpeedsForInterface(iface.id, node.nics, node.network.bonds),
                );
                const key0 = bridgeKey(iface.id, 0);
                const needsHostIp = needsHostIpForPurposes(bridge.purposes, bridge.otherNeedsHostIp);
                return (
                  <>
                    <label className="pc-checkbox">
                      <input
                        type="checkbox"
                        checked={bridge.enabled}
                        onChange={(e) => onBridgeChange(key0, { enabled: e.target.checked })}
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
                                    onBridgeChange(key0, { purposes: nextPurposes });
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
                          {storagePurpose === null && storagePurposeMissingHint}
                        </fieldset>

                        {[comboHint, cephSpeedHint]
                          .filter((hint): hint is Hint => hint !== null)
                          .map((hint, i) => (
                            <div key={i} className={`pc-callout pc-callout--${hint.tone}`}>
                              <span className="code pc-callout__glyph">{hint.glyph}</span>
                              <div className="pc-callout__body">
                                <p className="body-sm pc-callout__text">{hint.text}</p>
                              </div>
                            </div>
                          ))}

                        {bridge.purposes.includes("other") && (
                          <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
                            <legend className="label pc-radio-group__legend">does this node need an address here?</legend>
                            <label className="pc-radio">
                              <input
                                type="radio"
                                name={`otherip-${keyPrefix}-${key0}`}
                                checked={bridge.otherNeedsHostIp}
                                onChange={() => onBridgeChange(key0, { otherNeedsHostIp: true })}
                              />
                              <span className="pc-radio__box" />
                              <span className="code pc-radio__label">yes — give it a static ip</span>
                            </label>
                            <label className="pc-radio">
                              <input
                                type="radio"
                                name={`otherip-${keyPrefix}-${key0}`}
                                checked={!bridge.otherNeedsHostIp}
                                onChange={() => onBridgeChange(key0, { otherNeedsHostIp: false })}
                              />
                              <span className="pc-radio__box" />
                              <span className="code pc-radio__label">no — it&apos;s just a switch for vms</span>
                            </label>
                          </fieldset>
                        )}

                        <div className={`pc-field ${bridgeNameError ? "pc-field--error" : ""}`}>
                          <label className="label pc-field__label" htmlFor={`bridge-${keyPrefix}-${key0}`}>
                            bridge name
                            <span className="pc-field__required"> *</span>
                          </label>
                          <div className="pc-field__control">
                            <span className="code pc-field__bracket">$</span>
                            <input
                              id={`bridge-${keyPrefix}-${key0}`}
                              className="pc-field__input code"
                              type="text"
                              value={bridge.name}
                              onChange={(e) => onBridgeChange(key0, { name: e.target.value })}
                            />
                          </div>
                          <span className="body-sm pc-field__hint">
                            {bridgeNameError ?? "shown in the proxmox ui and used in vm/ct network config"}
                          </span>
                        </div>

                        {/* a real per-node static ip stays out of this
                            shared block entirely — NetworkAddressFields
                            handles it, once per node. a pure vm/ct
                            bridge's network is the one address-shaped
                            field that genuinely belongs here: it's the
                            same value on every node, so it's configured
                            once, right alongside this bridge's purpose. */}
                        {!needsHostIp && (
                          <CidrField
                            id={`bridgeip-${keyPrefix}-${key0}`}
                            label="network"
                            usedFor={purposesUsedForLabel(bridge.purposes)}
                            value={bridge.ip}
                            onChange={(value) => onBridgeChange(key0, { ip: value })}
                            placeholder={(() => {
                              const subnet =
                                placeholders.get(`0#${key0}`) ??
                                nonCollidingPlaceholderSubnet(node, globalCidr, addressKeys.indexOf(key0), 0);
                              return subnet?.network ?? "10.0.20.0/24";
                            })()}
                            error={validateNetwork(bridge.ip)}
                            hint="the subnet vms/cts on this bridge should use — the host itself still won't have an address here, and it's shared across every node"
                            defaultPrefix={lanPrefix}
                            required
                          />
                        )}
                      </>
                    )}
                  </>
                );
              })()}

            {isDedicatedStorageBond ? (
              <p className="body-sm pc-field__hint">
                bridges on this interface — locked to 1: {bridge?.purposes.includes("ceph") ? "ceph" : "zfs replication"} gets this
                bond to itself, so it can&apos;t be split into extra vlan-tagged bridges for anything else.
              </p>
            ) : (
              <>
                <BridgeCountField
                  keyPrefix={keyPrefix}
                  interfaceId={iface.id}
                  count={node.network.bridgeCounts[iface.id] ?? "1"}
                  onBridgeCountChange={onBridgeCountChange}
                />

                {Array.from({ length: Math.max(0, count - 1) }, (_, k) => k + 1).map((index) => {
                  const extraKey = bridgeKey(iface.id, index);
                  const extraBridge = node.network.bridges[extraKey];
                  if (!extraBridge) return null;
                  const extraNeedsHostIp = needsHostIpForPurposes(extraBridge.purposes, extraBridge.otherNeedsHostIp);
                  return (
                    <ExtraBridgeCard
                      key={extraKey}
                      keyPrefix={keyPrefix}
                      bridgeId={extraKey}
                      heading={`extra bridge (${extraBridge.name})`}
                      bridge={extraBridge}
                      siblingVlanTags={siblingVlanTagsFor(node.network.bridges, count, iface.id, index)}
                      names={names}
                      purposeOptions={purposeOptions}
                      storagePurpose={storagePurpose}
                      storagePurposeMissingHint={storagePurposeMissingHint}
                      nicSpeeds={nicSpeedsForInterface(iface.id, node.nics, node.network.bonds)}
                      onBridgeChange={onBridgeChange}
                      // same split as the first bridge above — a real static
                      // ip is per-node (NetworkAddressFields), a network-only
                      // value is shared, so only that case renders here.
                      address={
                        extraNeedsHostIp
                          ? undefined
                          : {
                              lanPrefix,
                              secondarySubnet:
                                placeholders.get(`0#${extraKey}`) ??
                                nonCollidingPlaceholderSubnet(node, globalCidr, addressKeys.indexOf(extraKey), 0),
                            }
                      }
                    />
                  );
                })}
              </>
            )}
          </div>
        );
      })}

      {[vmTrafficHint, storageHaHint, backupHint, corosyncHint]
        .filter((hint): hint is Hint => hint !== null)
        .map((hint, i) => (
          <div key={i} className={`pc-callout pc-callout--${hint.tone}`}>
            <span className="code pc-callout__glyph">{hint.glyph}</span>
            <div className="pc-callout__body">
              <p className="body-sm pc-callout__text">{hint.text}</p>
            </div>
          </div>
        ))}
    </>
  );
}

// the part of a node's network that MUST stay unique even when "identical
// network setup" is on: hostname, the management ip, and any bridge whose
// purpose needs a real per-node address. a pure vm/ct bridge's network
// isn't unique at all under "identical network setup" — it's configured
// once in NetworkStructureFields instead, so it's skipped here.
function NetworkAddressFields({
  keyPrefix,
  node,
  nodeIndex,
  hostnameSuffix,
  lanPrefix,
  globalCidr,
  placeholders,
  conflicts,
  onChange,
  onBridgeChange,
}: {
  keyPrefix: string;
  node: NodeInfo;
  // this node's position in the nodes list — every placeholder below is
  // offset by it, so the same bridge on a different node never suggests
  // the exact same address.
  nodeIndex: number;
  hostnameSuffix: string;
  lanPrefix: number;
  globalCidr: string;
  // one cluster-wide pass of ip/network suggestions (see
  // buildPlaceholderTable) — keeps a shared-purpose bridge's placeholder
  // consistent with whatever an earlier node already committed for it.
  placeholders: Map<string, PlaceholderSubnet>;
  // real address problems (see buildAddressConflicts) — an exact ip
  // reused anywhere, or two of this node's own claims overlapping.
  conflicts: Map<string, string>;
  onChange: (patch: Partial<NodeNetwork>) => void;
  onBridgeChange: (bridgeId: string, patch: Partial<BridgeConfig>) => void;
}) {
  const hostLabelError = validateHostLabel(node.network.hostLabel);
  const cidrError = validateCidr(node.network.cidr) ?? conflicts.get(`${nodeIndex}#mgmt`) ?? null;
  const mgmtBridgeKey = bridgeKey(node.network.managementInterfaceId, 0);
  const managementBridge = node.network.bridges[mgmtBridgeKey];
  const managementBridgeName = managementBridge?.name || "vmbr0";
  const managementCidrPlaceholder = deriveNodeCidr(globalCidr, nodeIndex) || "10.0.10.11/24";
  // every bridge except the management interface's own index-0 bridge —
  // that one's address is the "static ip" field above, not a field here.
  const addressableBridges = addressableBridgeKeys(node);

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

      <CidrField
        id={`nodecidr-${keyPrefix}`}
        label="static ip"
        usedFor={["management", ...(managementBridge?.purposes.map((p) => purposeInfoFor(p).label) ?? [])].join(", ")}
        value={node.network.cidr}
        onChange={(value) => onChange({ cidr: value })}
        placeholder={managementCidrPlaceholder}
        error={cidrError}
        hint={`for the web ui and ssh — assigned to the ${managementBridgeName} bridge, not the raw nic or bond`}
        defaultPrefix={lanPrefix}
      />

      {addressableBridges.map((key, position) => {
        const bridge = node.network.bridges[key];
        if (!bridge || !bridge.enabled) return null;
        const needsHostIp = needsHostIpForPurposes(bridge.purposes, bridge.otherNeedsHostIp);
        // NetworkAddressFields only ever renders under "identical network
        // setup" (its one caller), where a pure vm/ct bridge's network is
        // shared, shown once in NetworkStructureFields instead — showing
        // it again here, per node, would just invite re-typing the same
        // subnet on every node, or worse, drifting them apart.
        if (!needsHostIp) return null;
        const ipError = validateHostCidr(bridge.ip) ?? conflicts.get(`${nodeIndex}#${key}`) ?? null;
        const subnet = placeholders.get(`${nodeIndex}#${key}`) ?? nonCollidingPlaceholderSubnet(node, globalCidr, position, nodeIndex);
        return (
          <CidrField
            key={key}
            id={`bridgeip-${keyPrefix}-${key}`}
            label={`${bridge.name} — static ip for this node`}
            usedFor={purposesUsedForLabel(bridge.purposes)}
            value={bridge.ip}
            onChange={(value) => onBridgeChange(key, { ip: value })}
            placeholder={subnet?.host ?? "10.0.20.11/24"}
            error={ipError}
            hint={requiredIpHintFor(bridge.purposes, bridge.otherNeedsHostIp)}
            defaultPrefix={lanPrefix}
            required
          />
        );
      })}
    </>
  );
}

function NetworkFields({
  keyPrefix,
  node,
  nodeIndex,
  hostnameSuffix,
  lanPrefix,
  globalCidr,
  nodeCount,
  maxBonds,
  storageHaMode,
  storagePurpose,
  placeholders,
  conflicts,
  onChange,
  onBondCountChange,
  onToggleBondNic,
  onUpdateBondMeta,
  onManagementInterfaceChange,
  onBridgeChange,
  onBridgeCountChange,
}: {
  keyPrefix: string;
  node: NodeInfo;
  // this node's position in the nodes list — every ip placeholder below
  // is offset by it, so the same bridge on a different node never
  // suggests the exact same address.
  nodeIndex: number;
  hostnameSuffix: string;
  lanPrefix: number;
  // the homelab cidr set at the top of this step — used only to keep
  // example placeholder text in the fields below relevant to what the
  // visitor actually typed, instead of an unrelated hardcoded example.
  globalCidr: string;
  // drives the corosync warning below (only a cluster of 2+ has corosync
  // to worry about).
  nodeCount: number;
  maxBonds: number;
  // the visitor's raw choice above, before any disk-availability fallback
  // — only used to word the "why isn't ceph/zfs offered" hint correctly.
  storageHaMode: StorageHaMode;
  // the one storage purpose ("ceph" | "zfs" | null) the storage/ha
  // decision at the top of this step currently allows — drives which of
  // ceph/zfs (if either) is offered as a nic purpose, and is enforced
  // below via storageHaHintFor.
  storagePurpose: InterfacePurpose | null;
  // one cluster-wide pass of ip/network suggestions (see
  // buildPlaceholderTable) — keeps a shared-purpose bridge's placeholder
  // consistent with whatever an earlier node already committed for it.
  placeholders: Map<string, PlaceholderSubnet>;
  // real address problems (see buildAddressConflicts) — an exact ip
  // reused anywhere, or two of this node's own claims overlapping.
  conflicts: Map<string, string>;
  onChange: (patch: Partial<NodeNetwork>) => void;
  onBondCountChange: (value: string) => void;
  onToggleBondNic: (bondIndex: number, nicIndex: number, checked: boolean) => void;
  onUpdateBondMeta: (bondIndex: number, patch: Partial<Pick<BondConfig, "name" | "mode" | "vlanTag">>) => void;
  onManagementInterfaceChange: (interfaceId: string) => void;
  onBridgeChange: (bridgeId: string, patch: Partial<BridgeConfig>) => void;
  onBridgeCountChange: (interfaceId: string, value: string) => void;
}) {
  const hostLabelError = validateHostLabel(node.network.hostLabel);
  const cidrError = validateCidr(node.network.cidr) ?? conflicts.get(`${nodeIndex}#mgmt`) ?? null;
  const interfaces = interfacesFor(node.nics, node.network.bonds);
  const names = collectNodeNames(node);
  const mgmtBridgeKey = bridgeKey(node.network.managementInterfaceId, 0);
  const managementBridge = node.network.bridges[mgmtBridgeKey];
  const managementBridgeName = managementBridge?.name || "vmbr0";
  const managementBridgeNameError =
    validateInterfaceName(managementBridgeName) ?? validateUniqueName(managementBridgeName, names.interfaces);
  const purposeOptions = INTERFACE_PURPOSE_OPTIONS.filter(
    (opt) => (opt.value !== "ceph" && opt.value !== "zfs") || opt.value === storagePurpose,
  );
  const managementComboHint = purposeComboHint(managementBridge?.purposes ?? []);
  const managementCidrPlaceholder = deriveNodeCidr(globalCidr, nodeIndex) || "10.0.10.11/24";
  const addressKeys = addressableBridgeKeys(node);
  const vmTrafficHint = vmTrafficHintFor(node.network.bridges);
  const backupHint = backupHintFor(node.network.bridges);
  const corosyncHint = corosyncHintFor(node.network.bridges, nodeCount);
  const storageHaHint = storageHaHintFor(node.network.bridges, storagePurpose);
  const storagePurposeMissingHint = (
    <p className="body-sm pc-field__hint">
      {nodeCount < 2
        ? "ceph and zfs replication need at least 2 nodes for real redundancy — add another node to unlock a cluster storage option here"
        : storageHaMode === "none"
          ? 'you chose "no ha / sync" above — pick ceph or zfs with replication there to unlock a matching nic purpose here'
          : "ceph and zfs replication both need at least 1 disk beyond the boot disk on every node — add one in step 1, or the choice above falls back to \"no ha / sync\" until then"}
    </p>
  );

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
        maxBonds={maxBonds}
        onBondCountChange={onBondCountChange}
        onToggleBondNic={onToggleBondNic}
        onUpdateBondMeta={onUpdateBondMeta}
      />

      <div className="flex flex-col border border-border bg-surface-100 p-5" style={{ gap: "var(--space-3)" }}>
        <p className="label text-ink-muted">management</p>
        <CidrField
          id={`nodecidr-${keyPrefix}`}
          label="static ip"
          usedFor={["management", ...(managementBridge?.purposes.map((p) => purposeInfoFor(p).label) ?? [])].join(", ")}
          value={node.network.cidr}
          onChange={(value) => onChange({ cidr: value })}
          placeholder={managementCidrPlaceholder}
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
        <div className={`pc-field ${managementBridgeNameError ? "pc-field--error" : ""}`}>
          <label className="label pc-field__label" htmlFor={`mgmtbridge-${keyPrefix}`}>
            bridge name
            <span className="pc-field__required"> *</span>
          </label>
          <div className="pc-field__control">
            <span className="code pc-field__bracket">$</span>
            <input
              id={`mgmtbridge-${keyPrefix}`}
              className="pc-field__input code"
              type="text"
              value={managementBridge?.name ?? "vmbr0"}
              onChange={(e) => onBridgeChange(mgmtBridgeKey, { name: e.target.value })}
            />
          </div>
          <span className="body-sm pc-field__hint">
            {managementBridgeNameError ??
              "carries the management ip above and, by default, vm traffic too — vmbr0 is the proxmox convention, but you can rename it"}
          </span>
        </div>

        {managementBridge && (
          <>
            <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
              <legend className="label pc-radio-group__legend">also used for (pick as many as apply, or none)</legend>
              {purposeOptions
                .filter((opt) => opt.value !== "other")
                .map((opt) => {
                  const checked = managementBridge.purposes.includes(opt.value);
                  return (
                    <label key={opt.value} className="pc-checkbox">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const nextPurposes = e.target.checked
                            ? [...managementBridge.purposes, opt.value]
                            : managementBridge.purposes.filter((p) => p !== opt.value);
                          onBridgeChange(mgmtBridgeKey, { purposes: nextPurposes });
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
              {managementBridge.purposes.length === 0 && (
                <p className="body-sm pc-field__hint">
                  nothing checked — this bridge carries only the management ip above, no vm/container/backup/corosync
                  traffic
                </p>
              )}
              {storagePurpose === null && storagePurposeMissingHint}
            </fieldset>

            {managementComboHint && (
              <div className={`pc-callout pc-callout--${managementComboHint.tone}`}>
                <span className="code pc-callout__glyph">{managementComboHint.glyph}</span>
                <div className="pc-callout__body">
                  <p className="body-sm pc-callout__text">{managementComboHint.text}</p>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {interfaces.map((iface) => {
        const isManagement = iface.id === node.network.managementInterfaceId;
        const count = bridgeCountFor(node.network.bridgeCounts, iface.id);
        const bridge = node.network.bridges[bridgeKey(iface.id, 0)];
        // ceph/zfs get the whole bond — no extra vlan-tagged bridges to
        // split its bandwidth or latency budget with anything else.
        const isDedicatedStorageBond = iface.id.startsWith("bond-") && isDedicatedStorageBondPurpose(bridge?.purposes ?? []);

        return (
          <div key={iface.id} className="flex flex-col border border-border bg-surface-100 p-5" style={{ gap: "var(--space-3)" }}>
            <p className="label text-ink-muted">{iface.label}</p>

            {!isManagement &&
              bridge &&
              (() => {
                const needsHostIp = needsHostIpForPurposes(bridge.purposes, bridge.otherNeedsHostIp);
                const key0 = bridgeKey(iface.id, 0);
                const ipError =
                  (needsHostIp ? validateHostCidr(bridge.ip) : validateNetwork(bridge.ip)) ??
                  conflicts.get(`${nodeIndex}#${key0}`) ??
                  null;
                const bridgeNameError = validateInterfaceName(bridge.name) ?? validateUniqueName(bridge.name, names.interfaces);
                const comboHint = purposeComboHint(bridge.purposes);
                const cephSpeedHint = cephLinkSpeedHint(
                  bridge.purposes,
                  nicSpeedsForInterface(iface.id, node.nics, node.network.bonds),
                );
                return (
                  <>
                    <label className="pc-checkbox">
                      <input
                        type="checkbox"
                        checked={bridge.enabled}
                        onChange={(e) => onBridgeChange(key0, { enabled: e.target.checked })}
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
                                    onBridgeChange(key0, { purposes: nextPurposes });
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
                          {storagePurpose === null && storagePurposeMissingHint}
                        </fieldset>

                        {[comboHint, cephSpeedHint]
                          .filter((hint): hint is Hint => hint !== null)
                          .map((hint, i) => (
                            <div key={i} className={`pc-callout pc-callout--${hint.tone}`}>
                              <span className="code pc-callout__glyph">{hint.glyph}</span>
                              <div className="pc-callout__body">
                                <p className="body-sm pc-callout__text">{hint.text}</p>
                              </div>
                            </div>
                          ))}

                        {bridge.purposes.includes("other") && (
                          <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
                            <legend className="label pc-radio-group__legend">does this node need an address here?</legend>
                            <label className="pc-radio">
                              <input
                                type="radio"
                                name={`otherip-${keyPrefix}-${key0}`}
                                checked={bridge.otherNeedsHostIp}
                                onChange={() => onBridgeChange(key0, { otherNeedsHostIp: true })}
                              />
                              <span className="pc-radio__box" />
                              <span className="code pc-radio__label">yes — give it a static ip</span>
                            </label>
                            <label className="pc-radio">
                              <input
                                type="radio"
                                name={`otherip-${keyPrefix}-${key0}`}
                                checked={!bridge.otherNeedsHostIp}
                                onChange={() => onBridgeChange(key0, { otherNeedsHostIp: false })}
                              />
                              <span className="pc-radio__box" />
                              <span className="code pc-radio__label">no — it&apos;s just a switch for vms</span>
                            </label>
                          </fieldset>
                        )}

                        <div className={`pc-field ${bridgeNameError ? "pc-field--error" : ""}`}>
                          <label className="label pc-field__label" htmlFor={`bridge-${keyPrefix}-${key0}`}>
                            bridge name
                            <span className="pc-field__required"> *</span>
                          </label>
                          <div className="pc-field__control">
                            <span className="code pc-field__bracket">$</span>
                            <input
                              id={`bridge-${keyPrefix}-${key0}`}
                              className="pc-field__input code"
                              type="text"
                              value={bridge.name}
                              onChange={(e) => onBridgeChange(key0, { name: e.target.value })}
                            />
                          </div>
                          <span className="body-sm pc-field__hint">
                            {bridgeNameError ?? "shown in the proxmox ui and used in vm/ct network config"}
                          </span>
                        </div>

                        <CidrField
                          id={`bridgeip-${keyPrefix}-${key0}`}
                          label={needsHostIp ? "static ip for this node" : "network"}
                          usedFor={purposesUsedForLabel(bridge.purposes)}
                          value={bridge.ip}
                          onChange={(value) => onBridgeChange(key0, { ip: value })}
                          placeholder={(() => {
                            const subnet =
                              placeholders.get(`${nodeIndex}#${key0}`) ??
                              nonCollidingPlaceholderSubnet(node, globalCidr, addressKeys.indexOf(key0), nodeIndex);
                            return needsHostIp ? (subnet?.host ?? "10.0.20.11/24") : (subnet?.network ?? "10.0.20.0/24");
                          })()}
                          error={ipError}
                          hint={
                            needsHostIp
                              ? requiredIpHintFor(bridge.purposes, bridge.otherNeedsHostIp)
                              : "the subnet vms/cts on this bridge should use — the host itself still won't have an address here"
                          }
                          defaultPrefix={lanPrefix}
                          required
                        />
                      </>
                    )}
                  </>
                );
              })()}

            {isDedicatedStorageBond ? (
              <p className="body-sm pc-field__hint">
                bridges on this interface — locked to 1: {bridge?.purposes.includes("ceph") ? "ceph" : "zfs replication"} gets this
                bond to itself, so it can&apos;t be split into extra vlan-tagged bridges for anything else.
              </p>
            ) : (
              <>
                <BridgeCountField
                  keyPrefix={keyPrefix}
                  interfaceId={iface.id}
                  count={node.network.bridgeCounts[iface.id] ?? "1"}
                  onBridgeCountChange={onBridgeCountChange}
                />

                {Array.from({ length: Math.max(0, count - 1) }, (_, k) => k + 1).map((index) => {
                  const extraKey = bridgeKey(iface.id, index);
                  const extraBridge = node.network.bridges[extraKey];
                  if (!extraBridge) return null;
                  return (
                    <ExtraBridgeCard
                      key={extraKey}
                      keyPrefix={keyPrefix}
                      bridgeId={extraKey}
                      heading={`extra bridge (${extraBridge.name})`}
                      bridge={extraBridge}
                      siblingVlanTags={siblingVlanTagsFor(node.network.bridges, count, iface.id, index)}
                      names={names}
                      purposeOptions={purposeOptions}
                      storagePurpose={storagePurpose}
                      storagePurposeMissingHint={storagePurposeMissingHint}
                      nicSpeeds={nicSpeedsForInterface(iface.id, node.nics, node.network.bonds)}
                      onBridgeChange={onBridgeChange}
                      address={{
                        lanPrefix,
                        secondarySubnet:
                          placeholders.get(`${nodeIndex}#${extraKey}`) ??
                          nonCollidingPlaceholderSubnet(node, globalCidr, addressKeys.indexOf(extraKey), nodeIndex),
                      }}
                      conflictError={conflicts.get(`${nodeIndex}#${extraKey}`) ?? null}
                    />
                  );
                })}
              </>
            )}
          </div>
        );
      })}

      {[vmTrafficHint, storageHaHint, backupHint, corosyncHint]
        .filter((hint): hint is Hint => hint !== null)
        .map((hint, i) => (
          <div key={i} className={`pc-callout pc-callout--${hint.tone}`}>
            <span className="code pc-callout__glyph">{hint.glyph}</span>
            <div className="pc-callout__body">
              <p className="body-sm pc-callout__text">{hint.text}</p>
            </div>
          </div>
        ))}
    </>
  );
}

export default function Setup() {
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState<WizardStepId>("hardware");
  const [nodeCount, setNodeCount] = useState("1");
  const [hostnameSuffix, setHostnameSuffix] = useState("homelab.lan");
  const [globalCidr, setGlobalCidr] = useState("10.0.10.0/24");
  const [gateway, setGateway] = useState(() => deriveGateway("10.0.10.0/24"));
  const [homelabVlan, setHomelabVlan] = useState("");
  const [nodes, setNodes] = useState<NodeInfo[]>([defaultNode(0, "10.0.10.0/24")]);
  const [identicalHardware, setIdenticalHardware] = useState(false);
  const [identicalNetwork, setIdenticalNetwork] = useState(false);
  const [storageHaMode, setStorageHaMode] = useState<StorageHaMode>("ceph");
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
      setHomelabVlan(saved.homelabVlan);
      setNodes(saved.nodes);
      setIdenticalHardware(saved.identicalHardware);
      setIdenticalNetwork(saved.identicalNetwork);
      setStorageHaMode(saved.storageHaMode);
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
          homelabVlan,
          nodes,
          identicalHardware,
          identicalNetwork,
          storageHaMode,
        };
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch {
        // storage full, disabled, or unavailable — just skip persisting.
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [
    hydrated,
    currentStep,
    nodeCount,
    hostnameSuffix,
    globalCidr,
    gateway,
    homelabVlan,
    nodes,
    identicalHardware,
    identicalNetwork,
    storageHaMode,
  ]);

  const quorumHint = useMemo(() => quorumHintFor(nodes.length), [nodes.length]);
  const cpuHint = useMemo(() => cpuHintFor(nodes), [nodes]);
  const stepIndex = wizardSteps.findIndex((s) => s.id === currentStep);
  // the real subnet size for this homelab — used to fill in a sane
  // /prefix when a visitor types a bare ip with none, instead of /32.
  const lanPrefix = subnetDetails(globalCidr)?.prefix ?? 24;
  // see maxBondsForCluster — one node's bond-count ceiling can't exceed
  // what the least-equipped node in the cluster could ever host.
  const maxBonds = maxBondsForCluster(nodes);
  // one cluster-wide pass of ip/network suggestions for the network step
  // — recomputed whenever any node's network changes, so a shared-purpose
  // bridge's placeholder always reflects whatever an earlier node already
  // committed for it (see buildPlaceholderTable).
  const networkPlaceholders = useMemo(() => buildPlaceholderTable(nodes, globalCidr), [nodes, globalCidr]);
  // real (not placeholder) address problems: an exact ip reused anywhere,
  // or two of one node's own bridges/management ip whose ranges overlap.
  const addressConflicts = useMemo(() => buildAddressConflicts(nodes), [nodes]);
  const minDisks = useMemo(() => minAdditionalDisks(nodes), [nodes]);
  const clusterStorageAvailable = minDisks >= 1;
  const effectiveMode = useMemo(() => effectiveStorageHaMode(storageHaMode, nodes), [storageHaMode, nodes]);
  // nodes that couldn't carry ceph at a sane speed — drives the caveat on
  // the ceph option below. computed whatever the current choice is, so the
  // warning is visible before you pick it rather than after.
  const slowForCeph = useMemo(() => nodesWithoutFastNic(nodes), [nodes]);
  const storagePurpose = activeStoragePurpose(effectiveMode);

  // whenever the node count or the effective storage/ha decision changes
  // (including zfs silently losing its disks), drop any bridge purpose
  // that's no longer offered rather than leave it stuck in state with no
  // ui left to show or edit it. gated on hydrated for the same reason the
  // autosave effect is — otherwise this would run against the pre-restore
  // defaults and clobber whatever the restore is about to set.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!hydrated) return;
    const disallowed = (["ceph", "zfs"] as InterfacePurpose[]).filter((p) => p !== storagePurpose);
    setNodes((prev) => withoutPurposes(prev, disallowed));
  }, [hydrated, storagePurpose]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // every step switch (next/back, or the hydration restore landing on
  // whatever step was left off at) should start the visitor at the top of
  // that step's card, not wherever the previous step happened to be
  // scrolled to.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [currentStep]);

  function handleNodeCountChange(value: string) {
    setNodeCount(value);
    const n = parseInt(value, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= 16) {
      setNodes((prev) => resizeArray(prev, n, (i) => defaultNode(i, globalCidr)));
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

  function handleIdenticalNetworkChange(checked: boolean) {
    setIdenticalNetwork(checked);
    if (checked) {
      setNodes((prev) => (prev.length === 0 ? prev : applyNetworkStructure(prev, prev[0].network)));
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
        const clamped = !Number.isNaN(n) && n >= 1 && n <= MAX_NICS_PER_NODE ? n : node.nics.length;
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
        const clamped = !Number.isNaN(n) && n >= 1 && n <= MAX_NICS_PER_NODE ? n : node.nics.length;
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

  // when "identical network setup" is on, every structural change below
  // (bonds, management interface, bridge purposes/enabled/name, and a
  // pure vm/ct bridge's declared subnet) is mirrored onto every node right
  // after it's applied to the one actually edited — hostLabel, cidr, and
  // any real per-node static ip never go through this path, so those stay
  // unique regardless.
  function propagateIfIdentical(updated: NodeInfo[], sourceIndex: number): NodeInfo[] {
    return identicalNetwork ? applyNetworkStructure(updated, updated[sourceIndex].network) : updated;
  }

  function setManagementInterface(index: number, interfaceId: string) {
    setNodes((prev) => {
      const updated = prev.map((node, i) =>
        i === index
          ? { ...node, network: resyncNetworkForNics(node.network, node.nics.length, { managementInterfaceId: interfaceId }) }
          : node,
      );
      return propagateIfIdentical(updated, index);
    });
  }

  function updateBridge(index: number, interfaceId: string, patch: Partial<BridgeConfig>) {
    setNodes((prev) => {
      let updated = prev.map((node, i) =>
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
      );
      const editedBridge = updated[index].network.bridges[interfaceId];

      // ceph/zfs claim the whole bond (see isDedicatedStorageBondPurpose)
      // — the moment a bond's own native bridge picks up either purpose,
      // drop any extra vlan-tagged bridges it already had and lock the
      // count back to 1, rather than leaving them configured but now
      // forbidden to edit.
      const [ifaceId, bridgeIndex] = interfaceId.split("#");
      if (
        "purposes" in patch &&
        bridgeIndex === "0" &&
        ifaceId.startsWith("bond-") &&
        editedBridge &&
        isDedicatedStorageBondPurpose(editedBridge.purposes)
      ) {
        updated = updated.map((node, i) => {
          if (i !== index) return node;
          const currentCount = bridgeCountFor(node.network.bridgeCounts, ifaceId);
          if (currentCount <= 1) return node;
          const bridges = { ...node.network.bridges };
          for (let idx = 1; idx < currentCount; idx++) delete bridges[bridgeKey(ifaceId, idx)];
          return {
            ...node,
            network: { ...node.network, bridgeCounts: { ...node.network.bridgeCounts, [ifaceId]: "1" }, bridges },
          };
        });
      }

      // a real per-node static ip is always this node's own address —
      // never propagate that. but a pure vm/ct bridge's ip is just its
      // declared subnet, which IS shared structure (see
      // applyNetworkStructure), so an edit to it propagates same as a
      // purpose/name/enabled change would.
      const isStructural =
        "purposes" in patch ||
        "enabled" in patch ||
        "name" in patch ||
        "otherNeedsHostIp" in patch ||
        ("ip" in patch && !!editedBridge && !needsHostIpForPurposes(editedBridge.purposes, editedBridge.otherNeedsHostIp));
      return isStructural ? propagateIfIdentical(updated, index) : updated;
    });
  }

  // resizes just ONE interface's bridge count — deliberately narrower
  // than the resyncNetworkForNics-based handlers below: growing/shrinking
  // one interface's bridge count doesn't invalidate what any other
  // interface's bridges are configured as, so only this interface's own
  // slots are touched.
  function updateBridgeCount(index: number, interfaceId: string, value: string) {
    setNodes((prev) => {
      const updated = prev.map((node, i) => {
        if (i !== index) return node;
        // belt-and-suspenders alongside the UI hiding this control
        // entirely: a ceph/zfs bond never gets more than its one native
        // bridge, no matter what value comes in.
        const isDedicatedStorageBond =
          interfaceId.startsWith("bond-") &&
          isDedicatedStorageBondPurpose(node.network.bridges[bridgeKey(interfaceId, 0)]?.purposes ?? []);
        if (isDedicatedStorageBond) return node;
        const n = parseInt(value, 10);
        const clamped =
          !Number.isNaN(n) && n >= 1 && n <= MAX_BRIDGES_PER_INTERFACE
            ? n
            : bridgeCountFor(node.network.bridgeCounts, interfaceId);
        const bridges = { ...node.network.bridges };
        for (let idx = 0; idx < MAX_BRIDGES_PER_INTERFACE; idx++) {
          const key = bridgeKey(interfaceId, idx);
          if (idx < clamped && !bridges[key]) {
            bridges[key] = {
              enabled: true,
              name: nextVmbrName(bridges),
              purposes: ["vm"],
              otherNeedsHostIp: false,
              ip: "",
              vlanTag: "",
            };
          } else if (idx >= clamped && bridges[key]) {
            delete bridges[key];
          }
        }
        return {
          ...node,
          network: {
            ...node.network,
            bridgeCounts: { ...node.network.bridgeCounts, [interfaceId]: String(clamped) },
            bridges,
          },
        };
      });
      return propagateIfIdentical(updated, index);
    });
  }

  function handleBondCountChange(index: number, value: string) {
    const n = parseInt(value, 10);
    setNodes((prev) => {
      // read off prev, not the maxBonds already in scope — this always
      // has to reflect the nic counts as they stand right now, not
      // whatever they were on the last render.
      const cap = maxBondsForCluster(prev);
      const updated = prev.map((node, i) => {
        if (i !== index) return node;
        const clamped = !Number.isNaN(n) && n >= 0 && n <= cap ? n : node.network.bonds.length;
        const bonds = resizeArray(node.network.bonds, clamped, (idx) => ({
          name: defaultBondName(idx),
          mode: "active-backup" as BondMode,
          nicIndices: [],
          vlanTag: "",
        }));
        return { ...node, network: resyncNetworkForNics(node.network, node.nics.length, { bonds }) };
      });
      return propagateIfIdentical(updated, index);
    });
  }

  function toggleBondNic(index: number, bondIndex: number, nicIndex: number, checked: boolean) {
    setNodes((prev) => {
      const updated = prev.map((node, i) => {
        if (i !== index) return node;
        const bonds = node.network.bonds.map((b, j) => {
          if (j !== bondIndex) return b;
          const nicIndices = checked
            ? [...b.nicIndices, nicIndex].sort((a, b2) => a - b2)
            : b.nicIndices.filter((idx) => idx !== nicIndex);
          return { ...b, nicIndices };
        });
        return { ...node, network: resyncNetworkForNics(node.network, node.nics.length, { bonds }) };
      });
      return propagateIfIdentical(updated, index);
    });
  }

  function updateBondMeta(index: number, bondIndex: number, patch: Partial<Pick<BondConfig, "name" | "mode" | "vlanTag">>) {
    setNodes((prev) => {
      const updated = prev.map((node, i) => {
        if (i !== index) return node;
        // name/mode/vlanTag never change which interfaces exist, so patch
        // bonds directly rather than going through the full resync — that
        // would otherwise wipe out bridge customizations for no reason.
        const bonds = node.network.bonds.map((b, j) => (j === bondIndex ? { ...b, ...patch } : b));
        return { ...node, network: { ...node.network, bonds } };
      });
      return propagateIfIdentical(updated, index);
    });
  }

  const nodeCountError = validateIntRange(nodeCount, 1, 16, { required: true });
  const hostnameSuffixError = validateHostnameSuffix(hostnameSuffix);
  const globalCidrError = validateCidr(globalCidr);
  const homelabVlanError = validateOptionalVlanTag(homelabVlan);
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
                <div className={`pc-field ${nodeCountError ? "pc-field--error" : ""}`}>
                  <label className="label pc-field__label" htmlFor="node-count">
                    number of nodes
                    <span className="pc-field__required"> *</span>
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
                  <span className="body-sm pc-field__hint">{nodeCountError ?? "1–16 physical hosts"}</span>
                </div>

                <div className={`pc-callout pc-callout--${quorumHint.tone}`}>
                  <span className="code pc-callout__glyph">{quorumHint.glyph}</span>
                  <div className="pc-callout__body">
                    <p className="body pc-callout__text">{quorumHint.text}</p>
                  </div>
                </div>

                {nodes.length > 1 && (
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
                )}

                {identicalHardware && nodes.length > 1 && (
                  <div
                    className="flex flex-col border border-border bg-surface-100 p-5"
                    style={{ gap: "var(--space-5)" }}
                  >
                    <p className="label text-ink-muted">hardware — all nodes</p>
                    <HardwareFields
                      keyPrefix="shared"
                      values={nodes[0]}
                      names={collectNodeNames(nodes[0])}
                      onChange={updateAllNodesHardware}
                      onNicCountChange={updateAllNodesNicCount}
                      onNicChange={updateAllNodesNic}
                      onAdditionalDiskCountChange={updateAllNodesAdditionalDiskCount}
                      onAdditionalDiskChange={updateAllNodesAdditionalDisk}
                    />
                  </div>
                )}

                {nodes.map((node, i) => {
                  const nameError = validateHostLabel(node.name);

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

                      {(!identicalHardware || nodes.length <= 1) && (
                        <HardwareFields
                          keyPrefix={`node-${i}`}
                          values={node}
                          names={collectNodeNames(node)}
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
                <button
                  type="button"
                  className="pc-btn pc-btn--primary"
                  onClick={() => router.push("/setup/preview/hardware")}
                >
                  <span className="pc-btn__bracket">[</span>
                  preview
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
                      placeholder="e.g. homelab.lan"
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

                <div className={`pc-field ${homelabVlanError ? "pc-field--error" : ""}`}>
                  <label className="label pc-field__label" htmlFor="homelab-vlan">
                    main homelab vlan
                  </label>
                  <div className="pc-field__control">
                    <span className="code pc-field__bracket">#</span>
                    <input
                      id="homelab-vlan"
                      className="pc-field__input code"
                      type="number"
                      min={1}
                      max={4094}
                      placeholder="e.g. 10"
                      value={homelabVlan}
                      onChange={(e) => setHomelabVlan(e.target.value)}
                    />
                  </div>
                  <span className="body-sm pc-field__hint">
                    {homelabVlanError ??
                      "only if your switch numbers the untagged network — leave blank for a flat, unnumbered homelab"}
                  </span>
                </div>

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
                      placeholder={`e.g. ${deriveGateway(globalCidr) || "10.0.10.1"}`}
                      value={gateway}
                      onChange={(e) => setGateway(e.target.value)}
                    />
                  </div>
                  <span className="body-sm pc-field__hint">
                    {gatewayError ?? "default route for every node — usually your router or firewall"}
                  </span>
                </div>

                {nodes.length > 1 && (
                  <label className="pc-checkbox">
                    <input
                      type="checkbox"
                      checked={identicalNetwork}
                      onChange={(e) => handleIdenticalNetworkChange(e.target.checked)}
                    />
                    <span className="pc-checkbox__box" />
                    <span>
                      <span className="code pc-checkbox__label">identical network setup across all nodes</span>
                      <span className="body-sm pc-checkbox__hint">
                        keeps bonds, the management interface choice, and every bridge&apos;s purpose/name in sync — each
                        node still gets its own hostname and ip addresses
                      </span>
                    </span>
                  </label>
                )}

                {nodes.length > 1 && (
                  <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
                    <legend className="label pc-radio-group__legend">cluster storage</legend>
                    {STORAGE_HA_OPTIONS.filter((opt) => opt.value === "none" || clusterStorageAvailable).map((opt) => {
                      // only ceph gets a speed caveat here: zfs replication
                      // ships a scheduled snapshot stream and tolerates a
                      // slow link by just taking longer, where ceph puts the
                      // link in the path of every synchronous write.
                      const flagSlow = opt.value === "ceph" && slowForCeph.length > 0;
                      return (
                        <label key={opt.value} className="pc-radio">
                          <input
                            type="radio"
                            name="storage-ha-mode"
                            checked={effectiveMode === opt.value}
                            onChange={() => setStorageHaMode(opt.value)}
                          />
                          <span className="pc-radio__box" />
                          <span>
                            <span className="code pc-radio__label">
                              {opt.label}
                              {flagSlow && <span className="pc-radio__warnmark">⚠</span>}
                            </span>
                            <span className="body-sm pc-checkbox__hint">{opt.hint}</span>
                            {flagSlow && (
                              <span className="body-sm pc-radio__warntext">
                                ⚠ no 10 gbe (or faster) nic on{" "}
                                {slowForCeph.length === nodes.length
                                  ? "any node"
                                  : slowForCeph.map((n) => n.network.hostLabel || n.name).join(", ")}
                                . ceph acknowledges a write only once the other nodes have it, so the
                                slowest node&apos;s link sets the disk latency every vm in the cluster
                                sees — add a 10 gbe nic in step 1, or choose zfs with replication
                                instead.
                              </span>
                            )}
                          </span>
                        </label>
                      );
                    })}
                    {!clusterStorageAvailable && (
                      <p className="body-sm pc-field__hint">
                        ceph and zfs replication both need at least 1 disk beyond the boot disk on every node — your worst-equipped node currently has {minDisks}, so it sets the limit for the whole cluster. add one in step 1 to unlock either option here
                      </p>
                    )}
                    {/* ceph's requirements scale with the number of osds you
                        end up running, which this wizard can't know yet — so
                        rather than restate a snapshot of them, point at the
                        source and let it stay current. */}
                    {effectiveMode === "ceph" && (
                      <div className="pc-callout pc-callout--info">
                        <span className="code pc-callout__glyph">#</span>
                        <div className="pc-callout__body">
                          <p className="body-sm pc-callout__text">
                            Worth cross-checking your hardware against ceph&apos;s own
                            guidance before you commit — cpu and ram scale per osd, not
                            per node, so the numbers move as you add disks:{" "}
                            <a
                              className="pc-link"
                              href="https://docs.ceph.com/en/reef/start/hardware-recommendations/"
                              target="_blank"
                              rel="noreferrer"
                            >
                              ceph hardware recommendations ↗
                            </a>
                          </p>
                        </div>
                      </div>
                    )}
                  </fieldset>
                )}

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

                {identicalNetwork && nodes.length > 1 && (
                  <div
                    className="flex flex-col border border-border bg-surface-100 p-5"
                    style={{ gap: "var(--space-5)" }}
                  >
                    <p className="label text-ink-muted">network structure — all nodes</p>
                    <NetworkStructureFields
                      keyPrefix="shared"
                      node={nodes[0]}
                      nodeCount={nodes.length}
                      maxBonds={maxBonds}
                      storageHaMode={storageHaMode}
                      storagePurpose={storagePurpose}
                      globalCidr={globalCidr}
                      lanPrefix={lanPrefix}
                      placeholders={networkPlaceholders}
                      onBondCountChange={(value) => handleBondCountChange(0, value)}
                      onToggleBondNic={(bondIndex, nicIndex, checked) => toggleBondNic(0, bondIndex, nicIndex, checked)}
                      onUpdateBondMeta={(bondIndex, patch) => updateBondMeta(0, bondIndex, patch)}
                      onManagementInterfaceChange={(interfaceId) => setManagementInterface(0, interfaceId)}
                      onBridgeChange={(bridgeId, patch) => updateBridge(0, bridgeId, patch)}
                      onBridgeCountChange={(interfaceId, value) => updateBridgeCount(0, interfaceId, value)}
                    />
                  </div>
                )}

                {nodes.map((node, i) => (
                  <div
                    key={i}
                    className="flex flex-col border border-border bg-surface-100 p-5"
                    style={{ gap: "var(--space-5)" }}
                  >
                    <p className="label text-ink-muted">
                      node {String(i + 1).padStart(2, "0")} — {node.name}
                    </p>
                    {identicalNetwork && nodes.length > 1 ? (
                      <NetworkAddressFields
                        keyPrefix={`node-${i}`}
                        node={node}
                        nodeIndex={i}
                        hostnameSuffix={hostnameSuffix}
                        lanPrefix={lanPrefix}
                        globalCidr={globalCidr}
                        placeholders={networkPlaceholders}
                        conflicts={addressConflicts}
                        onChange={(patch) => updateNodeNetwork(i, patch)}
                        onBridgeChange={(bridgeId, patch) => updateBridge(i, bridgeId, patch)}
                      />
                    ) : (
                      <NetworkFields
                        keyPrefix={`node-${i}`}
                        node={node}
                        nodeIndex={i}
                        hostnameSuffix={hostnameSuffix}
                        lanPrefix={lanPrefix}
                        globalCidr={globalCidr}
                        nodeCount={nodes.length}
                        maxBonds={maxBonds}
                        storageHaMode={storageHaMode}
                        storagePurpose={storagePurpose}
                        placeholders={networkPlaceholders}
                        conflicts={addressConflicts}
                        onChange={(patch) => updateNodeNetwork(i, patch)}
                        onBondCountChange={(value) => handleBondCountChange(i, value)}
                        onToggleBondNic={(bondIndex, nicIndex, checked) => toggleBondNic(i, bondIndex, nicIndex, checked)}
                        onUpdateBondMeta={(bondIndex, patch) => updateBondMeta(i, bondIndex, patch)}
                        onManagementInterfaceChange={(interfaceId) => setManagementInterface(i, interfaceId)}
                        onBridgeChange={(bridgeId, patch) => updateBridge(i, bridgeId, patch)}
                        onBridgeCountChange={(interfaceId, value) => updateBridgeCount(i, interfaceId, value)}
                      />
                    )}
                  </div>
                ))}
              </div>

              <div className="pc-stepflow__nav">
                <button type="button" className="pc-btn" onClick={() => setCurrentStep("hardware")}>
                  <span className="pc-btn__bracket">[</span>
                  back
                  <span className="pc-btn__bracket">]</span>
                </button>
                <button
                  type="button"
                  className="pc-btn pc-btn--primary"
                  onClick={() => router.push("/setup/preview/network")}
                >
                  <span className="pc-btn__bracket">[</span>
                  preview
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
