// The generated repo, drawn as a real tree rather than spelled out with
// box-drawing characters.
//
// ├ │ └ only tile into unbroken lines when the line box is exactly the
// glyph's design cell, and .code sets line-height 22px at font-size 14px —
// so every row carried ~8px of leading that no glyph paints, and the
// verticals came apart. Worse, ├ and │ resolve to different faces down the
// ui-monospace/SFMono/Menlo/Consolas fallback chain on some machines, so
// they didn't even share an x. Drawing the connectors as css borders is
// exact at any font, any line height, and follows the theme tokens.

export interface TreeEntry {
  name: string;
  note?: string;
  // the two files the surrounding paragraph singles out — worth marking
  // in the drawing so the prose has something to point at.
  marked?: boolean;
  children?: TreeEntry[];
}

interface TreeRow {
  name: string;
  note: string;
  marked: boolean;
  // one flag per ancestor level: does that ancestor still have siblings
  // below this row? that's exactly the question of whether its column
  // keeps drawing a vertical line as the tree passes through.
  trunks: boolean[];
  // last child of its parent, so its own connector stops at the elbow
  // instead of carrying on down
  isLast: boolean;
  isRoot: boolean;
}

function walk(entries: TreeEntry[], trunks: boolean[], rows: TreeRow[]): void {
  entries.forEach((entry, i) => {
    const isLast = i === entries.length - 1;
    rows.push({
      name: entry.name,
      note: entry.note ?? "",
      marked: !!entry.marked,
      trunks,
      isLast,
      isRoot: false,
    });
    if (entry.children?.length) walk(entry.children, [...trunks, !isLast], rows);
  });
}

export function flattenTree(root: TreeEntry): TreeRow[] {
  const rows: TreeRow[] = [
    { name: root.name, note: root.note ?? "", marked: false, trunks: [], isLast: true, isRoot: true },
  ];
  walk(root.children ?? [], [], rows);
  return rows;
}

export function RepoTree({ root }: { root: TreeEntry }) {
  const rows = flattenTree(root);

  return (
    <div className="pc-tree">
      {rows.map((row) => (
        <div key={row.name} className="pc-tree__row">
          <div className="pc-tree__entry">
            {row.trunks.map((continues, depth) => (
              <span
                key={depth}
                className={`pc-tree__guide${continues ? " pc-tree__guide--trunk" : ""}`}
                aria-hidden="true"
              />
            ))}
            {!row.isRoot && (
              <span
                className={`pc-tree__guide pc-tree__guide--elbow${row.isLast ? " pc-tree__guide--stop" : ""}`}
                aria-hidden="true"
              />
            )}
            <span className={`pc-tree__name${row.marked ? " pc-tree__name--marked" : ""}`}>{row.name}</span>
          </div>
          <div className="pc-tree__note">{row.note}</div>
        </div>
      ))}
    </div>
  );
}
