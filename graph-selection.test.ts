import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FINDINGS } from "@/lib/preview-data";
import { applyNodeSelectChanges, findingForNode } from "@/components/Graph";

/**
 * Evidence tiers: UNIT tests for the change-folding reducer and association
 * integrity against the real preview data, plus static wiring checks that
 * the supported React Flow API is connected. Mounted keyboard interaction
 * inside React Flow is NOT RUN (no DOM runner available).
 */

describe("UNIT: applyNodeSelectChanges (Finding B)", () => {
  it("keyboard select of a new node updates canonical state", () => {
    expect(applyNodeSelectChanges([{ type: "select", id: "users", selected: true }], "orders")).toBe(
      "users"
    );
    expect(applyNodeSelectChanges([{ type: "select", id: "users", selected: true }], null)).toBe(
      "users"
    );
  });
  it("deselect clears only the targeted node", () => {
    expect(applyNodeSelectChanges([{ type: "select", id: "orders", selected: false }], "orders")).toBeNull();
    expect(applyNodeSelectChanges([{ type: "select", id: "other", selected: false }], "orders")).toBe(
      "orders"
    );
  });
  it("echoes resolve to current so the component skips onSelect (no loop)", () => {
    expect(applyNodeSelectChanges([{ type: "select", id: "orders", selected: true }], "orders")).toBe(
      "orders"
    );
    expect(applyNodeSelectChanges([], "orders")).toBe("orders");
    expect(applyNodeSelectChanges([], null)).toBeNull();
  });
  it("later changes win within one batch", () => {
    expect(
      applyNodeSelectChanges(
        [
          { type: "select", id: "users", selected: true },
          { type: "select", id: "orders", selected: true },
        ],
        null
      )
    ).toBe("orders");
  });
  it("non-select changes are ignored (static layout by design)", () => {
    expect(applyNodeSelectChanges([{ type: "position", id: "users" }], "orders")).toBe("orders");
    expect(applyNodeSelectChanges([{ type: "dimensions", id: "users" }], null)).toBeNull();
    expect(
      applyNodeSelectChanges(
        [
          { type: "position", id: "users" },
          { type: "select", id: "users", selected: true },
        ],
        null
      )
    ).toBe("users");
  });
});

describe("UNIT: node-to-finding associations stay safe (Finding B)", () => {
  it("every preview finding resolves through its own node and no other", () => {
    expect(FINDINGS.length).toBeGreaterThan(0);
    for (const f of FINDINGS) {
      const selected = applyNodeSelectChanges([{ type: "select", id: f.nodeId, selected: true }], null);
      expect(selected).toBe(f.nodeId);
      expect(findingForNode(f.id, selected)).toBe(f.id);
    }
  });
  it("keyboard-selecting an unrelated node never associates a finding", () => {
    const [first, second] = FINDINGS;
    expect(second).toBeDefined();
    const selected = applyNodeSelectChanges(
      [{ type: "select", id: second.nodeId, selected: true }],
      first.nodeId
    );
    expect(selected).toBe(second.nodeId);
    expect(findingForNode(first.id, selected)).toBeNull();
  });
  it("deselection clears the association consistently", () => {
    const [first] = FINDINGS;
    const cleared = applyNodeSelectChanges(
      [{ type: "select", id: first.nodeId, selected: false }],
      first.nodeId
    );
    expect(cleared).toBeNull();
    expect(findingForNode(first.id, cleared)).toBeNull();
    expect(findingForNode(first.id, null)).toBeNull();
    expect(findingForNode(null, first.nodeId)).toBeNull();
  });
});

describe("UNIT: no-render-loop guard protocol (Finding B)", () => {
  it("echo resolution equals current, so the component skips onSelect", () => {
    // Mirrors the ArchGraph guard: if (next !== selectedNode) onSelect(next).
    const cases: Array<[Array<{ type: string; id?: string; selected?: boolean }>, string | null]> = [
      [[{ type: "select", id: "orders", selected: true }], "orders"],
      [[], null],
      [
        [
          { type: "select", id: "orders", selected: false },
          { type: "select", id: "orders", selected: true },
        ],
        "orders",
      ],
    ];
    for (const [changes, current] of cases) {
      const next = applyNodeSelectChanges(changes, current);
      expect(next).toBe(current);
      let calls = 0;
      if (next !== current) calls += 1;
      expect(calls).toBe(0);
    }
  });
  it("genuine changes resolve differently, so onSelect fires exactly once", () => {
    const next = applyNodeSelectChanges([{ type: "select", id: "users", selected: true }], "orders");
    expect(next).not.toBe("orders");
    let calls = 0;
    if (next !== "orders") calls += 1;
    expect(calls).toBe(1);
  });
});

describe("WIRING (static checks, not behavior proof)", () => {
  it("mouse preserved; all selection flows through the supported onNodesChange path", () => {
    const src = readFileSync("components/Graph.tsx", "utf8");
    // Unchanged mouse toggle.
    expect(src).toContain("onSelect(n.id === selectedNode ? null : n.id)");
    // Single canonical path: controlled nodes publish selection ONLY via
    // onNodesChange (no defaultNodes => internal store never updates, so
    // onSelectionChange would never fire for controlled nodes).
    expect(src).toContain("onNodesChange={onNodesChange}");
    expect(src).not.toContain("onSelectionChange=");
    expect(src).not.toContain("onSelectionChange(");
    expect(src).toContain("applyNodeSelectChanges(changes, selectedNode)");
    expect(src).toContain("if (next !== selectedNode) onSelect(next)");
  });
  it("selected path and highlight still derive from the same selectedNode", () => {
    const src = readFileSync("components/Graph.tsx", "utf8");
    const dashSrc = readFileSync("components/Dashboard.tsx", "utf8");
    expect(src).toContain("selected: selectedNode === d.id");
    expect(dashSrc).toContain("findingForNode(s.findingId, s.selectedNode)");
  });
});
