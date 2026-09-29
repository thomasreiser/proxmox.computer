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
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HardwarePreview from "./hardware/page";
import NetworkPreview from "./network/page";
import StoragePreview from "./storage/page";
import BackupsPreview from "./backups/page";
import { STORAGE_KEY, loadPersistedState, type PersistedState } from "../wizard-state";
import { backupPlan, bond, bridge, cluster, disks, network, nics, persistedState } from "../test-fixtures";
import { router } from "@/test/router";

function save(state: PersistedState) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
] as const)("%s preview with nothing saved", (_name, Preview) => {
  it("offers a way back to step 1 instead of an empty diagram", async () => {
    render(<Preview />);
    expect(await screen.findByText(/nothing saved to preview yet/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /start at step 1/i })).toHaveAttribute("href", "/setup");
  });

  // a save from another build is discarded, not half-rendered
  it("treats a save from another version as nothing saved", async () => {
    save({ ...persistedState(), version: 1 });
    render(<Preview />);
    expect(await screen.findByText(/nothing saved to preview yet/i)).toBeInTheDocument();
  });
});

describe("hardware preview", () => {
  it("draws a card per node and totals the cluster", async () => {
    save(persistedState({ currentStep: "hardware", nodes: cluster(3, { additionalDisks: disks(1000) }) }));
    render(<HardwarePreview />);
    expect(await screen.findByText("# step 1 of 5 — preview")).toBeInTheDocument();
    expect(summaryValue(/^nodes$/i)).toBe("3");
    for (const name of ["pve01", "pve02", "pve03"]) expect(screen.getByText(name)).toBeInTheDocument();
  });

  // more than one grid row: every card is drawn, and there's no minimap —
  // the canvas is fitted to all of them, so it only ever showed a gray box
  it("draws every node of a cluster bigger than one row", async () => {
    save(persistedState({ currentStep: "hardware", nodeCount: "6", nodes: cluster(6) }));
    render(<HardwarePreview />);
    await screen.findByText("# step 1 of 5 — preview");
    expect(document.querySelectorAll(".pc-nodecard")).toHaveLength(6);
    expect(document.querySelector(".react-flow__minimap")).toBeNull();
  });

  // the page can be opened by url, so "next" applies the wizard's gate
  it("won't hand off while step 1 has problems, and lists them", async () => {
    const user = userEvent.setup();
    save(persistedState({ currentStep: "hardware", nodes: cluster(2, { ramGb: "" }), nodeCount: "2" }));
    render(<HardwarePreview />);
    const next = await screen.findByRole("button", { name: /next/i });
    expect(next).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/memory \(gb\)/i);
    await user.click(next);
    expect(router.push).not.toHaveBeenCalled();
    expect(loadPersistedState()?.currentStep).toBe("hardware");
  });

  it("hands off to the network step", async () => {
    const user = userEvent.setup();
    save(persistedState({ currentStep: "hardware" }));
    render(<HardwarePreview />);
    await user.click(await screen.findByRole("button", { name: /next/i }));
    expect(loadPersistedState()?.currentStep).toBe("network");
    expect(router.push).toHaveBeenCalledWith("/setup");
  });
});

