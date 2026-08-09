import { Board } from "@/types";
import { boardTopology, hasHLink, hasVLink } from "./boardTopology";
import { HOLE_RADIUS, HOLE_SPACING } from "./boardLayout";
import { StripSegment, segmentHoles } from "./stripSegments";

// ── Drawing the copper ─────────────────────────────────
//
// One answer to "where is there copper, and is it still live after the
// user's cuts", shared by the board canvas, the printout and the project
// thumbnail. Each of them draws in its own coordinate system — the cut
// sheet is even mirrored — so bars come back in hole-grid units and the
// caller maps them.
//
// Runs are merged as they are emitted: a strip of ten holes is one bar,
// not ten stubs, which is what the canvas reconciles on every board edit.

/** A run of copper, in hole-grid units. Ends carry the usual overhang. */
export interface CopperBar {
  /** Centre line, in hole coordinates (fractional past the end holes) */
  row1: number;
  col1: number;
  row2: number;
  col2: number;
  vertical: boolean;
}

/** How far copper reaches past the last hole of a run, in hole pitches. */
const OVERHANG = 0.4;

/**
 * How far short of a drilled-out hole its neighbouring copper stops, in
 * hole pitches. The copper runs right up to the hole rather than stopping
 * a whole pitch away, so the break reads as being *on* the hole instead of
 * as a wide blank in the middle of the strip.
 */
const DRILL_GAP = (HOLE_RADIUS + 1.5) / HOLE_SPACING;

/** Where the user has broken the copper. */
export interface BoardCuts {
  /** Gaps severed by a between-cut, as `row*(cols-1)+col` */
  severed: Set<number>;
  /** Holes drilled out, as `row*cols+col` */
  drilled: Set<number>;
}

export function boardCuts(board: Board): BoardCuts {
  const severed = new Set<number>();
  const drilled = new Set<number>();
  const cols = board.cols;
  for (const cut of board.cuts) {
    if (cut.kind === "hole") {
      if (cut.col >= 0 && cut.col < cols) drilled.add(cut.row * cols + cut.col);
    } else if (cut.col >= 0 && cut.col < cols - 1) {
      severed.add(cut.row * (cols - 1) + cut.col);
    }
  }
  return { severed, drilled };
}

/**
 * The bars that draw one segment's copper.
 *
 * Membership comes from the segment (so a drilled-out hole, which is not
 * in any segment, is never drawn through) and the links come from the
 * board, so the two can never disagree about what is connected.
 */
export function segmentBars(seg: StripSegment, board: Board, cuts: BoardCuts): CopperBar[] {
  const topo = boardTopology(board);
  const { severed, drilled } = cuts;
  const holes = segmentHoles(seg);
  const cols = board.cols;
  const inSeg = new Set<number>(holes.map((h) => h.row * cols + h.col));
  const joinedH = (r: number, c: number) =>
    inSeg.has(r * cols + c) && inSeg.has(r * cols + c + 1) &&
    hasHLink(topo, r, c) && !severed.has(r * (cols - 1) + c);
  const joinedV = (r: number, c: number) =>
    inSeg.has(r * cols + c) && inSeg.has((r + 1) * cols + c) && hasVLink(topo, r, c);

  // Where a run stops. Normally OVERHANG past its last hole — but if the
  // next hole along was drilled out, the copper it was joined to is still
  // there right up to the drill, so the run carries on to meet it. A
  // between-cut at the same gap wins: that break is between the two holes.
  const drilledAt = (r: number, c: number) => drilled.has(r * cols + c);
  const leftEnd = (r: number, c: number) =>
    drilledAt(r, c - 1) && hasHLink(topo, r, c - 1) && !severed.has(r * (cols - 1) + c - 1)
      ? c - 1 + DRILL_GAP : c - OVERHANG;
  const rightEnd = (r: number, c: number) =>
    drilledAt(r, c + 1) && hasHLink(topo, r, c) && !severed.has(r * (cols - 1) + c)
      ? c + 1 - DRILL_GAP : c + OVERHANG;
  const topEnd = (r: number, c: number) =>
    drilledAt(r - 1, c) && hasVLink(topo, r - 1, c) ? r - 1 + DRILL_GAP : r - OVERHANG;
  const bottomEnd = (r: number, c: number) =>
    drilledAt(r + 1, c) && hasVLink(topo, r, c) ? r + 1 - DRILL_GAP : r + OVERHANG;

  const bars: CopperBar[] = [];
  const startsRun = new Set<number>();

  // Maximal runs along a row, then down a column: walk to the end of each
  // and emit it once.
  for (const { row, col } of holes) {
    if (joinedH(row, col) && !joinedH(row, col - 1)) {
      let end = col;
      while (joinedH(row, end)) end++;
      bars.push({ row1: row, col1: leftEnd(row, col), row2: row, col2: rightEnd(row, end), vertical: false });
      for (let c = col; c <= end; c++) startsRun.add(row * cols + c);
    }
    if (joinedV(row, col) && !joinedV(row - 1, col)) {
      let end = row;
      while (joinedV(end, col)) end++;
      bars.push({ row1: topEnd(row, col), col1: col, row2: bottomEnd(end, col), col2: col, vertical: true });
      for (let r = row; r <= end; r++) startsRun.add(r * cols + col);
    }
  }

  // A hole joined to nothing is still a pad: draw it the width a strip
  // would have been, as a lone hole on a veroboard always looked.
  for (const { row, col } of holes) {
    if (!startsRun.has(row * cols + col)) {
      bars.push({ row1: row, col1: leftEnd(row, col), row2: row, col2: rightEnd(row, col), vertical: false });
    }
  }
  return bars;
}

/**
 * A bar as a rectangle in whatever coordinates the caller draws in. Both
 * board views want this and neither should have to work out which axis
 * carries the thickness; `x`/`y` may flip their axis (the printed cut
 * sheet is mirrored) without the result turning inside out.
 */
export function barRect(
  bar: CopperBar,
  x: (col: number) => number,
  y: (row: number) => number,
  thickness: { strip: number; bus: number },
): { x: number; y: number; width: number; height: number } {
  const ax = x(bar.col1);
  const bx = x(bar.col2);
  const ay = y(bar.row1);
  const by = y(bar.row2);
  const t = bar.vertical ? thickness.bus : thickness.strip;
  const left = Math.min(ax, bx);
  const top = Math.min(ay, by);
  return bar.vertical
    ? { x: left - t / 2, y: top, width: t, height: Math.abs(by - ay) }
    : { x: left, y: top - t / 2, width: Math.abs(bx - ax), height: t };
}

/** The two ends of a run, for placing the label a tag carries. */
export function segmentEnds(seg: StripSegment): [{ row: number; col: number }, { row: number; col: number }] {
  const holes = segmentHoles(seg);
  return [holes[0], holes[holes.length - 1]];
}
