/**
 * Integration tests: the wizard as a visitor drives it. These go through
 * the real form — no mocked state, no exported internals — so they cover
 * the wiring between the pure modules (./validation, ./derive, ./hints)
 * and the component tree that renders them, which unit tests can't reach.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Setup from "./page";
import { STEP_VERSIONS, STORAGE_KEY, type PersistedState } from "./wizard-state";
import { loadPersistedState, savePersistedState } from "./saved-state";
import { ED25519_KEY, RSA_KEY, accessPlan, backupPlan, cluster, persistedState } from "./test-fixtures";
import { defaultAccessPlan } from "./access";
import { countryFor, keyboardFor, timezoneOptions } from "./location";
import { lock, unlockStored } from "./vault";
import { router } from "@/test/router";
import {
  saved,
  waitForSave,
  setNodeCount,
  renderAtHardwareStep,
  renderAtNetworkStep,
  renderAtStorageStep,
  renderAtBackupsStep,
  addSpareDisk,
  addTwoSpareDisks,
  chooseClusterStorage,
  fillRequiredHardware,
  clusterStorage,
  storageCheckbox,
} from "./wizard-test-helpers";

describe("step 1 — location", () => {
  const next = () => screen.getByRole("button", { name: /^\[?\s*next/i });

  // a new setup starts from the browser it's made in (the test runner's)
  it("opens a new setup on location, guessed from the browser", async () => {
    render(<Setup />);
    expect(await screen.findByRole("heading", { name: "location" })).toBeInTheDocument();
    expect(screen.getByText("# step 1 of 8")).toBeInTheDocument();
    expect(screen.getByLabelText(/^country/i)).toHaveValue(countryFor(navigator.language));
    expect(screen.getByLabelText(/^keyboard/i)).toHaveValue(keyboardFor(navigator.language));
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(screen.getByLabelText(/^timezone/i)).toHaveValue(timezoneOptions().includes(zone) ? zone : "UTC");
  });

  it("saves what's picked, and restores it", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Setup />);
    await screen.findByRole("heading", { name: "location" });
    await user.selectOptions(screen.getByLabelText(/^country/i), "ch");
    await user.selectOptions(screen.getByLabelText(/^keyboard/i), "fr-ch");
    await user.selectOptions(screen.getByLabelText(/^timezone/i), "Europe/Zurich");
    await waitForSave((s) => s.location.country === "ch" && s.location.keyboard === "fr-ch" && s.location.timezone === "Europe/Zurich");
    unmount();
    render(<Setup />);
    await screen.findByRole("heading", { name: "location" });
    await waitFor(() => expect(screen.getByLabelText(/^keyboard/i)).toHaveValue("fr-ch"));
  });

  // nothing to draw, so it moves on directly — and back
  it("goes on to hardware, and back", async () => {
    const user = userEvent.setup();
    render(<Setup />);
    await screen.findByRole("heading", { name: "location" });
    await user.click(next());
    expect(await screen.findByRole("heading", { name: "hardware" })).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /^\[?\s*back/i }));
    expect(await screen.findByRole("heading", { name: "location" })).toBeInTheDocument();
  });

  // a save restored in a browser that doesn't know its timezone
  it("won't move on with a timezone this browser doesn't know", async () => {
    await savePersistedState(
      persistedState({ currentStep: "location", location: { country: "at", keyboard: "de", timezone: "Mars/Olympus_Mons" } }),
    );
    const user = userEvent.setup();
    render(<Setup />);
    await screen.findByRole("heading", { name: "location" });
    await user.click(next());
    expect(screen.getByRole("alert")).toHaveTextContent(/timezone/i);
    expect(screen.queryByRole("heading", { name: "hardware" })).not.toBeInTheDocument();
  });
});

describe("step 2 — hardware", () => {
  beforeEach(async () => {
    await renderAtHardwareStep();
  });

  it("opens on the hardware step", () => {
    expect(screen.getByRole("heading", { name: "hardware" })).toBeInTheDocument();
    expect(screen.getByText("# step 2 of 8")).toBeInTheDocument();
  });

  it("starts as a single standalone node", async () => {
    expect(await screen.findByText(/runs standalone/i)).toBeInTheDocument();
  });

  // the quorum advice is the reason to ask for a node count at all, so it
  // has to track the field live rather than on submit.
  it("updates the quorum advice as the node count changes", async () => {
    const user = userEvent.setup();
    await setNodeCount(user, "2");
    expect(await screen.findByText(/doesn't get automatic quorum/i)).toBeInTheDocument();

    await setNodeCount(user, "3");
    expect(await screen.findByText(/3 nodes gets automatic quorum/i)).toBeInTheDocument();
  });

  it("rejects a node count outside 1–16", async () => {
    const user = userEvent.setup();
    await setNodeCount(user, "17");
    expect(await screen.findByText(/must be between 1 and 16/i)).toBeInTheDocument();
  });

  it("offers the identical-hardware shortcut only once there's more than one node", async () => {
    const user = userEvent.setup();
    expect(screen.queryByLabelText(/identical hardware/i)).not.toBeInTheDocument();
    await setNodeCount(user, "3");
    expect(await screen.findByText(/identical hardware across all nodes/i)).toBeInTheDocument();
  });

  // regression: a node added after "identical hardware" was ticked came
  // with default hardware — blank memory and boot disk, the default cpu —
  // so it blocked step 1 and split the cpu types, with no form to fix it
  it("gives a node added later the shared hardware", async () => {
    const user = userEvent.setup();
    await setNodeCount(user, "2");
    await user.click(await screen.findByRole("checkbox", { name: /^identical hardware across all nodes/i }));
    await fillRequiredHardware(user);
    const family = screen.getByLabelText(/^cpu family/i) as HTMLSelectElement;
    const other = [...family.options].find((o) => o.value !== family.value)!.value;
    await user.selectOptions(family, other);
    await setNodeCount(user, "3");
    await waitForSave(
      (s) =>
        s.nodes.length === 3 &&
        s.nodes[2].ramGb === "64" &&
        s.nodes[2].bootDiskSizeGb === "512" &&
        s.nodes[2].cpuFamily === other,
    );
    await user.click(screen.getByRole("button", { name: /preview/i }));
    expect(router.push).toHaveBeenCalledWith("/setup/preview/hardware");
  }, 15_000);
});

describe("continuing past a step", () => {
  // the reported bug: step 1 moved on with no memory entered
  it("won't hand off to the preview while memory is missing", async () => {
    const user = userEvent.setup();
    await renderAtHardwareStep();
    await user.click(screen.getByRole("button", { name: /preview/i }));
    expect(router.push).not.toHaveBeenCalled();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/to fix before continuing/i);
    expect(alert).toHaveTextContent(/memory \(gb\)/i);
    expect(alert).toHaveTextContent(/node 01 — pve01/i);
  });

  // fields normally hold their error until visited — a blocked continue
  // has to point at the untouched empty one
  it("shows the error on fields nobody has touched yet", async () => {
    const user = userEvent.setup();
    await renderAtHardwareStep();
    const ram = screen.getByLabelText(/^memory \(gb\)/i);
    expect(ram.closest(".pc-field")).not.toHaveClass("pc-field--error");
    await user.click(screen.getByRole("button", { name: /preview/i }));
    expect(ram.closest(".pc-field")).toHaveClass("pc-field--error");
    expect(screen.getByLabelText(/^boot disk size/i).closest(".pc-field")).toHaveClass("pc-field--error");
  });

  it("lets the visitor through once the problems are fixed", async () => {
    const user = userEvent.setup();
    await renderAtHardwareStep();
    await user.click(screen.getByRole("button", { name: /preview/i }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await fillRequiredHardware(user);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /preview/i }));
    expect(router.push).toHaveBeenCalledWith("/setup/preview/hardware");
  });

  it("lists one entry per node that's missing something", async () => {
    const user = userEvent.setup();
    await renderAtHardwareStep();
    await setNodeCount(user, "3");
    await user.click(screen.getByRole("button", { name: /preview/i }));
    const alert = screen.getByRole("alert");
    for (const n of ["01", "02", "03"]) expect(alert).toHaveTextContent(new RegExp(`node ${n}`));
  });

  // a later step is built on the earlier ones: a save restored at step 2
  // with a gap in step 1 can't move on either
  it("blocks step 3 on a gap left in step 2, and says which step it's in", async () => {
    await savePersistedState(persistedState({ currentStep: "network", nodes: cluster(1, { ramGb: "" }), nodeCount: "1" }));
    const user = userEvent.setup();
    render(<Setup />);
    await screen.findByRole("heading", { name: "network" });
    await user.click(screen.getByRole("button", { name: /preview/i }));
    expect(router.push).not.toHaveBeenCalled();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/step hardware/i);
    expect(alert).toHaveTextContent(/earlier step/i);
  });

  it("starts the next step without errors it hasn't earned", async () => {
    const user = await renderAtNetworkStep();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /back/i }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("persistence", () => {
  it("saves what was entered and restores it on remount", async () => {
    const user = userEvent.setup();
    const { unmount } = await renderAtHardwareStep();
    await setNodeCount(user, "3");
    await screen.findByText(/3 nodes gets automatic quorum/i);

    await waitForSave((state) => state.nodeCount === "3" && state.nodes.length === 3);

    unmount();
    render(<Setup />);
    expect(await screen.findByLabelText(/number of nodes/i)).toHaveValue(3);
  });

  // a build that changed step 5 keeps steps 1–4 of a save, and starts 5 on over
  it("keeps the steps before one this build changed, and says so", async () => {
    const saved = persistedState({ currentStep: "software", hostnameSuffix: "lab.lan", backups: backupPlan({ keepDaily: "30" }) });
    await savePersistedState({ ...saved, stepVersions: { ...saved.stepVersions, backups: saved.stepVersions.backups - 1 } });
    const user = userEvent.setup();
    render(<Setup />);
    // back on the changed step, never past it
    expect(await screen.findByRole("heading", { name: "backups" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "step 5, backups, has changed since this setup was saved — it and the steps after it start over. steps 1–4 are kept.",
    );
    // step 3's answer is still there; step 5's is back at its default
    await waitForSave((s) => s.stepVersions.backups === STEP_VERSIONS.backups);
    const state = await loadPersistedState();
    expect(state?.hostnameSuffix).toBe("lab.lan");
    expect(state?.backups.keepDaily).not.toBe("30");

    await user.click(screen.getByRole("button", { name: /^got it$/i }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("says nothing when a save comes back whole", async () => {
    await savePersistedState(persistedState({ currentStep: "backups" }));
    render(<Setup />);
    expect(await screen.findByRole("heading", { name: "backups" })).toBeInTheDocument();
    expect(screen.queryByText(/has changed since this setup was saved/)).not.toBeInTheDocument();
  });

  // another layout of the save altogether is discarded wholesale rather
  // than risking a half-applied state.
  it("ignores a save from another storage version", async () => {
    await savePersistedState({ ...persistedState(), version: 1, nodeCount: "9" });
    render(<Setup />);
    expect(await screen.findByRole("heading", { name: "location" })).toBeInTheDocument();
    expect(screen.queryByDisplayValue("9")).not.toBeInTheDocument();
  });

  // saves from before encryption were plain json — nothing to unlock
  it("ignores a plain, unencrypted save from before", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...persistedState(), nodeCount: "9" }));
    render(<Setup />);
    expect(await screen.findByRole("heading", { name: "location" })).toBeInTheDocument();
    expect(screen.queryByDisplayValue("9")).not.toBeInTheDocument();
  });

  // nothing readable at rest: the passwords step 5 holds never hit disk in the clear
  it("saves the setup encrypted", async () => {
    const user = userEvent.setup();
    await renderAtHardwareStep();
    await setNodeCount(user, "3");
    await waitForSave((state) => state.nodeCount === "3");
    const raw = window.localStorage.getItem(STORAGE_KEY) ?? "";
    expect(raw).not.toContain("nodeCount");
    expect(raw).not.toContain("pve01");
  });

  it("survives corrupt json without crashing", async () => {
    window.localStorage.setItem(STORAGE_KEY, "{ not json");
    render(<Setup />);
    expect(await screen.findByRole("heading", { name: "location" })).toBeInTheDocument();
  });
});

describe("step 3 — network", () => {
  it("restores at the network step after the preview hands off", async () => {
    await renderAtNetworkStep();
    expect(screen.getByText("# step 3 of 8")).toBeInTheDocument();
  });

  it("derives a gateway and per-node addresses from the homelab subnet", async () => {
    await renderAtNetworkStep({ nodeCount: "2" });
    await waitForSave((state) => state.gateway === "10.0.10.1");
    expect((await saved())?.nodes.map((n) => n.network.cidr)).toEqual(["10.0.10.11/24", "10.0.10.12/24"]);
  });

  // cluster storage is a cluster-wide decision, so it has nothing to
  // decide on a single node.
  it("hides cluster storage for a single node", async () => {
    await renderAtNetworkStep();
    expect(screen.queryByText(/^cluster storage/)).not.toBeInTheDocument();
  });

  it("offers cluster storage for a real cluster", async () => {
    await renderAtNetworkStep({ nodeCount: "3", onHardware: addSpareDisk });
    expect(screen.getByText(/^cluster storage/)).toBeInTheDocument();
    // independent checkboxes — "neither" is just both unticked
    expect(storageCheckbox("ceph")).toBeChecked();
    expect(storageCheckbox("zfs")).not.toBeChecked();
    expect(within(clusterStorage()).queryByRole("radio")).not.toBeInTheDocument();
  });

  it("carries the hostname suffix into every node's fqdn", async () => {
    const user = await renderAtNetworkStep({ nodeCount: "2" });
    const suffix = screen.getByLabelText(/hostname suffix/i);
    await user.clear(suffix);
    await user.type(suffix, "lab.lan");
    await waitForSave((state) => state.hostnameSuffix === "lab.lan");
    expect((await saved())?.nodes.map((n) => n.network.hostLabel)).toEqual(["pve01", "pve02"]);
  });
});

describe("ceph guidance", () => {
  /**
   * The ceph option's label holds the warning triangle and the warning
   * line as sibling elements, so its text is split across nodes and
   * getByText can't see it whole. Matching the option by its accessible
   * name and then asserting on the label's text content is both robust to
   * that and closer to what a visitor actually reads.
   */
  function cephOption(): HTMLElement {
    return within(clusterStorage())
      .getByRole("checkbox", { name: /^ceph \(recommended\)/ })
      .closest("label") as HTMLElement;
  }

  // the default nics are 1gbe, so a fresh 3-node cluster is exactly the
  // case this warning exists for.
  it("flags ceph when no node has a 10gbe nic", async () => {
    await renderAtNetworkStep({ nodeCount: "3", onHardware: addSpareDisk });
    expect(cephOption()).toHaveTextContent(/no 10 gbe \(or faster\) nic on any node/i);
    expect(cephOption()).toHaveTextContent("⚠");
  });

  it("links ceph's own hardware guidance while ceph is selected", async () => {
    await renderAtNetworkStep({ nodeCount: "3", onHardware: addSpareDisk });
    const link = screen.getByRole("link", { name: /ceph hardware recommendations/i });
    expect(link).toHaveAttribute("href", "https://docs.ceph.com/en/reef/start/hardware-recommendations/");
    expect(link).toHaveAttribute("target", "_blank");
  });

  function zfsOption(): HTMLElement {
    return storageCheckbox("zfs").closest("label") as HTMLElement;
  }

  // one spare disk per node means a single-disk stripe: no failover
  // within the node.
  it("flags zfs replication when nodes have only one spare disk", async () => {
    const user = await renderAtNetworkStep({ nodeCount: "3", onHardware: addSpareDisk });
    await chooseClusterStorage(user, { ceph: false, zfs: false });
    expect(zfsOption()).toHaveTextContent(/fewer than two disks left for zfs on every node/i);
    expect(zfsOption()).toHaveTextContent("⚠");
  });

  it("does not flag zfs replication once every node has two spare disks for it", async () => {
    const user = await renderAtNetworkStep({ nodeCount: "3", onHardware: addTwoSpareDisks });
    await chooseClusterStorage(user, { ceph: false, zfs: true });
    expect(zfsOption()).not.toHaveTextContent(/fewer than two disks/i);
    expect(zfsOption()).not.toHaveTextContent("⚠");
  });

  // ceph takes each osd disk whole, so alongside ceph zfs only gets what's
  // left — two disks per node leave it one, a single-disk stripe
  it("counts the disk ceph takes when judging zfs redundancy", async () => {
    await renderAtNetworkStep({ nodeCount: "3", onHardware: addTwoSpareDisks });
    expect(storageCheckbox("ceph")).toBeChecked();
    expect(zfsOption()).toHaveTextContent(/fewer than two disks left for zfs on every node once ceph takes one/i);
  });

  // the caveat describes the option, so it's visible before it's chosen
  // and stays after — the same as ceph's speed caveat.
  it("shows the zfs caveat whether or not zfs is selected", async () => {
    const user = await renderAtNetworkStep({ nodeCount: "3", onHardware: addSpareDisk });
    await chooseClusterStorage(user, { ceph: false, zfs: true });
    expect(storageCheckbox("zfs")).toBeChecked();
    expect(zfsOption()).toHaveTextContent(/single-disk stripe/i);
  });

  // the two are deliberately gated differently: the speed caveat belongs
  // to the ceph *option*, so you see it before committing, while the docs
  // link follows the selection.
  it("keeps the speed caveat on the ceph option after unticking it", async () => {
    const user = await renderAtNetworkStep({ nodeCount: "3", onHardware: addSpareDisk });
    await chooseClusterStorage(user, { ceph: false, zfs: true });
    expect(cephOption()).toHaveTextContent(/no 10 gbe/i);
  });

  it("drops the docs link once ceph is no longer selected", async () => {
    const user = await renderAtNetworkStep({ nodeCount: "3", onHardware: addSpareDisk });
    expect(screen.getByRole("link", { name: /ceph hardware recommendations/i })).toBeInTheDocument();
    await user.click(storageCheckbox("ceph"));
    expect(screen.queryByRole("link", { name: /ceph hardware recommendations/i })).not.toBeInTheDocument();
  });

  // the whole chain: a step-1 nic speed clears a step-2 warning, which
  // only works if the hint reads the real nics behind the interface.
  it("clears the speed warning once the nics are fast enough", async () => {
    await renderAtNetworkStep({
      nodeCount: "3",
      // "identical hardware" defaults on, so one edit covers the cluster
      onHardware: async (user) => {
        await addSpareDisk(user);
        // each click re-renders, so a snapshot of the list goes stale —
        // re-query for the next unchecked one every time instead
        for (let guard = 0; guard < 32; guard++) {
          const next = screen
            .getAllByRole("radio", { name: /^10 gbe/i })
            .find((radio) => !(radio as HTMLInputElement).checked);
          if (!next) break;
          await user.click(next);
        }
      },
    });
    await waitForSave((state) => state.nodes.every((n) => n.nics.every((nic) => nic.speed === "10gbe")));
    expect(cephOption()).not.toHaveTextContent(/no 10 gbe/i);
  });
});