describe("network preview", () => {
  it("counts nodes and physical links", async () => {
    save(persistedState({ currentStep: "network", nodes: cephCluster() }));
    render(<NetworkPreview />);
    expect(await screen.findByText("# step 2 of 5 — preview")).toBeInTheDocument();
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
    save(persistedState({ currentStep: "network", nodes }));
    render(<NetworkPreview />);
    await screen.findByText("# step 2 of 5 — preview");
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
    save(persistedState({ currentStep: "network", nodes }));
    render(<NetworkPreview />);
    expect(await screen.findByText(/2 bonds need a lag on the switch/i)).toBeInTheDocument();
    expect(document.querySelectorAll(".pc-laglist__item")).toHaveLength(2);
    // two member ports on each of the two nodes
    expect(screen.getAllByText("lacp bond1").filter((el) => el.classList.contains("pc-switch__portlag"))).toHaveLength(4);
  });

  it("asks for no lag when no bond needs one", async () => {
    save(persistedState({ currentStep: "network" }));
    render(<NetworkPreview />);
    await screen.findByText("# step 2 of 5 — preview");
    expect(screen.queryByText(/a lag on the switch/i)).not.toBeInTheDocument();
    expect(document.querySelector(".pc-switch__portlag")).toBeNull();
  });

  // the one physical-layout rule the diagram can state: every ceph port on
  // one switch
  it("counts the ceph links and says they belong on one switch", async () => {
    save(persistedState({ currentStep: "network", nodes: cephCluster() }));
    render(<NetworkPreview />);
    await screen.findByText("# step 2 of 5 — preview");
    expect(summaryValue(/^ceph links$/i)).toBe("3");
    expect(screen.getByText(/all 3 ceph links belong on the same physical switch/i)).toBeInTheDocument();
    expect(screen.getByText(/3 ceph — keep on this one switch/i)).toBeInTheDocument();
  });

  it("says nothing about ceph placement when no link carries ceph", async () => {
    save(persistedState({ currentStep: "network", clusterStorage: { ceph: false, zfs: false } }));
    render(<NetworkPreview />);
    await screen.findByText("# step 2 of 5 — preview");
    expect(summaryValue(/^ceph links$/i)).toBe("—");
    expect(screen.queryByText(/belong on the same physical switch/i)).not.toBeInTheDocument();
  });

  it("shows the cluster-wide addressing", async () => {
    save(persistedState({ currentStep: "network" }));
    render(<NetworkPreview />);
    await screen.findByText("# step 2 of 5 — preview");
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
    save(persistedState({ currentStep: "network", nodes, homelabVlan: "5", clusterStorage: { ceph: false, zfs: false } }));
    render(<NetworkPreview />);
    await screen.findByText("# step 2 of 5 — preview");
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
    save(persistedState({ currentStep: "network", nodes, clusterStorage: { ceph: false, zfs: false } }));
    render(<NetworkPreview />);
    await screen.findByText("# step 2 of 5 — preview");
    const vlan = document.querySelector(".pc-switch__portvlan") as HTMLElement;
    expect(vlan).toHaveTextContent("u t?");
    expect(vlan).toHaveClass("pc-switch__portvlan--warn");
  });

  it("shows the dns server beside the gateway", async () => {
    save(persistedState({ currentStep: "network", dns: "10.0.10.53" }));
    render(<NetworkPreview />);
    await screen.findByText("# step 2 of 5 — preview");
    expect(summaryValue(/^dns server$/i)).toBe("10.0.10.53");
  });

  it("marks a ceph link as having no bridge", async () => {
    save(persistedState({ currentStep: "network", nodes: cephCluster() }));
    render(<NetworkPreview />);
    await screen.findByText("# step 2 of 5 — preview");
    expect(document.querySelectorAll(".pc-netcard__nobridge")).toHaveLength(3);
  });

  it("won't hand off while step 2 has problems", async () => {
    save(persistedState({ currentStep: "network", gateway: "" }));
    render(<NetworkPreview />);
    expect(await screen.findByRole("button", { name: /next/i })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/gateway/i);
  });

  it("hands off to the storage step", async () => {
    const user = userEvent.setup();
    save(persistedState({ currentStep: "network" }));
    render(<NetworkPreview />);
    await user.click(await screen.findByRole("button", { name: /next/i }));
    expect(loadPersistedState()?.currentStep).toBe("storage");
    expect(router.push).toHaveBeenCalledWith("/setup");
  });
});

