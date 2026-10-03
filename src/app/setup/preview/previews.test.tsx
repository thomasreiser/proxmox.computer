/**
 * Integration tests for the four preview routes. Each renders the real
 * page from a saved state — the way a visitor arrives from the wizard —
 * and checks what's drawn and where "next" hands off to.
 *
 * React Flow does mount its node cards in jsdom (unmeasured, but in the
 * DOM), so card content is asserted directly. Geometry — straight cables,
 * card alignment — can't be checked here and needs a real browser.
 */
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HardwarePreview from "./hardware/page";
import NetworkPreview from "./network/page";
import StoragePreview from "./storage/page";
import BackupsPreview from "./backups/page";
import AccessPreview from "./access/page";
import SoftwarePreview from "./software/page";
import { type PersistedState } from "../wizard-state";
import { loadPersistedState, savePersistedState } from "../saved-state";
import {
  ED25519_FINGERPRINT,
  accessPlan,
  backupPlan,
  bond,
  bridge,
  cluster,
  disks,
  network,
  nics,
  persistedState,
  softwarePlan,
} from "../test-fixtures";
import { lock } from "../vault";
import { newGuest } from "../software";
import { defaultStoragePlan } from "../derive";
import { router } from "@/test/router";

/** saves the state the way the wizard does — sealed with the session key */
function save(state: PersistedState): Promise<boolean> {
  return savePersistedState(state);
}

/**
 * Waits for React Flow to mount the diagram's node cards. The heading shows
 * as soon as the saved setup is decrypted, but the canvas draws a moment
 * later — reading card content before this is a race that fails now and then.
 */
async function drawn() {
  await waitFor(() => expect(document.querySelectorAll(".react-flow__node").length).toBeGreaterThan(0));
}

/** the summary strip's value for a given key, e.g. "osds" → "3" */
function summaryValue(key: RegExp): string {
  const keyEl = screen.getAllByText(key).find((el) => el.classList.contains("pc-summary__key"));
  if (!keyEl) throw new Error(`no summary cell ${key}`);
  return keyEl.parentElement?.querySelector(".pc-summary__val")?.textContent ?? "";
}

// nodes whose ceph traffic runs over nic-1 at the given speed
function cephCluster(speed: "1gbe" | "10gbe" = "10gbe") {
  return cluster(3, {
    nics: nics("1gbe", speed),
    additionalDisks: disks(1000),
    network: network({
      bridgeCounts: { "nic-0": "1", "nic-1": "1" },
      bridges: {
        "nic-0#0": bridge({ name: "vmbr0" }),
        "nic-1#0": bridge({ name: "vmbr1", purposes: ["ceph"], ip: "10.0.20.11/24" }),
      },
    }),
  });
}

describe.each([
  ["hardware", HardwarePreview],
  ["network", NetworkPreview],
  ["storage", StoragePreview],
  ["backups", BackupsPreview],
  ["access", AccessPreview],
  ["software", SoftwarePreview],
] as const)("%s preview with nothing saved", (_name, Preview) => {
  it("offers a way back to step 2 instead of an empty diagram", async () => {
    render(<Preview />);
    expect(await screen.findByText(/nothing saved to preview yet/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /start at step 1/i })).toHaveAttribute("href", "/setup");
  });

  // a save from another build is discarded, not half-rendered
  it("treats a save from another version as nothing saved", async () => {
    await save({ ...persistedState(), version: 1 });
    render(<Preview />);
    expect(await screen.findByText(/nothing saved to preview yet/i)).toBeInTheDocument();
  });
});

