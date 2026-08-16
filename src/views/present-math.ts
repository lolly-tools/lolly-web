// present-math.ts - the pure, DOM-free model behind presentation mode (plan 112).
//
// The conductor (present-mode.ts) reads the rendered `.lolly-frame-page` DOM into a
// list of FrameSpec, hands it here, and gets back: a deck walk order, `s=` address
// resolution, travel direction, and the per-frame state-class assignment (reveal's
// past/present/future trichotomy). Nothing in this file touches the DOM or the input
// model - it is unit-tested with plain objects, exactly like the CLI shares the
// engine's render path (one source of truth, no browser needed to check the maths).
//
// The model is 2D-capable from the start: frames group into COLUMNS (the main axis,
// `order`) each holding a vertical STACK of sub-slides (`stackOf`). When no frame
// declares `stackOf` - the M1 case, before the sub-slide field ships - every column
// holds exactly one frame and the walk is a plain left-to-right line, so the 2D code
// degrades to linear with no special-casing. Stacks (plan §6) then land as data only.

/** One frame as the conductor extracts it from a `.lolly-frame-page`. */
export interface FrameSpec {
  /** Frame id - the `data-frame-id` stamped on the page (ULID or a human id like `slide1`). */
  id: string;
  /** Authored sort key: presentation order ascending, then `x` ascending as tie-break. */
  order: number;
  /** Authored canvas position - used for the tie-break, overview map, and stack seeding. */
  x: number;
  y: number;
  /** Frame size, for letterboxing a mixed-size deck into one viewport stack. */
  w: number;
  h: number;
  /** Temporal dwell in ms for kiosk auto-advance (plan 93: `dur` > 0 = temporal). null/absent = manual. */
  dur?: number | null;
  /** Frame id of this frame's column head when it is a vertical sub-slide; null/absent = a head. */
  stackOf?: string | null;
}

/** A frame's resolved place in the deck: its column, its row within that column's
 *  stack, and its absolute position in the linear advance walk. */
export interface DeckPosition {
  id: string;
  /** 0-based column index along the main axis. */
  col: number;
  /** 0-based row within the column's vertical stack (0 = the column head). */
  row: number;
  /** 0-based position in the full linear walk (Space/→ order): head, its stack, next head, … */
  index: number;
  frame: FrameSpec;
}

/** The whole deck, in every shape the conductor needs to read it. */
export interface Deck {
  /** Every frame in linear walk order (what advance/retreat step through). */
  positions: DeckPosition[];
  /** Lookup by frame id (for `s=<id>` and reorder-proof URL sync). */
  byId: Map<string, DeckPosition>;
  /** columns[col][row] - the 2D grid, columns in main-axis order, rows top-to-bottom. */
  columns: DeckPosition[][];
  /** Total frames. */
  count: number;
  /** Number of column heads (what numeric `s=N` counts). */
  columnCount: number;
}

/** Travel direction between two positions, for `data-nav-dir` and direction-aware
 *  transition reversal. Horizontal moves win over vertical when both change (a jump
 *  across columns is a horizontal transition even if the target row differs). */
export type NavDir = 'left' | 'right' | 'up' | 'down' | null;

/** reveal's per-frame state trichotomy plus the peek-neighbour and unload flags. */
export interface FrameState {
  index: number;
  id: string;
  /** Exactly one of these, purely positional (index vs active) - NOT direction-aware;
   *  direction lives on the root as `data-nav-dir` so CSS composes the two. */
  state: 'past' | 'present' | 'future';
  /** The immediate neighbours in the walk, for peek/adjacency effects. */
  isPrev: boolean;
  isNext: boolean;
  /** Belongs to a column with more than one frame (a real stack) - `pr-stack`. */
  isStack: boolean;
  /** Beyond the live window (|index − active| > viewDistance): unload + aria-hidden.
   *  This is the rendering monopoly (plan §5.2): only the live window paints. */
  hidden: boolean;
}

/** The parsed form of an `s=` address: which frame, and which build step within it. */
export interface Address {
  /** The resolved position, or null when the address named nothing in the deck. */
  position: DeckPosition | null;
  /** Build-step threshold from an `.N` suffix (reveal boxes whose `build` ≤ N): a raw
   *  1-based build value, or null when no suffix was given. `.0` is meaningless → null. */
  build: number | null;
}

/** Is a string a bare non-negative integer (a positional `s=N`)? */
function isPositional(s: string): boolean {
  return /^\d+$/.test(s);
}

/** Build the deck from raw frame specs. Total function: an empty list yields an empty
 *  deck; a `stackOf` pointing at a missing/non-head frame degrades that frame to its
 *  own head rather than dropping it (geometry proposes, structure disposes - a dangling
 *  reference must never lose a slide). */