describe("storage preview", () => {
  it("draws every node's disks and the pool they feed", async () => {
    save(persistedState({ nodes: cephCluster() }));
    render(<StoragePreview />);
    expect(await screen.findByText("# step 3 of 5 — preview")).toBeInTheDocument();
    expect(summaryValue(/^osds$/i)).toBe("3");
    expect(summaryValue(/^ceph usable$/i)).toBe("1.0 tb");
    const pool = document.querySelector(".pc-pool") as HTMLElement;
    expect(within(pool).getByText("ceph-vm")).toBeInTheDocument();
    expect(within(pool).getByText(/of 3\.0 tb raw/)).toBeInTheDocument();
  });

  it("shows each node's ceph link speed", async () => {
    save(persistedState({ nodes: cephCluster("10gbe") }));
    render(<StoragePreview />);
    await screen.findByText("# step 3 of 5 — preview");
    expect(screen.getAllByText("ceph link")).toHaveLength(3);
    expect(screen.getAllByText("10 gbe")).toHaveLength(3);
  });

  it("flags a ceph link below 10 gbe", async () => {
    save(persistedState({ nodes: cephCluster("1gbe") }));
    render(<StoragePreview />);
    await screen.findByText("# step 3 of 5 — preview");
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
    save(state);
    render(<StoragePreview />);
    await screen.findByText("# step 3 of 5 — preview");
    expect(screen.getByText("2× (min 2)")).toBeInTheDocument();
  });

  it("warns on the pool when a node contributes nothing", async () => {
    const nodes = cephCluster();
    // two disks, both left out — a sole disk would be forced into ceph
    nodes[2].additionalDisks = disks({ role: "unused" }, { role: "unused" });
    save(persistedState({ nodes }));
    render(<StoragePreview />);
    await screen.findByText("# step 3 of 5 — preview");
    expect(screen.getByText(/only 2 of 3 nodes contribute a disk/i)).toBeInTheDocument();
  });

  it("describes the replicated zfs pool under zfs", async () => {
    save(persistedState({ clusterStorage: { ceph: false, zfs: true }, nodes: cluster(3, { additionalDisks: disks(1000, 1000) }) }));
    render(<StoragePreview />);
    await screen.findByText("# step 3 of 5 — preview");
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
    save(persistedState({ nodes, clusterStorage: { ceph: true, zfs: true } }));
    render(<StoragePreview />);
    await screen.findByText("# step 3 of 5 — preview");
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
    save(persistedState({ clusterStorage: { ceph: false, zfs: false } }));
    render(<StoragePreview />);
    await screen.findByText("# step 3 of 5 — preview");
    expect(document.querySelector(".pc-pool")).toBeNull();
    expect(screen.getByText(/no shared pool — every node is an island/i)).toBeInTheDocument();
  });

  // same rule as the wizard: no local disks, no local pool
  it("shows the local pool only when a disk is marked local", async () => {
    save(persistedState({ nodes: cephCluster() }));
    const { unmount } = render(<StoragePreview />);
    await screen.findByText("# step 3 of 5 — preview");
    expect(screen.queryByText(/local-zfs/)).not.toBeInTheDocument();
    unmount();

    const nodes = cluster(3, { additionalDisks: disks(1000, { role: "local" }) });
    save(persistedState({ nodes }));
    render(<StoragePreview />);
    await screen.findByText("# step 3 of 5 — preview");
    expect(screen.getByText(/local-zfs \(zfs\)/)).toBeInTheDocument();
    expect(summaryValue(/^local disks$/i)).toBe("3");
  });

  it("won't hand off while step 3 has problems, and lists them", async () => {
    const state = persistedState();
    state.storage = { ...state.storage, ceph: { ...state.storage.ceph, poolName: "" } };
    save({ ...state, nodes: cephCluster() });
    render(<StoragePreview />);
    expect(await screen.findByRole("button", { name: /next/i })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/ceph pool name/i);
  });

  it("hands off to the backups step", async () => {
    const user = userEvent.setup();
    save(persistedState());
    render(<StoragePreview />);
    await user.click(await screen.findByRole("button", { name: /next/i }));
    expect(loadPersistedState()?.currentStep).toBe("backups");
    expect(router.push).toHaveBeenCalledWith("/setup");
  });
});