describe("hardware preview", () => {
  it("draws a card per node and totals the cluster", async () => {
    await save(persistedState({ currentStep: "hardware", nodes: cluster(3, { additionalDisks: disks(1000) }) }));
    render(<HardwarePreview />);
    expect(await screen.findByText("# step 2 of 8 — preview")).toBeInTheDocument();
    await drawn();
    expect(summaryValue(/^nodes$/i)).toBe("3");
    for (const name of ["pve01", "pve02", "pve03"]) expect(screen.getByText(name)).toBeInTheDocument();
  });

  // more than one grid row: every card is drawn, and there's no minimap —
  // the canvas is fitted to all of them, so it only ever showed a gray box
  it("draws every node of a cluster bigger than one row", async () => {
    await save(persistedState({ currentStep: "hardware", nodeCount: "6", nodes: cluster(6) }));
    render(<HardwarePreview />);
    await screen.findByText("# step 2 of 8 — preview");
    await drawn();
    expect(document.querySelectorAll(".pc-nodecard")).toHaveLength(6);
    expect(document.querySelector(".react-flow__minimap")).toBeNull();
  });

  // the page can be opened by url, so "next" applies the wizard's gate
  it("won't hand off while step 2 has problems, and lists them", async () => {
    const user = userEvent.setup();
    await save(persistedState({ currentStep: "hardware", nodes: cluster(2, { ramGb: "" }), nodeCount: "2" }));
    render(<HardwarePreview />);
    const next = await screen.findByRole("button", { name: /next/i });
    expect(next).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/memory \(gb\)/i);
    await user.click(next);
    expect(router.push).not.toHaveBeenCalled();
    expect((await loadPersistedState())?.currentStep).toBe("hardware");
  });

  it("hands off to the network step", async () => {
    const user = userEvent.setup();
    await save(persistedState({ currentStep: "hardware" }));
    render(<HardwarePreview />);
    await user.click(await screen.findByRole("button", { name: /next/i }));
    // navigating waits for the hand-off to be saved (encrypted), so that comes first
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/setup"));
    expect((await loadPersistedState())?.currentStep).toBe("network");
  });
});

