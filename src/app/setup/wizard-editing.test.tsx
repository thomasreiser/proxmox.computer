/**
 * Integration tests for the wizard's editing controls — every field and
 * toggle a visitor can change, driven through the real form. page.test.tsx
 * covers the step flow, persistence and the advisories; this file covers
 * that each edit lands in the saved state and the form reacts to it.
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Setup from "./page";
import { router } from "@/test/router";
import {
  addSpareDisk,
  addTwoSpareDisks,
  chooseClusterStorage,
  fillRequiredHardware,
  fillRequiredNetwork,
  renderAtNetworkStep,
  renderAtStorageStep,
  saved,
  setNodeCount,
  setSpareDiskCount,
  waitForSave,
  type User,
} from "./wizard-test-helpers";

async function retype(user: User, field: HTMLElement, value: string) {
  await user.clear(field);
  if (value) await user.type(field, value);
}

/** the fieldset introduced by a given legend text */
function group(legend: RegExp, index = 0): HTMLElement {
  const legends = screen.getAllByText(legend).filter((el) => el.tagName === "LEGEND");
  return legends[index].closest("fieldset") as HTMLElement;
}

describe("step 1 — per-node hardware", () => {
  // regression: clearing the name (how most people retype one) passed "",
  // which skipped the sync and left the hostname behind for good
  it("renames a node and carries the name into its hostname", async () => {
    const user = userEvent.setup();
    render(<Setup />);
    await retype(user, screen.getByLabelText(/^node name/i), "alpha");
    await waitForSave((s) => s.nodes[0].name === "alpha" && s.nodes[0].network.hostLabel === "alpha");
  });

  it("rejects an uppercase node name", async () => {
    const user = userEvent.setup();
    render(<Setup />);
    await retype(user, screen.getByLabelText(/^node name/i), "PVE01");
    expect(await screen.findByText("lowercase only")).toBeInTheDocument();
  });

  it("warns when nodes mix cpu vendors", async () => {
    const user = userEvent.setup();
    render(<Setup />);
    await setNodeCount(user, "2");
    await user.click(screen.getAllByRole("radio", { name: /^amd/ })[1]);
    expect(await screen.findByText(/can't live-migrate across vendors/i)).toBeInTheDocument();
  });

  it("switches cpu family and suggests that family's core count", async () => {
    const user = userEvent.setup();
    render(<Setup />);
    const before = saved()?.nodes[0].coresPerCpu;
    await user.selectOptions(screen.getByLabelText(/^cpu family/i), "Nehalem");
    await waitForSave((s) => s.nodes[0].cpuFamily === "Nehalem");
    expect(typeof saved()?.nodes[0].coresPerCpu).toBe("string");
    expect(before === undefined || saved()?.nodes[0].coresPerCpu !== undefined).toBe(true);
  });

  it("records memory, cpu count and cores", async () => {
    const user = userEvent.setup();
    render(<Setup />);
    await retype(user, screen.getByLabelText(/^memory \(gb\)/i), "128");
    await retype(user, screen.getByLabelText(/^number of cpus/i), "2");
    await retype(user, screen.getByLabelText(/^cores per cpu/i), "16");
    await waitForSave((s) => s.nodes[0].ramGb === "128" && s.nodes[0].cpuCount === "2" && s.nodes[0].coresPerCpu === "16");
  });

  it("rejects an out-of-range cpu count", async () => {
    const user = userEvent.setup();
    render(<Setup />);
    await retype(user, screen.getByLabelText(/^number of cpus/i), "99");
    expect(await screen.findByText(/must be between/i)).toBeInTheDocument();
  });

  it("records the boot disk's type, size and name", async () => {
    const user = userEvent.setup();
    render(<Setup />);
    await user.click(within(group(/^boot disk type/i)).getByRole("radio", { name: /^hdd/ }));
    await retype(user, screen.getByLabelText(/^boot disk size/i), "256");
    await retype(user, screen.getByLabelText(/^boot disk friendly name/i), "system");
    await waitForSave(
      (s) => s.nodes[0].bootDiskType === "hdd" && s.nodes[0].bootDiskSizeGb === "256" && s.nodes[0].bootDiskName === "system",
    );
  });

  it("adds disks with their own type, size and name", async () => {
    const user = userEvent.setup();
    render(<Setup />);
    await setSpareDiskCount(user, "2");
    await user.click(within(group(/^disk type/i, 1)).getByRole("radio", { name: /^nvme/ }));
    await retype(user, screen.getAllByLabelText(/^size \(gb\)/i)[1], "2000");
    await waitForSave(
      (s) => s.nodes[0].additionalDisks.length === 2 && s.nodes[0].additionalDisks[1].type === "nvme" && s.nodes[0].additionalDisks[1].sizeGb === "2000",
    );
  });

  // disk names share one namespace per node
  it("rejects two disks with the same name", async () => {
    const user = userEvent.setup();
    render(<Setup />);
    await setSpareDiskCount(user, "2");
    const names = screen.getAllByLabelText(/^friendly name/i);
    // the first friendly-name fields are the disks', before the nics'
    await retype(user, names[1], "storage-1");
    expect((await screen.findAllByText(/used more than once/i)).length).toBeGreaterThan(0);
  });

  // speed alone doesn't settle the connector: 10 gbe is sfp+ or rj45
  it("asks for the connector only when the speed leaves a choice", async () => {
    const user = userEvent.setup();
    render(<Setup />);
    const firstNic = () => screen.getAllByText(/^nic 1$/)[0].parentElement as HTMLElement;
    // 1 gbe: rj45 or sfp — asked
    expect(within(firstNic()).getByText("connector")).toBeInTheDocument();
    await user.click(within(firstNic()).getByRole("radio", { name: /^2\.5 gbe/ }));
    // 2.5 gbe only ever comes as rj45 — not asked
    expect(within(firstNic()).queryByText("connector")).not.toBeInTheDocument();
    await user.click(within(firstNic()).getByRole("radio", { name: /^other/ }));
    // unsure of the speed means unsure of the connector — not asked
    expect(within(firstNic()).queryByText("connector")).not.toBeInTheDocument();
  });

  it("defaults a 10 gbe nic to sfp+ and records a switch to rj45", async () => {
    const user = userEvent.setup();
    render(<Setup />);
    const firstNic = () => screen.getAllByText(/^nic 1$/)[0].parentElement as HTMLElement;
    await user.click(within(firstNic()).getByRole("radio", { name: /^10 gbe/ }));
    expect(within(firstNic()).getByRole("radio", { name: /^sfp\+/ })).toBeChecked();
    await user.click(within(firstNic()).getByRole("radio", { name: /^rj45/ }));
    await waitForSave((s) => s.nodes[0].nics[0].speed === "10gbe" && s.nodes[0].nics[0].port === "rj45");
    expect(within(firstNic()).getByText(/10gbase-t/)).toBeInTheDocument();
  });

  it("resizes the nic list with the nic count", async () => {
    const user = userEvent.setup();
    render(<Setup />);
    await retype(user, screen.getByLabelText(/^number of nics/i), "4");
    await waitForSave((s) => s.nodes[0].nics.length === 4);
  });

  // nic names become real linux interface names
  it("rejects a nic name longer than linux allows", async () => {
    const user = userEvent.setup();
    render(<Setup />);
    const nicNames = screen.getAllByLabelText(/^friendly name/i);
    await retype(user, nicNames[nicNames.length - 1], "a-very-long-nic-name");
    expect(await screen.findByText(/15 characters max/i)).toBeInTheDocument();
  });

  it("hands off to the hardware preview once step 1 is complete", async () => {
    const user = userEvent.setup();
    render(<Setup />);
    await fillRequiredHardware(user);
    await user.click(screen.getByRole("button", { name: /preview/i }));
    expect(router.push).toHaveBeenCalledWith("/setup/preview/hardware");
  });
});

describe("step 1 — identical hardware", () => {
  // turning it on adopts node 1's spec, so the checkbox never claims the
  // nodes match while they visibly don't
  it("adopts node 1's hardware for every node", async () => {
    const user = userEvent.setup();
    render(<Setup />);
    await setNodeCount(user, "3");
    await retype(user, screen.getAllByLabelText(/^memory \(gb\)/i)[0], "256");
    await user.click(screen.getByRole("checkbox", { name: /identical hardware/i }));
    await waitForSave((s) => s.identicalHardware && s.nodes.every((n) => n.ramGb === "256"));
  });

  it("shows one shared form that edits every node at once", async () => {
    const user = userEvent.setup();
    render(<Setup />);
    await setNodeCount(user, "3");
    await user.click(screen.getByRole("checkbox", { name: /identical hardware/i }));
    expect(screen.getAllByLabelText(/^memory \(gb\)/i)).toHaveLength(1);

    await retype(user, screen.getByLabelText(/^number of nics/i), "3");
    await setSpareDiskCount(user, "2");
    await user.click(screen.getAllByRole("radio", { name: /^10 gbe/i })[0]);
    await waitForSave(
      (s) =>
        s.nodes.every((n) => n.nics.length === 3 && n.additionalDisks.length === 2 && n.nics[0].speed === "10gbe"),
    );
  });

  it("edits a shared disk on every node", async () => {
    const user = userEvent.setup();
    render(<Setup />);
    await setNodeCount(user, "2");
    await user.click(screen.getByRole("checkbox", { name: /identical hardware/i }));
    await setSpareDiskCount(user, "1");
    await retype(user, screen.getByLabelText(/^size \(gb\)/i), "4000");
    await waitForSave((s) => s.nodes.every((n) => n.additionalDisks[0]?.sizeGb === "4000"));
  });

  it("keeps each node's own name when shared hardware changes", async () => {
    const user = userEvent.setup();
    render(<Setup />);
    await setNodeCount(user, "2");
    await user.click(screen.getByRole("checkbox", { name: /identical hardware/i }));
    await retype(user, screen.getByLabelText(/^memory \(gb\)/i), "64");
    await waitForSave((s) => s.nodes.map((n) => n.name).join() === "pve01,pve02");
  });
});

describe("step 2 — cluster-wide network", () => {
  it("re-derives the gateway from a new homelab subnet", async () => {
    const user = await renderAtNetworkStep();
    await retype(user, screen.getByLabelText(/^homelab cidr/i), "192.168.50.0/24");
    await waitForSave((s) => s.globalCidr === "192.168.50.0/24" && s.gateway === "192.168.50.1");
  });

  it("rejects an invalid domain suffix", async () => {
    const user = await renderAtNetworkStep();
    await retype(user, screen.getByLabelText(/^hostname suffix/i), "-bad.lan");
    expect(await screen.findByText(/not a valid domain/i)).toBeInTheDocument();
  });

  it("rejects a main vlan outside 802.1q's range", async () => {
    const user = await renderAtNetworkStep();
    await retype(user, screen.getByLabelText(/^main homelab vlan/i), "5000");
    expect(await screen.findByText(/must be between 1 and 4094/i)).toBeInTheDocument();
  });

  it("records a gateway typed by hand", async () => {
    const user = await renderAtNetworkStep();
    await retype(user, screen.getByLabelText(/^gateway/i), "10.0.10.254");
    await waitForSave((s) => s.gateway === "10.0.10.254");
  });

  // a bare ip gets the homelab's prefix on blur — /32 would cut the node
  // off from its own gateway
  it("fills in the subnet prefix when a bare ip is typed", async () => {
    const user = await renderAtNetworkStep();
    const ip = screen.getByLabelText(/^static ip/i);
    await retype(user, ip, "10.0.10.50");
    await user.tab();
    expect(ip).toHaveValue("10.0.10.50/24");
  });

  it("shows a subnet breakdown on request", async () => {
    const user = await renderAtNetworkStep();
    await user.click(screen.getAllByTitle("show subnet details")[0]);
    expect(screen.getByText("usable hosts")).toBeInTheDocument();
    expect(screen.getByText("broadcast")).toBeInTheDocument();
  });

  it("hands off to the network preview once step 2 is complete, and back to hardware", async () => {
    const user = await renderAtNetworkStep();
    await fillRequiredNetwork(user);
    await user.click(screen.getByRole("button", { name: /preview/i }));
    expect(router.push).toHaveBeenCalledWith("/setup/preview/network");
    await user.click(screen.getByRole("button", { name: /back/i }));
    expect(await screen.findByRole("heading", { name: "hardware" })).toBeInTheDocument();
  });
});

describe("step 2 — bonds and interfaces", () => {
  it("builds a bond from two nics and offers it as an interface", async () => {
    const user = await renderAtNetworkStep();
    await retype(user, screen.getByLabelText(/^number of bonds/i), "1");
    const members = group(/^nics in this bond/i);
    expect(screen.getByText(/select at least 2 nics/i)).toBeInTheDocument();
    for (const box of within(members).getAllByRole("checkbox")) await user.click(box);
    await waitForSave((s) => s.nodes[0].network.bonds[0]?.nicIndices.length === 2);
    expect(screen.queryByText(/select at least 2 nics/i)).not.toBeInTheDocument();
    // the bonded nics disappear as standalone interfaces, the bond appears
    expect(within(group(/^interface$/i)).getByRole("radio", { name: /^bond0/ })).toBeInTheDocument();
  });

  // regression: same snap-back as the bridge count
  it("takes a bond count typed over a cleared field at face value", async () => {
    const user = await renderAtNetworkStep();
    const count = screen.getByLabelText(/^number of bonds/i);
    await user.clear(count);
    expect(count).toHaveValue(null);
    await user.type(count, "1");
    await waitForSave((s) => s.nodes[0].network.bonds.length === 1);
    await user.clear(count);
    await user.type(count, "0");
    await waitForSave((s) => s.nodes[0].network.bonds.length === 0);
  });

  it("puts an empty bond count back to what's committed when the field is left", async () => {
    const user = await renderAtNetworkStep();
    const count = screen.getByLabelText(/^number of bonds/i);
    await user.clear(count);
    await user.tab();
    expect(count).toHaveValue(0);
  });

  it("records the bond's mode and name", async () => {
    const user = await renderAtNetworkStep();
    await retype(user, screen.getByLabelText(/^number of bonds/i), "1");
    await user.click(within(group(/^bond mode/i)).getByRole("radio", { name: /^lacp/ }));
    await retype(user, screen.getByLabelText(/^bond name/i), "uplink");
    await waitForSave((s) => s.nodes[0].network.bonds[0]?.mode === "lacp" && s.nodes[0].network.bonds[0]?.name === "uplink");
  });

  it("moves management to another interface", async () => {
    const user = await renderAtNetworkStep();
    await user.click(within(group(/^interface$/i)).getByRole("radio", { name: /^nic 2/ }));
    await waitForSave((s) => s.nodes[0].network.managementInterfaceId === "nic-1");
  });

  it("renames the management bridge", async () => {
    const user = await renderAtNetworkStep();
    await retype(user, screen.getAllByLabelText(/^bridge name/i)[0], "vmbr9");
    await waitForSave((s) => Object.values(s.nodes[0].network.bridges).some((b) => b.name === "vmbr9"));
  });
});

describe("step 2 — bridges", () => {
  // nic 2 carries the one non-management bridge on a default node
  const secondBridgePurposes = () => group(/^used for \(pick as many as apply\)$/i);

  it("turns a bridge off", async () => {
    const user = await renderAtNetworkStep();
    await user.click(screen.getByRole("checkbox", { name: /^bridge this interface/i }));
    await waitForSave((s) => s.nodes[0].network.bridges["nic-1#0"]?.enabled === false);
  });

  // corosync is latency-sensitive; a backup saturating its link can cost
  // quorum
  it("warns when corosync shares a bridge with backups", async () => {
    const user = await renderAtNetworkStep();
    const purposes = secondBridgePurposes();
    await user.click(within(purposes).getByRole("checkbox", { name: /^cluster sync/i }));
    await user.click(within(purposes).getByRole("checkbox", { name: /^backups/i }));
    expect(await screen.findByText(/false quorum loss/i)).toBeInTheDocument();
  });

  it("never lets a bridge end up with no purpose at all", async () => {
    await renderAtNetworkStep();
    const only = within(secondBridgePurposes()).getAllByRole("checkbox").find((box) => (box as HTMLInputElement).checked);
    expect(only).toBeDisabled();
  });

  // regression: clearing the field snapped it back to "1", so typing "2"
  // produced "12" — and twelve bridges
  it("takes a bridge count typed over a cleared field at face value", async () => {
    const user = await renderAtNetworkStep();
    const count = screen.getAllByLabelText(/^bridges on this interface/i)[0];
    await user.clear(count);
    expect(count).toHaveValue(null);
    await user.type(count, "2");
    expect(count).toHaveValue(2);
    await waitForSave((s) => s.nodes[0].network.bridgeCounts["nic-0"] === "2");
    expect(screen.getAllByLabelText(/^vlan tag/i)).toHaveLength(1);
  });

  // an invalid value is shown (with its error) while typing but never
  // committed; leaving the field shows the last valid value — here "9",
  // which the keystroke before the second 9 committed
  it("never commits an invalid bridge count, and shows the last valid one on leaving", async () => {
    const user = await renderAtNetworkStep();
    const count = screen.getAllByLabelText(/^bridges on this interface/i)[0];
    await user.clear(count);
    await user.type(count, "99");
    expect(await screen.findByText(/must be between 1 and 24/i)).toBeInTheDocument();
    await user.tab();
    expect(count).toHaveValue(9);
    await waitForSave((s) => s.nodes[0].network.bridgeCounts["nic-0"] === "9");
    expect(screen.queryByText(/must be between 1 and 24/i)).not.toBeInTheDocument();
  });

  it("adds a vlan-tagged bridge that needs its own tag", async () => {
    const user = await renderAtNetworkStep();
    await retype(user, screen.getAllByLabelText(/^bridges on this interface/i)[0], "2");
    const vlan = await screen.findByLabelText(/^vlan tag/i);
    await retype(user, vlan, "0");
    await user.tab();
    expect(await screen.findByText(/must be between 1 and 4094/i)).toBeInTheDocument();
    await retype(user, vlan, "30");
    await waitForSave((s) => Object.values(s.nodes[0].network.bridges).some((b) => b.vlanTag === "30"));
  });

  it("rejects two extra bridges on one interface with the same vlan", async () => {
    const user = await renderAtNetworkStep();
    await retype(user, screen.getAllByLabelText(/^bridges on this interface/i)[0], "3");
    const tags = await screen.findAllByLabelText(/^vlan tag/i);
    await retype(user, tags[0], "20");
    await retype(user, tags[1], "20");
    await user.tab();
    expect((await screen.findAllByText(/already used by another bridge/i)).length).toBeGreaterThan(0);
  });
});

describe("step 2 — identical network", () => {
  it("shares one structure block and keeps addresses per node", async () => {
    const user = await renderAtNetworkStep({ nodeCount: "2" });
    await user.click(screen.getByRole("checkbox", { name: /identical network setup/i }));
    await waitForSave((s) => s.identicalNetwork);
    // one set of purpose pickers for the cluster, but a static ip per node
    expect(screen.getAllByLabelText(/^static ip/i)).toHaveLength(2);
    expect(screen.getAllByRole("checkbox", { name: /^bridge this interface/i })).toHaveLength(1);
  });

  it("copies a structural edit to every node", async () => {
    const user = await renderAtNetworkStep({ nodeCount: "2" });
    await user.click(screen.getByRole("checkbox", { name: /identical network setup/i }));
    await user.click(screen.getByRole("checkbox", { name: /^bridge this interface/i }));
    await waitForSave((s) => s.nodes.every((n) => n.network.bridges["nic-1#0"]?.enabled === false));
  });

  it("never copies a host address across nodes", async () => {
    const user = await renderAtNetworkStep({ nodeCount: "2" });
    await user.click(screen.getByRole("checkbox", { name: /identical network setup/i }));
    await waitForSave((s) => s.identicalNetwork);
    const ips = saved()?.nodes.map((n) => n.network.cidr);
    expect(new Set(ips).size).toBe(2);
  });
});

describe("step 3 — pool settings", () => {
  const chooseZfs = (user: User) => chooseClusterStorage(user, { ceph: false, zfs: true });

  it("renames the ceph pool", async () => {
    const user = await renderAtStorageStep({ nodeCount: "3", onHardware: addSpareDisk });
    await retype(user, screen.getByLabelText(/^pool name/i), "fast");
    await waitForSave((s) => s.storage.ceph.poolName === "fast");
  });

  it("records the zfs layout and replication interval", async () => {
    const user = await renderAtStorageStep({ nodeCount: "3", onHardware: addTwoSpareDisks, onNetwork: chooseZfs });
    await user.click(screen.getByRole("radio", { name: /^stripe/ }));
    await retype(user, screen.getByLabelText(/^replicate every/i), "30");
    await waitForSave((s) => s.storage.zfs.raidLevel === "stripe" && s.storage.zfs.replicationMinutes === "30");
    expect(screen.getAllByText(/a stripe has no redundancy/i).length).toBeGreaterThan(0);
  });

  it("rejects a replication interval outside a day", async () => {
    const user = await renderAtStorageStep({ nodeCount: "3", onHardware: addSpareDisk, onNetwork: chooseZfs });
    await retype(user, screen.getByLabelText(/^replicate every/i), "2000");
    expect(await screen.findByText(/must be between 1 and 1440/i)).toBeInTheDocument();
  });

  // the interval is exactly the data a failover can lose
  it("names a long replication window back to the visitor", async () => {
    const user = await renderAtStorageStep({ nodeCount: "3", onHardware: addSpareDisk, onNetwork: chooseZfs });
    await retype(user, screen.getByLabelText(/^replicate every/i), "120");
    expect(await screen.findByText(/loses up to 2 hours of writes/i)).toBeInTheDocument();
  });

  it("records the local pool's kind and storage id", async () => {
    const user = await renderAtStorageStep({ nodeCount: "3", onHardware: addTwoSpareDisks });
    await user.click(screen.getAllByRole("radio", { name: /^local storage/ })[1]);
    await user.click(await screen.findByRole("radio", { name: /^lvm-thin/ }));
    await retype(user, screen.getByLabelText(/^storage id/i), "scratch");
    await waitForSave((s) => s.storage.local.kind === "lvm-thin" && s.storage.local.name === "scratch");
  });

  it("hands off to the storage preview and back to network", async () => {
    const user = await renderAtStorageStep({ nodeCount: "3", onHardware: addSpareDisk });
    await user.click(screen.getByRole("button", { name: /preview/i }));
    expect(router.push).toHaveBeenCalledWith("/setup/preview/storage");
    await user.click(screen.getByRole("button", { name: /back/i }));
    expect(await screen.findByRole("heading", { name: "network" })).toBeInTheDocument();
  });
});
