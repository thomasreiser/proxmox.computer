/**
 * Shared helpers for tests that drive the real wizard through its UI
 * (page.test.tsx, wizard-editing.test.tsx). They reach each step the way a
 * visitor does — fill the earlier steps in, hand off through
 * persistCurrentStep like the preview routes, remount — and wait on the
 * debounced autosave rather than assuming it already ran.
 */
import { expect } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Setup from "./page";
import { STORAGE_KEY, persistCurrentStep, type PersistedState } from "./wizard-state";

export type User = ReturnType<typeof userEvent.setup>;

export function saved(): PersistedState | null {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as PersistedState) : null;
}

/**
 * The wizard's autosave is debounced by 300ms, so anything that reads
 * localStorage has to wait for it rather than assume the write already
 * landed. Waiting on a predicate (not a fixed delay) keeps this honest if
 * the debounce window ever changes.
 */
export function waitForSave(predicate: (state: PersistedState) => boolean) {
  return waitFor(
    () => {
      const state = saved();
      expect(state).not.toBeNull();
      expect(predicate(state as PersistedState)).toBe(true);
    },
    { timeout: SAVE_TIMEOUT },
  );
}

/**
 * Testing Library's default 1s wait is only ~3× the 300ms debounce, and
 * under a full-suite run (many jsdom workers at once) a burst of clicks
 * followed by that debounce can exceed it — which made a correct test fail
 * one run in a few. 5s is generous without hiding a save that truly never
 * happens.
 */
export const SAVE_TIMEOUT = 5000;

export async function setNodeCount(user: User, count: string) {
  const field = screen.getByLabelText(/number of nodes/i);
  await user.clear(field);
  await user.type(field, count);
}

/**
 * Fills step 1's required fields that start blank — memory, boot disk
 * size, and any spare disk's size — on every node's form. A fresh node
 * can't pass step 1's gate without them, which is the point of the gate.
 */
export async function fillRequiredHardware(user: User) {
  const fill = async (label: RegExp, value: string) => {
    for (const field of screen.queryAllByLabelText(label) as HTMLInputElement[]) {
      if (!field.value) await user.type(field, value);
    }
  };
  await fill(/^memory \(gb\)/i, "64");
  await fill(/^boot disk size/i, "512");
  await fill(/^size \(gb\)/i, "1000");
}

/**
 * Fills every empty address field on step 2 with the example its
 * placeholder suggests ("e.g. 10.0.20.0/24") — what a visitor does to get
 * past step 2's gate without planning their own subnets.
 */
export async function fillRequiredNetwork(user: User) {
  const empty = () =>
    (screen.queryAllByRole("textbox") as HTMLInputElement[]).filter(
      (field) => !field.value && field.placeholder.startsWith("e.g. "),
    );
  // re-query each time: typing re-renders, and placeholders can move on
  for (let guard = 0; guard < 64; guard++) {
    const field = empty()[0];
    if (!field) break;
    await user.type(field, field.placeholder.slice("e.g. ".length));
  }
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
export async function renderAtNetworkStep(opts: { nodeCount?: string; onHardware?: (user: User) => Promise<void> } = {}) {
  const user = userEvent.setup();
  const first = render(<Setup />);
  if (opts.nodeCount) {
    await setNodeCount(user, opts.nodeCount);
    await waitForSave((state) => state.nodeCount === opts.nodeCount);
  }
  // step 1 has to be complete, as it would be for a visitor who got past
  // its gate — after onHardware, so any disks it adds get sizes too.
  // persistCurrentStep reads localStorage back, so the hand-off waits for
  // the 300ms autosave to actually flush these edits — a "some state
  // exists" check would pass instantly and hand off a state that
  // predates them.
  const before = window.localStorage.getItem(STORAGE_KEY);
  await opts.onHardware?.(user);
  await fillRequiredHardware(user);
  await waitFor(() => expect(window.localStorage.getItem(STORAGE_KEY)).not.toBe(before), {
    timeout: SAVE_TIMEOUT,
  });

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
 * Renders the wizard on step 3, the same way: step 2 hands off through
 * /setup/preview/network. `onNetwork` runs while step 2 is on screen, for
 * the tests that need a particular cluster storage mode first.
 */
export async function renderAtStorageStep(opts: {
  nodeCount?: string;
  onHardware?: (user: User) => Promise<void>;
  onNetwork?: (user: User) => Promise<void>;
} = {}) {
  const user = await renderAtNetworkStep({ nodeCount: opts.nodeCount, onHardware: opts.onHardware });
  // step 2 complete too, as it is for a visitor who got past its gate —
  // after onNetwork, since its storage choice can add address fields
  const before = window.localStorage.getItem(STORAGE_KEY);
  await opts.onNetwork?.(user);
  await fillRequiredNetwork(user);
  await waitFor(() => expect(window.localStorage.getItem(STORAGE_KEY)).not.toBe(before), {
    timeout: SAVE_TIMEOUT,
  });
  await waitForSave(() => true);
  persistCurrentStep("storage");

  // remounting in place — the step-2 tree is still up, so it has to go
  cleanup();
  render(<Setup />);
  expect(await screen.findByRole("heading", { name: "storage" })).toBeInTheDocument();
  return user;
}

/**
 * ceph and zfs are gated on *every* node having a disk beyond boot, so
 * this fills in whichever disk-count fields are on screen — one when
 * "identical hardware" is on, one per node when it isn't.
 */
export async function addSpareDisk(user: User) {
  await setSpareDiskCount(user, "1");
}

/**
 * Two spare disks per node. With just one, cluster storage leaves it no
 * choice but the pool (see soleDiskMustJoinPool), so any test that moves a
 * disk to local or unused needs a second disk to move.
 */
export async function addTwoSpareDisks(user: User) {
  await setSpareDiskCount(user, "2");
}

export async function setSpareDiskCount(user: User, count: string) {
  for (const field of screen.getAllByLabelText(/number of additional disks/i)) {
    await user.clear(field);
    await user.type(field, count);
  }
}

/**
 * The cluster-storage checkboxes share wording with the per-nic purpose
 * options ("zfs replication" appears in both), so every query for them is
 * scoped to their own fieldset rather than the whole page.
 */
export function clusterStorage(): HTMLElement {
  return screen.getByText(/^cluster storage/).closest("fieldset") as HTMLElement;
}

/** the checkbox for one cluster storage mode */
export function storageCheckbox(mode: "ceph" | "zfs"): HTMLInputElement {
  const name = mode === "ceph" ? /^ceph \(recommended\)/ : /^zfs with replication/i;
  return within(clusterStorage()).getByRole("checkbox", { name }) as HTMLInputElement;
}

/**
 * Sets step 2's cluster storage to exactly this — ceph and zfs are
 * independent checkboxes, so e.g. "zfs only" means unticking ceph as well
 * as ticking zfs. zfs is set after ceph so it's never blocked by a ceph
 * that's about to be unticked.
 */
export async function chooseClusterStorage(user: User, want: { ceph: boolean; zfs: boolean }) {
  for (const mode of ["ceph", "zfs"] as const) {
    if (storageCheckbox(mode).checked !== want[mode]) await user.click(storageCheckbox(mode));
  }
}