describe("network preview", () => {
  it("counts nodes and physical links", async () => {
    await save(persistedState({ currentStep: "network", nodes: cephCluster() }));
    render(<NetworkPreview />);
    expect(await screen.findByText("# step 3 of 8 — preview")).toBeInTheDocument();
    await drawn();
    expect(summaryValue(/^nodes$/i)).toBe("3");
    expect(summaryValue(/^physical links$/i)).toBe("6");
  });

  it("counts bonds", async () => {
    const nodes = cluster(2, {
      nics: nics("1gbe", "1gbe", "1gbe"),
      network: network({
        bonds: [bond({ nicIndices: [1, 2] })],
        bridgeCounts: { "nic-0": "1", "bond-0": "1" },
        bridges: { "nic-0#0": bridge(), "bond-0#0": bridge({ name: "vmbr1" }) },
      }),
    });
    await save(persistedState({ currentStep: "network", nodes }));
    render(<NetworkPreview />);
    await screen.findByText("# step 3 of 8 — preview");
    await drawn();
    expect(summaryValue(/^bonds$/i)).toBe("2");
  });

  // an lacp bond stays down until the switch groups its ports into a lag
  it("says which ports the switch has to group into a lag", async () => {
    const nodes = cluster(2, {
      nics: nics("1gbe", "10gbe", "10gbe"),
      network: network({
        bondCount: "1",
        bonds: [bond({ name: "bond1", mode: "lacp", nicIndices: [1, 2] })],
        bridgeCounts: { "nic-0": "1", "bond-0": "1" },
        bridges: { "nic-0#0": bridge(), "bond-0#0": bridge({ purposes: ["ceph"], ip: "10.0.20.11/32" }) },
      }),
    });
    await save(persistedState({ currentStep: "network", nodes }));
    render(<NetworkPreview />);
    expect(await screen.findByText(/2 bonds need a lag on the switch/i)).toBeInTheDocument();
    expect(document.querySelectorAll(".pc-laglist__item")).toHaveLength(2);
    // two member ports on each of the two nodes
    expect(screen.getAllByText("lacp bond1").filter((el) => el.classList.contains("pc-switch__portlag"))).toHaveLength(4);
  });

  it("asks for no lag when no bond needs one", async () => {
    await save(persistedState({ currentStep: "network" }));
    render(<NetworkPreview />);
    await screen.findByText("# step 3 of 8 — preview");
    await drawn();
    expect(screen.queryByText(/a lag on the switch/i)).not.toBeInTheDocument();
    expect(document.querySelector(".pc-switch__portlag")).toBeNull();
  });

  // the one physical-layout rule the diagram can state: every ceph port on
  // one switch
  it("counts the ceph links and says they belong on one switch", async () => {
    await save(persistedState({ currentStep: "network", nodes: cephCluster() }));
    render(<NetworkPreview />);
    await screen.findByText("# step 3 of 8 — preview");
    await drawn();
    expect(summaryValue(/^ceph links$/i)).toBe("3");
    expect(screen.getByText(/all 3 ceph links belong on the same physical switch/i)).toBeInTheDocument();
    expect(screen.getByText(/3 ceph — keep on this one switch/i)).toBeInTheDocument();
  });

  it("says nothing about ceph placement when no link carries ceph", async () => {
    await save(persistedState({ currentStep: "network", clusterStorage: { ceph: false, zfs: false } }));
    render(<NetworkPreview />);
    await screen.findByText("# step 3 of 8 — preview");
    await drawn();
    expect(summaryValue(/^ceph links$/i)).toBe("—");
    expect(screen.queryByText(/belong on the same physical switch/i)).not.toBeInTheDocument();
  });

  it("shows the cluster-wide addressing", async () => {
    await save(persistedState({ currentStep: "network" }));
    render(<NetworkPreview />);
    await screen.findByText("# step 3 of 8 — preview");
    await drawn();
    expect(summaryValue(/^gateway$/i)).toBe("10.0.10.1");
    expect(summaryValue(/^domain$/i)).toBe("lab.lan");
    expect(summaryValue(/^native vlan$/i)).toBe("untagged");
  });

  // what you'd configure (or buy) a switch port by: connector and vlans
  it("labels every switch port with its connector and vlan config", async () => {
    const nodes = cluster(1, {
      nics: nics({ speed: "1gbe" }, { speed: "10gbe" }, { speed: "10gbe", port: "rj45" }),
      network: network({
        bridgeCounts: { "nic-0": "1", "nic-1": "2", "nic-2": "1" },
        bridges: {
          "nic-0#0": bridge({ name: "vmbr0" }),
          "nic-1#0": bridge({ name: "vmbr1" }),
          "nic-1#1": bridge({ name: "vmbr2", vlanTag: "40" }),
          "nic-2#0": bridge({ name: "vmbr3" }),
        },
      }),
    });
    await save(persistedState({ currentStep: "network", nodes, homelabVlan: "5", clusterStorage: { ceph: false, zfs: false } }));
    render(<NetworkPreview />);
    await screen.findByText("# step 3 of 8 — preview");
    await drawn();
    const ports = [...document.querySelectorAll(".pc-switch__portbox")];
    const read = (sel: string) => ports.map((p) => p.querySelector(sel)?.textContent);
    expect(read(".pc-switch__porttype")).toEqual(["rj45", "sfp+", "rj45"]);
    expect(read(".pc-switch__portvlan")).toEqual(["u5", "u5 t40", "u5"]);
    expect(ports[1].getAttribute("title")).toMatch(/untagged: vlan 5 · tagged: vlan 40/);
  });

  it("flags a switch port whose tagged vlan isn't set yet", async () => {
    const nodes = cluster(1, {
      network: network({
        bridgeCounts: { "nic-0": "2" },
        bridges: { "nic-0#0": bridge(), "nic-0#1": bridge({ name: "vmbr1", vlanTag: "" }) },
      }),
    });
    await save(persistedState({ currentStep: "network", nodes, clusterStorage: { ceph: false, zfs: false } }));
    render(<NetworkPreview />);
    await screen.findByText("# step 3 of 8 — preview");
    await drawn();
    const vlan = document.querySelector(".pc-switch__portvlan") as HTMLElement;
    expect(vlan).toHaveTextContent("u t?");
    expect(vlan).toHaveClass("pc-switch__portvlan--warn");
  });

  it("shows the dns server beside the gateway", async () => {
    await save(persistedState({ currentStep: "network", dns: "10.0.10.53" }));
    render(<NetworkPreview />);
    await screen.findByText("# step 3 of 8 — preview");
    await drawn();
    expect(summaryValue(/^dns server$/i)).toBe("10.0.10.53");
  });

  it("marks a ceph link as having no bridge", async () => {
    await save(persistedState({ currentStep: "network", nodes: cephCluster() }));
    render(<NetworkPreview />);
    await screen.findByText("# step 3 of 8 — preview");
    await drawn();
    expect(document.querySelectorAll(".pc-netcard__nobridge")).toHaveLength(3);
  });

  it("won't hand off while step 3 has problems", async () => {
    await save(persistedState({ currentStep: "network", gateway: "" }));
    render(<NetworkPreview />);
    expect(await screen.findByRole("button", { name: /next/i })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/gateway/i);
  });

  it("hands off to the storage step", async () => {
    const user = userEvent.setup();
    await save(persistedState({ currentStep: "network" }));
    render(<NetworkPreview />);
    await user.click(await screen.findByRole("button", { name: /next/i }));
    // navigating waits for the hand-off to be saved (encrypted), so that comes first
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/setup"));
    expect((await loadPersistedState())?.currentStep).toBe("storage");
  });
});