describe("backups preview", () => {
  it("cables every node to the backup server", async () => {
    save(persistedState({ currentStep: "backups" }));
    render(<BackupsPreview />);
    expect(await screen.findByText("# step 4 of 5 — preview")).toBeInTheDocument();
    expect(summaryValue(/^kept per guest$/i)).toBe("20");
    expect(summaryValue(/^reaches back$/i)).toBe("about 6 months");
    const target = document.querySelector(".pc-pool--backup") as HTMLElement;
    expect(within(target).getByText("10.0.10.50")).toBeInTheDocument();
    expect(within(target).getByText("daily at 02:00")).toBeInTheDocument();
    expect(document.querySelectorAll(".pc-storcard")).toHaveLength(3);
  });

  it("shows the speed of each node's backup link", async () => {
    save(persistedState({ currentStep: "backups", nodes: cluster(3, { nics: nics("2.5gbe", "1gbe") }) }));
    render(<BackupsPreview />);
    await screen.findByText("# step 4 of 5 — preview");
    // no backup bridge: the management link's nic
    expect(screen.getAllByText("2.5 gbe")).toHaveLength(3);
  });

  // steps 1–4 are an installable setup; step 5 is optional
  it("offers installing now or going on to the optional software step", async () => {
    save(persistedState({ currentStep: "backups" }));
    render(<BackupsPreview />);
    expect(await screen.findByText("ready to install — or keep going")).toBeInTheDocument();
    expect(screen.getByText(/that step is optional/i)).toBeInTheDocument();
  });

  it("says which nodes share the management link", async () => {
    save(persistedState({ currentStep: "backups" }));
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
    save(persistedState({ currentStep: "backups", nodeCount: "1", nodes }));
    render(<BackupsPreview />);
    expect(await screen.findByText("vmbr7")).toBeInTheDocument();
    expect(screen.queryByText(/over the management link/i)).not.toBeInTheDocument();
  });

  it("draws the off-site copy when pbs syncs one", async () => {
    save(persistedState({ currentStep: "backups", backups: backupPlan({ offsite: true, offsiteAddress: "far.example" }) }));
    render(<BackupsPreview />);
    expect(await screen.findByText("far.example")).toBeInTheDocument();
    expect(summaryValue(/^off-site$/i)).toBe("yes");
  });

  it("warns on a pbs vm without an off-site copy", async () => {
    save(persistedState({ currentStep: "backups", backups: backupPlan({ target: "pbs-vm" }) }));
    render(<BackupsPreview />);
    expect(await screen.findByText(/lives on the cluster it backs up/i)).toBeInTheDocument();
  });

  it("draws no target and says why with no backups", async () => {
    save(persistedState({ currentStep: "backups", backups: backupPlan({ target: "none" }) }));
    render(<BackupsPreview />);
    expect(await screen.findByText(/no backups — nothing to cable/i)).toBeInTheDocument();
    expect(document.querySelector(".pc-pool--backup")).toBeNull();
    expect(summaryValue(/^target$/i)).toBe("none");
  });

  it("lists what step 4 still needs", async () => {
    save(persistedState({ currentStep: "backups", backups: backupPlan({ pbsAddress: "" }) }));
    render(<BackupsPreview />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/pbs address/i);
  });

  it("offers each node's answer file as a toml download", async () => {
    save(persistedState({ currentStep: "backups", hostnameSuffix: "lab.lan" }));
    render(<BackupsPreview />);
    const links = await screen.findAllByRole("link", { name: /^\[\s*answer-.*\.toml\s*\]$/ });
    expect(links.map((l) => l.getAttribute("download"))).toEqual([
      "answer-pve01.toml",
      "answer-pve02.toml",
      "answer-pve03.toml",
    ]);
    const href = links[1].getAttribute("href") ?? "";
    expect(href.startsWith("data:application/toml")).toBe(true);
    const toml = decodeURIComponent(href.slice(href.indexOf(",") + 1));
    expect(toml).toContain('fqdn = "pve02.lab.lan"');
    expect(toml).toContain("disk-list = [\"CHANGE-ME\"]");
  });

  it("holds the answer files back while a step has problems", async () => {
    save(persistedState({ currentStep: "backups", backups: backupPlan({ pbsAddress: "" }) }));
    render(<BackupsPreview />);
    expect(await screen.findByText(/fix the problems listed below first/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /answer-.*\.toml/ })).not.toBeInTheDocument();
    for (const button of screen.getAllByRole("button", { name: /answer-.*\.toml/ })) expect(button).toBeDisabled();
  });

  // step 5 doesn't exist yet, so there's nowhere to hand off to
  it("keeps next disabled until step 5 exists", async () => {
    save(persistedState({ currentStep: "backups" }));
    render(<BackupsPreview />);
    expect(await screen.findByRole("button", { name: /next/i })).toBeDisabled();
  });
});
