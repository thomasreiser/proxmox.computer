// The end-to-end pipeline the explanation page draws: every phase, which
// side of the line it runs on, and — the part that actually carries the
// argument — what travels between the two sides.
//
// This is static content, not derived from a visitor's saved wizard state
// (unlike ./preview/*/topology.ts, which builds its diagram from NodeInfo[]).
// It's laid out by hand for the same reason: there are exactly seven
// phases and they never change shape, so a hand-tuned layout reads far
// better than anything an algorithm would produce for a graph this small.

// which side of the "nothing here logs into your servers" line a phase
// runs on — also what colors it, and which lane it's laid out in.
export type PhaseSide = "browser" | "node";

export interface PhaseSpec {
  id: string;
  // "01".."07" — the order a visitor actually does these in, including
  // the two that happen on real hardware. deliberately one sequence
  // rather than per-lane numbering: the whole point is that the browser
  // half and the machine half interleave.
  step: string;
  title: string;
  tagline: string;
  side: PhaseSide;
  bullets: string[];
  position: { x: number; y: number };
}

// a phase card exposes a target and a source handle on all four sides
// (see phase-node.tsx), named "<side>-in" / "<side>-out" — so an edge
// picks whichever pair keeps its route short and non-crossing, rather
// than every edge being forced through one top/bottom pair.
export interface FlowSpec {
  id: string;
  from: string;
  fromHandle: string;
  to: string;
  toHandle: string;
  // the file that travels, drawn as the edge's label. "" for a plain
  // "…and then" arrow inside one lane, which moves no artifact and is
  // drawn quieter to match.
  carries: string;
  // step   — the next phase, same side of the line
  // handoff— crosses the line: a file you carry over yourself
  // loop   — the return path that makes this a cycle instead of a funnel
  kind: "step" | "handoff" | "loop";
}

// which side of the line a phase runs on, in words — shared by the diagram
// cards and the roster above them so the two can never word it differently.
export function sideLabel(side: PhaseSide): string {
  return side === "browser" ? "in your browser" : "on your nodes";
}

export const LANE_WIDTH = 460;
export const CARD_WIDTH = 380;
// x of each lane's cards; the lane box itself is drawn LANE_PAD to the
// left of this and LANE_WIDTH wide.
export const LANE_X: Record<PhaseSide, number> = { browser: 0, node: 540 };
export const LANE_PAD = 40;
export const LANE_TOP = -90;

// each lane is only as tall as its own last card, not as tall as the
// diagram — the browser half genuinely finishes before the machine half
// does, and stretching both to a shared height just prints a large empty
// box under "emit" and costs the whole diagram zoom at fit.
export const LANES: { side: PhaseSide; label: string; hint: string; height: number }[] = [
  {
    side: "browser",
    label: "in your browser",
    hint: "no account, no login, no server — this half never sees your machines",
    height: 1030,
  },
  {
    side: "node",
    label: "on your nodes",
    hint: "you run every one of these yourself, from your own terminal",
    height: 1300,
  },
];

export const PHASES: PhaseSpec[] = [
  {
    id: "declare",
    step: "01",
    title: "declare",
    tagline: "the wizard you're already looking at",
    side: "browser",
    bullets: [
      "nodes, cpus, disks, nics",
      "bonds, bridges, vlans, ceph vs zfs replication",
      "roles only — never enp3s0, never /dev/sda",
    ],
    position: { x: LANE_X.browser, y: 0 },
  },
  {
    id: "install",
    step: "02",
    title: "unattended install",
    tagline: "bare metal → a booted, reachable node",
    side: "node",
    bullets: [
      "an answer file per node, written by step 01",
      "proxmox-auto-install-assistant prepare-iso",
      "boot it once, then walk away",
    ],
    position: { x: LANE_X.node, y: 110 },
  },
  {
    id: "discover",
    step: "03",
    title: "discover",
    tagline: "the machines say what they actually are",
    side: "browser",
    bullets: [
      "one read-only command per node",
      "macs, /dev/disk/by-id, serials, link state",
      "paste the json back — nothing phones home",
    ],
    position: { x: LANE_X.browser, y: 250 },
  },
  {
    id: "bind",
    step: "04",
    title: "bind",
    tagline: "intent × identity — the only place they meet",
    side: "browser",
    bullets: [
      "auto-matches everything unambiguous",
      "asks only where two ports look identical",
      "nic role → mac, disk role → by-id path",
    ],
    position: { x: LANE_X.browser, y: 470 },
  },
  {
    id: "emit",
    step: "05",
    title: "emit",
    tagline: "a repo, not a wall of copy-paste",
    side: "browser",
    bullets: [
      "inventory, host_vars, site.yml, upgrade.yml",
      "roles vendored and pinned, no galaxy at runtime",
      "wizard.json rides along inside the zip",
    ],
    position: { x: LANE_X.browser, y: 690 },
  },
  {
    id: "apply",
    step: "06",
    title: "apply",
    tagline: "ansible-playbook site.yml",
    side: "node",
    bullets: [
      "preflight → base → network → cluster → storage",
      "every band tagged, so you can re-run just one",
      "idempotent: running it twice changes nothing",
    ],
    position: { x: LANE_X.node, y: 760 },
  },
  {
    id: "daytwo",
    step: "07",
    title: "day two",
    tagline: "the part that outlives the install",
    side: "node",
    bullets: [
      "--check --diff reports every hand-made change",
      "upgrade.yml rolls one node at a time, health-gated",
      "adding a node is the same pipeline, --limit'd",
    ],
    position: { x: LANE_X.node, y: 980 },
  },
];

export const FLOWS: FlowSpec[] = [
  { id: "declare-install", from: "declare", fromHandle: "r-out", to: "install", toHandle: "l-in", carries: "answer.toml", kind: "handoff" },
  { id: "declare-discover", from: "declare", fromHandle: "b-out", to: "discover", toHandle: "t-in", carries: "", kind: "step" },
  { id: "install-discover", from: "install", fromHandle: "b-out", to: "discover", toHandle: "r-in", carries: "inventory.json", kind: "handoff" },
  { id: "discover-bind", from: "discover", fromHandle: "b-out", to: "bind", toHandle: "t-in", carries: "", kind: "step" },
  { id: "bind-emit", from: "bind", fromHandle: "b-out", to: "emit", toHandle: "t-in", carries: "", kind: "step" },
  { id: "emit-apply", from: "emit", fromHandle: "r-out", to: "apply", toHandle: "l-in", carries: "homelab.zip", kind: "handoff" },
  { id: "apply-daytwo", from: "apply", fromHandle: "b-out", to: "daytwo", toHandle: "t-in", carries: "", kind: "step" },
  // the edge that makes this a cycle: re-importing the state file the zip
  // shipped with reopens the wizard exactly where you left it, so "add a
  // fourth node" is an edit, not a rebuild. routed the long way round —
  // down, out past the left lane, and back up — because it deliberately
  // reads as a return path rather than as another step.
  { id: "daytwo-declare", from: "daytwo", fromHandle: "b-out", to: "declare", toHandle: "l-in", carries: "wizard.json", kind: "loop" },
];

export const FLOW_STROKE: Record<FlowSpec["kind"], string> = {
  step: "var(--border-strong)",
  handoff: "var(--brand)",
  loop: "var(--accent)",
};