describe("storage preview", () => {
  it("draws every node's disks and the pool they feed", async () => {
    await save(persistedState({ nodes: cephCluster() }));
    render(<StoragePreview />);
    expect(await screen.findByText("# step 4 of 8 — preview")).toBeInTheDocument();
    await drawn();
    expect(summaryValue(/^osds$/i)).toBe("3");
    expect(summaryValue(/^ceph usable$/i)).toBe("1.0 tb");
    const pool = document.querySelector(".pc-pool") as HTMLElement;
    expect(within(pool).getByText("ceph-vm")).toBeInTheDocument();
    expect(within(pool).getByText(/of 3\.0 tb raw/)).toBeInTheDocument();
  });

  it("shows each node's ceph link speed", async () => {
    await save(persistedState({ nodes: cephCluster("10gbe") }));
    render(<StoragePreview />);
    await screen.findByText("# step 4 of 8 — preview");
    await drawn();
    expect(screen.getAllByText("ceph link")).toHaveLength(3);
    expect(screen.getAllByText("10 gbe")).toHaveLength(3);
  });

  it("flags a ceph link below 10 gbe", async () => {
    await save(persistedState({ nodes: cephCluster("1gbe") }));
    render(<StoragePreview />);
    await screen.findByText("# step 4 of 8 — preview");
    await drawn();
    const slow = screen.getAllByText(/1 gbe/).filter((el) => el.classList.contains("pc-storcard__linkval"));
    expect(slow).toHaveLength(3);
    expect(slow[0]).toHaveClass("pc-storcard__linkval--warn");
    // the ⚠ comes with its reason, not on its own
    expect(screen.getAllByText(/ceph waits on this link for every write/i)).toHaveLength(3);
  });

  // a save from a bigger cluster can hold more replicas than this one can
  // place — the diagram has to show what's actually in effect
  it("quotes the replica count actually in effect", async () => {
    const state = persistedState({ nodes: cephCluster().slice(0, 2), nodeCount: "2" });
    state.storage.ceph = { ...state.storage.ceph, replicas: "3", minReplicas: "3" };
    await save(state);
    render(<StoragePreview />);
    await screen.findByText("# step 4 of 8 — preview");
    await drawn();
    expect(screen.getByText("2× (min 2)")).toBeInTheDocument();
  });

  it("warns on the pool when a node contributes nothing", async () => {
    const nodes = cephCluster();
    // two disks, both left out — a sole disk would be forced into ceph
    nodes[2].additionalDisks = disks({ role: "unused" }, { role: "unused" });
    await save(persistedState({ nodes }));
    render(<StoragePreview />);
    await screen.findByText("# step 4 of 8 — preview");
    await drawn();
    expect(screen.getByText(/only 2 of 3 nodes contribute a disk/i)).toBeInTheDocument();
  });

  it("describes the replicated zfs pool under zfs", async () => {
    await save(persistedState({ clusterStorage: { ceph: false, zfs: true }, nodes: cluster(3, { additionalDisks: disks(1000, 1000) }) }));
    render(<StoragePreview />);
    await screen.findByText("# step 4 of 8 — preview");
    await drawn();
    expect(screen.getByText("zfs + replication")).toBeInTheDocument();
    expect(screen.getByText("mirror per node")).toBeInTheDocument();
    expect(summaryValue(/^zfs disks$/i)).toBe("6");
  });

  // ceph as the main storage, zfs replication alongside: both pools cabled
  // to every node, each built from its own disks
  it("draws both pools when ceph and zfs are both on", async () => {
    const nodes = cephCluster().map((n) => ({
      ...n,
      additionalDisks: disks({ role: "ceph", sizeGb: "2000" }, { role: "zfs" }, { role: "zfs" }),
    }));
    await save(persistedState({ nodes, clusterStorage: { ceph: true, zfs: true } }));
    render(<StoragePreview />);
    await screen.findByText("# step 4 of 8 — preview");
    await drawn();
    const pools = [...document.querySelectorAll(".pc-pool")];
    expect(pools).toHaveLength(2);
    expect(pools[0]).toHaveTextContent("ceph pool");
    expect(pools[1]).toHaveTextContent("zfs + replication");
    // both pools take a cable from every node
    expect(pools[0].querySelectorAll(".pc-pool__portbox")).toHaveLength(3);
    expect(pools[1].querySelectorAll(".pc-pool__portbox")).toHaveLength(3);
    expect(summaryValue(/^osds$/i)).toBe("3");
    expect(summaryValue(/^zfs disks$/i)).toBe("6");
    expect(screen.getAllByText("zfs pool")).toHaveLength(3);
  });

  it("draws no pool and says why without cluster storage", async () => {
    await save(persistedState({ clusterStorage: { ceph: false, zfs: false } }));
    render(<StoragePreview />);
    await screen.findByText("# step 4 of 8 — preview");
    await drawn();
    expect(document.querySelector(".pc-pool")).toBeNull();
    expect(screen.getByText(/no shared pool — every node is an island/i)).toBeInTheDocument();
  });

  // same rule as the wizard: no local disks, no local pool
  it("shows the local pool only when a disk is marked local", async () => {
    await save(persistedState({ nodes: cephCluster() }));
    const { unmount } = render(<StoragePreview />);
    await screen.findByText("# step 4 of 8 — preview");
    await drawn();
    expect(screen.queryByText(/local-zfs/)).not.toBeInTheDocument();
    unmount();

    const nodes = cluster(3, { additionalDisks: disks(1000, { role: "local" }) });
    await save(persistedState({ nodes }));
    render(<StoragePreview />);
    await screen.findByText("# step 4 of 8 — preview");
    await drawn();
    expect(screen.getByText(/local-zfs \(zfs\)/)).toBeInTheDocument();
    expect(summaryValue(/^local disks$/i)).toBe("3");
  });

  it("won't hand off while step 4 has problems, and lists them", async () => {
    const state = persistedState();
    state.storage = { ...state.storage, ceph: { ...state.storage.ceph, poolName: "" } };
    await save({ ...state, nodes: cephCluster() });
    render(<StoragePreview />);
    expect(await screen.findByRole("button", { name: /next/i })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/ceph pool name/i);
  });

  it("hands off to the backups step", async () => {
    const user = userEvent.setup();
    await save(persistedState());
    render(<StoragePreview />);
    await user.click(await screen.findByRole("button", { name: /next/i }));
    // navigating waits for the hand-off to be saved (encrypted), so that comes first
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/setup"));
    expect((await loadPersistedState())?.currentStep).toBe("backups");
  });
});

