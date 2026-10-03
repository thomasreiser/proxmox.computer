"use client";

// One vm or container in step 7, in the detail proxmox's own create
// dialogs ask for. The essentials sit open; everything proxmox tucks
// behind "advanced" sits in collapsed sections. Every list only offers
// what this guest's node (or, highly available, every node) can do, and
// every edit is re-checked against that before it lands (see normalize).

import type { ReactNode } from "react";
import { Check, CheckedTextField, CidrField, Select } from "./form-fields";
import { clusterCpuBaseline } from "./cpu";
import type { Hint } from "./hints";
import {
  BIOS_OPTIONS,
  BUS_OPTIONS,
  CACHE_OPTIONS,
  DISPLAY_OPTIONS,
  MACHINE_OPTIONS,
  NIC_MODEL_OPTIONS,
  OS_TYPE_OPTIONS,
  SCSI_CONTROLLER_OPTIONS,
  bridgeOptions,
  bridgeSubnet,
  busProblems,
  effectiveDiskStorage,
  effectiveGuestCpuType,
  effectiveGuestNode,
  guestCpuTypeOptions,
  haAvailable,
  imagesFor,
  iothreadPossible,
  newDisk,
  newNic,
  nicSubnetHint,
  normalizeGuest,
  ssdPossible,
  storageOptions,
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
  vcpuHint,
  type GuestContext,
  type GuestDisk,
  type GuestNic,
  type GuestPlan,
} from "./software";

/** a section proxmox keeps under "advanced" — closed until it's wanted */
function Section({ title, summary, open = false, children }: { title: string; summary: string; open?: boolean; children: ReactNode }) {
  return (
    <details className="pc-guestsec" open={open}>
      <summary className="pc-guestsec__summary">
        <span className="label">{title}</span>
        <span className="meta pc-guestsec__glance">{summary}</span>
      </summary>
      <div className="pc-guestsec__body">{children}</div>
    </details>
  );
}

function Callouts({ hints }: { hints: (Hint | null)[] }) {
  return (
    <>
      {hints
        .filter((h): h is Hint => h !== null)
        .map((h, i) => (
          <div key={i} className={`pc-callout pc-callout--${h.tone}`}>
            <span className="code pc-callout__glyph">{h.glyph}</span>
            <div className="pc-callout__body">
              <p className="body-sm pc-callout__text">{h.text}</p>
            </div>
          </div>
        ))}
    </>
  );
}

