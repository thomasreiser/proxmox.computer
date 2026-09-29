import { describe, expect, it } from "vitest";
import { CARD_WIDTH, GAP, layout, offsiteX, rowWidth } from "./cabling";
import { buildBackupOverview } from "./plan";
import { backupPlan, bridge, cluster, network } from "../../test-fixtures";

const overview = (plan: Parameters<typeof backupPlan>[0] = {}, count = 3) =>
  buildBackupOverview(cluster(count), backupPlan(plan), "");

describe("backups preview layout", () => {
  it("cables every node to the target", () => {
    const { nodes, edges } = layout(overview());
    expect(nodes.map((n) => n.id)).toEqual(["node-0", "node-1", "node-2", "target"]);
    expect(edges.map((e) => [e.source, e.target, e.targetHandle])).toEqual([
      ["node-0", "target", "node-0"],
      ["node-1", "target", "node-1"],
      ["node-2", "target", "node-2"],
    ]);
  });

  it("draws the nodes alone with no backups", () => {
    const { nodes, edges } = layout(overview({ target: "none" }));
    expect(nodes.map((n) => n.id)).toEqual(["node-0", "node-1", "node-2"]);
    expect(edges).toEqual([]);
  });

  // solid over a backup bridge, dashed over the shared management link
  it("dashes the cables that share the management link", () => {
    const nodes = cluster(2);
    nodes[0].network = network({
      bridgeCounts: { "nic-0": "1", "nic-1": "1" },
      bridges: {
        "nic-0#0": bridge({ name: "vmbr0" }),
        "nic-1#0": bridge({ name: "vmbr1", purposes: ["backup"], ip: "10.0.30.11/24" }),
      },
    });
    const { edges } = layout(buildBackupOverview(nodes, backupPlan(), ""));
    expect(edges[0].style?.strokeDasharray).toBeUndefined();
    expect(edges[1].style?.strokeDasharray).toBeDefined();
  });

  it("adds the off-site copy under the target, centered", () => {
    const { nodes, edges } = layout(overview({ offsite: true, offsiteAddress: "far.example" }));
    const offsite = nodes.find((n) => n.id === "offsite");
    expect(offsite?.position.x).toBe(offsiteX(3));
    expect(edges.find((e) => e.id === "offsite-sync")).toMatchObject({ source: "target", target: "offsite" });
  });

  it("measures the node row the target spans", () => {
    expect(rowWidth(1)).toBe(CARD_WIDTH);
    expect(rowWidth(3)).toBe(3 * CARD_WIDTH + 2 * GAP);
    expect(offsiteX(1)).toBe(0);
  });
});
