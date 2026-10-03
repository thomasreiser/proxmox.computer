"use client";

import type { ReactNode } from "react";
import { AnswerFilesPanel } from "./answer-files-panel";
import { DISK_PLACEHOLDER, LSBLK_COMMAND, PROXMOX_VERSION } from "./answer-file";
import { bootDiskTypeHint, validateBootDiskName, withNodeBootDisk } from "./boot-disk";
import { CheckedTextField } from "./form-fields";
import {
  AUTO_INSTALL_DOCS_URL,
  ISO_FILE,
  ISO_SHA256,
  ISO_URL,
  PROXMOX_DOWNLOADS_URL,
  checksumCommand,
  exampleDiskName,
  nodeInstalls,
  type NodeInstall,
} from "./install";
import type { InstallPlan, PersistedState } from "./wizard-state";

/**
 * Step 8: from the setup to installed nodes, in the order it's done — get
 * the iso, find each boot disk on the machine, name it here, download the
 * answer files with it written in, build one iso per node, boot it.
 * Everything computed lives in install.ts and boot-disk.ts.
 */
export function InstallGuide({
  state,
  blocked,
  onInstallChange,
}: {
  state: PersistedState;
  blocked: boolean;
  onInstallChange: (update: (plan: InstallPlan) => InstallPlan) => void;
}) {
  const nodes = nodeInstalls(state);
  const missing = nodes.filter((n) => !n.bootDisk.name);

  return (
    <ol className="flex flex-col" style={{ gap: "var(--space-4)", listStyle: "none", margin: 0, padding: 0 }} aria-label="install, step by step">
      <GuideStep n={1} title={`get proxmox ve ${PROXMOX_VERSION}`}>
        <p className="body-sm text-ink-muted">
          The answer files are written for Proxmox VE {PROXMOX_VERSION}. Download its installer,{" "}
          <a className="pc-link" href={ISO_URL} target="_blank" rel="noopener noreferrer">
            {ISO_FILE}
          </a>
          , straight from proxmox (also listed on their{" "}
          <a className="pc-link" href={PROXMOX_DOWNLOADS_URL} target="_blank" rel="noopener noreferrer">
            download page
          </a>
          ), and check it arrived intact: the command prints <span className="code">OK</span> only
          for the exact file proxmox published.
        </p>
        <Command text={checksumCommand("sha256sum")} />
        <p className="body-sm text-ink-muted">On macos:</p>
        <Command text={checksumCommand("shasum")} />
        <p className="body-sm text-ink-muted">
          The expected sha256 is <span className="code" style={{ overflowWrap: "anywhere" }}>{ISO_SHA256}</span>.
        </p>
      </GuideStep>

      <GuideStep n={2} title="find each node's boot disk">
        <p className="body-sm text-ink-muted">
          The installer wipes the disk its answer file names, and the wizard
          never guesses which one that is. Look on the machine itself: write{" "}
          <span className="code">{ISO_FILE}</span> to a usb stick (see step 6),
          boot the node from it and pick{" "}
          <strong>Advanced Options → Install Proxmox VE (Terminal UI, Debug Mode)</strong>.
          It stops at a shell before anything is written. List the disks there,
          note the boot disk&apos;s <span className="code">NAME</span>, then
          switch the machine off: nothing has been installed.
        </p>
        <Command text={LSBLK_COMMAND} />
        {/* a list, not a table: what to look for is a sentence, and it has to
            fit a phone next to the node's name */}
        <ul className="flex flex-col border border-border" aria-label="boot disks to look for" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {nodes.map((node, i) => (
            <li
              key={node.answerFile}
              className={`flex flex-col px-3 py-2${i > 0 ? " border-t border-border" : ""}`}
              style={{ gap: "var(--space-1)" }}
            >
              <span className="body-sm code">
                {node.fqdn} — {node.bootDisk.type}, {node.bootDisk.sizeGb ? `${node.bootDisk.sizeGb} gb` : "size not set"}
              </span>
              <span className="body-sm text-ink-muted">
                {node.bootDisk.lsblkSize && <span className="code">SIZE ≈ {node.bootDisk.lsblkSize}; </span>}
                {node.bootDisk.clue}
              </span>
              {node.bootDisk.lookalikes > 0 && (
                <span className="body-sm pc-field__meaning pc-field__meaning--warn">
                  ⚠ {node.bootDisk.lookalikes === 1 ? "another disk looks" : `${node.bootDisk.lookalikes} other disks look`} the
                  same — tell them apart by MODEL or SERIAL
                </span>
              )}
            </li>
          ))}
        </ul>
        <p className="body-sm text-ink-muted">
          lsblk counts in binary units, so a disk sold as 512 gb shows as about 477G.
        </p>
      </GuideStep>

      <GuideStep n={3} title="name the boot disk">
        <p className="body-sm text-ink-muted">
          {state.identicalHardware
            ? "The nodes' hardware is identical (step 2), so one name covers them all — the one lsblk printed, without /dev/."
            : "The NAME lsblk printed on each node, without /dev/."}{" "}
          It goes straight into the answer files below. Leave one empty and that
          node&apos;s file keeps <span className="code">{DISK_PLACEHOLDER}</span>,
          which stops its install until you fill it in.
        </p>
        <div className="pc-stepflow__fields">
          {state.identicalHardware ? (
            <BootDiskField
              id="boot-disk"
              label="boot disk — every node"
              node={nodes[0]}
              value={state.install.bootDisk}
              onChange={(bootDisk) => onInstallChange((plan) => ({ ...plan, bootDisk }))}
            />
          ) : (
            nodes.map((node, i) => (
              <BootDiskField
                key={node.answerFile}
                id={`boot-disk-${i}`}
                label={`boot disk — ${node.fqdn}`}
                node={node}
                value={state.install.bootDisks[i] ?? ""}
                onChange={(value) => onInstallChange((plan) => withNodeBootDisk(plan, i, value))}
              />
            ))
          )}
        </div>
      </GuideStep>

      <GuideStep n={4} title="download the answer files">
        <AnswerFilesPanel state={state} blocked={blocked} />
        {missing.length === 0 ? (
          <p className="body-sm text-ink-muted">
            Each file already names its node&apos;s boot disk under{" "}
            <span className="code">[disk-setup]</span>. Nothing to edit by hand.
          </p>
        ) : (
          <p className="body-sm pc-field__meaning pc-field__meaning--warn">
            ⚠ no boot disk named yet for {missing.map((n) => n.fqdn).join(", ")}: {missing.length === 1 ? "its file keeps" : "their files keep"}{" "}
            <span className="code">disk-list = [&quot;{DISK_PLACEHOLDER}&quot;]</span> and the install stops there. Name{" "}
            {missing.length === 1 ? "it" : "them"} in step 3, or edit the file.
          </p>
        )}
        <p className="body-sm text-ink-muted">
          Names can shuffle between boots on a machine with several disks. To
          pin a disk for certain, replace its file&apos;s{" "}
          <span className="code">disk-list</span> line with the disk&apos;s
          serial, as the file shows: <span className="code">filter.ID_SERIAL = &quot;*S5GXNF0R123456*&quot;</span>.
          Leave the rest as it is, including the long last line: that&apos;s
          your encrypted setup, which reopens it later.
        </p>
      </GuideStep>

      <GuideStep n={5} title="build one iso per node">
        <p className="body-sm text-ink-muted">
          Proxmox&apos;s <span className="code">proxmox-auto-install-assistant</span>{" "}
          checks each file and bakes it into its own copy of the iso. It runs on
          linux: any proxmox ve host, or debian with the proxmox package
          repository added (a vm or container is fine on macos and windows).
          Put the iso and the answer files in one folder and run:
        </p>
        <Command text="apt install proxmox-auto-install-assistant xorriso" />
        {nodes.map((node) => (
          <div key={node.answerFile} className="flex flex-col" style={{ gap: "var(--space-2)" }}>
            <p className="label text-ink-muted">{node.fqdn}</p>
            <Command text={node.validate} />
            <Command text={node.prepareIso} />
          </div>
        ))}
        <p className="body-sm text-ink-muted">
          validate-answer stops on a typo or a missing value before it costs you
          a boot. Details in proxmox&apos;s{" "}
          <a className="pc-link" href={AUTO_INSTALL_DOCS_URL} target="_blank" rel="noopener noreferrer">
            automated installation guide
          </a>
          .
        </p>
      </GuideStep>

      <GuideStep n={6} title="write it to a usb stick and boot">
        <p className="body-sm text-ink-muted">
          Write each node&apos;s iso to a usb stick with balenaEtcher, Rufus (in
          dd image mode) or <span className="code">dd</span>, and boot the node
          from it. The boot menu starts the automated install on its own after
          a few seconds. The node installs, then reboots into proxmox.
        </p>
        <div className="pc-callout pc-callout--warning">
          <span className="code pc-callout__glyph">⚠</span>
          <div className="pc-callout__body">
            <p className="body-sm pc-callout__text">
              Take the stick out once the install finishes, or put the boot disk
              first in the boot order. Otherwise the node boots the stick again
              and installs over itself.
            </p>
          </div>
        </div>
        <p className="body-sm text-ink-muted">
          Each node then answers at its address from step 3. Log in as{" "}
          <span className="code">root</span> with its password from step 6, realm
          Linux PAM. Expect a certificate warning: the node signed its own.
        </p>
        <div className="pc-table-wrap">
          <table className="pc-table pc-table--wrap" aria-label="web ui of each node">
            <tbody>
              {nodes.map((node) => (
                <tr key={node.answerFile}>
                  <td className="body-sm code">{node.fqdn}</td>
                  <td className="body-sm code">{node.webUi ?? "no address set in step 3"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </GuideStep>
    </ol>
  );
}

function BootDiskField({
  id,
  label,
  node,
  value,
  onChange,
}: {
  id: string;
  label: string;
  node: NodeInstall;
  value: string;
  onChange: (value: string) => void;
}) {
  const mismatch = bootDiskTypeHint(value, node.bootDisk.type);
  return (
    <div>
      <CheckedTextField
        id={id}
        label={label}
        hint={`declared as ${node.bootDisk.type}${node.bootDisk.lsblkSize ? `, SIZE ≈ ${node.bootDisk.lsblkSize}` : ""} in lsblk`}
        value={value}
        placeholder={exampleDiskName(node.bootDisk.type)}
        validate={validateBootDiskName}
        onChange={onChange}
        optional
      />
      {mismatch && <p className="body-sm pc-field__meaning pc-field__meaning--warn">⚠ {mismatch}</p>}
    </div>
  );
}

function GuideStep({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex flex-col border border-border bg-surface-100 p-5" style={{ gap: "var(--space-3)" }}>
      <p className="h3">
        <span className="code text-ink-muted">{String(n).padStart(2, "0")} </span>
        {title}
      </p>
      {children}
    </li>
  );
}

function Command({ text }: { text: string }) {
  return (
    <div className="pc-cmdline">
      <span className="code pc-cmdline__prompt">$</span>
      {/* wrapped, not scrolled: the end of a command (prepare-iso's --output)
          matters as much as its start */}
      <span className="code pc-cmdline__text" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {text}
      </span>
    </div>
  );
}
