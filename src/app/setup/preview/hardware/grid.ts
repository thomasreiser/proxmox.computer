// Where each card of the hardware preview goes. A pure function so the
// row maths is tested directly — it's the part that broke: rows were
// spaced off an estimated card height, and a card taller than the
// estimate had the next row drawn over its bottom.

export const GRID_COLUMNS = 4;

/**
 * The y of each card in a grid of `columns` columns, given each card's
 * height: every row starts `gap` below the tallest card of the row above.
 * Cards in one row share a y, so a short card never pulls its row up.
 */
export function gridRowYs(heights: number[], columns: number, gap: number): number[] {
  const cols = Math.max(1, columns);
  const ys: number[] = [];
  let rowY = 0;
  for (let start = 0; start < heights.length; start += cols) {
    const row = heights.slice(start, start + cols);
    for (let i = 0; i < row.length; i++) ys.push(rowY);
    rowY += Math.max(0, ...row) + gap;
  }
  return ys;
}

/** at most GRID_COLUMNS per row, fewer when there are fewer cards */
export function gridColumns(count: number): number {
  return Math.min(Math.max(count, 1), GRID_COLUMNS);
}