describe("ceph and zfs together", () => {
  // ceph as the main ha storage, zfs replication alongside — e.g. for backups
  it("lets both be ticked with two spare disks per node", async () => {
    const user = await renderAtNetworkStep({ nodeCount: "3", onHardware: addTwoSpareDisks });
    await chooseClusterStorage(user, { ceph: true, zfs: true });
    expect(storageCheckbox("ceph")).toBeChecked();
    expect(storageCheckbox("zfs")).toBeChecked();
    await waitForSave((s) => s.clusterStorage.ceph && s.clusterStorage.zfs);
  });

  // ceph takes each osd disk whole, so zfs needs a disk of its own
  it("blocks the second with only one spare disk, and says why", async () => {
    await renderAtNetworkStep({ nodeCount: "3", onHardware: addSpareDisk });
    expect(storageCheckbox("ceph")).toBeChecked();
    expect(storageCheckbox("zfs")).toBeDisabled();
    expect(storageCheckbox("zfs").closest("label")).toHaveTextContent(/ceph and zfs can't share a disk/i);
  });

  it("frees the other once one is unticked", async () => {
    const user = await renderAtNetworkStep({ nodeCount: "3", onHardware: addSpareDisk });
    await user.click(storageCheckbox("ceph"));
    expect(storageCheckbox("zfs")).toBeEnabled();
  });

  it("says what neither means", async () => {
    const user = await renderAtNetworkStep({ nodeCount: "3", onHardware: addSpareDisk });
    await chooseClusterStorage(user, { ceph: false, zfs: false });
    expect(within(clusterStorage()).getByText(/neither ticked/i)).toBeInTheDocument();
  });

  it("offers both nic purposes and wants a nic for each", async () => {
    const user = await renderAtNetworkStep({ nodeCount: "3", onHardware: addTwoSpareDisks });
    await chooseClusterStorage(user, { ceph: true, zfs: true });
    expect(screen.getAllByRole("checkbox", { name: /^ceph \/ storage traffic/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("checkbox", { name: /^zfs replication/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/no nic on this node is set up for ceph traffic/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/no nic on this node is set up for zfs replication traffic/i).length).toBeGreaterThan(0);
  });

  it("offers both roles per disk and plans both pools in step 4", async () => {
    await renderAtStorageStep({
      nodeCount: "3",
      onHardware: addTwoSpareDisks,
      onNetwork: (user) => chooseClusterStorage(user, { ceph: true, zfs: true }),
    });
    expect(screen.getAllByRole("radio", { name: /^ceph osd/ })).toHaveLength(6);
    expect(screen.getAllByRole("radio", { name: /^zfs pool member/ })).toHaveLength(6);
    expect(screen.getByText("the ceph pool")).toBeInTheDocument();
    expect(screen.getByText("the replicated zfs pool")).toBeInTheDocument();
  });

  // every unchosen disk starts in ceph, so zfs has nothing until one is moved
  it("warns that zfs has no disks until some are given to it", async () => {
    const user = await renderAtStorageStep({
      nodeCount: "3",
      onHardware: addTwoSpareDisks,
      onNetwork: (u) => chooseClusterStorage(u, { ceph: true, zfs: true }),
    });
    expect(screen.getByText(/no disk anywhere in the cluster is assigned to the replicated zfs pool/i)).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /identical disk layout/i }));
    await user.click(screen.getAllByRole("radio", { name: /^zfs pool member/ })[1]);
    await waitForSave((s) => s.nodes.every((n) => n.additionalDisks[1].role === "zfs"));
    expect(screen.queryByText(/assigned to the replicated zfs pool/i)).not.toBeInTheDocument();
  });

  // unticking zfs doesn't forget which disks were meant for it
  it("keeps a disk's zfs role while zfs is off, and restores it", async () => {
    await renderAtStorageStep({
      nodeCount: "3",
      onHardware: addTwoSpareDisks,
      onNetwork: async (user) => {
        await chooseClusterStorage(user, { ceph: true, zfs: false });
        await waitForSave((s) => !s.clusterStorage.zfs);
        const state = (await saved()) as PersistedState;
        for (const n of state.nodes) n.additionalDisks[1].role = "zfs";
        await savePersistedState(state);
      },
    });
    // zfs is off, so the disk shows in ceph — but the choice is kept
    expect(screen.queryByRole("radio", { name: /^zfs pool member/ })).not.toBeInTheDocument();
    expect((await saved())?.nodes.every((n) => n.additionalDisks[1].role === "zfs")).toBe(true);
  });
});

describe("node-level network advice", () => {
  it("does not claim a node can't host vms when its default bridge can", async () => {
    await renderAtNetworkStep();
    expect(screen.queryByText(/won't be able to host any vms or cts/i)).not.toBeInTheDocument();
  });

  it("warns that a node has nowhere to back up to", async () => {
    await renderAtNetworkStep();
    expect(screen.getByText(/no nic on this node is set up for backups/i)).toBeInTheDocument();
  });

  // corosync only matters once there's a cluster, so a lone node must not
  // be nagged about it.
  it("says nothing about corosync on a standalone node", async () => {
    await renderAtNetworkStep();
    expect(screen.queryByText(/set up for cluster sync/i)).not.toBeInTheDocument();
  });

  it("warns about corosync once it's a real cluster", async () => {
    await renderAtNetworkStep({ nodeCount: "3" });
    expect(screen.getAllByText(/set up for cluster sync/i).length).toBeGreaterThan(0);
  });

  it("demands a nic for the storage mode that was chosen", async () => {
    await renderAtNetworkStep({ nodeCount: "3", onHardware: addSpareDisk });
    expect(screen.getAllByText(/no nic on this node is set up for ceph traffic/i).length).toBeGreaterThan(0);
  });
});

describe("step 4 — storage", () => {
  /** zfs replication only, picked in step 2 on the way through */
  const chooseZfs = (user: ReturnType<typeof userEvent.setup>) => chooseClusterStorage(user, { ceph: false, zfs: true });

  it("restores at the storage step after the preview hands off", async () => {
    await renderAtStorageStep({ nodeCount: "3", onHardware: addSpareDisk });
    expect(screen.getByText("# step 4 of 8")).toBeInTheDocument();
  });

  // step 1 declared the disks; step 3 is where they get a job.
  it("lists each declared disk with a role to choose", async () => {
    await renderAtStorageStep({ nodeCount: "3", onHardware: addTwoSpareDisks });
    expect(screen.getAllByRole("radio", { name: /^ceph osd/ })).toHaveLength(6);
    expect(screen.getAllByRole("radio", { name: /^local storage/ })).toHaveLength(6);
    expect(screen.getAllByRole("radio", { name: /^leave unused/ })).toHaveLength(6);
  });

  // a node's only spare disk has to be in the pool, or that node stores
  // nothing for the cluster storage chosen in step 2.
  it("offers only the pool role for a node's sole disk under ceph", async () => {
    await renderAtStorageStep({ nodeCount: "3", onHardware: addSpareDisk });
    expect(screen.getAllByRole("radio", { name: /^ceph osd/ })).toHaveLength(3);
    expect(screen.queryByRole("radio", { name: /^local storage/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /^leave unused/ })).not.toBeInTheDocument();
    expect(screen.getAllByText(/only disk beyond boot, so it has to join the pool/i)).toHaveLength(3);
  });

  it("offers only the pool role for a node's sole disk under zfs", async () => {
    await renderAtStorageStep({ nodeCount: "3", onHardware: addSpareDisk, onNetwork: chooseZfs });
    expect(screen.getAllByRole("radio", { name: /^zfs pool member/ })).toHaveLength(3);
    expect(screen.queryByRole("radio", { name: /^local storage/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /^leave unused/ })).not.toBeInTheDocument();
  });

  // going from two disks to one must not strand a role the picker can no
  // longer show.
  // read-side: the stored choice is kept, the radios show the role in
  // effect — here ceph, the only one a sole disk can take
  it("shows a sole disk in the pool whatever role was stored for it", async () => {
    await renderAtStorageStep({
      nodeCount: "3",
      onHardware: addSpareDisk,
      onNetwork: async () => {
        // simulate a save from when the node had a choice
        const state = (await saved()) as PersistedState;
        for (const n of state.nodes) n.additionalDisks[0].role = "local";
        await savePersistedState(state);
      },
    });
    for (const radio of screen.getAllByRole("radio", { name: /^ceph osd/ })) expect(radio).toBeChecked();
    expect((await saved())?.nodes.every((n) => n.additionalDisks[0].role === "local")).toBe(true);
  });

  // a new disk has no role stored; it shows in the storage that's on
  it("shows an unchosen disk in the cluster storage that's on", async () => {
    await renderAtStorageStep({ nodeCount: "3", onHardware: addTwoSpareDisks });
    for (const radio of screen.getAllByRole("radio", { name: /^ceph osd/ })) expect(radio).toBeChecked();
    expect((await saved())?.nodes.every((n) => n.additionalDisks.every((d) => d.role === ""))).toBe(true);
  });

  it("names the pool role after the mode — zfs, not ceph", async () => {
    await renderAtStorageStep({ nodeCount: "3", onHardware: addSpareDisk, onNetwork: chooseZfs });
    expect(screen.getAllByRole("radio", { name: /^zfs pool member/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("radio", { name: /^ceph osd/ })).not.toBeInTheDocument();
  });

  it("moves a disk out of the pool when its role changes", async () => {
    const user = await renderAtStorageStep({ nodeCount: "3", onHardware: addTwoSpareDisks });
    await user.click(screen.getAllByRole("radio", { name: /^leave unused/ })[0]);
    await waitForSave((state) => state.nodes[0].additionalDisks[0].role === "unused");
  });

  // the boot disk is the one disk a visitor never assigns, so it's shown
  // apart rather than as another row with a role picker.
  it("shows the boot disk as already spoken for", async () => {
    await renderAtStorageStep({ nodeCount: "3", onHardware: addSpareDisk });
    expect(screen.getAllByText(/proxmox owns this one/i).length).toBeGreaterThan(0);
  });

  it("warns when a node contributes nothing to the pool", async () => {
    const user = await renderAtStorageStep({ nodeCount: "3", onHardware: addTwoSpareDisks });
    // node 1's two disks are the first two "leave unused" radios; taking
    // both out of the pool leaves that node with nothing in it
    await user.click(screen.getAllByRole("radio", { name: /^leave unused/ })[0]);
    await user.click(screen.getAllByRole("radio", { name: /^leave unused/ })[1]);
    expect(await screen.findByText(/1 of 3 nodes contribute no disk to ceph/i)).toBeInTheDocument();
  });

  it("rejects a pool name zfs would refuse", async () => {
    const user = await renderAtStorageStep({ nodeCount: "3", onHardware: addSpareDisk });
    const field = screen.getByLabelText(/^pool name/i);
    await user.clear(field);
    await user.type(field, "mirror");
    expect(await screen.findByText(/reserved by zfs/i)).toBeInTheDocument();
  });

  // invalid values aren't warned about after the fact — they're never
  // offered in the first place.
  it("offers no more replicas than there are nodes", async () => {
    await renderAtStorageStep({ nodeCount: "3", onHardware: addSpareDisk });
    const options = within(screen.getByLabelText(/replicas \(size\)/i)).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["2", "3"]);
  });

  it("offers min_size only up to the replica count", async () => {
    const user = await renderAtStorageStep({ nodeCount: "3", onHardware: addSpareDisk });
    expect(within(screen.getByLabelText(/min replicas/i)).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "2",
      "3",
    ]);
    await user.selectOptions(screen.getByLabelText(/replicas \(size\)/i), "2");
    const options = within(screen.getByLabelText(/min replicas/i)).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["2"]);
  });

  it("never shows min_size above size", async () => {
    const user = await renderAtStorageStep({ nodeCount: "3", onHardware: addSpareDisk });
    await user.selectOptions(screen.getByLabelText(/min replicas/i), "3");
    await user.selectOptions(screen.getByLabelText(/replicas \(size\)/i), "2");
    expect(screen.getByLabelText(/min replicas/i)).toHaveValue("2");
    // the choice of 3 is kept, not overwritten — raising size brings it back
    await user.selectOptions(screen.getByLabelText(/replicas \(size\)/i), "3");
    expect(screen.getByLabelText(/min replicas/i)).toHaveValue("3");
  });

  // the wizard starts at one node; ceph's default of 3 replicas must
  // survive that and apply once the cluster is big enough.
  it("keeps ceph's default of 3 replicas after starting from a single node", async () => {
    await renderAtStorageStep({ nodeCount: "3", onHardware: addSpareDisk });
    expect(screen.getByLabelText(/replicas \(size\)/i)).toHaveValue("3");
    expect(screen.getByLabelText(/min replicas/i)).toHaveValue("2");
  });

  // a save from a bigger cluster, reopened after the node count dropped,
  // must not show a replica count this cluster can't place.
  it("shows a saved replica count only as far as the node count allows", async () => {
    await renderAtStorageStep({
      nodeCount: "2",
      onHardware: addSpareDisk,
      onNetwork: async () => {
        const state = (await saved()) as PersistedState;
        state.storage.ceph = { ...state.storage.ceph, replicas: "3", minReplicas: "3" };
        await savePersistedState(state);
      },
    });
    expect(screen.getByLabelText(/replicas \(size\)/i)).toHaveValue("2");
    expect(screen.getByLabelText(/min replicas/i)).toHaveValue("2");
  });

  it("warns about 2 replicas on a cluster big enough for 3", async () => {
    const user = await renderAtStorageStep({ nodeCount: "3", onHardware: addSpareDisk });
    await user.selectOptions(screen.getByLabelText(/replicas \(size\)/i), "2");
    expect(await screen.findByText(/3 is the default for good reason/i)).toBeInTheDocument();
  });

  it("swaps the ceph pool card for the zfs one when the mode changes", async () => {
    await renderAtStorageStep({ nodeCount: "3", onHardware: addSpareDisk, onNetwork: chooseZfs });
    expect(screen.getByText("the replicated zfs pool")).toBeInTheDocument();
    expect(screen.queryByText("the ceph pool")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/replicate every/i)).toBeInTheDocument();
  });

  // only layouts every node can build are offered at all
  it("offers only a stripe when nodes have one pool disk", async () => {
    await renderAtStorageStep({ nodeCount: "3", onHardware: addSpareDisk, onNetwork: chooseZfs });
    const layouts = within(screen.getByText(/how the pool's disks are arranged/i).closest("fieldset") as HTMLElement);
    expect(layouts.getAllByRole("radio").map((r) => r.closest("label")?.textContent)).toEqual([
      expect.stringMatching(/^stripe/),
    ]);
    expect(layouts.getByText(/with 1 pool disk on the thinnest node/i)).toBeInTheDocument();
  });

  it("offers mirror and stripe with two pool disks, but no raidz", async () => {
    await renderAtStorageStep({ nodeCount: "3", onHardware: addTwoSpareDisks, onNetwork: chooseZfs });
    expect(screen.getByRole("radio", { name: /^mirror/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^stripe/ })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /^raidz/ })).not.toBeInTheDocument();
  });

  // the thinnest node decides, even when others have more disks
  it("limits the layouts by the node with the fewest pool disks", async () => {
    await renderAtStorageStep({
      nodeCount: "2",
      onHardware: async (user) => {
        const counts = screen.getAllByLabelText(/number of additional disks/i);
        await user.clear(counts[0]);
        await user.type(counts[0], "4");
        await user.clear(counts[1]);
        await user.type(counts[1], "2");
      },
      onNetwork: chooseZfs,
    });
    expect(screen.queryByRole("radio", { name: /^raidz/ })).not.toBeInTheDocument();
  });

  // a chosen layout that stops fitting falls back, and isn't overwritten
  it("shows a layout that no longer fits as mirror, keeping the choice", async () => {
    await renderAtStorageStep({
      nodeCount: "3",
      onHardware: addTwoSpareDisks,
      onNetwork: async (user) => {
        await chooseZfs(user);
        // let the zfs choice's own autosave land first, or this edit would
        // be written over a state that still says ceph
        await waitForSave((s) => s.clusterStorage.zfs && !s.clusterStorage.ceph);
        const state = (await saved()) as PersistedState;
        state.storage.zfs = { ...state.storage.zfs, raidLevel: "raidz2" };
        await savePersistedState(state);
      },
    });
    expect(screen.getByRole("radio", { name: /^mirror/ })).toBeChecked();
    expect((await saved())?.storage.zfs.raidLevel).toBe("raidz2");
  });

  it("keeps the disk roles but drops the pool card with no cluster storage", async () => {
    await renderAtStorageStep({
      nodeCount: "3",
      onHardware: addSpareDisk,
      onNetwork: (user) => chooseClusterStorage(user, { ceph: false, zfs: false }),
    });
    expect(screen.queryByText("the ceph pool")).not.toBeInTheDocument();
    expect(screen.queryByText("the replicated zfs pool")).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /^ceph osd/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("radio", { name: /^local storage/ }).length).toBeGreaterThan(0);
  });

  // isos and templates go to proxmox's own "local" storage, which needs no
  // setup — so there's nothing to ask.
  it("doesn't ask where isos live", async () => {
    await renderAtStorageStep({ nodeCount: "3", onHardware: addTwoSpareDisks });
    expect(screen.queryByLabelText(/isos and container templates/i)).not.toBeInTheDocument();
  });

  // with no disk marked local there's no local pool to configure.
  it("hides the local pool until some disk is marked local", async () => {
    const user = await renderAtStorageStep({ nodeCount: "3", onHardware: addTwoSpareDisks });
    expect(screen.queryByText("the local storage pool")).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /^lvm-thin/ })).not.toBeInTheDocument();

    await user.click(screen.getAllByRole("radio", { name: /^local storage/ })[1]);
    expect(await screen.findByText("the local storage pool")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^lvm-thin/ })).toBeInTheDocument();
    expect(screen.getByLabelText(/storage id/i)).toBeInTheDocument();

    await user.click(screen.getAllByRole("radio", { name: /^ceph osd/ })[1]);
    expect(screen.queryByText("the local storage pool")).not.toBeInTheDocument();
  });

  it("syncs disk roles across nodes under identical storage", async () => {
    const user = await renderAtStorageStep({ nodeCount: "3", onHardware: addTwoSpareDisks });
    await user.click(screen.getByRole("checkbox", { name: /identical disk layout/i }));
    await user.click(screen.getAllByRole("radio", { name: /^local storage/ })[1]);
    await waitForSave((state) => state.nodes.every((n) => n.additionalDisks[1].role === "local"));
  });

  it("collapses to a single shared card under identical storage", async () => {
    const user = await renderAtStorageStep({ nodeCount: "3", onHardware: addSpareDisk });
    expect(screen.getAllByText(/proxmox owns this one/i)).toHaveLength(3);
    await user.click(screen.getByRole("checkbox", { name: /identical disk layout/i }));
    expect(screen.getAllByText(/proxmox owns this one/i)).toHaveLength(1);
    expect(screen.getByText("every node's disks")).toBeInTheDocument();
  });
});

