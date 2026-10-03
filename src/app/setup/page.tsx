"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useContext, useEffect, useMemo, useState } from "react";
import wizardSteps from "@/data/wizard-steps.json";
import {
  BOND_MODE_OPTIONS,
  bridgeCountFor,
  interfaceNameFor,
  isStorageLink,
  isStoragePurpose,
  bridgeKey,
  interfacesFor,
  MAX_BRIDGES_PER_INTERFACE,
  MAX_NICS_PER_NODE,
  NIC_PORT_LABEL,
  effectivePort,
  portChoices,
  portHint,
  needsHostIpForPurposes,
  nicSpeedLabel,
  nicSpeedsForInterface,
  nicSpeedOptions,
  PURPOSE_NEEDS_HOST_IP,
  STORAGE_VERSION,
  STEP_VERSIONS,
  type AdditionalDisk,
  type BondConfig,
  type BondMode,
  type BridgeConfig,
  type DiskRole,
  type DiskType,
  type HardwareSpec,
  type InterfacePurpose,
  type NicInfo,
  type NicSpeed,
  type InstallPlan,
  type NodeInfo,
  type NodeNetwork,
  type PersistedState,
  type ClusterStorage,
  type StorageMode,
  enabledStorageModes,
  type BackupPlan,
  type AccessPlan,
  type OidcPlan,
  type StoragePlan,
  type WizardStepId,
} from "./wizard-state";
import { freshState, loadSaved, savePersistedState, startedOverNotice } from "./saved-state";
import {
  cephDiskTypeHint,
  cephRawWithoutLargestNodeGb,
  cephReplicaHint,
  cephUsableGb,
  diskRoleOptions,
  disksWithRole,
  formatGb,
  hasLocalDisks,
  LOCAL_STORAGE_OPTIONS,
  MAX_CEPH_REPLICAS,
  minReplicaChoices,
  replicaChoices,
  effectiveCephPlan,
  soleDiskMode,
  withEffectiveDiskRoles,
  effectiveRaidLevel,
  minPoolMembers,
  mixedDiskSizeHint,
  raidLevelChoices,
  nodesWithoutZfsRedundancy,
  poolMembershipHint,
  replicationWindowHint,
  totalGb,
  validatePoolName,
  zfsLayoutHint,
  zfsUsableGb,
  ZFS_RAID_OPTIONS,
} from "./storage";
import { problemsUpTo } from "./step-checks";
import {
  BACKUP_TARGET_OPTIONS,
  RETENTION_FIELDS,
  backupNicHint,
  backupSizeHint,
  maxGuestDataGb,
  encryptionHint,
  maxBackupsKept,
  noBackupHint,
  offsiteHint,
  retentionHint,
  retentionReach,
  sameHardwareHint,
  usesPbs,
  validateExportPath,
  validateHostAddress,
  validateRetention,
  validateScheduleTime,
} from "./backups";
import { ProblemList } from "./problem-list";
import {
  MIN_ROOT_PASSWORD,
  USERNAME_CLAIM_OPTIONS,
  generatePassword,
  oidcRedirectUris,
  parseSshPublicKey,
  passwordSshHint,
  rootPasswordFor,
  sharedRootPasswordHint,
  sshKeyLines,
  validateClientId,
  validateIssuerUrl,
  validateRealm,
  validateRootPassword,
  validateSshKeys,
  type SshPublicKey,
} from "./access";
import { VaultGate } from "./vault-gate";
import { CheckedTextField, CidrField, RevealErrorsContext } from "./form-fields";
import { InstallGuide } from "./install-guide";
import { MeterBar } from "./meter-bar";
import { bootDiskMeter, cephMeter, localMeter, memoryMeter, zfsMeter } from "./capacity";
import {
  haQuorumHint,
  isKubernetesNode,
  memoryHint,
  newGuest,
  nodeLoads,
  storageHint,
  storageUse,
  type GuestPlan,
  type SoftwarePlan,
} from "./software";
import { GuestCard } from "./guest-card";
import { applyK8sLayout, cephReachHint, currentK8sLayout, type K8sLayout } from "./kubernetes";
import { KubernetesPlanner, KubernetesStorage } from "./kubernetes-panel";
import {
  COUNTRY_OPTIONS,
  KEYBOARD_OPTIONS,
  detectLocation,
  timezoneOptions,
  type LocationPlan,
} from "./location";
import {
  subnetDetails,
  validateCidr,
  validateFriendlyName,
  validateHostCidr,
  validateHostLabel,
  validateHostnameSuffix,
  validateIntRange,
  validateInterfaceName,
  required,
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
  activeStoragePurposes,
  addressableBridgeKeys,
  applyNetworkStructure,
  buildAddressConflicts,
  buildPlaceholderTable,
  collectNodeNames,
  defaultAdditionalDisk,
  defaultBondName,
  defaultNic,
  deriveGateway,
  followGateway,
  deriveNodeCidr,
  effectiveClusterStorage,
  enforceStorageLinks,
  maxBondsForCluster,
  minAdditionalDisks,
  nextVmbrName,
  nonCollidingPlaceholderSubnet,
  resizeArray,
  resyncNetworkForNics,
  siblingVlanTagsFor,
  withoutPurposes,
  withHardwareOf,
  resizeNodes,
  applyStorageRoles,
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

// independent switches, not alternatives — see ClusterStorage
const CLUSTER_STORAGE_OPTIONS: { value: StorageMode; label: string; hint: string }[] = [
  {
    value: "ceph",
    label: "ceph (recommended)",
    hint: "distributed storage built into proxmox — vm disks live on every node, live-migrate freely, survive a node going down",
  },
  {
    value: "zfs",
    label: "zfs with replication",
    hint: "local zfs storage per node, periodically synced to the others — cheaper and simpler than ceph, but replication is scheduled, not instant, so a failover can lose a few minutes of writes. alongside ceph, a second copy of what matters — for backups, say",
  },
];













































































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
  const reveal = useContext(RevealErrorsContext);
  const showRamGbError = (sizeTouched.ram || reveal) && ramGbError;
  const showBootDiskSizeError = (sizeTouched.boot || reveal) && bootDiskSizeError;

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
        const showDiskSizeError = (sizeTouched[`disk-${j}`] || reveal) && diskSizeError;
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
            {/* asked only when the speed leaves a real choice — 10 gbe is
                sfp+ or rj45, 2.5 gbe is only ever rj45 */}
            {portChoices(nic.speed).length > 1 && (
              <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
                <legend className="label pc-radio-group__legend">connector</legend>
                {portChoices(nic.speed).map((port) => (
                  <label key={port} className="pc-radio">
                    <input
                      type="radio"
                      name={`nicport-${keyPrefix}-${j}`}
                      checked={effectivePort(nic) === port}
                      onChange={() => onNicChange(j, { port })}
                    />
                    <span className="pc-radio__box" />
                    <span>
                      <span className="code pc-radio__label">{NIC_PORT_LABEL[port]}</span>
                      <span className="body-sm pc-checkbox__hint">{portHint(nic.speed, port)}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
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
  const validateBondCount = (value: string) => validateIntRange(value, 0, maxBonds, { required: true });
  const bondCountField = useDraftCount(
    node.network.bondCount,
    (value) => !validateBondCount(value),
    onBondCountChange,
  );
  const bondCountError = validateBondCount(bondCountField.value);
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
            value={bondCountField.value}
            onChange={(e) => bondCountField.onChange(e.target.value)}
            onBlur={bondCountField.onBlur}
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
  // bridge purposes only — ceph and zfs never ride an extra bridge
  purposeOptions: PurposeInfo[];
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
  const reveal = useContext(RevealErrorsContext);
  const showVlanError = (vlanTouched || reveal) && vlanError;

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
          host={needsHostIp}
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

/**
 * A count field whose committed value must always be valid, but which
 * still has to be editable: emptying a field and typing a new number is
 * how most people change it. The input shows its own draft; only a valid
 * draft is committed, and leaving the field with an invalid one snaps it
 * back to the committed value.
 *
 * Without this, the handler rewrote the field mid-edit — clearing "1"
 * left it at "1", so typing "2" produced "12" and twelve bridges.
 */
function useDraftCount(committed: string, isValid: (value: string) => boolean, commit: (value: string) => void) {
  const [draft, setDraft] = useState(committed);
  const [seen, setSeen] = useState(committed);
  // follow the committed value when it changes from outside (a sibling
  // node under "identical network", a resync after a nic count change) —
  // React's documented way to derive state from a changed prop
  if (committed !== seen) {
    setSeen(committed);
    setDraft(committed);
  }
  return {
    value: draft,
    onChange: (value: string) => {
      setDraft(value);
      if (isValid(value)) commit(value);
    },
    onBlur: () => {
      if (!isValid(draft)) setDraft(committed);
    },
  };
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
  const validate = (value: string) => validateIntRange(value, 1, MAX_BRIDGES_PER_INTERFACE, { required: true });
  const field = useDraftCount(count, (value) => !validate(value), (value) => onBridgeCountChange(interfaceId, value));
  const error = validate(field.value);
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
          value={field.value}
          onChange={(e) => field.onChange(e.target.value)}
          onBlur={field.onBlur}
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
  anyStorageChosen,
  storagePurposes,
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
  // whether ceph or zfs is ticked at all — only words the hint below
  anyStorageChosen: boolean;
  storagePurposes: InterfacePurpose[];
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
    (opt) => (opt.value !== "ceph" && opt.value !== "zfs") || storagePurposes.includes(opt.value),
  );
  // off the management interface these never mix: ceph and zfs make an
  // interface a storage link, everything else rides a bridge
  const storageOptions = purposeOptions.filter((opt) => isStoragePurpose(opt.value));
  const bridgeOptions = purposeOptions.filter((opt) => !isStoragePurpose(opt.value));
  const managementComboHint = purposeComboHint(managementBridge?.purposes ?? []);
  const vmTrafficHint = vmTrafficHintFor(node.network.bridges);
  const backupHint = backupHintFor(node.network.bridges);
  const corosyncHint = corosyncHintFor(node.network.bridges, nodeCount);
  // one per enabled mode: each needs its own nic on every node
  const storageHaHints = storagePurposes.map((purpose) => storageHaHintFor(node.network.bridges, purpose));
  const storagePurposeMissingHint = (
    <p className="body-sm pc-field__hint">
      {nodeCount < 2
        ? "ceph and zfs replication need at least 2 nodes for real redundancy — add another node to unlock a cluster storage option here"
        : !anyStorageChosen
          ? "neither ceph nor zfs replication is ticked above — tick one there to unlock its nic purpose here"
          : "ceph and zfs replication both need at least 1 disk beyond the boot disk on every node — add one in step 2 to unlock the storage you ticked"}
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
              {storagePurposes.length === 0 && storagePurposeMissingHint}
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
        // ceph/zfs here make it a storage link: the address goes on the
        // nic or bond itself — no bridge, and nothing else shares it
        const storageLink = isStorageLink(node.network, bridgeKey(iface.id, 0));
        const ifaceName = interfaceNameFor(iface.id, node.nics, node.network.bonds);

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
                        <span className="code pc-checkbox__label">use this interface</span>
                        <span className="body-sm pc-checkbox__hint">
                          for vm bridges, or as a storage link — leave unchecked to keep it unused for now
                        </span>
                      </span>
                    </label>
                    {bridge.enabled && (
                      <>
                        {storageOptions.length > 0 && (
                          <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
                            <legend className="label pc-radio-group__legend">carries</legend>
                            <label className="pc-radio">
                              <input
                                type="radio"
                                name={`carries-${keyPrefix}-${key0}`}
                                checked={!storageLink}
                                onChange={() => onBridgeChange(key0, { purposes: ["vm"] })}
                              />
                              <span className="pc-radio__box" />
                              <span>
                                <span className="code pc-radio__label">vm bridges</span>
                                <span className="body-sm pc-checkbox__hint">
                                  linux bridges for vms and cts, backups or corosync — split into vlan-tagged bridges
                                  if it needs more than one
                                </span>
                              </span>
                            </label>
                            <label className="pc-radio">
                              <input
                                type="radio"
                                name={`carries-${keyPrefix}-${key0}`}
                                checked={storageLink}
                                onChange={() => onBridgeChange(key0, { purposes: [storageOptions[0].value] })}
                              />
                              <span className="pc-radio__box" />
                              <span>
                                <span className="code pc-radio__label">a storage link — ceph / zfs</span>
                                <span className="body-sm pc-checkbox__hint">
                                  no bridge: this node&apos;s storage address goes straight onto {ifaceName}, and
                                  nothing else shares the link — no vm ever joins storage traffic
                                </span>
                              </span>
                            </label>
                          </fieldset>
                        )}
                        <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
                          <legend className="label pc-radio-group__legend">used for (pick as many as apply)</legend>
                          {(storageLink ? storageOptions : bridgeOptions).map((opt) => {
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
                          {storagePurposes.length === 0 && storagePurposeMissingHint}
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

                        {storageLink ? (
                          <p className="body-sm pc-field__hint">
                            no bridge name — {ifaceName} carries the address itself
                          </p>
                        ) : (
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
                        )}

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

            {storageLink ? (
              <p className="body-sm pc-field__hint">
                no vlan-tagged bridges here — a storage link has no bridge to split, and{" "}
                {bridge?.purposes.includes("ceph") ? "ceph" : "zfs replication"} gets {ifaceName} to itself.
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
                      purposeOptions={bridgeOptions}
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

      {[vmTrafficHint, ...storageHaHints, backupHint, corosyncHint]
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
  const cidrError = validateHostCidr(node.network.cidr) ?? conflicts.get(`${nodeIndex}#mgmt`) ?? null;
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
        host
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
            label={`${
              isStorageLink(node.network, key)
                ? interfaceNameFor(key.split("#")[0], node.nics, node.network.bonds)
                : bridge.name
            } — static ip for this node`}
            host
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
  anyStorageChosen,
  storagePurposes,
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
  // whether ceph or zfs is ticked at all, before any disk-availability
  // fallback — only words the "why isn't ceph/zfs offered" hint
  anyStorageChosen: boolean;
  // the storage purposes the cluster storage at the top of this step
  // currently allows — each is offered as a nic purpose, and required on
  // every node via storageHaHintFor
  storagePurposes: InterfacePurpose[];
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
  const cidrError = validateHostCidr(node.network.cidr) ?? conflicts.get(`${nodeIndex}#mgmt`) ?? null;
  const interfaces = interfacesFor(node.nics, node.network.bonds);
  const names = collectNodeNames(node);
  const mgmtBridgeKey = bridgeKey(node.network.managementInterfaceId, 0);
  const managementBridge = node.network.bridges[mgmtBridgeKey];
  const managementBridgeName = managementBridge?.name || "vmbr0";
  const managementBridgeNameError =
    validateInterfaceName(managementBridgeName) ?? validateUniqueName(managementBridgeName, names.interfaces);
  const purposeOptions = INTERFACE_PURPOSE_OPTIONS.filter(
    (opt) => (opt.value !== "ceph" && opt.value !== "zfs") || storagePurposes.includes(opt.value),
  );
  // off the management interface these never mix: ceph and zfs make an
  // interface a storage link, everything else rides a bridge
  const storageOptions = purposeOptions.filter((opt) => isStoragePurpose(opt.value));
  const bridgeOptions = purposeOptions.filter((opt) => !isStoragePurpose(opt.value));
  const managementComboHint = purposeComboHint(managementBridge?.purposes ?? []);
  const managementCidrPlaceholder = deriveNodeCidr(globalCidr, nodeIndex) || "10.0.10.11/24";
  const addressKeys = addressableBridgeKeys(node);
  const vmTrafficHint = vmTrafficHintFor(node.network.bridges);
  const backupHint = backupHintFor(node.network.bridges);
  const corosyncHint = corosyncHintFor(node.network.bridges, nodeCount);
  // one per enabled mode: each needs its own nic on every node
  const storageHaHints = storagePurposes.map((purpose) => storageHaHintFor(node.network.bridges, purpose));
  const storagePurposeMissingHint = (
    <p className="body-sm pc-field__hint">
      {nodeCount < 2
        ? "ceph and zfs replication need at least 2 nodes for real redundancy — add another node to unlock a cluster storage option here"
        : !anyStorageChosen
          ? "neither ceph nor zfs replication is ticked above — tick one there to unlock its nic purpose here"
          : "ceph and zfs replication both need at least 1 disk beyond the boot disk on every node — add one in step 2 to unlock the storage you ticked"}
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
          host
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
              {storagePurposes.length === 0 && storagePurposeMissingHint}
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
        // ceph/zfs here make it a storage link: the address goes on the
        // nic or bond itself — no bridge, and nothing else shares it
        const storageLink = isStorageLink(node.network, bridgeKey(iface.id, 0));
        const ifaceName = interfaceNameFor(iface.id, node.nics, node.network.bonds);

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
                        <span className="code pc-checkbox__label">use this interface</span>
                        <span className="body-sm pc-checkbox__hint">
                          for vm bridges, or as a storage link — leave unchecked to keep it unused for now
                        </span>
                      </span>
                    </label>
                    {bridge.enabled && (
                      <>
                        {storageOptions.length > 0 && (
                          <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
                            <legend className="label pc-radio-group__legend">carries</legend>
                            <label className="pc-radio">
                              <input
                                type="radio"
                                name={`carries-${keyPrefix}-${key0}`}
                                checked={!storageLink}
                                onChange={() => onBridgeChange(key0, { purposes: ["vm"] })}
                              />
                              <span className="pc-radio__box" />
                              <span>
                                <span className="code pc-radio__label">vm bridges</span>
                                <span className="body-sm pc-checkbox__hint">
                                  linux bridges for vms and cts, backups or corosync — split into vlan-tagged bridges
                                  if it needs more than one
                                </span>
                              </span>
                            </label>
                            <label className="pc-radio">
                              <input
                                type="radio"
                                name={`carries-${keyPrefix}-${key0}`}
                                checked={storageLink}
                                onChange={() => onBridgeChange(key0, { purposes: [storageOptions[0].value] })}
                              />
                              <span className="pc-radio__box" />
                              <span>
                                <span className="code pc-radio__label">a storage link — ceph / zfs</span>
                                <span className="body-sm pc-checkbox__hint">
                                  no bridge: this node&apos;s storage address goes straight onto {ifaceName}, and
                                  nothing else shares the link — no vm ever joins storage traffic
                                </span>
                              </span>
                            </label>
                          </fieldset>
                        )}
                        <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
                          <legend className="label pc-radio-group__legend">used for (pick as many as apply)</legend>
                          {(storageLink ? storageOptions : bridgeOptions).map((opt) => {
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
                          {storagePurposes.length === 0 && storagePurposeMissingHint}
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

                        {storageLink ? (
                          <p className="body-sm pc-field__hint">
                            no bridge name — {ifaceName} carries the address itself
                          </p>
                        ) : (
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
                        )}

                        <CidrField
                          id={`bridgeip-${keyPrefix}-${key0}`}
                          label={needsHostIp ? "static ip for this node" : "network"}
                          host={needsHostIp}
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
                            storageLink
                              ? `${requiredIpHintFor(bridge.purposes, bridge.otherNeedsHostIp)} — set directly on ${ifaceName}`
                              : needsHostIp
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

            {storageLink ? (
              <p className="body-sm pc-field__hint">
                no vlan-tagged bridges here — a storage link has no bridge to split, and{" "}
                {bridge?.purposes.includes("ceph") ? "ceph" : "zfs replication"} gets {ifaceName} to itself.
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
                      purposeOptions={bridgeOptions}
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

      {[vmTrafficHint, ...storageHaHints, backupHint, corosyncHint]
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

// A pool name / storage id field. Step 4 asks for four of these and they
// all answer to the same rules (see validatePoolName), so the validation
// and the "don't go red before it's been touched" behavior live here
// rather than being repeated per field.
function PoolNameField({
  id,
  label,
  hint,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const error = validatePoolName(value);
  return (
    <div className={`pc-field ${error ? "pc-field--error" : ""}`}>
      <label className="label pc-field__label" htmlFor={id}>
        {label}
        <span className="pc-field__required"> *</span>
      </label>
      <div className="pc-field__control">
        <span className="code pc-field__bracket">$</span>
        <input
          id={id}
          className="pc-field__input code"
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      <span className="body-sm pc-field__hint">{error ?? hint}</span>
    </div>
  );
}


/**
 * A secret: hidden until asked, never echoed anywhere else. `onGenerate`
 * adds a button that fills in a random one — and shows it, since a
 * generated password is useless until it's been copied somewhere safe.
 */
function SecretField({
  id,
  label,
  hint,
  value,
  onChange,
  validate,
  onGenerate,
  required = false,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  validate?: (value: string) => string | null;
  onGenerate?: () => void;
  required?: boolean;
}) {
  const [shown, setShown] = useState(false);
  const [touched, setTouched] = useState(false);
  const reveal = useContext(RevealErrorsContext);
  const error = validate ? validate(value) : null;
  const showError = (touched || reveal) && error;
  return (
    <div className={`pc-field ${showError ? "pc-field--error" : ""}`}>
      <label className="label pc-field__label" htmlFor={id}>
        {label}
        {required && <span className="pc-field__required"> *</span>}
      </label>
      <div className="pc-field__control">
        <span className="code pc-field__bracket">*</span>
        <input
          id={id}
          className="pc-field__input code"
          type={shown ? "text" : "password"}
          autoComplete="new-password"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setTouched(true)}
        />
        <button type="button" className="pc-field__action" onClick={() => setShown((v) => !v)}>
          {shown ? "hide" : "show"}
        </button>
        {onGenerate && (
          <button
            type="button"
            className="pc-field__action"
            onClick={() => {
              onGenerate();
              setShown(true);
              setTouched(true);
            }}
          >
            generate
          </button>
        )}
      </div>
      <span className="body-sm pc-field__hint">{showError ? error : hint}</span>
    </div>
  );
}

/** the ssh keys box — every key it recognizes is listed back under it */
function SshKeysField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [touched, setTouched] = useState(false);
  const reveal = useContext(RevealErrorsContext);
  const error = validateSshKeys(value);
  // a pasted private key is flagged at once, touched or not
  const showError = (touched || reveal || /PRIVATE KEY/.test(value)) && error;
  const keys = sshKeyLines(value)
    .map(parseSshPublicKey)
    .filter((k): k is SshPublicKey => k !== null);
  return (
    <div className={`pc-field ${showError ? "pc-field--error" : ""}`}>
      <label className="label pc-field__label" htmlFor="ssh-keys">
        ssh public key
        <span className="pc-field__required"> *</span>
      </label>
      <div className="pc-field__control">
        <textarea
          id="ssh-keys"
          className="pc-field__input pc-field__textarea code"
          rows={3}
          spellCheck={false}
          placeholder="ssh-ed25519 AAAA… you@laptop"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setTouched(true)}
        />
      </div>
      <span className="body-sm pc-field__hint">
        {showError
          ? error
          : "the contents of your .pub file (cat ~/.ssh/id_ed25519.pub) — root on every node accepts it. one per line for several"}
      </span>
      {keys.length > 0 && !error && (
        <ul className="pc-keylist">
          {keys.map((k) => (
            <li key={k.data} className="body-sm">
              <span className="code">{k.type}</span> <span className="text-ink-muted">{k.comment || "(no comment)"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}


export default function Setup() {
  return (
    <VaultGate mode="wizard">
      <Wizard />
    </VaultGate>
  );
}

function Wizard() {
  const router = useRouter();
  // the same untouched setup a stale step starts over from (see saved-state.ts)
  const [initial] = useState(freshState);
  const [currentStep, setCurrentStep] = useState<WizardStepId>(initial.currentStep);
  const [location, setLocation] = useState<LocationPlan>(initial.location);
  const [nodeCount, setNodeCount] = useState(initial.nodeCount);
  const [hostnameSuffix, setHostnameSuffix] = useState(initial.hostnameSuffix);
  const [globalCidr, setGlobalCidr] = useState(initial.globalCidr);
  const [gateway, setGateway] = useState(initial.gateway);
  const [dns, setDns] = useState(initial.dns);
  const [homelabVlan, setHomelabVlan] = useState(initial.homelabVlan);
  const [nodes, setNodes] = useState<NodeInfo[]>(initial.nodes);
  const [identicalHardware, setIdenticalHardware] = useState(initial.identicalHardware);
  const [identicalNetwork, setIdenticalNetwork] = useState(initial.identicalNetwork);
  const [clusterStorage, setClusterStorage] = useState<ClusterStorage>(initial.clusterStorage);
  const [storage, setStorage] = useState<StoragePlan>(initial.storage);
  const [identicalStorage, setIdenticalStorage] = useState(initial.identicalStorage);
  const [backups, setBackups] = useState<BackupPlan>(initial.backups);
  const [access, setAccess] = useState<AccessPlan>(initial.access);
  const [software, setSoftware] = useState<SoftwarePlan>(initial.software);
  const [install, setInstall] = useState<InstallPlan>(initial.install);
  // set when a save came back only in part: this build changed a step
  const [startedOver, setStartedOver] = useState<string | null>(null);
  // the kubernetes planner's layout while it's open — not saved: it only makes guests
  const [k8sDraft, setK8sDraft] = useState<K8sLayout | null>(null);
  // gates the save effect below so it never fires with the initial default
  // state before the restore attempt (which may replace that state) has
  // actually run — otherwise a freshly-loaded save could get clobbered by
  // defaults on the very first render.
  const [hydrated, setHydrated] = useState(false);

  // restore-on-mount, through restoreSaved: kept whole when every step is
  // current, kept up to the first changed step otherwise (and the visitor
  // told so); anything else (missing key, bad json, another layout) leaves
  // the clean defaults already in state untouched.
  // localStorage doesn't exist during ssr, so this has to run post-mount —
  // reading it during render would desync client output from the server
  // html. that's exactly what useEffect is for here, so the set-state-in-
  // effect rule's general advice doesn't apply to this specific case.
   
  useEffect(() => {
    let cancelled = false;
    void loadSaved().then((restored) => {
      if (cancelled) return;
      const saved = restored?.state;
      if (restored?.startedOverFrom) setStartedOver(startedOverNotice(restored.startedOverFrom));
      if (saved) {
      setCurrentStep(saved.currentStep);
      setNodeCount(saved.nodeCount);
      setHostnameSuffix(saved.hostnameSuffix);
      setGlobalCidr(saved.globalCidr);
      setGateway(saved.gateway);
      setDns(saved.dns);
      setHomelabVlan(saved.homelabVlan);
      setNodes(saved.nodes);
      setIdenticalHardware(saved.identicalHardware);
      setIdenticalNetwork(saved.identicalNetwork);
      setClusterStorage(saved.clusterStorage);
      setStorage(saved.storage);
      setIdenticalStorage(saved.identicalStorage);
      setBackups(saved.backups);
      setAccess(saved.access);
      // a location that started over is detected afresh, like a new setup's
      setLocation(
        restored.startedOverFrom === "location"
          ? detectLocation(navigator.language, Intl.DateTimeFormat().resolvedOptions().timeZone)
          : saved.location,
      );
      setSoftware(saved.software);
      setInstall(saved.install);
      } else {
        // a new setup starts from the browser it's being made in
        setLocation(detectLocation(navigator.language, Intl.DateTimeFormat().resolvedOptions().timeZone));
      }
      setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
   

  // the whole setup as it stands — what's saved, what the gate checks, and
  // what step 8's answer files are built from
  const snapshot = useMemo<PersistedState>(
    () => ({
      version: STORAGE_VERSION,
      stepVersions: { ...STEP_VERSIONS },
      currentStep,
      location,
      nodeCount,
      hostnameSuffix,
      globalCidr,
      gateway,
      dns,
      homelabVlan,
      nodes,
      identicalHardware,
      identicalNetwork,
      clusterStorage,
      storage,
      identicalStorage,
      backups,
      // a removed node's password isn't kept around
      access: { ...access, rootPasswords: nodes.map((_, i) => rootPasswordFor(access, i)) },
      software,
      // nor its boot disk
      install: { ...install, bootDisks: nodes.map((_, i) => install.bootDisks[i] ?? "") },
    }),
    [
      currentStep,
      location,
      nodeCount,
      hostnameSuffix,
      globalCidr,
      gateway,
      dns,
      homelabVlan,
      nodes,
      identicalHardware,
      identicalNetwork,
      clusterStorage,
      storage,
      identicalStorage,
      backups,
      access,
      software,
      install,
    ],
  );

  // debounced autosave — only once hydrated, so this never overwrites a
  // save with the pre-restore defaults.
  useEffect(() => {
    if (!hydrated) return;
    // encrypted on its way out (see vault.ts); a refused save just skips
    const handle = setTimeout(() => void savePersistedState(snapshot), 300);
    return () => clearTimeout(handle);
  }, [hydrated, snapshot]);

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
  // what's actually in effect given the nodes and disks (see
  // effectiveClusterStorage) — everything below reads these, never the
  // raw choice, except the checkboxes themselves
  const activeStorage = useMemo(() => effectiveClusterStorage(clusterStorage, nodes), [clusterStorage, nodes]);
  // keyed on the two booleans, not the object: effectiveClusterStorage
  // builds a new object whenever it clamps, and an effect below depends on
  // these — a new array on every node edit re-ran it in a render loop
  const storageModes = useMemo(
    () => enabledStorageModes({ ceph: activeStorage.ceph, zfs: activeStorage.zfs }),
    [activeStorage.ceph, activeStorage.zfs],
  );
  // every node's disks with the role they actually play under those modes
  const planNodes = useMemo(() => withEffectiveDiskRoles(nodes, storageModes), [nodes, storageModes]);
  // nodes that couldn't carry ceph at a sane speed — drives the caveat on
  // the ceph option below. computed whatever the current choice is, so the
  // warning is visible before you pick it rather than after.
  const slowForCeph = useMemo(() => nodesWithoutFastNic(nodes), [nodes]);
  // nodes whose zfs pool could only be a one-disk stripe — the zfs option's
  // caveat, shown before it's picked for the same reason as slowForCeph.
  // ceph takes a disk per node first when both are on, so zfs gets what's left
  const stripeOnlyForZfs = useMemo(
    () => nodesWithoutZfsRedundancy(nodes, clusterStorage.ceph ? 1 : 0),
    [nodes, clusterStorage.ceph],
  );
  const storagePurposes = useMemo(
    () => activeStoragePurposes({ ceph: activeStorage.ceph, zfs: activeStorage.zfs }),
    [activeStorage.ceph, activeStorage.zfs],
  );

  // ── step 4 derivations ────────────────────────────────────────────────
  // the zfs layouts every node can build, and the one in effect — the
  // picker lists only those, and everything below reads the effective one
  const zfsMembers = useMemo(() => minPoolMembers(planNodes), [planNodes]);
  const zfsChoices = raidLevelChoices(zfsMembers);
  const raidLevel = effectiveRaidLevel(storage.zfs.raidLevel, zfsMembers) ?? storage.zfs.raidLevel;
  // the replica counts in effect for this many nodes — everything below
  // reads these, never storage.ceph directly (see effectiveCephPlan)
  const ceph = useMemo(() => effectiveCephPlan(storage.ceph, nodes.length), [storage.ceph, nodes.length]);
  const replicas = Number(ceph.replicas);
  const cephReplicaWarning = useMemo(
    () => cephReplicaHint(nodes.length, replicas),
    [nodes.length, replicas],
  );
  // one membership check per enabled mode — each needs a disk on every node
  const poolMembership = useMemo(
    () => storageModes.map((mode) => poolMembershipHint(planNodes, mode)),
    [planNodes, storageModes],
  );
  const cephDiskTypes = useMemo(
    () => (activeStorage.ceph ? cephDiskTypeHint(planNodes) : null),
    [planNodes, activeStorage.ceph],
  );
  const anyLocalDisks = useMemo(() => hasLocalDisks(planNodes), [planNodes]);
  const replicationHint = useMemo(
    () => (activeStorage.zfs ? replicationWindowHint(Number(storage.zfs.replicationMinutes) || 0) : null),
    [activeStorage.zfs, storage.zfs.replicationMinutes],
  );
  // capacity is quoted per node for zfs (each node builds its own pool)
  // and once for ceph (there is only one pool, spread across the cluster).
  const cephCapacityGb = useMemo(() => cephUsableGb(planNodes, replicas), [planNodes, replicas]);
  const cephSurvivesNodeLossGb = useMemo(
    () => (replicas > 0 ? cephRawWithoutLargestNodeGb(planNodes) / replicas : 0),
    [planNodes, replicas],
  );

  // whenever the node count or the effective storage/ha decision changes
  // (including zfs silently losing its disks), drop any bridge purpose
  // that's no longer offered rather than leave it stuck in state with no
  // ui left to show or edit it. gated on hydrated for the same reason the
  // autosave effect is — otherwise this would run against the pre-restore
  // defaults and clobber whatever the restore is about to set.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!hydrated) return;
    const disallowed = (["ceph", "zfs"] as InterfacePurpose[]).filter((p) => !storagePurposes.includes(p));
    setNodes((prev) => withoutPurposes(prev, disallowed));
  }, [hydrated, storagePurposes]);
  // disk roles need no such effect: they're read through
  // withEffectiveDiskRoles, so a role that stops being offered simply
  // stops applying, and comes back if it's offered again
  /* eslint-enable react-hooks/set-state-in-effect */

  // ── step 5 derivations ───────────────────────────────────────────────
  // the most a full backup can reach — the storage planned in step 4, full
  const guestDataGb = useMemo(() => maxGuestDataGb(nodes, clusterStorage, storage), [nodes, clusterStorage, storage]);
  const backupHints = [
    noBackupHint(backups.target),
    sameHardwareHint(backups.target, backups.offsite),
    retentionHint(backups),
    encryptionHint(backups),
    offsiteHint(backups.target, backups.offsite),
    backupNicHint(nodes, backups.target),
    backupSizeHint(guestDataGb, backups),
  ];
  const setBackup = (patch: Partial<BackupPlan>) => setBackups((b) => ({ ...b, ...patch }));

  // ── step 6 derivations ───────────────────────────────────────────────
  const setOidc = (patch: Partial<OidcPlan>) => setAccess((a) => ({ ...a, oidc: { ...a.oidc, ...patch } }));
  const setRootPassword = (index: number, value: string) =>
    setAccess((a) => ({ ...a, rootPasswords: nodes.map((_, i) => (i === index ? value : rootPasswordFor(a, i))) }));
  const accessHints = [passwordSshHint(access.disablePasswordSsh), sharedRootPasswordHint(access, nodes.length)];

  // ── step 7 derivations ───────────────────────────────────────────────
  const guestCtx = useMemo(
    () => ({ nodes, clusterStorage, storage, kubernetes: software.kubernetes }),
    [nodes, clusterStorage, storage, software.kubernetes],
  );
  const guests = software.guests;
  const k8sPlanned = guests.filter(isKubernetesNode).length;
  const addGuests = (added: GuestPlan[]) => setSoftware((sw) => ({ ...sw, guests: [...sw.guests, ...added] }));
  const replaceGuest = (next: GuestPlan) => setSoftware((sw) => ({ ...sw, guests: sw.guests.map((g) => (g.id === next.id ? next : g)) }));
  const removeGuest = (id: string) => setSoftware((sw) => ({ ...sw, guests: sw.guests.filter((g) => g.id !== id) }));
  const applyK8s = (layout: K8sLayout) => {
    setSoftware((sw) => ({ ...sw, guests: applyK8sLayout(layout, sw.guests, guestCtx) }));
    setK8sDraft(null);
  };
  const softwareHints = [
    ...nodeLoads(guests, nodes).map((load) =>
      memoryHint(load, nodes[load.nodeIndex]?.network.hostLabel || nodes[load.nodeIndex]?.name || `node ${load.nodeIndex + 1}`),
    ),
    ...storageUse(guests, guestCtx).map(storageHint),
    haQuorumHint(guests, nodes.length),
    cephReachHint(guests, guestCtx),
  ];

  // ── the gate ──────────────────────────────────────────────────────────
  // everything blocking this step and the ones before it, from the live
  // form — the same checks the preview pages apply to the saved state
  const blocking = useMemo(() => problemsUpTo(currentStep, snapshot), [currentStep, snapshot]);
  // set by a blocked "preview": from then on every field shows its error,
  // and the list below says what's left. cleared on a step switch, so
  // the next step starts without red it hasn't earned yet.
  const [revealErrors, setRevealErrors] = useState(false);
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setRevealErrors(false);
  }, [currentStep]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // step 1 has nothing to draw, so it moves on directly — through the same gate
  function tryNext(next: WizardStepId) {
    if (blocking.length > 0) {
      setRevealErrors(true);
      return;
    }
    setCurrentStep(next);
  }

  function tryPreview(step: WizardStepId) {
    if (blocking.length > 0) {
      setRevealErrors(true);
      return;
    }
    router.push(`/setup/preview/${step}`);
  }

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
      setNodes((prev) =>
        resizeNodes(prev, n, globalCidr, { hardware: identicalHardware, network: identicalNetwork }),
      );
    }
  }

  function handleIdenticalHardwareChange(checked: boolean) {
    setIdenticalHardware(checked);
    if (checked) {
      setNodes((prev) => {
        if (prev.length === 0) return prev;
        return prev.map((node) => withHardwareOf(node, prev[0]));
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
        // `!== undefined`, not truthiness: clearing the field to retype
        // a name passes "" — skipping that broke the sync for good, since
        // the label and the name never matched again afterwards.
        if (patch.name !== undefined && node.network.hostLabel === node.name) {
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
          nics: resizeArray(node.nics, clamped, defaultNic),
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

  // step 4's only per-node edit. under "identical storage" the role is
  // written to the disk at the same position on every node, which is the
  // only correspondence the nodes reliably share (see applyStorageRoles).
  function updateDiskRole(nodeIndex: number, diskIndex: number, role: DiskRole) {
    setNodes((prev) =>
      prev.map((node, i) =>
        !identicalStorage && i !== nodeIndex
          ? node
          : {
              ...node,
              additionalDisks: node.additionalDisks.map((d, j) => (j === diskIndex ? { ...d, role } : d)),
            },
      ),
    );
  }

  function handleIdenticalStorageChange(next: boolean) {
    setIdenticalStorage(next);
    // turning it on adopts node 1's plan, the same way the network step
    // adopts node 1's structure — otherwise the checkbox would claim the
    // nodes match while they visibly don't.
    if (next && nodes.length > 0) setNodes((prev) => applyStorageRoles(prev, prev[0].additionalDisks));
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
          nics: resizeArray(node.nics, clamped, defaultNic),
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

  // the dns server follows the gateway until it's set to something else
  function changeGateway(next: string) {
    setDns((current) => followGateway(current, gateway, next));
    setGateway(next);
  }

  function handleGlobalCidrChange(value: string) {
    setGlobalCidr(value);
    changeGateway(deriveGateway(value));
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

      // ceph/zfs make a storage link, which takes the whole interface
      // (see enforceStorageLinks) — any extra bridges it had go
      updated = updated.map((node, i) => {
        if (i !== index) return node;
        const network = enforceStorageLinks(node.network);
        return network === node.network ? node : { ...node, network };
      });

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
        // entirely: a storage link never gets a bridge, let alone extra
        // ones, no matter what value comes in.
        if (isStorageLink(node.network, bridgeKey(interfaceId, 0))) return node;
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
  const globalCidrError = required(globalCidr, validateCidr);
  const homelabVlanError = validateOptionalVlanTag(homelabVlan);
  const gatewayError = required(gateway, validateIp);
  const dnsError = required(dns, validateIp);

  return (
    <div className="pc-root flex min-h-full flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
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

          {startedOver && (
            <div className="pc-callout pc-callout--info" role="status">
              <span className="code pc-callout__glyph">#</span>
              <div className="pc-callout__body">
                <p className="body-sm pc-callout__text">{startedOver}</p>
                <div className="mt-3">
                  <button type="button" className="pc-btn pc-btn--ghost" onClick={() => setStartedOver(null)}>
                    got it
                  </button>
                </div>
              </div>
            </div>
          )}

          <RevealErrorsContext.Provider value={revealErrors}>
          {currentStep === "location" && (
            <div className="pc-stepflow__card">
              <p className="meta pc-stepflow__meta"># step 1 of 8</p>
              <h2 className="h2 pc-stepflow__title">location</h2>
              <p className="body pc-stepflow__intro">
                Where the cluster lives. The installer asks these three before
                anything else, and they&apos;re set the same on every node —
                picked up from this browser, so check they match the machines.
              </p>

              <div className="pc-stepflow__fields">
                <div className="pc-field">
                  <label className="label pc-field__label" htmlFor="location-country">
                    country
                  </label>
                  <div className="pc-field__control">
                    <select
                      id="location-country"
                      className="pc-field__input code"
                      value={location.country}
                      onChange={(e) => setLocation((l) => ({ ...l, country: e.target.value }))}
                    >
                      {COUNTRY_OPTIONS.map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <span className="body-sm pc-field__hint">picks the installer&apos;s nearest package mirror</span>
                </div>

                <div className="pc-field">
                  <label className="label pc-field__label" htmlFor="location-keyboard">
                    keyboard
                  </label>
                  <div className="pc-field__control">
                    <select
                      id="location-keyboard"
                      className="pc-field__input code"
                      value={location.keyboard}
                      onChange={(e) => setLocation((l) => ({ ...l, keyboard: e.target.value }))}
                    >
                      {KEYBOARD_OPTIONS.map((k) => (
                        <option key={k.value} value={k.value}>
                          {k.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <span className="body-sm pc-field__hint">
                    the layout of the keyboard plugged into the nodes — it&apos;s what you&apos;ll type the root
                    password on at the console
                  </span>
                </div>

                <div className="pc-field">
                  <label className="label pc-field__label" htmlFor="location-timezone">
                    timezone
                  </label>
                  <div className="pc-field__control">
                    <select
                      id="location-timezone"
                      className="pc-field__input code"
                      value={location.timezone}
                      onChange={(e) => setLocation((l) => ({ ...l, timezone: e.target.value }))}
                    >
                      {timezoneOptions().map((z) => (
                        <option key={z} value={z}>
                          {z}
                        </option>
                      ))}
                    </select>
                  </div>
                  <span className="body-sm pc-field__hint">
                    the nodes&apos; clocks — log timestamps, and when the nightly backup from step 5 runs
                  </span>
                </div>
              </div>

              {revealErrors && <ProblemList problems={blocking} step={currentStep} />}
              <div className="pc-stepflow__nav">
                <Link href="/" className="pc-btn pc-btn--ghost">
                  ← back to overview
                </Link>
                <button type="button" className="pc-btn pc-btn--primary" onClick={() => tryNext("hardware")}>
                  <span className="pc-btn__bracket">[</span>
                  next
                  <span className="pc-btn__bracket">]</span>
                </button>
              </div>
            </div>
          )}

          {currentStep === "hardware" && (
            <div className="pc-stepflow__card">
              <p className="meta pc-stepflow__meta"># step 2 of 8</p>
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
                  const nameError = required(node.name, validateHostLabel);

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

              {revealErrors && <ProblemList problems={blocking} step={currentStep} />}
              <div className="pc-stepflow__nav">
                <button type="button" className="pc-btn" onClick={() => setCurrentStep("location")}>
                  <span className="pc-btn__bracket">[</span>
                  back
                  <span className="pc-btn__bracket">]</span>
                </button>
                <button
                  type="button"
                  className="pc-btn pc-btn--primary"
                  onClick={() => tryPreview("hardware")}
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
              <p className="meta pc-stepflow__meta"># step 3 of 8</p>
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
                      onChange={(e) => changeGateway(e.target.value)}
                    />
                  </div>
                  <span className="body-sm pc-field__hint">
                    {gatewayError ?? "default route for every node — usually your router or firewall"}
                  </span>
                </div>

                <div className={`pc-field ${dnsError ? "pc-field--error" : ""}`}>
                  <label className="label pc-field__label" htmlFor="dns">
                    dns server
                  </label>
                  <div className="pc-field__control">
                    <span className="code pc-field__bracket">#</span>
                    <input
                      id="dns"
                      className="pc-field__input code"
                      type="text"
                      placeholder={`e.g. ${gateway || "10.0.10.1"}`}
                      value={dns}
                      onChange={(e) => setDns(e.target.value)}
                    />
                  </div>
                  <span className="body-sm pc-field__hint">
                    {dnsError ??
                      "what every node resolves names through — follows the gateway, since most routers answer dns too, until you set your own"}
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
                    <legend className="label pc-radio-group__legend">cluster storage (tick any, or none)</legend>
                    {clusterStorageAvailable &&
                      CLUSTER_STORAGE_OPTIONS.map((opt) => {
                        const other: StorageMode = opt.value === "ceph" ? "zfs" : "ceph";
                        // ceph takes each osd disk whole, so running both needs
                        // a second spare disk on every node for zfs
                        const blockedByOther = !activeStorage[opt.value] && activeStorage[other] && minDisks < 2;
                        // only ceph gets a speed caveat: zfs replication ships a
                        // scheduled snapshot stream and tolerates a slow link by
                        // taking longer, where ceph puts the link in the path of
                        // every synchronous write.
                        const flagSlow = opt.value === "ceph" && slowForCeph.length > 0;
                        // zfs's own caveat: fewer than two disks left for it means
                        // a single-disk stripe, with nothing to fail over to
                        // inside the node.
                        const flagStripe = opt.value === "zfs" && stripeOnlyForZfs.length > 0;
                        return (
                          <label key={opt.value} className="pc-checkbox">
                            <input
                              type="checkbox"
                              checked={activeStorage[opt.value]}
                              disabled={blockedByOther}
                              onChange={(e) => setClusterStorage((cs) => ({ ...cs, [opt.value]: e.target.checked }))}
                            />
                            <span className="pc-checkbox__box" />
                            <span>
                              <span className="code pc-checkbox__label">
                                {opt.label}
                                {(flagSlow || flagStripe) && <span className="pc-radio__warnmark">⚠</span>}
                              </span>
                              <span className="body-sm pc-checkbox__hint">{opt.hint}</span>
                              {blockedByOther && (
                                <span className="body-sm pc-checkbox__hint">
                                  needs a second disk beyond boot on every node — {other} takes one, and ceph and
                                  zfs can&apos;t share a disk. add one in step 2 to run both.
                                </span>
                              )}
                              {flagSlow && (
                                <span className="body-sm pc-radio__warntext">
                                  ⚠ no 10 gbe (or faster) nic on{" "}
                                  {slowForCeph.length === nodes.length
                                    ? "any node"
                                    : slowForCeph.map((n) => n.network.hostLabel || n.name).join(", ")}
                                  . ceph acknowledges a write only once the other nodes have it, so the
                                  slowest node&apos;s link sets the disk latency every vm in the cluster
                                  sees — add a 10 gbe nic in step 2, or use zfs with replication
                                  instead.
                                </span>
                              )}
                              {flagStripe && (
                                <span className="body-sm pc-radio__warntext">
                                  ⚠ fewer than two disks left for zfs on{" "}
                                  {stripeOnlyForZfs.length === nodes.length
                                    ? "every node"
                                    : stripeOnlyForZfs.map((n) => n.network.hostLabel || n.name).join(", ")}
                                  {clusterStorage.ceph ? " once ceph takes one" : ""}, so each zfs pool there
                                  can only be a single-disk stripe — no redundancy within the node. one failed
                                  disk loses that node&apos;s whole pool, and its guests come back from another
                                  node only as of the last replication run. add a disk per node in step 2 to
                                  mirror them.
                                </span>
                              )}
                            </span>
                          </label>
                        );
                      })}
                    {clusterStorageAvailable && storageModes.length === 0 && (
                      <p className="body-sm pc-field__hint">
                        neither ticked: each node&apos;s storage is its own island — simplest, but a vm
                        doesn&apos;t survive its node going down.
                      </p>
                    )}
                    {!clusterStorageAvailable && (
                      <p className="body-sm pc-field__hint">
                        ceph and zfs replication both need at least 1 disk beyond the boot disk on every node — your worst-equipped node currently has {minDisks}, so it sets the limit for the whole cluster. add one in step 2 to unlock either option here
                      </p>
                    )}
                    {/* ceph's requirements scale with the number of osds you
                        end up running, which this wizard can't know yet — so
                        rather than restate a snapshot of them, point at the
                        source and let it stay current. */}
                    {activeStorage.ceph && (
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
                      anyStorageChosen={clusterStorage.ceph || clusterStorage.zfs}
                      storagePurposes={storagePurposes}
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
                        anyStorageChosen={clusterStorage.ceph || clusterStorage.zfs}
                        storagePurposes={storagePurposes}
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

              {revealErrors && <ProblemList problems={blocking} step={currentStep} />}
              <div className="pc-stepflow__nav">
                <button type="button" className="pc-btn" onClick={() => setCurrentStep("hardware")}>
                  <span className="pc-btn__bracket">[</span>
                  back
                  <span className="pc-btn__bracket">]</span>
                </button>
                <button
                  type="button"
                  className="pc-btn pc-btn--primary"
                  onClick={() => tryPreview("network")}
                >
                  <span className="pc-btn__bracket">[</span>
                  preview
                  <span className="pc-btn__bracket">]</span>
                </button>
              </div>
            </div>
          )}

          {currentStep === "storage" && (
            <div className="pc-stepflow__card">
              <p className="meta pc-stepflow__meta"># step 4 of 8</p>
              <h2 className="h2 pc-stepflow__title">storage</h2>
              <p className="body pc-stepflow__intro">
                Step 2 asked what disks each node has. This decides what
                they&apos;re <em>for</em> — which ones join the cluster&apos;s
                shared storage, which stay local to their node, and how each
                pool is laid out.
              </p>

              <div className="pc-stepflow__fields">
                {storageModes.length === 0 && (
                  <div className="pc-callout pc-callout--info">
                    <span className="code pc-callout__glyph">#</span>
                    <div className="pc-callout__body">
                      <p className="body pc-callout__text">
                        Neither ceph nor zfs replication is on, so there&apos;s
                        no cluster-wide pool to build — every disk below is
                        either this node&apos;s own storage or left alone.
                        Tick one in step 3 to plan a shared pool here
                        instead.
                      </p>
                    </div>
                  </div>
                )}

                {nodes.length > 1 && (
                  <label className="pc-checkbox">
                    <input
                      type="checkbox"
                      checked={identicalStorage}
                      onChange={(e) => handleIdenticalStorageChange(e.target.checked)}
                    />
                    <span className="pc-checkbox__box" />
                    <span>
                      <span className="code pc-checkbox__label">identical disk layout across all nodes</span>
                      <span className="body-sm pc-checkbox__hint">
                        the disk in the same slot plays the same role on every node — which is what ceph and zfs
                        replication both assume
                      </span>
                    </span>
                  </label>
                )}

                {/* per-node disk roles */}
                {nodes.map((node, nodeIndex) => {
                  if (identicalStorage && nodeIndex > 0) return null;
                  // the same node with its disks' effective roles — what the
                  // radios show and every figure below is computed from
                  const planNode = planNodes[nodeIndex];
                  const zfsDisks = disksWithRole(planNode, "zfs");
                  const layoutHint = activeStorage.zfs ? zfsLayoutHint(zfsDisks.length, raidLevel) : null;
                  const sizeHint = activeStorage.zfs ? mixedDiskSizeHint(zfsDisks, raidLevel) : null;
                  const soleMode = soleDiskMode(storageModes, node.additionalDisks.length);

                  return (
                    <div
                      key={node.name + nodeIndex}
                      className="flex flex-col border border-border bg-surface-100 p-5"
                      style={{ gap: "var(--space-4)" }}
                    >
                      <p className="label text-ink-muted">
                        {identicalStorage
                          ? "every node's disks"
                          : `node ${String(nodeIndex + 1).padStart(2, "0")} — ${node.name}`}
                      </p>

                      {/* same headline as the data disks below, so the boot
                          disk reads as one of this node's disks — the box
                          under it then only has to say why it has no role
                          to pick, instead of repeating its name and size. */}
                      <div className="pc-radio-group">
                        <p className="label pc-radio-group__legend">
                          {node.bootDiskName || "boot"} — {node.bootDiskSizeGb || "?"} gb {node.bootDiskType}
                        </p>
                        <div className="pc-diskline">
                          <span className="body-sm pc-diskline__meta">
                            the proxmox installer puts the os here, plus the small &ldquo;local&rdquo; storage for
                            isos and backups — so it takes no role below
                          </span>
                          <span className="meta pc-diskline__locked">proxmox owns this one</span>
                        </div>
                      </div>

                      {node.additionalDisks.length === 0 ? (
                        <p className="body-sm text-ink-muted">
                          no disks beyond boot on this node — add some in step 2 to have anything to plan here.
                        </p>
                      ) : (
                        node.additionalDisks.map((disk, diskIndex) => (
                          <fieldset
                            key={diskIndex}
                            className="pc-radio-group"
                            style={{ border: 0, margin: 0, padding: 0 }}
                          >
                            <legend className="label pc-radio-group__legend">
                              {disk.name || `disk ${diskIndex + 1}`} — {disk.sizeGb || "?"} gb {disk.type}
                            </legend>
                            {diskRoleOptions(storageModes, node.additionalDisks.length).map((opt) => (
                              <label key={opt.value} className="pc-radio">
                                <input
                                  type="radio"
                                  name={`diskrole-${nodeIndex}-${diskIndex}`}
                                  checked={planNode.additionalDisks[diskIndex].role === opt.value}
                                  onChange={() => updateDiskRole(nodeIndex, diskIndex, opt.value)}
                                />
                                <span className="pc-radio__box" />
                                <span>
                                  <span className="code pc-radio__label">{opt.label}</span>
                                  <span className="body-sm pc-checkbox__hint">{opt.hint}</span>
                                </span>
                              </label>
                            ))}
                            {soleMode && (
                              <p className="body-sm pc-field__hint">
                                it&apos;s this node&apos;s only disk beyond boot, so it has to join the pool — left
                                out, the node would store nothing for{" "}
                                {soleMode === "ceph" ? "ceph" : "zfs replication"}. add a second disk in step 2
                                to keep one for local storage.
                              </p>
                            )}
                          </fieldset>
                        ))
                      )}

                      {activeStorage.zfs && zfsDisks.length > 0 && (
                        <div className="pc-summary">
                          <div className="pc-summary__cell">
                            <span className="label pc-summary__key">zfs pool members</span>
                            <span className="code pc-summary__val">{zfsDisks.length}</span>
                          </div>
                          <div className="pc-summary__cell">
                            <span className="label pc-summary__key">raw</span>
                            <span className="code pc-summary__val pc-summary__val--sm">
                              {formatGb(totalGb(zfsDisks))}
                            </span>
                          </div>
                          <div className="pc-summary__cell">
                            <span className="label pc-summary__key">usable</span>
                            <span className="code pc-summary__val pc-summary__val--sm">
                              {formatGb(zfsUsableGb(zfsDisks, raidLevel))}
                            </span>
                          </div>
                        </div>
                      )}

                      {[layoutHint, sizeHint]
                        .filter((hint): hint is Hint => hint !== null)
                        .map((hint, i) => (
                          <div key={i} className={`pc-callout pc-callout--${hint.tone}`}>
                            <span className="code pc-callout__glyph">{hint.glyph}</span>
                            <div className="pc-callout__body">
                              <p className="body-sm pc-callout__text">{hint.text}</p>
                            </div>
                          </div>
                        ))}
                    </div>
                  );
                })}

                {[...poolMembership, cephDiskTypes]
                  .filter((hint): hint is Hint => hint !== null)
                  .map((hint, i) => (
                    <div key={i} className={`pc-callout pc-callout--${hint.tone}`}>
                      <span className="code pc-callout__glyph">{hint.glyph}</span>
                      <div className="pc-callout__body">
                        <p className="body-sm pc-callout__text">{hint.text}</p>
                      </div>
                    </div>
                  ))}

                {/* ceph pool */}
                {activeStorage.ceph && (
                  <div
                    className="flex flex-col border border-border bg-surface-100 p-5"
                    style={{ gap: "var(--space-5)" }}
                  >
                    <p className="label text-ink-muted">the ceph pool</p>

                    <PoolNameField
                      id="ceph-pool-name"
                      label="pool name"
                      hint="the proxmox storage id your vm disks will live on"
                      value={storage.ceph.poolName}
                      onChange={(poolName) => setStorage((p) => ({ ...p, ceph: { ...p.ceph, poolName } }))}
                    />

                    {/* pickers rather than free number fields: only values
                        ceph can actually honor are listed, so an
                        unplaceable replica count or a min_size above size
                        can't be entered at all (see replicaChoices). */}
                    <div className="pc-field">
                      <label className="label pc-field__label" htmlFor="ceph-replicas">
                        replicas (size)
                        <span className="pc-field__required"> *</span>
                      </label>
                      <div className="pc-field__control">
                        <select
                          id="ceph-replicas"
                          className="pc-field__input code"
                          value={ceph.replicas}
                          onChange={(e) =>
                            setStorage((p) => ({ ...p, ceph: { ...p.ceph, replicas: e.target.value } }))
                          }
                        >
                          {replicaChoices(nodes.length).map((n) => (
                            <option key={n} value={String(n)}>
                              {n}
                            </option>
                          ))}
                        </select>
                      </div>
                      <span className="body-sm pc-field__hint">
                        copies of every object, one per node — at least 2, at most{" "}
                        {Math.min(nodes.length, MAX_CEPH_REPLICAS)} with {nodes.length} nodes. 3 is ceph&apos;s default.
                      </span>
                    </div>

                    <div className="pc-field">
                      <label className="label pc-field__label" htmlFor="ceph-min-replicas">
                        min replicas (min_size)
                        <span className="pc-field__required"> *</span>
                      </label>
                      <div className="pc-field__control">
                        <select
                          id="ceph-min-replicas"
                          className="pc-field__input code"
                          // shows the effective value: min_size never reads
                          // above size, even while the stored choice is higher
                          value={ceph.minReplicas}
                          onChange={(e) =>
                            setStorage((p) => ({ ...p, ceph: { ...p.ceph, minReplicas: e.target.value } }))
                          }
                        >
                          {minReplicaChoices(replicas).map((n) => (
                            <option key={n} value={String(n)}>
                              {n}
                            </option>
                          ))}
                        </select>
                      </div>
                      <span className="body-sm pc-field__hint">
                        how many copies must be writable before the pool accepts a write — from 2 (never 1, which
                        accepts writes that exist in one place only) up to the replica count
                      </span>
                    </div>

                    <div className="pc-summary">
                      <div className="pc-summary__cell">
                        <span className="label pc-summary__key">raw across cluster</span>
                        <span className="code pc-summary__val pc-summary__val--sm">
                          {formatGb(planNodes.reduce((sum, n) => sum + totalGb(disksWithRole(n, "ceph")), 0))}
                        </span>
                      </div>
                      <div className="pc-summary__cell">
                        <span className="label pc-summary__key">usable at {replicas || "?"}×</span>
                        <span className="code pc-summary__val pc-summary__val--sm">{formatGb(cephCapacityGb)}</span>
                      </div>
                      <div className="pc-summary__cell">
                        <span className="label pc-summary__key">with one node down</span>
                        <span className="code pc-summary__val pc-summary__val--sm">
                          {formatGb(cephSurvivesNodeLossGb)}
                        </span>
                      </div>
                    </div>
                    <p className="body-sm text-ink-muted">
                      Raw capacity before compression and before ceph&apos;s
                      full ratio, which starts refusing writes around 95%.
                      Plan to stay under the &ldquo;with one node down&rdquo;
                      figure — that&apos;s what still fits while a node is
                      being rebuilt.
                    </p>

                    {cephReplicaWarning && (
                      <div className={`pc-callout pc-callout--${cephReplicaWarning.tone}`}>
                        <span className="code pc-callout__glyph">{cephReplicaWarning.glyph}</span>
                        <div className="pc-callout__body">
                          <p className="body-sm pc-callout__text">{cephReplicaWarning.text}</p>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* zfs pool */}
                {activeStorage.zfs && (
                  <div
                    className="flex flex-col border border-border bg-surface-100 p-5"
                    style={{ gap: "var(--space-5)" }}
                  >
                    <p className="label text-ink-muted">the replicated zfs pool</p>

                    <PoolNameField
                      id="zfs-pool-name"
                      label="pool name"
                      hint="the same pool name is created on every node — replication pairs them up by name"
                      value={storage.zfs.poolName}
                      onChange={(poolName) => setStorage((p) => ({ ...p, zfs: { ...p.zfs, poolName } }))}
                    />

                    {/* only layouts every node can build; with no pool disks
                        anywhere there's nothing to arrange, and the pool
                        membership warning above already says why */}
                    {zfsChoices.length > 0 && (
                      <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
                        <legend className="label pc-radio-group__legend">how the pool&apos;s disks are arranged</legend>
                        {ZFS_RAID_OPTIONS.filter((opt) => zfsChoices.includes(opt.value)).map((opt) => (
                          <label key={opt.value} className="pc-radio">
                            <input
                              type="radio"
                              name="zfs-raid-level"
                              checked={raidLevel === opt.value}
                              onChange={() => setStorage((p) => ({ ...p, zfs: { ...p.zfs, raidLevel: opt.value } }))}
                            />
                            <span className="pc-radio__box" />
                            <span>
                              <span className="code pc-radio__label">
                                {opt.label}
                                <span className="pc-radio__aside"> — {opt.minDisks}+ disks</span>
                              </span>
                              <span className="body-sm pc-checkbox__hint">{opt.hint}</span>
                            </span>
                          </label>
                        ))}
                        {zfsChoices.length < ZFS_RAID_OPTIONS.length && (
                          <p className="body-sm pc-field__hint">
                            with {zfsMembers} pool {zfsMembers === 1 ? "disk" : "disks"} on the thinnest node, these are
                            the layouts every node can build — add disks in step 2 for the others.
                          </p>
                        )}
                      </fieldset>
                    )}

                    <div className="pc-field">
                      <label className="label pc-field__label" htmlFor="zfs-replication-minutes">
                        replicate every
                        <span className="pc-field__required"> *</span>
                      </label>
                      <div className="pc-field__control">
                        <input
                          id="zfs-replication-minutes"
                          className="pc-field__input code"
                          type="number"
                          min={1}
                          max={1440}
                          value={storage.zfs.replicationMinutes}
                          onChange={(e) =>
                            setStorage((p) => ({ ...p, zfs: { ...p.zfs, replicationMinutes: e.target.value } }))
                          }
                        />
                        <span className="code pc-field__bracket">minutes</span>
                      </div>
                      <span className="body-sm pc-field__hint">
                        {validateIntRange(storage.zfs.replicationMinutes, 1, 1440, { required: true }) ??
                          "the most recent writes a failover can lose — 1 to 1440 minutes"}
                      </span>
                    </div>

                    {replicationHint && (
                      <div className={`pc-callout pc-callout--${replicationHint.tone}`}>
                        <span className="code pc-callout__glyph">{replicationHint.glyph}</span>
                        <div className="pc-callout__body">
                          <p className="body-sm pc-callout__text">{replicationHint.text}</p>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* local storage — only once some disk is actually marked
                    local; with none, there's no pool to configure. the
                    plan's local settings are kept, so marking a disk local
                    later brings back whatever was chosen before. */}
                {anyLocalDisks && (
                <div
                  className="flex flex-col border border-border bg-surface-100 p-5"
                  style={{ gap: "var(--space-5)" }}
                >
                  {/* deliberately not just "local storage": that's the name
                      of a disk role above, and two different things sharing
                      a label in one step is how a form gets misread. */}
                  <p className="label text-ink-muted">the local storage pool</p>

                  <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
                    <legend className="label pc-radio-group__legend">
                      what the disks marked &ldquo;local storage&rdquo; become
                    </legend>
                    {LOCAL_STORAGE_OPTIONS.map((opt) => (
                      <label key={opt.value} className="pc-radio">
                        <input
                          type="radio"
                          name="local-storage-kind"
                          checked={storage.local.kind === opt.value}
                          onChange={() => setStorage((p) => ({ ...p, local: { ...p.local, kind: opt.value } }))}
                        />
                        <span className="pc-radio__box" />
                        <span>
                          <span className="code pc-radio__label">{opt.label}</span>
                          <span className="body-sm pc-checkbox__hint">{opt.hint}</span>
                        </span>
                      </label>
                    ))}
                  </fieldset>

                  <PoolNameField
                    id="local-storage-name"
                    label="storage id"
                    hint="how this shows up in the proxmox ui, on every node that has one"
                    value={storage.local.name}
                    onChange={(name) => setStorage((p) => ({ ...p, local: { ...p.local, name } }))}
                  />
                </div>
                )}

              </div>

              {revealErrors && <ProblemList problems={blocking} step={currentStep} />}
              <div className="pc-stepflow__nav">
                <button type="button" className="pc-btn" onClick={() => setCurrentStep("network")}>
                  <span className="pc-btn__bracket">[</span>
                  back
                  <span className="pc-btn__bracket">]</span>
                </button>
                <button
                  type="button"
                  className="pc-btn pc-btn--primary"
                  onClick={() => tryPreview("storage")}
                >
                  <span className="pc-btn__bracket">[</span>
                  preview
                  <span className="pc-btn__bracket">]</span>
                </button>
              </div>
            </div>
          )}

          {currentStep === "backups" && (
            <div className="pc-stepflow__card">
              <p className="meta pc-stepflow__meta"># step 5 of 8</p>
              <h2 className="h2 pc-stepflow__title">backups</h2>
              <p className="body pc-stepflow__intro">
                Ceph and zfs replication keep guests running through a failed
                node — they copy a deleted file or a corrupted disk to every
                node just as faithfully. Backups are what let you go back. This
                decides where they go and how long they&apos;re kept.
              </p>

              <div className="pc-stepflow__fields">
                <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
                  <legend className="label pc-radio-group__legend">back up to</legend>
                  {BACKUP_TARGET_OPTIONS.map((opt) => (
                    <label key={opt.value} className="pc-radio">
                      <input
                        type="radio"
                        name="backup-target"
                        checked={backups.target === opt.value}
                        onChange={() => setBackup({ target: opt.value })}
                      />
                      <span className="pc-radio__box" />
                      <span>
                        <span className="code pc-radio__label">{opt.label}</span>
                        <span className="body-sm pc-checkbox__hint">{opt.hint}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>

                {backups.target === "pbs-external" && (
                  <CheckedTextField
                    id="pbs-address"
                    label="pbs address"
                    hint="where the backup server answers — its ip, or a name your dns resolves"
                    placeholder="10.0.10.50"
                    value={backups.pbsAddress}
                    validate={validateHostAddress}
                    onChange={(pbsAddress) => setBackup({ pbsAddress })}
                  />
                )}

                {usesPbs(backups.target) && (
                  <PoolNameField
                    id="pbs-datastore"
                    label="datastore"
                    hint="the pbs datastore the cluster writes into — also the storage id proxmox shows"
                    value={backups.datastore}
                    onChange={(datastore) => setBackup({ datastore })}
                  />
                )}

                {backups.target === "nfs" && (
                  <>
                    <CheckedTextField
                      id="nfs-server"
                      label="nfs server"
                      hint="the nas or server exporting the share"
                      placeholder="nas.homelab.lan"
                      value={backups.nfsServer}
                      validate={validateHostAddress}
                      onChange={(nfsServer) => setBackup({ nfsServer })}
                    />
                    <CheckedTextField
                      id="nfs-export"
                      label="export path"
                      hint="the exported directory on that server"
                      placeholder="/volume1/proxmox"
                      value={backups.nfsExport}
                      validate={validateExportPath}
                      onChange={(nfsExport) => setBackup({ nfsExport })}
                    />
                  </>
                )}

                {backups.target !== "none" && (
                  <>
                    <CheckedTextField
                      id="backup-schedule"
                      label="backup time"
                      hint="daily, 24h — pick a quiet hour; every guest on every node is backed up then"
                      value={backups.schedule}
                      validate={validateScheduleTime}
                      onChange={(schedule) => setBackup({ schedule })}
                    />

                    <div
                      className="flex flex-col border border-border bg-surface-100 p-5"
                      style={{ gap: "var(--space-4)" }}
                    >
                      <p className="label text-ink-muted">retention</p>
                      {RETENTION_FIELDS.map((field) => {
                        const error = validateRetention(backups[field.key]);
                        return (
                          <div key={field.key} className={`pc-field ${error ? "pc-field--error" : ""}`}>
                            <label className="label pc-field__label" htmlFor={`retention-${field.key}`}>
                              {field.label}
                            </label>
                            <div className="pc-field__control">
                              <input
                                id={`retention-${field.key}`}
                                className="pc-field__input code"
                                type="number"
                                min={0}
                                max={1000}
                                value={backups[field.key]}
                                onChange={(e) => setBackup({ [field.key]: e.target.value })}
                              />
                            </div>
                            <span className="body-sm pc-field__hint">{error ?? field.hint}</span>
                          </div>
                        );
                      })}
                      <div className="pc-summary">
                        <div className="pc-summary__cell">
                          <span className="label pc-summary__key">backups kept per vm</span>
                          <span className="code pc-summary__val">up to {maxBackupsKept(backups)}</span>
                        </div>
                        <div className="pc-summary__cell">
                          <span className="label pc-summary__key">oldest reaches back</span>
                          <span className="code pc-summary__val pc-summary__val--sm">{retentionReach(backups)}</span>
                        </div>
                      </div>
                    </div>
                  </>
                )}

                {usesPbs(backups.target) && (
                  <div
                    className="flex flex-col border border-border bg-surface-100 p-5"
                    style={{ gap: "var(--space-4)" }}
                  >
                    <p className="label text-ink-muted">proxmox backup server</p>
                    <label className="pc-checkbox">
                      <input
                        type="checkbox"
                        checked={backups.verify}
                        onChange={(e) => setBackup({ verify: e.target.checked })}
                      />
                      <span className="pc-checkbox__box" />
                      <span>
                        <span className="code pc-checkbox__label">verify backups weekly</span>
                        <span className="body-sm pc-checkbox__hint">
                          reads every backup back and checks it against its checksums — a backup nobody has
                          verified is one you&apos;re hoping about
                        </span>
                      </span>
                    </label>
                    <label className="pc-checkbox">
                      <input
                        type="checkbox"
                        checked={backups.encrypt}
                        onChange={(e) => setBackup({ encrypt: e.target.checked })}
                      />
                      <span className="pc-checkbox__box" />
                      <span>
                        <span className="code pc-checkbox__label">encrypt backups</span>
                        <span className="body-sm pc-checkbox__hint">
                          encrypted on each node before it leaves — the backup server only ever sees ciphertext
                        </span>
                      </span>
                    </label>
                    <label className="pc-checkbox">
                      <input
                        type="checkbox"
                        checked={backups.offsite}
                        onChange={(e) => setBackup({ offsite: e.target.checked })}
                      />
                      <span className="pc-checkbox__box" />
                      <span>
                        <span className="code pc-checkbox__label">sync to an off-site pbs</span>
                        <span className="body-sm pc-checkbox__hint">
                          a second pbs somewhere else pulls a copy of the datastore — the off-site copy of the 3-2-1
                          rule
                        </span>
                      </span>
                    </label>
                    {backups.offsite && (
                      <CheckedTextField
                        id="offsite-address"
                        label="off-site pbs address"
                        hint="the second backup server, somewhere this cluster isn't"
                        placeholder="pbs.offsite.example"
                        value={backups.offsiteAddress}
                        validate={validateHostAddress}
                        onChange={(offsiteAddress) => setBackup({ offsiteAddress })}
                      />
                    )}
                  </div>
                )}

                {backupHints
                  .filter((hint): hint is Hint => hint !== null)
                  .map((hint, i) => (
                    <div key={i} className={`pc-callout pc-callout--${hint.tone}`}>
                      <span className="code pc-callout__glyph">{hint.glyph}</span>
                      <div className="pc-callout__body">
                        <p className="body-sm pc-callout__text">{hint.text}</p>
                      </div>
                    </div>
                  ))}
              </div>

              {revealErrors && <ProblemList problems={blocking} step={currentStep} />}
              <div className="pc-stepflow__nav">
                <button type="button" className="pc-btn" onClick={() => setCurrentStep("storage")}>
                  <span className="pc-btn__bracket">[</span>
                  back
                  <span className="pc-btn__bracket">]</span>
                </button>
                <button type="button" className="pc-btn pc-btn--primary" onClick={() => tryPreview("backups")}>
                  <span className="pc-btn__bracket">[</span>
                  preview
                  <span className="pc-btn__bracket">]</span>
                </button>
              </div>
            </div>
          )}
          {currentStep === "access" && (
            <div className="pc-stepflow__card">
              <p className="meta pc-stepflow__meta"># step 6 of 8</p>
              <h2 className="h2 pc-stepflow__title">access</h2>
              <p className="body pc-stepflow__intro">
                How you get into the nodes once they&apos;re installed: one ssh
                key for all of them, a root password each, and — if you run an
                identity provider — single sign-on for the web ui. Everything
                here is encrypted with your passphrase before it&apos;s saved.
              </p>

              <div className="pc-stepflow__fields">
                <SshKeysField value={access.sshKeys} onChange={(sshKeys) => setAccess((a) => ({ ...a, sshKeys }))} />

                <label className="pc-checkbox">
                  <input
                    type="checkbox"
                    checked={access.disablePasswordSsh}
                    onChange={(e) => setAccess((a) => ({ ...a, disablePasswordSsh: e.target.checked }))}
                  />
                  <span className="pc-checkbox__box" />
                  <span>
                    <span className="code pc-checkbox__label">turn off password logins over ssh</span>
                    <span className="body-sm pc-checkbox__hint">
                      ssh takes the key only — the web ui and the console still take the root password. applied when
                      the cluster is configured, after the install
                    </span>
                  </span>
                </label>

                <div className="flex flex-col border border-border bg-surface-100 p-5" style={{ gap: "var(--space-4)" }}>
                  <p className="label text-ink-muted">root passwords</p>
                  <p className="body-sm text-ink-muted">
                    one per node, for the web ui (root@pam) and the console. the answer files only ever carry a
                    hash of it.
                  </p>
                  {nodes.map((node, i) => (
                    <SecretField
                      key={i}
                      id={`rootpw-${i}`}
                      label={`root password — ${node.network.hostLabel || node.name}`}
                      hint={`at least ${MIN_ROOT_PASSWORD} characters — or generate one, and keep it in your password manager`}
                      value={rootPasswordFor(access, i)}
                      validate={validateRootPassword}
                      onChange={(value) => setRootPassword(i, value)}
                      onGenerate={() => setRootPassword(i, generatePassword())}
                      required
                    />
                  ))}
                </div>

                <label className="pc-checkbox">
                  <input
                    type="checkbox"
                    checked={access.oidc.enabled}
                    onChange={(e) => setOidc({ enabled: e.target.checked })}
                  />
                  <span className="pc-checkbox__box" />
                  <span>
                    <span className="code pc-checkbox__label">sign in to the web ui with oidc (optional)</span>
                    <span className="body-sm pc-checkbox__hint">
                      log in through your identity provider — authentik, keycloak, authelia… root@pam keeps working
                      alongside it, for when the provider is down
                    </span>
                  </span>
                </label>

                {access.oidc.enabled && (
                  <div className="flex flex-col border border-border bg-surface-100 p-5" style={{ gap: "var(--space-4)" }}>
                    <p className="label text-ink-muted">openid connect</p>
                    <CheckedTextField
                      id="oidc-realm"
                      label="realm"
                      hint="the name people pick on the login screen — also the part after the @ in their user name"
                      value={access.oidc.realm}
                      validate={validateRealm}
                      onChange={(realm) => setOidc({ realm })}
                    />
                    <CheckedTextField
                      id="oidc-issuer"
                      label="issuer url"
                      hint="your provider's issuer — proxmox finds everything else under /.well-known/openid-configuration"
                      placeholder="https://auth.example.com/realms/homelab"
                      value={access.oidc.issuerUrl}
                      validate={validateIssuerUrl}
                      onChange={(issuerUrl) => setOidc({ issuerUrl })}
                    />
                    <CheckedTextField
                      id="oidc-client-id"
                      label="client id"
                      hint="the client you created for proxmox at the provider"
                      placeholder="proxmox"
                      value={access.oidc.clientId}
                      validate={validateClientId}
                      onChange={(clientId) => setOidc({ clientId })}
                    />
                    <SecretField
                      id="oidc-client-secret"
                      label="client secret"
                      hint="leave blank for a public client — encrypted like the passwords"
                      value={access.oidc.clientSecret}
                      onChange={(clientSecret) => setOidc({ clientSecret })}
                    />
                    <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
                      <legend className="label pc-radio-group__legend">user name from</legend>
                      {USERNAME_CLAIM_OPTIONS.map((opt) => (
                        <label key={opt.value} className="pc-radio">
                          <input
                            type="radio"
                            name="oidc-claim"
                            checked={access.oidc.usernameClaim === opt.value}
                            onChange={() => setOidc({ usernameClaim: opt.value })}
                          />
                          <span className="pc-radio__box" />
                          <span>
                            <span className="code pc-radio__label">{opt.label}</span>
                            <span className="body-sm pc-checkbox__hint">{opt.hint}</span>
                          </span>
                        </label>
                      ))}
                    </fieldset>
                    <label className="pc-checkbox">
                      <input
                        type="checkbox"
                        checked={access.oidc.autocreate}
                        onChange={(e) => setOidc({ autocreate: e.target.checked })}
                      />
                      <span className="pc-checkbox__box" />
                      <span>
                        <span className="code pc-checkbox__label">create users on first login</span>
                        <span className="body-sm pc-checkbox__hint">
                          they start with no permissions — grant them in the proxmox ui
                        </span>
                      </span>
                    </label>
                    <label className="pc-checkbox">
                      <input
                        type="checkbox"
                        checked={access.oidc.isDefault}
                        onChange={(e) => setOidc({ isDefault: e.target.checked })}
                      />
                      <span className="pc-checkbox__box" />
                      <span>
                        <span className="code pc-checkbox__label">preselect it on the login screen</span>
                        <span className="body-sm pc-checkbox__hint">root@pam is still one click away</span>
                      </span>
                    </label>
                    <div className="pc-callout pc-callout--info">
                      <span className="code pc-callout__glyph">#</span>
                      <div className="pc-callout__body">
                        <p className="body-sm pc-callout__text">
                          register these redirect uris with the client at your provider — proxmox sends people back
                          to whichever node they logged in on:
                        </p>
                        <ul className="pc-urilist">
                          {oidcRedirectUris(nodes, hostnameSuffix).map((uri) => (
                            <li key={uri} className="code body-sm">
                              {uri}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>
                )}

                {accessHints
                  .filter((hint): hint is Hint => hint !== null)
                  .map((hint, i) => (
                    <div key={i} className={`pc-callout pc-callout--${hint.tone}`}>
                      <span className="code pc-callout__glyph">{hint.glyph}</span>
                      <div className="pc-callout__body">
                        <p className="body-sm pc-callout__text">{hint.text}</p>
                      </div>
                    </div>
                  ))}
              </div>

              {revealErrors && <ProblemList problems={blocking} step={currentStep} />}
              <div className="pc-stepflow__nav">
                <button type="button" className="pc-btn" onClick={() => setCurrentStep("backups")}>
                  <span className="pc-btn__bracket">[</span>
                  back
                  <span className="pc-btn__bracket">]</span>
                </button>
                <button type="button" className="pc-btn pc-btn--primary" onClick={() => tryPreview("access")}>
                  <span className="pc-btn__bracket">[</span>
                  preview
                  <span className="pc-btn__bracket">]</span>
                </button>
              </div>
            </div>
          )}
          {currentStep === "software" && (
            <div className="pc-stepflow__card">
              <p className="meta pc-stepflow__meta"># step 7 of 8</p>
              <h2 className="h2 pc-stepflow__title">software</h2>
              <p className="body pc-stepflow__intro">
                The vms and containers the cluster runs. Optional — skip it, and
                add them later. Every choice below comes from the steps before:
                a guest can only live on storage step 4 builds and join a bridge
                step 3 set up for vm traffic. They&apos;re created when the
                cluster is configured, after the install.
              </p>

              <div className="pc-stepflow__fields">
                <div className="flex flex-wrap" style={{ gap: "var(--space-2)" }}>
                  <button type="button" className="pc-btn" onClick={() => addGuests([newGuest("vm", guests, guestCtx)])}>
                    <span className="pc-btn__bracket">[</span>+ vm
                    <span className="pc-btn__bracket">]</span>
                  </button>
                  <button
                    type="button"
                    className="pc-btn"
                    onClick={() => addGuests([newGuest("container", guests, guestCtx)])}
                  >
                    <span className="pc-btn__bracket">[</span>+ container
                    <span className="pc-btn__bracket">]</span>
                  </button>
                  <button type="button" className="pc-btn" onClick={() => setK8sDraft(currentK8sLayout(guests, nodes.length))}>
                    <span className="pc-btn__bracket">[</span>
                    {k8sPlanned > 0 ? "re-plan kubernetes" : "+ kubernetes"}
                    <span className="pc-btn__bracket">]</span>
                  </button>
                </div>

                {k8sDraft ? (
                  <KubernetesPlanner
                    layout={k8sDraft}
                    nodes={nodes}
                    planned={k8sPlanned}
                    onChange={setK8sDraft}
                    onApply={() => applyK8s(k8sDraft)}
                    onCancel={() => setK8sDraft(null)}
                  />
                ) : (
                  <KubernetesStorage
                    guests={guests}
                    cephBuilt={activeStorage.ceph}
                    plan={software.kubernetes}
                    onChange={(patch) => setSoftware((sw) => ({ ...sw, kubernetes: { ...sw.kubernetes, ...patch } }))}
                  />
                )}

                {/* what's left to plan with — live, as guests come and go */}
                <div className="pc-roomleft">
                  <p className="label text-ink-muted">room left</p>
                  {cephMeter(guests, guestCtx) && <MeterBar meter={cephMeter(guests, guestCtx)!} unit="gb" compact />}
                  <div className="pc-roomleft__nodes">
                    {nodes.map((node, i) => (
                      <div key={i} className="pc-roomleft__node">
                        <p className="code pc-roomleft__host">{node.network.hostLabel || node.name}</p>
                        <MeterBar meter={memoryMeter(i, guests, guestCtx)} unit="gib" compact />
                        {zfsMeter(i, guests, guestCtx) && <MeterBar meter={zfsMeter(i, guests, guestCtx)!} unit="gb" compact />}
                        {localMeter(i, guests, guestCtx) && <MeterBar meter={localMeter(i, guests, guestCtx)!} unit="gb" compact />}
                        <MeterBar meter={bootDiskMeter(i, guests, guestCtx)} unit="gb" compact />
                      </div>
                    ))}
                  </div>
                  <p className="meta text-ink-dim">
                    after proxmox, ceph and the zfs cache take their share — estimates; the preview breaks them down
                  </p>
                </div>

                {guests.length === 0 && (
                  <p className="body-sm pc-field__hint">
                    no vms or containers yet — add some above, or skip this step.
                  </p>
                )}

                {guests.map((guest) => (
                  <GuestCard
                    key={guest.id}
                    guest={guest}
                    guests={guests}
                    ctx={guestCtx}
                    hasAccessKeys={sshKeyLines(access.sshKeys).length > 0}
                    onReplace={replaceGuest}
                    onRemove={() => removeGuest(guest.id)}
                  />
                ))}

                {softwareHints
                  .filter((hint): hint is Hint => hint !== null)
                  .map((hint, i) => (
                    <div key={i} className={`pc-callout pc-callout--${hint.tone}`}>
                      <span className="code pc-callout__glyph">{hint.glyph}</span>
                      <div className="pc-callout__body">
                        <p className="body-sm pc-callout__text">{hint.text}</p>
                      </div>
                    </div>
                  ))}
              </div>

              {revealErrors && <ProblemList problems={blocking} step={currentStep} />}
              <div className="pc-stepflow__nav">
                <button type="button" className="pc-btn" onClick={() => setCurrentStep("access")}>
                  <span className="pc-btn__bracket">[</span>
                  back
                  <span className="pc-btn__bracket">]</span>
                </button>
                {guests.length === 0 ? (
                  <button type="button" className="pc-btn pc-btn--primary" onClick={() => tryNext("install")}>
                    <span className="pc-btn__bracket">[</span>
                    skip
                    <span className="pc-btn__bracket">]</span>
                  </button>
                ) : (
                  <button type="button" className="pc-btn pc-btn--primary" onClick={() => tryPreview("software")}>
                    <span className="pc-btn__bracket">[</span>
                    preview
                    <span className="pc-btn__bracket">]</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {currentStep === "install" && (
            <div className="pc-stepflow__card">
              <p className="meta pc-stepflow__meta"># step 8 of 8</p>
              <h2 className="h2 pc-stepflow__title">install</h2>
              <p className="body pc-stepflow__intro">
                That&apos;s the whole setup. Everything a node needs to install
                itself is in its answer file: baked into the proxmox iso, it
                installs the node unattended, reachable at its address from
                step 3. The rest — ssh hardening, oidc,
                backups{guests.length > 0 ? ", the vms and containers" : ""} — is
                applied when the cluster is configured, after the install.
              </p>

              <div className="pc-stepflow__fields">
                {blocking.length > 0 && <ProblemList problems={blocking} step={currentStep} />}
                <InstallGuide state={snapshot} blocked={blocking.length > 0} onInstallChange={setInstall} />
              </div>

              <div className="pc-stepflow__nav">
                <button type="button" className="pc-btn" onClick={() => setCurrentStep("software")}>
                  <span className="pc-btn__bracket">[</span>
                  back
                  <span className="pc-btn__bracket">]</span>
                </button>
              </div>
            </div>
          )}
          </RevealErrorsContext.Provider>

        </div>
      </main>
    </div>
  );
}
