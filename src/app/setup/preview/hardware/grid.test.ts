import { describe, expect, it } from "vitest";
import { GRID_COLUMNS, gridColumns, gridRowYs } from "./grid";

describe("gridRowYs", () => {
  it("puts a single row at the top", () => {
    expect(gridRowYs([100, 200, 150], 4, 50)).toEqual([0, 0, 0]);
  });

  // the bug: the second row was placed from an estimate, so a card taller
  // than it ran under the next row
  it("starts each row below the tallest card of the row above", () => {
    const ys = gridRowYs([300, 500, 300, 300, 200], 4, 50);
    expect(ys).toEqual([0, 0, 0, 0, 550]);
  });

  it("stacks several rows on their own tallest cards", () => {
    const ys = gridRowYs([100, 100, 400, 100, 250, 100], 2, 10);
    expect(ys).toEqual([0, 0, 110, 110, 520, 520]);
  });

  it("never lets a row overlap the one above, whatever the heights", () => {
    const heights = [120, 610, 90, 300, 480, 75, 700, 60, 200];
    const cols = 4;
    const ys = gridRowYs(heights, cols, 56);
    for (let i = cols; i < heights.length; i++) {
      const rowAbove = heights.slice(Math.floor(i / cols) * cols - cols, Math.floor(i / cols) * cols);
      const bottomAbove = ys[i - cols] + Math.max(...rowAbove);
      expect(ys[i]).toBeGreaterThanOrEqual(bottomAbove + 56);
    }
  });

  it("handles no cards and a single column", () => {
    expect(gridRowYs([], 4, 50)).toEqual([]);
    expect(gridRowYs([10, 20, 30], 1, 5)).toEqual([0, 15, 40]);
  });

  it("treats a non-positive column count as one column", () => {
    expect(gridRowYs([10, 10], 0, 0)).toEqual([0, 10]);
  });
});

describe("gridColumns", () => {
  it("uses one column per card up to the maximum", () => {
    expect(gridColumns(1)).toBe(1);
    expect(gridColumns(3)).toBe(3);
    expect(gridColumns(GRID_COLUMNS)).toBe(GRID_COLUMNS);
    expect(gridColumns(16)).toBe(GRID_COLUMNS);
  });

  it("never goes below one", () => {
    expect(gridColumns(0)).toBe(1);
  });
});