describe("step 5 — backups", () => {
  // a save that got past steps 1–3, left at step 4 with the backup
  // defaults — the pbs address still blank, as a visitor would find it
  async function renderStep4(backups = backupPlan({ pbsAddress: "" })) {
    await savePersistedState(
        persistedState({
          currentStep: "backups",
          nodes: cluster(3, { ramGb: "64", bootDiskSizeGb: "512" }),
          backups,
        }),
      );
    const user = userEvent.setup();
    render(<Setup />);
    await screen.findByRole("heading", { name: "backups" });
    return user;
  }
  const target = (name: RegExp) => screen.getByRole("radio", { name });

  it("is reached from step 4 through its hand-off", async () => {
    await renderAtBackupsStep();
    expect(target(/on its own machine/i)).toBeChecked();
    expect(screen.getByLabelText(/pbs address/i)).toHaveValue("");
  }, 30_000);

  it("starts on a separate pbs with the default retention", async () => {
    await renderStep4();
    expect(target(/on its own machine/i)).toBeChecked();
    expect(screen.getByLabelText(/^datastore/i)).toHaveValue("backups");
    expect(screen.getByLabelText(/backup time/i)).toHaveValue("02:00");
    expect(screen.getByLabelText(/keep monthly/i)).toHaveValue(6);
    expect(summaryVal(/oldest reaches back/)).toBe("about 6 months");
  });

  it("asks only for the chosen target's own fields", async () => {
    const user = await renderStep4();
    await user.click(target(/as a vm/i));
    expect(screen.queryByLabelText(/pbs address/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^datastore/i)).toBeInTheDocument();

    await user.click(target(/nfs/i));
    expect(screen.queryByLabelText(/^datastore/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/nfs server/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/export path/i)).toBeInTheDocument();
    // verify, encryption and sync are pbs features
    expect(screen.queryByRole("checkbox", { name: /encrypt/i })).not.toBeInTheDocument();
  });

  it("asks for nothing, and warns, with no backups", async () => {
    const user = await renderStep4();
    await user.click(target(/no backups/i));
    expect(screen.queryByLabelText(/backup time/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/keep daily/i)).not.toBeInTheDocument();
    expect(screen.getByText(/gone for good\. ceph and zfs replication/i)).toBeInTheDocument();
  });

  it("won't preview without the pbs address, and lists it", async () => {
    const user = await renderStep4();
    await user.click(screen.getByRole("button", { name: /preview/i }));
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/pbs address/i);
    // spaced off the fields above it (see .pc-stepflow__card .pc-problemlist)
    expect(screen.getByRole("alert")).toHaveClass("pc-problemlist");

    await user.type(screen.getByLabelText(/pbs address/i), "pbs.lab.lan");
    await user.click(screen.getByRole("button", { name: /preview/i }));
    expect(router.push).toHaveBeenCalledWith("/setup/preview/backups");
  });

  // quiet until the visitor has been in the field — no red on arrival
  it("holds an address error back until the field is left", async () => {
    const user = await renderStep4();
    const field = screen.getByLabelText(/pbs address/i);
    expect(screen.queryByText("required")).not.toBeInTheDocument();
    await user.type(field, "pbs_01");
    expect(screen.queryByText(/hostname like/)).not.toBeInTheDocument();
    await user.tab();
    expect(screen.getByText(/hostname like/)).toBeInTheDocument();
  });

  it("recounts the retention as it's edited", async () => {
    const user = await renderStep4();
    const monthly = screen.getByLabelText(/keep monthly/i);
    await user.clear(monthly);
    await user.type(monthly, "12");
    expect(summaryVal(/oldest reaches back/)).toBe("about 12 months");
    expect(summaryVal(/backups kept per vm/)).toBe("up to 26");
  });

  it("won't take retention that keeps nothing", async () => {
    const user = await renderStep4(backupPlan());
    for (const label of [/keep last/i, /keep daily/i, /keep weekly/i, /keep monthly/i]) {
      await user.clear(screen.getByLabelText(label));
      await user.type(screen.getByLabelText(label), "0");
    }
    expect(screen.getByText(/deleted as soon as it's made/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /preview/i }));
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/keeps nothing/i);
  });

  it("asks where the off-site copy goes once it's ticked", async () => {
    const user = await renderStep4(backupPlan());
    expect(screen.queryByLabelText(/off-site pbs address/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /off-site pbs/i }));
    expect(screen.getByLabelText(/off-site pbs address/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /preview/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/off-site pbs address/i);
  });

  it("warns about a pbs vm until there's an off-site copy", async () => {
    const user = await renderStep4(backupPlan());
    await user.click(target(/as a vm/i));
    expect(screen.getByText(/takes the backups with it/i)).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /off-site pbs/i }));
    expect(screen.queryByText(/takes the backups with it/i)).not.toBeInTheDocument();
    expect(screen.getByText(/fine while the off-site copy/i)).toBeInTheDocument();
  });

  // the fixture's nodes each have one 1000 gb disk, in ceph with 3 replicas
  it("says how big a full backup can get once storage is full", async () => {
    const user = await renderStep4(backupPlan());
    expect(screen.getByText(/one full backup of every guest is up to 1\.0 tb/i)).toBeInTheDocument();
    await user.click(target(/nfs/i));
    expect(screen.getByText(/20 kept backups can reach 20 tb/i)).toBeInTheDocument();
    await user.click(target(/no backups/i));
    expect(screen.queryByText(/one full backup of every guest/i)).not.toBeInTheDocument();
  });

  it("reminds to keep the encryption key safe", async () => {
    const user = await renderStep4(backupPlan());
    await user.click(screen.getByRole("checkbox", { name: /encrypt backups/i }));
    expect(screen.getByText(/without it an encrypted backup can't be restored/i)).toBeInTheDocument();
  });

  it("saves the plan as it's edited", async () => {
    const user = await renderStep4();
    await user.click(target(/nfs/i));
    await user.type(screen.getByLabelText(/nfs server/i), "nas.lab.lan");
    await waitForSave((s) => s.backups.target === "nfs" && s.backups.nfsServer === "nas.lab.lan");
  });

  it("goes back to storage", async () => {
    const user = await renderStep4();
    await user.click(screen.getByRole("button", { name: /back/i }));
    expect(await screen.findByRole("heading", { name: "storage" })).toBeInTheDocument();
  });
});