export function buildDeck(frames: readonly FrameSpec[]): Deck {
  // Canonical sort: order asc, then x asc, then id asc (stable, deterministic - the
  // same rule hooks.js uses for paged export, so present order === export order).
  const sorted = [...frames].sort(
    (a, b) => a.order - b.order || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const byIdSpec = new Map<string, FrameSpec>();
  for (const f of sorted) byIdSpec.set(f.id, f);

  // A frame is a HEAD unless its stackOf names another frame that is itself a head.
  // (A stackOf chain is one level deep by construction - a sub-slide can't head a stack.)
  const isHead = (f: FrameSpec): boolean => {
    const head = f.stackOf;
    if (head == null || head === '' || head === f.id) return true;
    const target = byIdSpec.get(head);
    // Dangling or pointing at another sub-slide ⇒ treat as its own head.
    return !target || (target.stackOf != null && target.stackOf !== '' && target.stackOf !== target.id);
  };

  const heads = sorted.filter(isHead);
  const columns: DeckPosition[][] = [];
  const positions: DeckPosition[] = [];
  const byId = new Map<string, DeckPosition>();

  for (let col = 0; col < heads.length; col++) {
    const head = heads[col]!;
    const members = [head, ...sorted.filter((f) => !isHead(f) && f.stackOf === head.id)];
    const column: DeckPosition[] = [];
    for (let row = 0; row < members.length; row++) {
      const frame = members[row]!;
      const pos: DeckPosition = { id: frame.id, col, row, index: 0, frame };
      column.push(pos);
    }
    columns.push(column);
  }

  // Flatten columns → linear walk, assigning the absolute index as we go.
  let index = 0;
  for (const column of columns) {
    for (const pos of column) {
      pos.index = index++;
      positions.push(pos);
      byId.set(pos.id, pos);
    }
  }

  return { positions, byId, columns, count: positions.length, columnCount: columns.length };
}

/** Resolve an `s=` address against a deck. Digits count COLUMN HEADS (1-based, plan §6);
 *  anything else is a frame id (matches any frame, head or sub-slide, regardless of
 *  position - reorder-proof). An `.N` suffix is a 1-based build step, returned 0-based.
 *  Junk / out-of-range → position null (the caller falls back to the first frame),
 *  never a throw. */
export function resolveAddress(s: string | null | undefined, deck: Deck): Address {
  if (s == null || s === '') return { position: null, build: null };
  const dot = s.indexOf('.');
  const slidePart = dot < 0 ? s : s.slice(0, dot);
  const buildPart = dot < 0 ? '' : s.slice(dot + 1);

  let build: number | null = null;
  if (isPositional(buildPart)) {
    const n = parseInt(buildPart, 10);
    build = n >= 1 ? n : null; // `.N` is a build-value threshold (reveal boxes with build ≤ N); `.0` is meaningless
  }

  let position: DeckPosition | null = null;
  if (isPositional(slidePart)) {
    const n = parseInt(slidePart, 10);
    const head = deck.columns[n - 1]?.[0]; // 1-based head index
    position = head ?? null;
  } else {
    position = deck.byId.get(slidePart) ?? null;
  }
  return { position, build };
}

/** Travel direction between two positions (old → new). Column change = horizontal and
 *  takes precedence; same column, different row = vertical; same position = null. */
export function navDir(from: DeckPosition | null, to: DeckPosition | null): NavDir {
  if (!from || !to) return null;
  if (to.col !== from.col) return to.col > from.col ? 'right' : 'left';
  if (to.row !== from.row) return to.row > from.row ? 'down' : 'up';
  return null;
}

/** The state-class assignment for the whole deck at a given active index. Positional,
 *  not direction-aware (direction is a separate root signal). `viewDistance` is the
 *  live window each side of the active frame (reveal's viewDistance; default 1 - the
 *  rendering monopoly keeps only active±1 painting, plan §5.2.1). */
export function frameStates(deck: Deck, activeIndex: number, viewDistance = 1): FrameState[] {
  const active = clampIndex(deck, activeIndex);
  return deck.positions.map((pos) => {
    const d = pos.index - active;
    const state: FrameState['state'] = d < 0 ? 'past' : d > 0 ? 'future' : 'present';
    return {
      index: pos.index,
      id: pos.id,
      state,
      isPrev: pos.index === active - 1,
      isNext: pos.index === active + 1,
      isStack: (deck.columns[pos.col]?.length ?? 1) > 1,
      hidden: Math.abs(d) > viewDistance,
    };
  });
}

/** Clamp an index into the deck's range (empty deck → 0). */
export function clampIndex(deck: Deck, index: number): number {
  if (deck.count === 0) return 0;
  if (index < 0) return 0;
  if (index >= deck.count) return deck.count - 1;
  return index;
}

/** The next frame in the linear walk. With `loop`, wraps from the last frame to the
 *  first; without it, stays put at the end (returns the same index). Builds are handled
 *  by the conductor before it calls this - this is slide-to-slide only. */
export function walkNext(deck: Deck, index: number, opts: { loop?: boolean } = {}): number {
  if (deck.count === 0) return 0;
  const i = clampIndex(deck, index);
  if (i < deck.count - 1) return i + 1;
  return opts.loop ? 0 : i;
}

/** The previous frame in the linear walk. With `loop`, wraps from the first to the last. */
export function walkPrev(deck: Deck, index: number, opts: { loop?: boolean } = {}): number {
  if (deck.count === 0) return 0;
  const i = clampIndex(deck, index);
  if (i > 0) return i - 1;
  return opts.loop ? deck.count - 1 : i;
}

// ── Morph matching (M5) ───────────────────────────────────────────────────────────────
// The "morph" transition FLIPs boxes that MATCH across two adjacent slides from their old
// place to their new one. Matching is where every competitor is weak - Figma matches by
// layer name (breaks on rename), Canva/Pitch by a hidden auto id. We expose it: an author
// sets `matchOf` for a deliberate link, and otherwise identical text or the same image is
// matched implicitly. This is the pure pairing; the conductor does the FLIP off these ids.

/** A box as the morph matcher sees it (the conductor reads these off the rendered DOM). */
export interface MorphBox {
  id: string;
  /** Explicit match key (`matchOf` / `data-match`) - the strongest signal. */
  matchOf?: string | null;
  /** Visible text content, trimmed - the implicit signal for text boxes. */
  text?: string | null;
  /** Image/video identity (asset id or `data-video-key`) - the implicit signal for media. */
  imageKey?: string | null;
}

/** A matched pair: the leaving box morphs INTO the entering box. */
export interface MorphPair { fromId: string; toId: string; via: 'matchOf' | 'text' | 'image'; }

/** Pair boxes across the leaving frame (`from`) and entering frame (`to`) for a morph.
 *  One-to-one and greedy: explicit `matchOf` links first, then equal non-empty text, then
 *  equal image key. A box already claimed by a stronger tier is never reused, so a rename
 *  that breaks an implicit text match still leaves an explicit `matchOf` intact. */
export function matchMorphBoxes(from: readonly MorphBox[], to: readonly MorphBox[]): MorphPair[] {
  const pairs: MorphPair[] = [];
  const usedFrom = new Set<string>();
  const usedTo = new Set<string>();

  const claim = (a: MorphBox, b: MorphBox, via: MorphPair['via']): void => {
    pairs.push({ fromId: a.id, toId: b.id, via });
    usedFrom.add(a.id); usedTo.add(b.id);
  };
  const norm = (s: string | null | undefined): string => (s ?? '').trim();

  // Tier 1 - explicit matchOf === matchOf (both non-empty).
  for (const a of from) {
    if (usedFrom.has(a.id)) continue;
    const key = norm(a.matchOf);
    if (!key) continue;
    const b = to.find((t) => !usedTo.has(t.id) && norm(t.matchOf) === key);
    if (b) claim(a, b, 'matchOf');
  }
  // Tier 2 - identical non-empty text.
  for (const a of from) {
    if (usedFrom.has(a.id)) continue;
    const key = norm(a.text);
    if (!key) continue;
    const b = to.find((t) => !usedTo.has(t.id) && norm(t.text) === key);
    if (b) claim(a, b, 'text');
  }
  // Tier 3 - identical non-empty image/media key.
  for (const a of from) {
    if (usedFrom.has(a.id)) continue;
    const key = norm(a.imageKey);
    if (!key) continue;
    const b = to.find((t) => !usedTo.has(t.id) && norm(t.imageKey) === key);
    if (b) claim(a, b, 'image');
  }
  return pairs;
}

/** Vertical navigation within the active frame's column (the 4-arrow stack walk).
 *  Returns the index of the neighbour above/below in the same column, or the same
 *  index when there is none (a column edge - do NOT spill into the next column; that
 *  is what ←/→ are for). */
export function stackStep(deck: Deck, index: number, dir: 'up' | 'down'): number {
  if (deck.count === 0) return 0;
  const pos = deck.positions[clampIndex(deck, index)];
  if (!pos) return index;
  const column = deck.columns[pos.col];
  if (!column) return index;
  const targetRow = dir === 'down' ? pos.row + 1 : pos.row - 1;
  const target = column[targetRow];
  return target ? target.index : pos.index;
}
