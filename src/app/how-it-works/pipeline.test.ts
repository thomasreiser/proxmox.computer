import { describe, expect, it } from "vitest";
import { FLOWS, FLOW_STROKE, LANES, LANE_X, PHASES, sideLabel } from "./pipeline";
import { flattenTree, type TreeEntry } from "./repo-tree";

describe("the phase list", () => {
  it("numbers the phases consecutively from 01", () => {
    expect(PHASES.map((p) => p.step)).toEqual(["01", "02", "03", "04", "05", "06", "07"]);
  });

  it("gives every phase a unique id", () => {
    expect(new Set(PHASES.map((p) => p.id)).size).toBe(PHASES.length);
  });

  it("lays every phase out in its own lane's column", () => {
    for (const phase of PHASES) {
      expect(phase.position.x).toBe(LANE_X[phase.side]);
    }
  });

  it("stacks the phases within a lane in step order", () => {
    for (const lane of LANES) {
      const ys = PHASES.filter((p) => p.side === lane.side).map((p) => p.position.y);
      expect(ys).toEqual([...ys].sort((a, b) => a - b));
    }
  });

  it("words the two sides the same way the cards do", () => {
    expect(sideLabel("browser")).toBe("in your browser");
    expect(sideLabel("node")).toBe("on your nodes");
  });
});

describe("the flows between phases", () => {
  const ids = new Set(PHASES.map((p) => p.id));

  it("only connects phases that exist", () => {
    for (const flow of FLOWS) {
      expect(ids).toContain(flow.from);
      expect(ids).toContain(flow.to);
    }
  });

  it("uses handles the phase cards actually render", () => {
    for (const flow of FLOWS) {
      expect(flow.fromHandle).toMatch(/^[trbl]-out$/);
      expect(flow.toHandle).toMatch(/^[trbl]-in$/);
    }
  });

  it("gives every flow a unique id, so react flow can key them", () => {
    expect(new Set(FLOWS.map((f) => f.id)).size).toBe(FLOWS.length);
  });

  // the diagram's argument: a file only ever moves when the flow crosses
  // between the browser and the machines, and a same-lane step carries
  // nothing.
  it("labels exactly the flows that cross between lanes", () => {
    const sideOf = new Map(PHASES.map((p) => [p.id, p.side]));
    for (const flow of FLOWS) {
      if (flow.kind === "handoff") {
        expect(sideOf.get(flow.from)).not.toBe(sideOf.get(flow.to));
        expect(flow.carries).not.toBe("");
      }
      if (flow.kind === "step") {
        expect(sideOf.get(flow.from)).toBe(sideOf.get(flow.to));
        expect(flow.carries).toBe("");
      }
    }
  });

  it("closes the loop back to the first phase", () => {
    const loops = FLOWS.filter((f) => f.kind === "loop");
    expect(loops).toHaveLength(1);
    expect(loops[0].to).toBe(PHASES[0].id);
    expect(loops[0].from).toBe(PHASES[PHASES.length - 1].id);
  });

  it("reaches every phase from the first one", () => {
    const out = new Map<string, string[]>();
    for (const f of FLOWS) out.set(f.from, [...(out.get(f.from) ?? []), f.to]);
    const seen = new Set<string>();
    const walk = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const next of out.get(id) ?? []) walk(next);
    };
    walk(PHASES[0].id);
    expect(seen.size).toBe(PHASES.length);
  });

  it("has a stroke color for every flow kind in use", () => {
    for (const flow of FLOWS) expect(FLOW_STROKE[flow.kind]).toBeTruthy();
  });
});

describe("flattenTree", () => {
  const tree: TreeEntry = {
    name: "root/",
    children: [
      { name: "a" },
      { name: "dir/", children: [{ name: "b" }, { name: "c" }] },
      { name: "d" },
    ],
  };
  const rows = flattenTree(tree);

  it("emits one row per entry, depth-first", () => {
    expect(rows.map((r) => r.name)).toEqual(["root/", "a", "dir/", "b", "c", "d"]);
  });

  it("gives the root no connectors of its own", () => {
    expect(rows[0]).toMatchObject({ isRoot: true, trunks: [] });
  });

  // the whole point of the flags: a child draws a vertical line in an
  // ancestor's column only while that ancestor still has siblings below.
  it("draws an ancestor's trunk through its children while siblings remain", () => {
    expect(rows.find((r) => r.name === "b")?.trunks).toEqual([true]);
    expect(rows.find((r) => r.name === "c")?.trunks).toEqual([true]);
  });

  it("marks the last child at each level so its stem stops at the elbow", () => {
    expect(rows.find((r) => r.name === "c")?.isLast).toBe(true);
    expect(rows.find((r) => r.name === "b")?.isLast).toBe(false);
    expect(rows.find((r) => r.name === "d")?.isLast).toBe(true);
  });

  it("stops drawing an ancestor's trunk once it is the last child", () => {
    const lastDir: TreeEntry = {
      name: "root/",
      children: [{ name: "a" }, { name: "dir/", children: [{ name: "b" }] }],
    };
    expect(flattenTree(lastDir).find((r) => r.name === "b")?.trunks).toEqual([false]);
  });

  it("handles a root with no children", () => {
    expect(flattenTree({ name: "empty/" })).toHaveLength(1);
  });

  it("nests more than two levels deep", () => {
    const deep: TreeEntry = {
      name: "r/",
      children: [{ name: "a/", children: [{ name: "b/", children: [{ name: "c" }] }] }],
    };
    expect(flattenTree(deep).find((r) => r.name === "c")?.trunks).toEqual([false, false]);
  });
});