/** a summary cell's value in the wizard, by its key */
function summaryVal(key: RegExp): string {
  const keyEl = screen.getAllByText(key).find((el) => el.classList.contains("pc-summary__key"));
  return keyEl?.parentElement?.querySelector(".pc-summary__val")?.textContent ?? "";
}

describe("step 6 — access", () => {
  // a save that got past steps 1–4, left at step 5 with nothing entered yet
  async function renderStep5(access = defaultAccessPlan()) {
    await savePersistedState(
      persistedState({ currentStep: "access", nodes: cluster(3, { ramGb: "64", bootDiskSizeGb: "512" }), access }),
    );
    const user = userEvent.setup();
    render(<Setup />);
    await screen.findByRole("heading", { name: "access" });
    return user;
  }
  const keysField = () => screen.getByLabelText(/^ssh public key/i);
  const passwordFields = () => screen.getAllByLabelText(/^root password — /i) as HTMLInputElement[];

  it("asks for a key and a root password per node, with password ssh off", async () => {
    await renderStep5();
    expect(screen.getByText("# step 6 of 8")).toBeInTheDocument();
    expect(keysField()).toHaveValue("");
    expect(passwordFields().map((f) => f.id)).toEqual(["rootpw-0", "rootpw-1", "rootpw-2"]);
    expect(screen.getByLabelText(/^root password — pve02/i)).toHaveAttribute("type", "password");
    expect(screen.getByRole("checkbox", { name: /^turn off password logins over ssh/i })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /^sign in to the web ui with oidc/i })).not.toBeChecked();
  });

  it("won't preview without a key and every password, and lists them", async () => {
    const user = await renderStep5();
    await user.click(screen.getByRole("button", { name: /preview/i }));
    expect(router.push).not.toHaveBeenCalled();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/ssh public key/i);
    for (const node of ["pve01", "pve02", "pve03"]) expect(alert).toHaveTextContent(new RegExp(`${node}.*root password`, "i"));

    await user.click(keysField());
    await user.paste(ED25519_KEY);
    for (const button of screen.getAllByRole("button", { name: /^generate$/i })) await user.click(button);
    await user.click(screen.getByRole("button", { name: /preview/i }));
    expect(router.push).toHaveBeenCalledWith("/setup/preview/access");
  });

  it("lists the keys it recognizes", async () => {
    const user = await renderStep5();
    await user.click(keysField());
    await user.paste(`${ED25519_KEY}\n${RSA_KEY}`);
    expect(screen.getByText("test@fixture")).toBeInTheDocument();
    expect(screen.getByText("rsa@fixture")).toBeInTheDocument();
  });

  // flagged the moment it's pasted — not after the field is left
  it("flags a pasted private key at once", async () => {
    const user = await renderStep5();
    await user.click(keysField());
    await user.paste("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----");
    expect(screen.getByText(/that's a private key — never paste it anywhere/i)).toBeInTheDocument();
  });

  it("hides a password until it's asked for", async () => {
    const user = await renderStep5();
    const field = screen.getByLabelText(/^root password — pve01/i);
    await user.type(field, "correct-horse-battery");
    expect(field).toHaveAttribute("type", "password");
    await user.click(within(field.closest(".pc-field") as HTMLElement).getByRole("button", { name: /^show$/i }));
    expect(field).toHaveAttribute("type", "text");
    expect(field).toHaveValue("correct-horse-battery");
  });

  // a generated password is useless until it's copied somewhere safe
  it("generates a password and shows it", async () => {
    const user = await renderStep5();
    const field = screen.getByLabelText(/^root password — pve02/i);
    await user.click(within(field.closest(".pc-field") as HTMLElement).getByRole("button", { name: /^generate$/i }));
    expect(field).toHaveAttribute("type", "text");
    expect((field as HTMLInputElement).value).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{24}$/);
  });

  it("warns when ssh keeps taking passwords", async () => {
    const user = await renderStep5();
    expect(screen.queryByText(/anything that reaches port 22/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /^turn off password logins over ssh/i }));
    expect(screen.getByText(/anything that reaches port 22/i)).toBeInTheDocument();
    await waitForSave((s) => s.access.disablePasswordSsh === false);
  });

  it("sets up oidc on request, with the redirect uris to register", async () => {
    const user = await renderStep5(accessPlan());
    expect(screen.queryByLabelText(/^issuer url/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /^sign in to the web ui with oidc/i }));
    expect(screen.getByLabelText(/^realm/i)).toHaveValue("oidc");
    expect(screen.getByLabelText(/^client secret/i)).toHaveAttribute("type", "password");
    expect(screen.getByText("https://pve01.lab.lan:8006")).toBeInTheDocument();
    expect(screen.getByText("https://pve03.lab.lan:8006")).toBeInTheDocument();

    // required once it's on
    await user.click(screen.getByRole("button", { name: /preview/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/issuer url/i);

    await user.type(screen.getByLabelText(/^issuer url/i), "https://auth.lab.lan/application/o/pve/");
    await user.type(screen.getByLabelText(/^client id/i), "proxmox");
    await user.click(screen.getByRole("radio", { name: /^email/i }));
    await waitForSave((s) => s.access.oidc.enabled && s.access.oidc.clientId === "proxmox" && s.access.oidc.usernameClaim === "email");
    await user.click(screen.getByRole("button", { name: /preview/i }));
    expect(router.push).toHaveBeenCalledWith("/setup/preview/access");
  });

  it("notes one root password on every node", async () => {
    const user = await renderStep5(accessPlan({ rootPasswords: [] }));
    for (const field of passwordFields()) await user.type(field, "same-password-everywhere");
    expect(screen.getByText(/every node has the same root password/i)).toBeInTheDocument();
  });

  // the whole reason for the passphrase
  it("saves the passwords encrypted", async () => {
    const user = await renderStep5();
    await user.type(screen.getByLabelText(/^root password — pve01/i), "a-secret-root-password");
    await waitForSave((s) => s.access.rootPasswords[0] === "a-secret-root-password");
    expect(window.localStorage.getItem(STORAGE_KEY)).not.toContain("a-secret-root-password");
  });

  it("goes back to backups", async () => {
    const user = await renderStep5();
    await user.click(screen.getByRole("button", { name: /^\[?\s*back/i }));
    expect(await screen.findByRole("heading", { name: "backups" })).toBeInTheDocument();
  });
});

