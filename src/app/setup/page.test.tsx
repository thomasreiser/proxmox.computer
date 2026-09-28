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
import { STORAGE_KEY, persistCurrentStep, type PersistedState } from "./wizard-state";

function saved(): PersistedState | null {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as PersistedState) : null;
}

/**
 * The wizard's autosave is debounced by 300ms, so anything that reads
 * localStorage has to wait for it rather than assume the write already
 * landed. Waiting on a predicate (not a fixed delay) keeps this honest if
 * the debounce window ever changes.
 */
function waitForSave(predicate: (state: PersistedState) => boolean) {
  return waitFor(() => {
    const state = saved();
    expect(state).not.toBeNull();
    expect(predicate(state as PersistedState)).toBe(true);
  });
}

async function setNodeCount(user: ReturnType<typeof userEvent.setup>, count: string) {
  const field = screen.getByLabelText(/number of nodes/i);
  await user.clear(field);
  await user.type(field, count);
}

/**
 * Renders the wizard already on step 2.
 *
 * In the app you never click straight from hardware to network: step 1
 * hands off to /setup/preview/hardware, and that route calls
 * persistCurrentStep("network") before sending you back here. This walks
 * the same path — fill step 1 in through the form, persist the next step
 * the way the preview route does, remount — so the test exercises the real
 * hand-off rather than reaching into component state.
 */
async function renderAtNetworkStep(opts: { nodeCount?: string; onHardware?: (user: ReturnType<typeof userEvent.setup>) => Promise<void> } = {}) {
  const user = userEvent.setup();
  const first = render(<Setup />);
  if (opts.nodeCount) {
    await setNodeCount(user, opts.nodeCount);
    await waitForSave((state) => state.nodeCount === opts.nodeCount);
  }
  if (opts.onHardware) {
    // persistCurrentStep reads localStorage back, so the hand-off has to
    // wait for the 300ms autosave to actually flush these edits — a
    // "some state exists" check would pass instantly and hand off a state
    // that predates them.
    const before = window.localStorage.getItem(STORAGE_KEY);
    await opts.onHardware(user);
    await waitFor(() => expect(window.localStorage.getItem(STORAGE_KEY)).not.toBe(before));
  }

  // even with no edits at all, the first autosave still has to land before
  // the hand-off can read a state back out
  await waitForSave(() => true);
  persistCurrentStep("network");
  first.unmount();

  render(<Setup />);
  expect(await screen.findByRole("heading", { name: "network" })).toBeInTheDocument();
  return user;
}

/**
 * ceph and zfs are gated on *every* node having a disk beyond boot, so
 * this fills in whichever disk-count fields are on screen — one when
 * "identical hardware" is on, one per node when it isn't.
 */
async function addSpareDisk(user: ReturnType<typeof userEvent.setup>) {
  for (const field of screen.getAllByLabelText(/number of additional disks/i)) {
    await user.clear(field);
    await user.type(field, "1");
  }
}

describe("step 1 — hardware", () => {
  beforeEach(() => render(<Setup />));

  it("opens on the hardware step", () => {
    expect(screen.getByRole("heading", { name: "hardware" })).toBeInTheDocument();
    expect(screen.getByText("# step 1 of 5")).toBeInTheDocument();
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
});

describe("persistence", () => {
  it("saves what was entered and restores it on remount", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Setup />);
    await setNodeCount(user, "3");
    await screen.findByText(/3 nodes gets automatic quorum/i);

    await waitForSave((state) => state.nodeCount === "3" && state.nodes.length === 3);

    unmount();
    render(<Setup />);
    expect(await screen.findByLabelText(/number of nodes/i)).toHaveValue(3);
  });

  // a save from an older build has a different shape, so it's discarded
  // wholesale rather than risking a half-applied state.
  it("ignores a save from another storage version", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, nodeCount: "9" }));
    render(<Setup />);
    expect(await screen.findByRole("heading", { name: "hardware" })).toBeInTheDocument();
    expect(screen.queryByDisplayValue("9")).not.toBeInTheDocument();
  });

  it("survives corrupt json without crashing", async () => {
    window.localStorage.setItem(STORAGE_KEY, "{ not json");
    render(<Setup />);
    expect(await screen.findByRole("heading", { name: "hardware" })).toBeInTheDocument();
  });
});

describe("step 2 — network", () => {
  it("restores at the network step after the preview hands off", async () => {
    await renderAtNetworkStep();
    expect(screen.getByText("# step 2 of 5")).toBeInTheDocument();
  });

  it("derives a gateway and per-node addresses from the homelab subnet", async () => {
    await renderAtNetworkStep({ nodeCount: "2" });
    await waitForSave((state) => state.gateway === "10.0.10.1");
    expect(saved()?.nodes.map((n) => n.network.cidr)).toEqual(["10.0.10.11/24", "10.0.10.12/24"]);
  });

  // cluster storage is a cluster-wide decision, so it has nothing to
  // decide on a single node.
  it("hides cluster storage for a single node", async () => {
    await renderAtNetworkStep();
    expect(screen.queryByText("cluster storage")).not.toBeInTheDocument();
  });

  it("offers cluster storage for a real cluster", async () => {
    await renderAtNetworkStep({ nodeCount: "3", onHardware: addSpareDisk });
    expect(screen.getByText("cluster storage")).toBeInTheDocument();
    const options = within(clusterStorage());
    expect(options.getByRole("radio", { name: /^ceph \(recommended\)/ })).toBeInTheDocument();
    expect(options.getByRole("radio", { name: /^zfs with replication/i })).toBeInTheDocument();
    expect(options.getByRole("radio", { name: /^no ha \/ sync/i })).toBeInTheDocument();
  });

  it("carries the hostname suffix into every node's fqdn", async () => {
    const user = await renderAtNetworkStep({ nodeCount: "2" });
    const suffix = screen.getByLabelText(/hostname suffix/i);
    await user.clear(suffix);
    await user.type(suffix, "lab.lan");
    await waitForSave((state) => state.hostnameSuffix === "lab.lan");
    expect(saved()?.nodes.map((n) => n.network.hostLabel)).toEqual(["pve01", "pve02"]);
  });
});

/**
 * The cluster-storage radios share wording with the per-nic purpose
 * options ("zfs replication" appears in both), so every query for them is
 * scoped to their own fieldset rather than the whole page.
 */
function clusterStorage(): HTMLElement {
  return screen.getByText("cluster storage").closest("fieldset") as HTMLElement;
}

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
      .getByRole("radio", { name: /^ceph \(recommended\)/ })
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

  // the two are deliberately gated differently: the speed caveat belongs
  // to the ceph *option*, so you see it before committing, while the docs
  // link follows the selection.
  it("keeps the speed caveat on the ceph option after switching to zfs", async () => {
    const user = await renderAtNetworkStep({ nodeCount: "3", onHardware: addSpareDisk });
    await user.click(within(clusterStorage()).getByRole("radio", { name: /^zfs with replication/i }));
    expect(cephOption()).toHaveTextContent(/no 10 gbe/i);
  });

  it("drops the docs link once ceph is no longer selected", async () => {
    const user = await renderAtNetworkStep({ nodeCount: "3", onHardware: addSpareDisk });
    expect(screen.getByRole("link", { name: /ceph hardware recommendations/i })).toBeInTheDocument();
    await user.click(within(clusterStorage()).getByRole("radio", { name: /^zfs with replication/i }));
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