export function GuestCard({
  guest,
  guests,
  ctx,
  hasAccessKeys,
  onReplace,
  onRemove,
}: {
  guest: GuestPlan;
  guests: GuestPlan[];
  ctx: GuestContext;
  // step 6 has keys to hand on
  hasAccessKeys: boolean;
  onReplace: (next: GuestPlan) => void;
  onRemove: () => void;
}) {
  const vm = guest.kind === "vm";
  const kindLabel = vm ? "vm" : "container";
  const id = (field: string) => `guest-${field}-${guest.id}`;
  const nodeIndex = effectiveGuestNode(guest, ctx.nodes.length);
  const node = ctx.nodes[nodeIndex];
  const canHa = haAvailable(guest, ctx);
  const ha = guest.ha && canHa;
  const bridges = bridgeOptions(ctx, nodeIndex, ha);
  const stores = storageOptions(ctx, nodeIndex);
  const cloud = takesCloudInit(guest);
  const taken = (field: "name" | "vmid", value: string) => guests.some((g) => g.id !== guest.id && g[field] === value);

  const change = (patch: Partial<GuestPlan>) => onReplace(normalizeGuest({ ...guest, ...patch }, ctx));
  const changeDisk = (diskId: string, patch: Partial<GuestDisk>) =>
    change({ disks: guest.disks.map((d) => (d.id === diskId ? { ...d, ...patch } : d)) });
  const changeNic = (nicId: string, patch: Partial<GuestNic>) =>
    change({ nics: guest.nics.map((n) => (n.id === nicId ? { ...n, ...patch } : n)) });

  // the cpu type: "" follows step 2's cluster baseline; the rest are what
  // every node this guest may run on can run
  const cpuOptions = guestCpuTypeOptions(guest, ctx);
  const baseline = clusterCpuBaseline(ctx.nodes);
  const cpuChoices = [
    { value: "", label: `${baseline} — the cluster's baseline from step 2, every node runs it` },
    ...cpuOptions
      .filter((t) => t !== baseline)
      .map((t) => ({
        value: t,
        label:
          t === "host"
            ? "host — this node's own cpu, fastest, can't migrate to a different one"
            : t === "x86-64-v2-AES"
              ? "x86-64-v2-AES — proxmox's own default"
              : t,
      })),
  ];
  const cpuValue = cpuOptions.includes(guest.cpuType) ? guest.cpuType : "";

  return (
    <div className="flex flex-col border border-border bg-surface-100 p-5" style={{ gap: "var(--space-4)" }}>
      <div className="flex items-baseline justify-between" style={{ gap: "var(--space-3)" }}>
        <p className="label text-ink-muted">
          {kindLabel} {guest.vmid} — {guest.name || "unnamed"}
        </p>
        <button type="button" className="pc-btn pc-btn--ghost" onClick={onRemove}>
          remove {guest.name || kindLabel}
        </button>
      </div>

      {/* the essentials — what proxmox's dialogs ask on every tab's first line */}
      <CheckedTextField
        id={id("name")}
        label="name"
        hint="its hostname — lowercase letters, digits and hyphens"
        value={guest.name}
        validate={(v) => validateGuestName(v) ?? (taken("name", v) ? "another guest has this name" : null)}
        onChange={(name) => change({ name })}
      />
      <CheckedTextField
        id={id("vmid")}
        label="vmid"
        hint="proxmox's number for it — unique across the cluster, 100 and up"
        value={guest.vmid}
        validate={(v) => validateVmid(v) ?? (taken("vmid", v) ? "another guest has this vmid" : null)}
        onChange={(vmid) => change({ vmid })}
      />
      <Select
        id={id("image")}
        label={vm ? "image" : "template"}
        hint={
          vm
            ? cloud
              ? "a cloud image: boots straight into a configured system, set up through cloud-init"
              : "an empty vm — its installer sets up the network and logins"
            : "proxmox's own container templates, downloaded when it's created"
        }
        value={guest.image}
        options={imagesFor(guest.kind).map((i) => ({ value: i.id, label: i.label }))}
        onChange={(image) => change({ image })}
      />
      {ctx.nodes.length > 1 && (
        <Select
          id={id("node")}
          label="node"
          hint={ha ? "where it runs — and where it goes back to after a failover" : "where it runs"}
          value={String(nodeIndex)}
          options={ctx.nodes.map((n, i) => ({ value: String(i), label: n.network.hostLabel || n.name }))}
          onChange={(value) => change({ node: value })}
        />
      )}
      {canHa ? (
        <Check
          label="high availability"
          hint="if its node fails, another starts it — every disk is on storage the other nodes reach"
          checked={ha}
          onChange={(v) => change({ ha: v })}
        />
      ) : (
        ctx.nodes.length > 1 && (
          <p className="body-sm pc-field__hint">
            {guest.k8sRole
              ? "no high availability — it's a kubernetes node: kubernetes moves its pods to the other nodes itself"
              : "no high availability — a disk lives on this node only, so no other node could start it"}
          </p>
        )
      )}
      {vm && (
        <CheckedTextField
          id={id("sockets")}
          label="sockets"
          hint="cpu sockets it sees — leave at 1 unless software licenses per socket"
          value={guest.sockets}
          validate={validateSockets}
          onChange={(sockets) => change({ sockets })}
        />
      )}
      <CheckedTextField
        id={id("cores")}
        label="cores"
        hint={vm ? "per socket — sharing cores across guests is normal" : "cpu cores — sharing them across guests is normal"}
        value={guest.cores}
        validate={validateCores}
        onChange={(cores) => change({ cores })}
      />
      <CheckedTextField
        id={id("memory")}
        label="memory (gib)"
        hint="the one resource that can't be shared — it adds up against the node's ram"
        value={guest.memoryGb}
        validate={validateMemoryGb}
        onChange={(memoryGb) => change({ memoryGb })}
      />

      <Section
        title="general"
        summary={[guest.startOnBoot ? "starts on boot" : "manual start", guest.tags && `tags: ${guest.tags}`].filter(Boolean).join(" · ")}
      >
        <Check label="start when its node boots" checked={guest.startOnBoot} onChange={(v) => change({ startOnBoot: v })} />
        <CheckedTextField
          id={id("order")}
          label="startup order"
          hint="lower starts first, shuts down last — blank for any"
          value={guest.startupOrder}
          validate={(v) => validateOptionalCount(v, 1000)}
          onChange={(startupOrder) => change({ startupOrder })}
          optional
        />
        <CheckedTextField
          id={id("delay")}
          label="startup delay (s)"
          hint="seconds before the next guest starts"
          value={guest.startupDelay}
          validate={(v) => validateOptionalCount(v, 3600)}
          onChange={(startupDelay) => change({ startupDelay })}
          optional
        />
        <CheckedTextField
          id={id("timeout")}
          label="shutdown timeout (s)"
          hint="how long a clean shutdown gets before it's stopped hard"
          value={guest.shutdownTimeout}
          validate={(v) => validateOptionalCount(v, 86_400)}
          onChange={(shutdownTimeout) => change({ shutdownTimeout })}
          optional
        />
        <CheckedTextField
          id={id("tags")}
          label="tags"
          hint="shown in the proxmox tree — separate with ; or spaces"
          value={guest.tags}
          validate={validateTags}
          onChange={(tags) => change({ tags })}
          optional
        />
        <CheckedTextField
          id={id("notes")}
          label="notes"
          hint="shown on its summary page"
          value={guest.notes}
          validate={() => null}
          onChange={(notes) => change({ notes })}
          optional
        />
      </Section>

      {vm && (
        <Section title="system" summary={`${guest.machine} · ${guest.bios}${guest.tpm ? " · tpm" : ""}${guest.qemuAgent ? " · agent" : ""}`}>
          <Select id={id("ostype")} label="guest os" value={guest.osType} options={OS_TYPE_OPTIONS} onChange={(osType) => change({ osType })} />
          <Select id={id("machine")} label="machine" value={guest.machine} options={MACHINE_OPTIONS} onChange={(machine) => change({ machine })} />
          <Select id={id("bios")} label="bios" value={guest.bios} options={BIOS_OPTIONS} onChange={(bios) => change({ bios })} />
          <Check label="tpm 2.0" hint="a virtual tpm — windows 11 insists on one" checked={guest.tpm} onChange={(v) => change({ tpm: v })} />
          <Select
            id={id("scsihw")}
            label="scsi controller"
            value={guest.scsiController}
            options={SCSI_CONTROLLER_OPTIONS}
            onChange={(scsiController) => change({ scsiController })}
          />
          <Check
            label="qemu guest agent"
            hint="clean shutdowns, frozen snapshots and its ip in the ui — cloud images ship the agent"
            checked={guest.qemuAgent}
            onChange={(v) => change({ qemuAgent: v })}
          />
          <Select id={id("display")} label="display" value={guest.display} options={DISPLAY_OPTIONS} onChange={(display) => change({ display })} />
          <Callouts
            hints={[
              validateOsSystem(guest) ? { tone: "danger", glyph: "✗", text: `${validateOsSystem(guest)}.` } : null,
            ]}
          />
        </Section>
      )}

      <Section
        title="cpu"
        summary={[vm && effectiveGuestCpuType(guest, ctx), guest.cpuLimit && `limit ${guest.cpuLimit}`, guest.cpuUnits && `weight ${guest.cpuUnits}`]
          .filter(Boolean)
          .join(" · ") || "defaults"}
      >
        {vm && (
          <Select
            id={id("cputype")}
            label="cpu type"
            hint={
              ha
                ? "only types every node can run — it may wake up on any of them"
                : `only types ${node?.network.hostLabel || "its node"} can run`
            }
            value={cpuValue}
            options={cpuChoices}
            onChange={(cpuType) => change({ cpuType })}
          />
        )}
        <CheckedTextField
          id={id("cpulimit")}
          label="cpu limit"
          hint="caps it at this many cpus' worth of time, like 1.5 — blank for none"
          value={guest.cpuLimit}
          validate={() => validateCpuLimit(guest)}
          onChange={(cpuLimit) => change({ cpuLimit })}
          optional
        />
        <CheckedTextField
          id={id("cpuunits")}
          label="cpu weight"
          hint="its share when the node is busy, 1–10000 — blank for proxmox's 100"
          value={guest.cpuUnits}
          validate={validateCpuUnits}
          onChange={(cpuUnits) => change({ cpuUnits })}
          optional
        />
        {vm && <Check label="numa" hint="for big vms spanning sockets" checked={guest.numa} onChange={(v) => change({ numa: v })} />}
      </Section>

      <Section
        title="memory"
        summary={vm ? (guest.ballooning ? `balloon down to ${guest.minMemoryGb || "?"} gib` : "fixed") : `swap ${guest.swapGb || 0} gib`}
      >
        {vm ? (
          <>
            <Check
              label="ballooning"
              hint="lets it hand memory back when the node runs short"
              checked={guest.ballooning}
              onChange={(v) => change({ ballooning: v })}
            />
            {guest.ballooning && (
              <CheckedTextField
                id={id("minmem")}
                label="minimum memory (gib)"
                hint="the least it's ever squeezed down to"
                value={guest.minMemoryGb}
                validate={() => validateMinMemoryGb(guest)}
                onChange={(minMemoryGb) => change({ minMemoryGb })}
              />
            )}
          </>
        ) : (
          <CheckedTextField
            id={id("swap")}
            label="swap (gib)"
            hint="on top of its memory — 0 for none"
            value={guest.swapGb}
            validate={validateSwapGb}
            onChange={(swapGb) => change({ swapGb })}
          />
        )}
      </Section>

      <Section
        title="disks"
        summary={guest.disks.map((d) => `${d.sizeGb || "?"} gb on ${effectiveDiskStorage(d, guest, ctx).id}`).join(", ")}
        open
      >
        {guest.disks.map((disk, i) => {
          const label = vm ? `disk ${i + 1}` : i === 0 ? "root disk" : `mount point ${i}`;
          const storage = effectiveDiskStorage(disk, guest, ctx);
          const onZfs = storage.id === ctx.storage.zfs.poolName;
          return (
            <div key={disk.id} className="pc-guestsub">
              <div className="flex items-baseline justify-between">
                <p className="meta text-ink-muted">{label}</p>
                {i > 0 && (
                  <button type="button" className="pc-btn pc-btn--ghost" onClick={() => change({ disks: guest.disks.filter((d) => d.id !== disk.id) })}>
                    remove {label}
                  </button>
                )}
              </div>
              {!vm && i > 0 && (
                <CheckedTextField
                  id={id(`path-${disk.id}`)}
                  label="path"
                  hint="where it appears inside the container"
                  value={disk.mountPath}
                  validate={() => validateMountPath(disk, i)}
                  onChange={(mountPath) => changeDisk(disk.id, { mountPath })}
                />
              )}
              <Select
                id={id(`storage-${disk.id}`)}
                label="storage"
                hint="only the storage this node has — step 4 decides what exists"
                value={storage.id}
                options={stores.map((o) => ({ value: o.id, label: o.label }))}
                onChange={(value) => changeDisk(disk.id, { storage: value })}
              />
              <CheckedTextField
                id={id(`size-${disk.id}`)}
                label="size (gb)"
                hint="thin-provisioned — it only takes what's actually written"
                value={disk.sizeGb}
                validate={validateDiskGb}
                onChange={(sizeGb) => changeDisk(disk.id, { sizeGb })}
              />
              {vm && (
                <>
                  <Select id={id(`bus-${disk.id}`)} label="bus" value={disk.bus} options={BUS_OPTIONS} onChange={(bus) => changeDisk(disk.id, { bus })} />
                  <Select id={id(`cache-${disk.id}`)} label="cache" value={disk.cache} options={CACHE_OPTIONS} onChange={(cache) => changeDisk(disk.id, { cache })} />
                  <Check
                    label="discard"
                    hint="passes trims to thin storage, so deleted files free space"
                    checked={disk.discard}
                    onChange={(v) => changeDisk(disk.id, { discard: v })}
                  />
                  {ssdPossible(disk) && (
                    <Check label="ssd emulation" hint="tells the guest it's on an ssd" checked={disk.ssd} onChange={(v) => changeDisk(disk.id, { ssd: v })} />
                  )}
                  {iothreadPossible(disk, guest) ? (
                    <Check label="io thread" hint="its own thread for disk io" checked={disk.iothread} onChange={(v) => changeDisk(disk.id, { iothread: v })} />
                  ) : (
                    <p className="body-sm pc-field__hint">io threads need virtio block, or scsi on the virtio scsi single controller</p>
                  )}
                </>
              )}
              {(vm || i > 0) && (
                <Check label="include in backups" checked={disk.backup} onChange={(v) => changeDisk(disk.id, { backup: v })} />
              )}
              {onZfs && (
                <Check
                  label="replicate"
                  hint="copied to the other nodes' zfs pools with the rest"
                  checked={disk.replicate}
                  onChange={(v) => changeDisk(disk.id, { replicate: v })}
                />
              )}
            </div>
          );
        })}
        {busProblems(guest) && <p className="body-sm pc-field__hint">{busProblems(guest)}</p>}
        <div>
          <button
            type="button"
            className="pc-btn"
            onClick={() =>
              change({
                disks: [...guest.disks, newDisk(stores[0].id, { sizeGb: vm ? "32" : "16", mountPath: vm ? "/" : `/mnt/data${guest.disks.length}` })],
              })
            }
          >
            <span className="pc-btn__bracket">[</span>+ {vm ? "disk" : "mount point"}
            <span className="pc-btn__bracket">]</span>
          </button>
        </div>
      </Section>

      <Section
        title="network"
        summary={guest.nics.length === 0 ? "no network" : guest.nics.map((n) => `${n.bridge}${n.vlanTag ? `.${n.vlanTag}` : ""}`).join(", ")}
        open
      >
        {guest.nics.length === 0 && <p className="body-sm pc-field__hint">no network device</p>}
        {guest.nics.map((nic, i) => {
          const subnet = node ? bridgeSubnet(node, nic.bridge) : null;
          const addressed = !vm || cloud;
          return (
            <div key={nic.id} className="pc-guestsub">
              <div className="flex items-baseline justify-between">
                <p className="meta text-ink-muted">{vm ? `nic ${i + 1}` : `eth${i}`}</p>
                <button type="button" className="pc-btn pc-btn--ghost" onClick={() => change({ nics: guest.nics.filter((n) => n.id !== nic.id) })}>
                  remove {vm ? `nic ${i + 1}` : `eth${i}`}
                </button>
              </div>
              <Select
                id={id(`bridge-${nic.id}`)}
                label="bridge"
                hint={
                  bridges.length === 0
                    ? "no bridge here carries vm traffic — give one that purpose in step 3"
                    : ha
                      ? "only bridges every node has — it may wake up on any of them"
                      : "the bridges step 3 set up for vm traffic"
                }
                value={nic.bridge}
                options={bridges.map((b) => ({ value: b, label: b }))}
                onChange={(bridge) => changeNic(nic.id, { bridge })}
              />
              <CheckedTextField
                id={id(`vlan-${nic.id}`)}
                label="vlan tag"
                hint="tags its traffic on the bridge; blank rides the bridge's own network"
                value={nic.vlanTag}
                validate={validateGuestVlan}
                onChange={(vlanTag) => changeNic(nic.id, { vlanTag })}
                optional
              />
              {vm && <Select id={id(`model-${nic.id}`)} label="model" value={nic.model} options={NIC_MODEL_OPTIONS} onChange={(model) => changeNic(nic.id, { model })} />}
              <Check label="firewall" hint="proxmox's firewall on this interface" checked={nic.firewall} onChange={(v) => changeNic(nic.id, { firewall: v })} />
              <CheckedTextField
                id={id(`mac-${nic.id}`)}
                label="mac address"
                hint="blank — proxmox makes one"
                value={nic.macAddress}
                validate={validateMac}
                onChange={(macAddress) => changeNic(nic.id, { macAddress })}
                optional
              />
              <CheckedTextField
                id={id(`rate-${nic.id}`)}
                label="rate limit (mb/s)"
                hint="blank — no limit"
                value={nic.rateMbps}
                validate={validateRate}
                onChange={(rateMbps) => changeNic(nic.id, { rateMbps })}
                optional
              />
              <CheckedTextField
                id={id(`mtu-${nic.id}`)}
                label="mtu"
                hint="blank — the bridge's"
                value={nic.mtu}
                validate={validateMtu}
                onChange={(mtu) => changeNic(nic.id, { mtu })}
                optional
              />
              {addressed ? (
                <>
                  <fieldset className="pc-radio-group" style={{ border: 0, margin: 0, padding: 0 }}>
                    <legend className="label pc-radio-group__legend">address{vm ? " (through cloud-init)" : ""}</legend>
                    {(["dhcp", "static", "none"] as const).map((mode) => (
                      <label key={mode} className="pc-radio">
                        <input type="radio" name={id(`ipmode-${nic.id}`)} checked={nic.ipMode === mode} onChange={() => changeNic(nic.id, { ipMode: mode })} />
                        <span className="pc-radio__box" />
                        <span className="code pc-radio__label">{mode === "none" ? "none — set it inside" : mode}</span>
                      </label>
                    ))}
                  </fieldset>
                  {nic.ipMode === "static" && (
                    <>
                      <CidrField
                        id={id(`ip-${nic.id}`)}
                        label="static ip"
                        value={nic.ip}
                        onChange={(ip) => changeNic(nic.id, { ip })}
                        placeholder={subnet ? subnet.replace(/\.0\//, ".50/") : "10.0.10.50/24"}
                        error={validateNicIp(nic)}
                        hint={subnet ? `on ${nic.bridge}, whose network is ${subnet}` : "the guest's address and its network's prefix"}
                        defaultPrefix={Number(subnet?.split("/")[1]) || 24}
                        host
                        required
                      />
                      <CheckedTextField
                        id={id(`gw-${nic.id}`)}
                        label="gateway"
                        hint="blank for none — only one interface should have one"
                        value={nic.gateway}
                        validate={() => validateNicGateway(nic)}
                        onChange={(gateway) => changeNic(nic.id, { gateway })}
                        optional
                      />
                    </>
                  )}
                </>
              ) : (
                <p className="body-sm pc-field__hint">its address is set in its own installer — only cloud images take one from here</p>
              )}
              <Callouts hints={[nicSubnetHint(nic, guest, ctx)]} />
            </div>
          );
        })}
        <div>
          <button
            type="button"
            className="pc-btn"
            onClick={() => change({ nics: [...guest.nics, newNic(bridges[0] ?? "", { firewall: true })] })}
          >
            <span className="pc-btn__bracket">[</span>+ network device
            <span className="pc-btn__bracket">]</span>
          </button>
        </div>
      </Section>

      {!vm && (
        <Section
          title="container"
          summary={[guest.unprivileged ? "unprivileged" : "privileged", guest.nesting && "nesting", guest.fuse && "fuse", guest.keyctl && "keyctl"]
            .filter(Boolean)
            .join(" · ")}
        >
          <Check
            label="unprivileged"
            hint="root inside isn't root on the node — the safe default"
            checked={guest.unprivileged}
            onChange={(v) => change({ unprivileged: v })}
          />
          <Check label="nesting" hint="containers inside it — docker, systemd's own sandboxing" checked={guest.nesting} onChange={(v) => change({ nesting: v })} />
          <Check label="fuse" hint="fuse mounts inside it — sshfs, appimages" checked={guest.fuse} onChange={(v) => change({ fuse: v })} />
          {guest.unprivileged && (
            <Check label="keyctl" hint="the keyring syscalls docker in an unprivileged container needs" checked={guest.keyctl} onChange={(v) => change({ keyctl: v })} />
          )}
        </Section>
      )}

      <Section title="login" summary={guest.useAccessKeys && hasAccessKeys ? "step 6's ssh keys" : "no keys"}>
        {vm && !cloud ? (
          <p className="body-sm pc-field__hint">an iso install sets up its own users — there&apos;s nothing to hand it from here</p>
        ) : (
          <>
            <Check
              label="step 6's ssh keys"
              hint={vm ? "for its cloud-init user" : "for root inside it"}
              checked={guest.useAccessKeys}
              onChange={(v) => change({ useAccessKeys: v })}
            />
            {vm && (
              <CheckedTextField
                id={id("ciuser")}
                label="user"
                hint="the account cloud-init creates — log in as it, then sudo"
                value={guest.ciUser}
                validate={() => validateCiUser(guest)}
                onChange={(ciUser) => change({ ciUser })}
              />
            )}
          </>
        )}
      </Section>

      <Callouts hints={[vcpuHint(guest, ctx)]} />
    </div>
  );
}