describe("the passphrase", () => {
  // every other test starts unlocked; these start as a fresh visit does
  it("asks for a new passphrase before the wizard opens, and wants it twice", async () => {
    lock();
    const user = userEvent.setup();
    render(<Setup />);
    expect(await screen.findByRole("heading", { name: "choose a passphrase" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "location" })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(/^passphrase/i), "short");
    await user.click(screen.getByRole("button", { name: /start/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/at least 12 characters/i);

    await user.clear(screen.getByLabelText(/^passphrase/i));
    await user.type(screen.getByLabelText(/^passphrase/i), "a long enough passphrase");
    await user.type(screen.getByLabelText(/^once more/i), "a long enough passphrase!");
    await user.click(screen.getByRole("button", { name: /start/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/don't match/i);

    await user.clear(screen.getByLabelText(/^once more/i));
    await user.type(screen.getByLabelText(/^once more/i), "a long enough passphrase");
    await user.click(screen.getByRole("button", { name: /start/i }));
    expect(await screen.findByRole("heading", { name: "location" })).toBeInTheDocument();

    // what it saves opens with that passphrase, and only that one
    await user.click(screen.getByRole("button", { name: /^\[?\s*next/i }));
    await setNodeCount(user, "2");
    await waitForSave((s) => s.nodeCount === "2");
    lock();
    expect(await unlockStored("a long enough passphrase")).toMatchObject({ nodeCount: "2" });
  });

  it("unlocks a saved setup, and restores it", async () => {
    await savePersistedState(persistedState({ currentStep: "network" }));
    lock();
    const user = userEvent.setup();
    render(<Setup />);
    expect(await screen.findByRole("heading", { name: "unlock your setup" })).toBeInTheDocument();

    await user.type(screen.getByLabelText(/^passphrase/i), "the wrong one");
    await user.click(screen.getByRole("button", { name: /^\[?\s*unlock/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not the passphrase/i);

    await user.clear(screen.getByLabelText(/^passphrase/i));
    await user.type(screen.getByLabelText(/^passphrase/i), "test passphrase");
    await user.click(screen.getByRole("button", { name: /^\[?\s*unlock/i }));
    expect(await screen.findByRole("heading", { name: "network" })).toBeInTheDocument();
  });

  // without the passphrase nobody can read it — starting over is the only way on
  it("starts over, deleting the saved setup, only once confirmed", async () => {
    await savePersistedState(persistedState({ currentStep: "network" }));
    lock();
    const user = userEvent.setup();
    render(<Setup />);
    await user.click(await screen.findByRole("button", { name: /forgot it\? start over/i }));
    await user.click(screen.getByRole("button", { name: /^keep it$/i }));
    expect(window.localStorage.getItem(STORAGE_KEY)).not.toBeNull();

    await user.click(screen.getByRole("button", { name: /forgot it\? start over/i }));
    await user.click(screen.getByRole("button", { name: /delete it and start over/i }));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(await screen.findByRole("heading", { name: "choose a passphrase" })).toBeInTheDocument();
  });
});

describe("step 7 — software", () => {
  // a complete setup, left at step 7 with no guests yet
  async function renderStep7(overrides: Partial<PersistedState> = {}) {
    await savePersistedState(
      persistedState({
        currentStep: "software",
        nodes: cluster(3, { ramGb: "64", bootDiskSizeGb: "512" }),
        ...overrides,
      }),
    );
    const user = userEvent.setup();
    render(<Setup />);
    await screen.findByRole("heading", { name: "software" });
    return user;
  }
  const add = (user: ReturnType<typeof userEvent.setup>, what: RegExp) => user.click(screen.getByRole("button", { name: what }));

  // optional: nothing to add, nothing to preview
  it("can be skipped straight to the install", async () => {
    const user = await renderStep7();
    expect(screen.getByText("# step 7 of 8")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /preview/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^\[?\s*skip/i }));
    expect(await screen.findByRole("heading", { name: "install" })).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("adds a vm and a container with valid defaults, and previews them", async () => {
    const user = await renderStep7();
    await add(user, /^\[?\s*\+ vm/i);
    await add(user, /^\[?\s*\+ container/i);
    expect(screen.getByText(/^vm 100 — vm-01/)).toBeInTheDocument();
    expect(screen.getByText(/^container 101 — ct-01/)).toBeInTheDocument();
    await waitForSave((s) => s.software.guests.map((g) => g.kind).join() === "vm,container");
    // with guests, it's a preview like every other step
    expect(screen.queryByRole("button", { name: /^\[?\s*skip/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /preview/i }));
    expect(router.push).toHaveBeenCalledWith("/setup/preview/software");
  });

  describe("kubernetes", () => {
    const planner = () => screen.getByRole("group", { name: "kubernetes cluster" });
    const placement = () => within(screen.getByRole("list", { name: "kubernetes placement" })).getAllByRole("listitem").map((li) => li.textContent);

    // counts and placement come first — nothing is added until they're confirmed
    it("asks for control planes, workers and placement before adding a vm", async () => {
      const user = await renderStep7();
      await add(user, /^\[?\s*\+ kubernetes/i);
      expect(screen.queryByText(/^vm 100/)).not.toBeInTheDocument();
      expect(within(planner()).getByLabelText(/^control planes/i)).toHaveValue("3");
      expect(within(planner()).getByLabelText(/^workers/i)).toHaveValue("3");
      expect(within(planner()).getByRole("radio", { name: /^side by side/i })).toBeChecked();
      // three nodes: separate would leave the workers nowhere
      expect(within(planner()).queryByRole("radio", { name: /^separate/i })).not.toBeInTheDocument();
      expect(placement()).toEqual(["pve01: 1 control plane · 1 worker", "pve02: 1 control plane · 1 worker", "pve03: 1 control plane · 1 worker"]);

      await user.click(within(planner()).getByRole("button", { name: /add 6 vms/i }));
      expect(screen.queryByRole("group", { name: "kubernetes cluster" })).not.toBeInTheDocument();
      await waitForSave(
        (s) =>
          s.software.guests.map((g) => `${g.name}@${g.node}`).join() ===
          "k8s-cp-01@0,k8s-cp-02@1,k8s-cp-03@2,k8s-worker-01@0,k8s-worker-02@1,k8s-worker-03@2",
      );
      const saved = (await loadPersistedState())!.software.guests;
      expect(saved.every((g) => !g.ha && g.disks[0].storage === "local-lvm" && g.cpuType === "host")).toBe(true);
    });

    it("places what the visitor picks, and warns about control planes sharing nodes", async () => {
      const user = await renderStep7({ nodes: cluster(2, { ramGb: "64", bootDiskSizeGb: "512" }) });
      await add(user, /^\[?\s*\+ kubernetes/i);
      expect(within(planner()).getByLabelText(/^control planes/i)).toHaveValue("1");
      await user.selectOptions(within(planner()).getByLabelText(/^control planes/i), "3");
      await user.selectOptions(within(planner()).getByLabelText(/^workers/i), "0");
      expect(placement()).toEqual(["pve01: 2 control planes", "pve02: 1 control plane"]);
      expect(within(planner()).getByText(/3 control planes on 2 nodes/)).toBeInTheDocument();
      expect(within(planner()).getByText(/allowSchedulingOnControlPlanes/)).toBeInTheDocument();
      await user.click(within(planner()).getByRole("button", { name: /add 3 vms/i }));
      await waitForSave((s) => s.software.guests.map((g) => g.k8sRole).join() === "control-plane,control-plane,control-plane");
    });

    // from six nodes the control planes get nodes of their own
    it("proposes separate control plane nodes on a big cluster", async () => {
      const user = await renderStep7({ nodes: cluster(6, { ramGb: "64", bootDiskSizeGb: "512" }) });
      await add(user, /^\[?\s*\+ kubernetes/i);
      expect(within(planner()).getByRole("radio", { name: /^separate/i })).toBeChecked();
      expect(placement().slice(2, 4)).toEqual(["pve03: 1 control plane", "pve04: 1 worker"]);
      await user.click(within(planner()).getByRole("radio", { name: /^side by side/i }));
      await user.selectOptions(within(planner()).getByLabelText(/^workers/i), "6");
      expect(placement()[0]).toBe("pve01: 1 control plane · 1 worker");
    });

    it("re-plans in place of the vms it made, keeping other guests, and cancels without a change", async () => {
      const user = await renderStep7();
      await add(user, /^\[?\s*\+ vm/i);
      await add(user, /^\[?\s*\+ kubernetes/i);
      await user.click(within(planner()).getByRole("button", { name: /^\[?\s*cancel/i }));
      expect(screen.queryByRole("group", { name: "kubernetes cluster" })).not.toBeInTheDocument();
      await add(user, /^\[?\s*\+ kubernetes/i);
      await user.click(within(planner()).getByRole("button", { name: /add 6 vms/i }));
      await waitForSave((s) => s.software.guests.length === 7);

      await add(user, /^\[?\s*re-plan kubernetes/i);
      // it reopens on the layout the vms have
      expect(within(planner()).getByLabelText(/^workers/i)).toHaveValue("3");
      await user.selectOptions(within(planner()).getByLabelText(/^workers/i), "1");
      await user.click(within(planner()).getByRole("button", { name: /replace the 6 kubernetes vms with 4/i }));
      await waitForSave((s) => s.software.guests.map((g) => g.name).join() === "vm-01,k8s-cp-01,k8s-cp-02,k8s-cp-03,k8s-worker-01");
    });

    // kubernetes moves pods itself; its data lives in ceph
    it("offers a kubernetes vm no ha, and keeps its volumes on ceph", async () => {
      const user = await renderStep7();
      await add(user, /^\[?\s*\+ kubernetes/i);
      await user.click(within(planner()).getByRole("button", { name: /add 6 vms/i }));
      expect(screen.queryByRole("checkbox", { name: /^high availability/i })).not.toBeInTheDocument();
      expect(screen.getAllByText(/it's a kubernetes node/i)).toHaveLength(6);

      const storagePanel = screen.getByRole("group", { name: "kubernetes storage" });
      expect(storagePanel).toHaveTextContent(/3 control planes, 3 workers/);
      expect(within(storagePanel).getByRole("checkbox", { name: /^persistent volumes on ceph/i })).toBeChecked();
      // the vms sit on local-lvm; the volumes' 200 gb come out of ceph's 1 tb
      expect(screen.getByRole("figure", { name: /^ceph pool ceph-vm: / })).toHaveTextContent("800 gb free of 1.0 tb");
      const space = within(storagePanel).getByLabelText(/^space for volumes/i);
      await user.clear(space);
      await user.type(space, "500");
      await waitForSave((s) => s.software.kubernetes.volumeGb === "500");
      await user.click(within(storagePanel).getByRole("checkbox", { name: /^persistent volumes on ceph/i }));
      await waitForSave((s) => !s.software.kubernetes.cephVolumes);
      expect(within(storagePanel).queryByLabelText(/^space for volumes/i)).not.toBeInTheDocument();
    });

    it("won't preview without space for the volumes", async () => {
      const user = await renderStep7();
      await add(user, /^\[?\s*\+ kubernetes/i);
      await user.selectOptions(within(planner()).getByLabelText(/^control planes/i), "1");
      await user.selectOptions(within(planner()).getByLabelText(/^workers/i), "0");
      await user.click(within(planner()).getByRole("button", { name: /add 1 vm/i }));
      await user.clear(screen.getByLabelText(/^space for volumes/i));
      await user.click(screen.getByRole("button", { name: /preview/i }));
      expect(router.push).not.toHaveBeenCalled();
      expect(screen.getByRole("alert")).toHaveTextContent(/space for volumes/i);
    });

    it("points to other volume storage when step 4 builds no ceph", async () => {
      const user = await renderStep7({ clusterStorage: { ceph: false, zfs: false } });
      await add(user, /^\[?\s*\+ kubernetes/i);
      await user.click(within(planner()).getByRole("button", { name: /add 6 vms/i }));
      const storagePanel = screen.getByRole("group", { name: "kubernetes storage" });
      expect(within(storagePanel).queryByRole("checkbox")).not.toBeInTheDocument();
      expect(storagePanel).toHaveTextContent(/no ceph in step 4/);
    });
  });

  it("starts a vm on uefi with a tpm", async () => {
    const user = await renderStep7();
    await add(user, /^\[?\s*\+ vm/i);
    await user.click(screen.getByText("system", { selector: ".pc-guestsec__summary .label" }));
    expect(screen.getByLabelText(/^bios/i)).toHaveValue("ovmf");
    expect(screen.getByRole("checkbox", { name: /^tpm 2\.0/i })).toBeChecked();
    await waitForSave((s) => s.software.guests[0]?.bios === "ovmf" && s.software.guests[0]?.tpm === true);
  });

  it("removes a guest", async () => {
    const user = await renderStep7();
    await add(user, /^\[?\s*\+ vm/i);
    await user.click(screen.getByRole("button", { name: /^remove vm-01/i }));
    await waitForSave((s) => s.software.guests.length === 0);
    expect(screen.getByRole("button", { name: /^\[?\s*skip/i })).toBeInTheDocument();
  });

  it("offers only the storage the cluster builds, and ha only on shared storage", async () => {
    const user = await renderStep7();
    await add(user, /^\[?\s*\+ vm/i);
    const storage = screen.getByLabelText(/^storage/i) as HTMLSelectElement;
    expect([...storage.options].map((o) => o.value)).toEqual(["ceph-vm", "local-lvm"]);
    expect(screen.getByRole("checkbox", { name: /^high availability/i })).toBeInTheDocument();

    await user.selectOptions(storage, "local-lvm");
    expect(screen.queryByRole("checkbox", { name: /^high availability/i })).not.toBeInTheDocument();
    expect(screen.getByText(/no high availability — a disk lives on this node only/i)).toBeInTheDocument();
  });

  // the fixture's nodes are all the default family (SandyBridge) —
  // the calculated baseline is its qemu type
  it("defaults the cpu type to step 2's baseline, and offers only what the nodes run", async () => {
    const user = await renderStep7();
    await add(user, /^\[?\s*\+ vm/i);
    await user.click(screen.getByText("cpu", { selector: ".pc-guestsec__summary .label" }));
    const cpu = screen.getByLabelText(/^cpu type/i) as HTMLSelectElement;
    expect(cpu.value).toBe("");
    expect(cpu.selectedOptions[0].textContent).toMatch(/^SandyBridge-IBRS — the cluster's baseline/);
    const values = [...cpu.options].map((o) => o.value);
    // nothing newer than the nodes' own cpu, and no amd-only model
    expect(values).not.toContain("Skylake-Server");
    expect(values).not.toContain("EPYC-Rome");
    expect(values).toContain("x86-64-v2-AES");
    // identical nodes: passing the host cpu through still migrates
    expect(values).toContain("host");
    // a newer generation than the nodes' own is never offered
    expect(values).not.toContain("IvyBridge");
  });

  it("holds a guest to options its disks and nics can take", async () => {
    const user = await renderStep7();
    await add(user, /^\[?\s*\+ vm/i);
    // io thread and ssd emulation on scsi (single controller), neither on virtio's ssd
    expect(screen.getByRole("checkbox", { name: /^io thread/i })).toBeChecked();
    await user.selectOptions(screen.getByLabelText(/^bus/i), "virtio");
    expect(screen.queryByRole("checkbox", { name: /^ssd emulation/i })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/^bus/i), "sata");
    expect(screen.queryByRole("checkbox", { name: /^io thread/i })).not.toBeInTheDocument();
    await waitForSave((s) => s.software.guests[0]?.disks[0]?.bus === "sata" && !s.software.guests[0]?.disks[0]?.iothread);
  });

  it("adds and removes disks and network devices", async () => {
    const user = await renderStep7();
    await add(user, /^\[?\s*\+ vm/i);
    await user.click(screen.getByRole("button", { name: /^\[?\s*\+ disk/i }));
    await user.click(screen.getByRole("button", { name: /^\[?\s*\+ network device/i }));
    await waitForSave((s) => s.software.guests[0]?.disks.length === 2 && s.software.guests[0]?.nics.length === 2);
    await user.click(screen.getByRole("button", { name: /^remove disk 2/i }));
    await user.click(screen.getByRole("button", { name: /^remove nic 2/i }));
    await waitForSave((s) => s.software.guests[0]?.disks.length === 1 && s.software.guests[0]?.nics.length === 1);
  });

  it("gives a container mount points, and keyctl only while unprivileged", async () => {
    const user = await renderStep7();
    await add(user, /^\[?\s*\+ container/i);
    await user.click(screen.getByRole("button", { name: /^\[?\s*\+ mount point/i }));
    expect(screen.getByLabelText(/^path/i)).toHaveValue("/mnt/data1");
    await user.click(screen.getByText("container", { selector: ".pc-guestsec__summary .label" }));
    expect(screen.getByRole("checkbox", { name: /^keyctl/i })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /^unprivileged/i }));
    expect(screen.queryByRole("checkbox", { name: /^keyctl/i })).not.toBeInTheDocument();
  });

  // an iso install sets its own address and users
  it("asks an iso vm for no address and no login", async () => {
    const user = await renderStep7();
    await add(user, /^\[?\s*\+ vm/i);
    expect(screen.getByRole("radio", { name: /^static/i })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/^image/i), "iso");
    expect(screen.queryByRole("radio", { name: /^static/i })).not.toBeInTheDocument();
    expect(screen.getByText(/its address is set in its own installer/i)).toBeInTheDocument();
  });

  it("won't take windows 11 without uefi and a tpm", async () => {
    const user = await renderStep7();
    await add(user, /^\[?\s*\+ vm/i);
    await user.click(screen.getByText("system", { selector: ".pc-guestsec__summary .label" }));
    await user.selectOptions(screen.getByLabelText(/^guest os/i), "win11");
    // the defaults already are
    expect(screen.queryByText(/windows 11 needs/i)).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/^bios/i), "seabios");
    expect(screen.getByText(/windows 11 needs uefi/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /preview/i }));
    expect(router.push).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByLabelText(/^bios/i), "ovmf");
    await user.click(screen.getByRole("checkbox", { name: /^tpm 2\.0/i }));
    expect(screen.getAllByText(/windows 11 needs a tpm/i).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("checkbox", { name: /^tpm 2\.0/i }));
    expect(screen.queryByText(/windows 11 needs/i)).not.toBeInTheDocument();
  });

  it("won't preview a guest with problems, and lists them", async () => {
    const user = await renderStep7();
    await add(user, /^\[?\s*\+ vm/i);
    await add(user, /^\[?\s*\+ vm/i);
    const names = screen.getAllByLabelText(/^name/i);
    await user.clear(names[1]);
    await user.type(names[1], "vm-01");
    await user.click(screen.getByRole("button", { name: /preview/i }));
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/another guest has this name/i);
  });

  it("asks for an address only once it's static", async () => {
    const user = await renderStep7();
    await add(user, /^\[?\s*\+ container/i);
    expect(screen.queryByLabelText(/^static ip/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /^static/i }));
    await user.type(screen.getByLabelText(/^static ip/i), "10.0.0.60/24");
    await waitForSave((s) => s.software.guests[0]?.nics[0]?.ipMode === "static" && s.software.guests[0]?.nics[0]?.ip === "10.0.0.60/24");
  });

  // proxmox 2 + ceph (one osd + monitor) 5 gib of 64, before any guest
  it("shows the room left on every node, live", async () => {
    const user = await renderStep7();
    const memory = () => screen.getAllByRole("figure", { name: /^memory: / });
    expect(memory()).toHaveLength(3);
    expect(memory()[0]).toHaveTextContent("57 gib free of 64 gib");
    expect(screen.getByRole("figure", { name: /^ceph pool ceph-vm: / })).toBeInTheDocument();

    await add(user, /^\[?\s*\+ vm/i);
    // the new vm's 4 gib lands on node 1 only
    expect(memory()[0]).toHaveTextContent("53 gib free of 64 gib");
    expect(memory()[1]).toHaveTextContent("57 gib free of 64 gib");
  });

  it("shows how far a node is overcommitted", async () => {
    const user = await renderStep7();
    await add(user, /^\[?\s*\+ vm/i);
    const memoryField = screen.getByLabelText(/^memory \(gib\)/i);
    await user.clear(memoryField);
    await user.type(memoryField, "80");
    expect(screen.getAllByRole("figure", { name: /^memory: / })[0]).toHaveTextContent("23 gib over");
  });

  it("warns when a node's guests want more memory than it has", async () => {
    const user = await renderStep7();
    await add(user, /^\[?\s*\+ vm/i);
    const memory = screen.getByLabelText(/^memory \(gib\)/i);
    await user.clear(memory);
    await user.type(memory, "80");
    expect(screen.getByText(/ask for 80 gib of memory, but it has 64 gib/i)).toBeInTheDocument();
  });

  it("goes back to access", async () => {
    const user = await renderStep7();
    await user.click(screen.getByRole("button", { name: /^\[?\s*back/i }));
    expect(await screen.findByRole("heading", { name: "access" })).toBeInTheDocument();
  });
});

describe("step 8 — install", () => {
  async function renderStep8(overrides: Partial<PersistedState> = {}) {
    await savePersistedState(
      persistedState({ currentStep: "install", nodes: cluster(3, { ramGb: "64", bootDiskSizeGb: "512" }), ...overrides }),
    );
    render(<Setup />);
    await screen.findByRole("heading", { name: "install" });
  }

  it("offers each node's answer file, with its hash and the keys", async () => {
    await renderStep8({ hostnameSuffix: "lab.lan" });
    expect(screen.getByText("# step 8 of 8")).toBeInTheDocument();
    const links = await screen.findAllByRole("link", { name: /^\[\s*answer-.*\.toml\s*\]$/ }, { timeout: 5000 });
    expect(links.map((l) => l.getAttribute("download"))).toEqual(["answer-pve01.toml", "answer-pve02.toml", "answer-pve03.toml"]);
    const href = links[1].getAttribute("href") ?? "";
    const toml = decodeURIComponent(href.slice(href.indexOf(",") + 1));
    expect(toml).toContain('fqdn = "pve02.lab.lan"');
    expect(toml).toMatch(/root-password-hashed = "\$6\$/);
    expect(toml).toContain(ED25519_KEY);
    expect(toml).toContain('keyboard = "de"');
  });

  // nothing to fix here — so the earlier steps' problems are listed up front
  it("holds the files back, listing what an earlier step still needs", async () => {
    await renderStep8({ access: accessPlan({ rootPasswords: ["long-enough-pw-1", "", "long-enough-pw-3"] }) });
    expect(screen.getByRole("alert")).toHaveTextContent(/step access/i);
    expect(screen.getByText(/fix the problems listed below first/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /answer-.*\.toml/ })).not.toBeInTheDocument();
  });

  it("goes back to software", async () => {
    await renderStep8();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^\[?\s*back/i }));
    expect(await screen.findByRole("heading", { name: "software" })).toBeInTheDocument();
  });
});