describe("backups preview", () => {
  it("cables every node to the backup server", async () => {
    await save(persistedState({ currentStep: "backups" }));
    render(<BackupsPreview />);
    expect(await screen.findByText("# step 5 of 8 — preview")).toBeInTheDocument();
    await drawn();
    expect(summaryValue(/^kept per guest$/i)).toBe("20");
    expect(summaryValue(/^reaches back$/i)).toBe("about 6 months");
    const target = document.querySelector(".pc-pool--backup") as HTMLElement;
    expect(within(target).getByText("10.0.10.50")).toBeInTheDocument();
    expect(within(target).getByText("daily at 02:00")).toBeInTheDocument();
    expect(document.querySelectorAll(".pc-storcard")).toHaveLength(3);
  });

  it("shows the speed of each node's backup link", async () => {
    await save(persistedState({ currentStep: "backups", nodes: cluster(3, { nics: nics("2.5gbe", "1gbe") }) }));
    render(<BackupsPreview />);
    await screen.findByText("# step 5 of 8 — preview");
    await drawn();
    // no backup bridge: the management link's nic
    expect(screen.getAllByText("2.5 gbe")).toHaveLength(3);
  });

  // steps 1–4 are an installable setup; step 5 is optional
  it("says which nodes share the management link", async () => {
    await save(persistedState({ currentStep: "backups" }));
    render(<BackupsPreview />);
    expect(await screen.findByText(/every node send backups over the management link/i)).toBeInTheDocument();
    expect(screen.getAllByText("management link")).toHaveLength(3);
  });

  it("names a node's backup bridge", async () => {
    const nodes = cluster(1, {
      network: network({
        bridgeCounts: { "nic-0": "1", "nic-1": "1" },
        bridges: {
          "nic-0#0": bridge({ name: "vmbr0" }),
          "nic-1#0": bridge({ name: "vmbr7", purposes: ["backup"], ip: "10.0.30.11/24" }),
        },
      }),
    });
    await save(persistedState({ currentStep: "backups", nodeCount: "1", nodes }));
    render(<BackupsPreview />);
    expect(await screen.findByText("vmbr7")).toBeInTheDocument();
    expect(screen.queryByText(/over the management link/i)).not.toBeInTheDocument();
  });

  it("draws the off-site copy when pbs syncs one", async () => {
    await save(persistedState({ currentStep: "backups", backups: backupPlan({ offsite: true, offsiteAddress: "far.example" }) }));
    render(<BackupsPreview />);
    expect(await screen.findByText("far.example")).toBeInTheDocument();
    expect(summaryValue(/^off-site$/i)).toBe("yes");
  });

  it("warns on a pbs vm without an off-site copy", async () => {
    await save(persistedState({ currentStep: "backups", backups: backupPlan({ target: "pbs-vm" }) }));
    render(<BackupsPreview />);
    expect(await screen.findByText(/lives on the cluster it backs up/i)).toBeInTheDocument();
  });

  it("draws no target and says why with no backups", async () => {
    await save(persistedState({ currentStep: "backups", backups: backupPlan({ target: "none" }) }));
    render(<BackupsPreview />);
    expect(await screen.findByText(/no backups — nothing to cable/i)).toBeInTheDocument();
    expect(document.querySelector(".pc-pool--backup")).toBeNull();
    expect(summaryValue(/^target$/i)).toBe("none");
  });

  it("lists what step 5 still needs", async () => {
    await save(persistedState({ currentStep: "backups", backups: backupPlan({ pbsAddress: "" }) }));
    render(<BackupsPreview />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/pbs address/i);
  });

  it("won't hand off while step 5 has problems", async () => {
    await save(persistedState({ currentStep: "backups", backups: backupPlan({ pbsAddress: "" }) }));
    render(<BackupsPreview />);
    expect(await screen.findByRole("button", { name: /next/i })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/pbs address/i);
  });

  it("hands off to the access step", async () => {
    const user = userEvent.setup();
    await save(persistedState({ currentStep: "backups" }));
    render(<BackupsPreview />);
    await user.click(await screen.findByRole("button", { name: /next/i }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/setup"));
    expect((await loadPersistedState())?.currentStep).toBe("access");
  });

  // the answer files moved to step 5: they need its passwords and keys
  it("no longer offers answer files", async () => {
    await save(persistedState({ currentStep: "backups" }));
    render(<BackupsPreview />);
    await screen.findByText("# step 5 of 8 — preview");
    await drawn();
    expect(screen.queryByRole("link", { name: /answer-.*\.toml/ })).not.toBeInTheDocument();
  });
});

describe("access preview", () => {
  it("lists every key with its fingerprint, and no passwords", async () => {
    const state = persistedState({ currentStep: "access" });
    await save(state);
    render(<AccessPreview />);
    expect(await screen.findByText("# step 6 of 8 — preview")).toBeInTheDocument();
    expect(await screen.findByText(ED25519_FINGERPRINT)).toBeInTheDocument();
    expect(screen.getAllByText("✓ set")).toHaveLength(3);
    for (const password of state.access.rootPasswords) expect(document.body.textContent).not.toContain(password);
  });

  it("marks a node without a root password, and won't hand off", async () => {
    await save(persistedState({ currentStep: "access", access: accessPlan({ rootPasswords: ["long-enough-pw-1", "", "long-enough-pw-3"] }) }));
    render(<AccessPreview />);
    expect(await screen.findByText("✗ not set")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next/i })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/root password/i);
  });

  it("shows the oidc realm and the redirect uris to register", async () => {
    const oidc = { ...accessPlan().oidc, enabled: true, realm: "authentik", issuerUrl: "https://auth.lab.lan/o/pve/", clientId: "proxmox" };
    await save(persistedState({ currentStep: "access", hostnameSuffix: "lab.lan", access: accessPlan({ oidc }) }));
    render(<AccessPreview />);
    expect(await screen.findByText("oidc — realm authentik")).toBeInTheDocument();
    expect(screen.getAllByText("https://pve01.lab.lan:8006").length).toBeGreaterThan(0);
    expect(screen.getByText(/proxmox \(public\)/)).toBeInTheDocument();
  });

  it("hands off to step 7, software", async () => {
    const user = userEvent.setup();
    await save(persistedState({ currentStep: "access" }));
    render(<AccessPreview />);
    await user.click(await screen.findByRole("button", { name: /next/i }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/setup"));
    expect((await loadPersistedState())?.currentStep).toBe("software");
  });

  // the downloads live in step 8 now
  it("no longer offers answer files", async () => {
    await save(persistedState({ currentStep: "access" }));
    render(<AccessPreview />);
    await screen.findByText("# step 6 of 8 — preview");
    expect(screen.queryByRole("link", { name: /answer-.*\.toml/ })).not.toBeInTheDocument();
  });

  it("asks for the passphrase after a reload, and opens once it's right", async () => {
    await save(persistedState({ currentStep: "access" }));
    lock();
    const user = userEvent.setup();
    render(<AccessPreview />);
    await user.type(await screen.findByLabelText(/^passphrase/i), "wrong passphrase");
    await user.click(screen.getByRole("button", { name: /^\[?\s*unlock/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not the passphrase/i);
    await user.clear(screen.getByLabelText(/^passphrase/i));
    await user.type(screen.getByLabelText(/^passphrase/i), "test passphrase");
    await user.click(screen.getByRole("button", { name: /^\[?\s*unlock/i }));
    expect(await screen.findByText("# step 6 of 8 — preview")).toBeInTheDocument();
  });
});

describe("software preview", () => {
  const nodes = () => cluster(3, { ramGb: "64", bootDiskSizeGb: "512" });
  const ctx = () => ({ nodes: nodes(), clusterStorage: { ceph: true, zfs: false }, storage: defaultStoragePlan() });

  it("lists every guest on the node it runs on", async () => {
    const guests = [
      newGuest("vm", [], ctx(), { name: "web", vmid: "100", node: "0" }),
      newGuest("container", [], ctx(), { name: "dns", vmid: "101", node: "1", ha: true }),
    ];
    await save(persistedState({ currentStep: "software", nodes: nodes(), software: softwarePlan(guests) }));
    render(<SoftwarePreview />);
    expect(await screen.findByText("# step 7 of 8 — preview")).toBeInTheDocument();
    expect(screen.getByText("100 web")).toBeInTheDocument();
    expect(screen.getByText("101 dns")).toBeInTheDocument();
    expect(screen.getByText("ct · ha")).toBeInTheDocument();
    expect(summaryValue(/^vms$/i)).toBe("1");
    expect(summaryValue(/^containers$/i)).toBe("1");
  });

  it("shows where each node's memory and disks go", async () => {
    const guests = [newGuest("vm", [], ctx(), { memoryGb: "8", node: "0" })];
    await save(persistedState({ currentStep: "software", nodes: nodes(), software: softwarePlan(guests) }));
    render(<SoftwarePreview />);
    const memory = await screen.findAllByRole("figure", { name: /^memory: / });
    expect(memory).toHaveLength(3);
    // proxmox 2 + ceph (1 osd + monitor) 5 + guests 8, of 64
    expect(memory[0]).toHaveAccessibleName("memory: 15 gib of 64 gib used");
    expect(within(memory[0]).getByText("guests")).toBeInTheDocument();
    expect(screen.getAllByRole("figure", { name: /^boot disk: / })).toHaveLength(3);
    expect(screen.getByRole("figure", { name: /^ceph pool ceph-vm: / })).toBeInTheDocument();
  });

  it("holds kubernetes' persistent volumes in the ceph pool", async () => {
    const guests = [newGuest("vm", [], ctx(), { k8sRole: "worker" })];
    await save(persistedState({ currentStep: "software", nodes: nodes(), software: softwarePlan(guests, { volumeGb: "250" }) }));
    render(<SoftwarePreview />);
    const ceph = await screen.findByRole("figure", { name: /^ceph pool ceph-vm: / });
    expect(within(ceph).getByText("kubernetes volumes (k8s-volumes)")).toBeInTheDocument();
  });

  it("marks a node whose memory is overcommitted", async () => {
    const guests = [newGuest("vm", [], ctx(), { memoryGb: "100" })];
    await save(persistedState({ currentStep: "software", nodes: nodes(), software: softwarePlan(guests) }));
    render(<SoftwarePreview />);
    const [first] = await screen.findAllByRole("figure", { name: /^memory: / });
    expect(first).toHaveAccessibleName(/43 gib over$/);
  });

  it("warns when a node's guests outgrow its memory", async () => {
    const guests = [newGuest("vm", [], ctx(), { memoryGb: "100" })];
    await save(persistedState({ currentStep: "software", nodes: nodes(), software: softwarePlan(guests) }));
    render(<SoftwarePreview />);
    expect(await screen.findByText(/ask for 100 gib of memory, but it has 64 gib/i)).toBeInTheDocument();
  });

  it("won't hand off while a guest has problems", async () => {
    const guests = [newGuest("vm", [], ctx(), { name: "" })];
    await save(persistedState({ currentStep: "software", nodes: nodes(), software: softwarePlan(guests) }));
    render(<SoftwarePreview />);
    expect(await screen.findByRole("button", { name: /next/i })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/name/i);
  });

  it("hands off to step 8, install", async () => {
    const user = userEvent.setup();
    await save(persistedState({ currentStep: "software", nodes: nodes(), software: softwarePlan([newGuest("vm", [], ctx())]) }));
    render(<SoftwarePreview />);
    await user.click(await screen.findByRole("button", { name: /next/i }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/setup"));
    expect((await loadPersistedState())?.currentStep).toBe("install");
  });
});
