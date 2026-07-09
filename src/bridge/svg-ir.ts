// SPDX-License-Identifier: MPL-2.0
/**
 * SVG DOM → EMF intermediate representation (IR).
 *
 * Walks a rendered SVG element into the flat, device-pixel, sRGB, alpha-composited
 * IR that engine/src/emf.js serializes. Mirrors drawSvgVectorsInRegion in
 * export.js (viewBox mapping, <g> translate+scale incl. d3.zoom, non-scaling
 * stroke) but emits IR prims instead of jsPDF calls — and, critically, ALWAYS
 * outlines <text> to vector paths via host.text.toPath (the "always text-as-paths"
 * rule). A <text> run that can't be vectorized throws, so EMF never ships a
 * partially-textless file. See plans/emf-support.md.
 *
 * Every shape (rect/circle/ellipse/line/polygon/polyline) is expressed as an SVG
 * `d` string and run through the shared engine tokenizer (parseSvgPath), so there
 * is one geometry path for the whole walk.
 *
 * SUSE-specific font resolution lives in the shell (text-svg.js), never the
 * engine. This module is DOM-light: it only reads attributes + (optionally)
 * computed style, so it runs under jsdom for native-SVG tools in the CLI — except
 * the text outlining, which needs host.text (absent in the lean CLI).
 */

import { parseSvgPath } from '@lolly/engine';
import type { HostV1, TextPathResult } from '../../../../engine/src/bridge/host-v1.ts';
import type { PathSegment } from '../../../../engine/src/svg-path.ts';
import type { VectorPathPrim, VectorImagePrim, VectorPrim, Rgb } from '../../../../engine/src/emf.ts';
import { canVectoriseText, featureSettingsToHb, letterSpacingPx } from './text-svg.ts';
import { resolveVectorFont } from './font-registry.ts';

const SKIP = new Set(['defs', 'clippath', 'lineargradient', 'radialgradient',
  'symbol', 'style', 'script', 'title', 'desc', 'metadata', 'filter', 'mask']);

// ─── colour ───────────────────────────────────────────────────────────────────

type RgbTuple = [number, number, number];

const NAMED: Record<string, RgbTuple> = {
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0],
  blue: [0, 0, 255], gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192],
  yellow: [255, 255, 0], orange: [255, 165, 0], purple: [128, 0, 128], navy: [0, 0, 128],
};

// Parse an SVG/CSS colour to [r,g,b], or null for none/transparent/unparseable.
export function parseColor(input: string | null | undefined): RgbTuple | null {
  if (!input) return null;
  const c = String(input).trim().toLowerCase();
  if (!c || c === 'none' || c === 'transparent') return null;
  if (c === 'currentcolor') return [0, 0, 0];
  if (c[0] === '#') {
    let hex = c.slice(1);
    if (hex.length === 3) hex = hex.split('').map(h => h + h).join('');
    if (hex.length === 6) {
      const n = parseInt(hex, 16);
      if (!Number.isNaN(n)) return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    return null;
  }
  const m = c.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1]!.split(',').map(s => s.trim());
    const ch = (s: string) => s.endsWith('%') ? Math.round(parseFloat(s) * 2.55) : parseInt(s, 10);
    const r = ch(parts[0]!), g = ch(parts[1]!), b = ch(parts[2]!);
    if ([r, g, b].every(Number.isFinite)) return [r, g, b];
    return null;
  }
  return NAMED[c] ?? null;
}

// Composite a colour over an opaque background by its alpha (source-over flatten).
// EMF has no per-path alpha, so opacity collapses to a solid here.
function flatten(rgb: RgbTuple, alpha: number, bg: RgbTuple): RgbTuple {
  if (alpha >= 0.999) return rgb;
  return [
    Math.round(rgb[0] * alpha + bg[0] * (1 - alpha)),
    Math.round(rgb[1] * alpha + bg[1] * (1 - alpha)),
    Math.round(rgb[2] * alpha + bg[2] * (1 - alpha)),
  ];
}

const rgbObj = ([r, g, b]: RgbTuple): Rgb => ({ r, g, b });

// ─── style resolution ─────────────────────────────────────────────────────────

type StyleMap = Record<string, string | undefined>;

function parseStyleAttr(el: Element): StyleMap {
  const s = el.getAttribute?.('style');
  if (!s) return {};
  const out: StyleMap = {};
  for (const decl of s.split(';')) {
    const i = decl.indexOf(':');
    if (i > 0) out[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim();
  }
  return out;
}

// Property precedence: inline style > presentation attribute > inherited.
function prop(el: Element, style: StyleMap, name: string, inherited?: StyleMap | null): string | undefined {
  return style[name] ?? el.getAttribute?.(name) ?? inherited?.[name];
}

// length, resolving a % against `total`.
function len(v: string | undefined, total = 0): number {
  if (v == null) return 0;
  const s = String(v).trim();
  if (s.endsWith('%')) return (parseFloat(s) / 100) * total;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

// ─── shape → SVG `d` builders (reused through parseSvgPath) ─────────────────────

function rectPath(x: number, y: number, w: number, h: number, rx: number, ry: number): string {
  if (w <= 0 || h <= 0) return '';
  if (rx > 0 || ry > 0) {
    rx = Math.min(rx || ry, w / 2); ry = Math.min(ry || rx, h / 2);
    return `M${x + rx},${y} H${x + w - rx} A${rx},${ry} 0 0 1 ${x + w},${y + ry}` +
           ` V${y + h - ry} A${rx},${ry} 0 0 1 ${x + w - rx},${y + h}` +
           ` H${x + rx} A${rx},${ry} 0 0 1 ${x},${y + h - ry}` +
           ` V${y + ry} A${rx},${ry} 0 0 1 ${x + rx},${y} Z`;
  }
  return `M${x},${y} H${x + w} V${y + h} H${x} Z`;
}

const circlePath = (cx: number, cy: number, r: number): string =>
  r <= 0 ? '' : `M${cx - r},${cy} A${r},${r} 0 1 0 ${cx + r},${cy} A${r},${r} 0 1 0 ${cx - r},${cy} Z`;

const ellipsePath = (cx: number, cy: number, rx: number, ry: number): string =>
  (rx <= 0 || ry <= 0) ? '' : `M${cx - rx},${cy} A${rx},${ry} 0 1 0 ${cx + rx},${cy} A${rx},${ry} 0 1 0 ${cx - rx},${cy} Z`;

function pointsPath(str: string | null, close: boolean): string {
  const nums = (str || '').match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g);
  if (!nums || nums.length < 4) return '';
  let d = `M${nums[0]},${nums[1]}`;
  for (let i = 2; i + 1 < nums.length; i += 2) d += ` L${nums[i]},${nums[i + 1]}`;
  return d + (close ? ' Z' : '');
}

// ─── main walk ──────────────────────────────────────────────────────────────

/** Group/transform accumulator carried down the walk. */
interface WalkTransform {
  tx: number;
  ty: number;
  sX: number;
  sY: number;
}

// Compose an element's own `transform` (translate/scale) onto the inherited CTM.
// Applies to containers AND leaf drawables — a <path transform="translate() scale()">
// (brand-lockup's per-leaf layout) must scale/position like a <g> would.
function applyElementTransform(el: Element, t: WalkTransform): WalkTransform {
  const nt: WalkTransform = { ...t };
  const transform = el.getAttribute?.('transform') || '';
  if (transform) {
    const { sX, sY } = t;
    const tm = transform.match(/translate\(\s*([+-]?\d*\.?\d+)[,\s]\s*([+-]?\d*\.?\d+)\s*\)/) ??
               transform.match(/translate\(\s*([+-]?\d*\.?\d+)\s*\)/);
    const sm = transform.match(/scale\(\s*([+-]?\d*\.?\d+)(?:[,\s]\s*([+-]?\d*\.?\d+))?\s*\)/);
    if (tm) { nt.tx += sX * parseFloat(tm[1]!); nt.ty += sY * parseFloat(tm[2] ?? '0'); }
    if (sm) { nt.sX = sX * parseFloat(sm[1]!); nt.sY = sY * parseFloat(sm[2] ?? sm[1]!); }
  }
  return nt;
}

/** Geometry closures + per-leaf opacity handed to emitText. */
interface LeafTextGeometry {
  PX: (v: number) => number;
  PY: (v: number) => number;
  mapPt: (x: number, y: number) => { x: number; y: number };
  gAvg: number;
  rAvg: number;
  elemOpacity: number;
}

/** Context the caller provides to resolve host services + environment. */
export interface SvgIrContext {
  host?: HostV1 | null;
  getComputedStyle?: (el: Element) => CSSStyleDeclaration;
  background?: string;
  /** User-facing label for log/error text. Defaults to 'EMF'. */
  label?: string;
}

/** Normalized vector IR consumed by engine/src/emf.js and engine/src/eps.js. */
export interface VectorIrResult {
  width: number;
  height: number;
  prims: VectorPrim[];
}

// Decode an <image> href (a data:/blob: URL — e.g. the vector escape-hatch's PNG) to
// opaque RGB, compositing any alpha over `bg` (EMF/EPS have no alpha channel).
// Browser-only (canvas); returns null under jsdom (CLI) or on any failure, so the
// caller warns + skips rather than throwing.
async function decodeImageToRgb(href: string, bg: RgbTuple): Promise<{ w: number; h: number; rgb: Uint8Array } | null> {
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return null;
  try {
    const blob = await (await fetch(href)).blob();
    const bmp = await createImageBitmap(blob);
    const w = bmp.width, h = bmp.height;
    if (!(w > 0 && h > 0)) { bmp.close?.(); return null; }
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const cx = canvas.getContext('2d', { willReadFrequently: true });
    if (!cx) { bmp.close?.(); return null; }
    cx.drawImage(bmp, 0, 0);
    bmp.close?.();
    const data = cx.getImageData(0, 0, w, h).data;   // RGBA
    const rgb = new Uint8Array(w * h * 3);
    const [br, bgn, bb] = bg;
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      const a = data[i + 3]! / 255, ia = 1 - a;
      rgb[j]     = Math.round(data[i]!     * a + br  * ia);
      rgb[j + 1] = Math.round(data[i + 1]! * a + bgn * ia);
      rgb[j + 2] = Math.round(data[i + 2]! * a + bb  * ia);
    }
    return { w, h, rgb };
  } catch { return null; }
}

/**
 * @param {Element} svgEl  the root <svg>
 * @param {object} ctx     { host, getComputedStyle, background }
 * @returns {Promise<{width,height,prims}>}
 */
export async function svgDomToIr(svgEl: Element, ctx: SvgIrContext = {}): Promise<VectorIrResult> {
  const { host, getComputedStyle } = ctx;
  // User-facing label for log/error text. Defaults to 'EMF' so existing callers
  // (which pass no label) read exactly as before; the EPS sink passes 'EPS'.
  const LABEL = ctx.label || 'EMF';
  const bg: RgbTuple = ctx.background ? (parseColor(ctx.background) ?? [255, 255, 255]) : [255, 255, 255];

  // viewBox: prefer the live SVGRect (browser), fall back to parsing the
  // attribute string — jsdom often leaves viewBox.baseVal unimplemented, so the
  // CLI path must read the attribute (qr-code relies on it).
  const base = (svgEl as Element & { viewBox?: SVGAnimatedRect }).viewBox?.baseVal;
  let vbX = 0, vbY = 0, vbW = 0, vbH = 0, hasVb = false;
  if (base && base.width > 0 && base.height > 0) {
    ({ x: vbX, y: vbY, width: vbW, height: vbH } = base); hasVb = true;
  } else {
    const a = (svgEl.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if (a.length === 4 && a.every(Number.isFinite) && a[2]! > 0 && a[3]! > 0) {
      [vbX, vbY, vbW, vbH] = a as [number, number, number, number]; hasVb = true;
    }
  }
  // A px width/height attribute (no '%') gives the canvas size; otherwise fall
  // back to the viewBox (qr-code uses width="100%" + viewBox, so parseFloat alone
  // would wrongly yield 100).
  const pxAttr = (name: string): number => {
    const a = svgEl.getAttribute(name);
    if (!a || /%/.test(a)) return NaN;
    const n = parseFloat(a);
    return Number.isFinite(n) && n > 0 ? n : NaN;
  };
  if (!hasVb) { vbW = pxAttr('width') || 0; vbH = pxAttr('height') || 0; }
  const canvasW = pxAttr('width') || vbW;
  const canvasH = pxAttr('height') || vbH;
  if (!(vbW > 0 && vbH > 0)) {
    throw new Error(`${LABEL} export: SVG has no usable size (need a viewBox or width/height)`);
  }
  const regX = canvasW / vbW;
  const regY = canvasH / vbH;

  const prims: VectorPrim[] = [];
  const textApi = host?.text || null;
  const warn = (m: string) => host?.log?.('warn', `${LABEL.toLowerCase()}: ${m}`);

  // tx/ty/sX/sY accumulate the group transform; the closure maps a user coord to
  // device px (region-scaled).
  async function visit(el: Element, t: WalkTransform, inherited: StyleMap | null): Promise<void> {
    if (!el.tagName) return;
    const tag = el.tagName.toLowerCase().replace(/^svg:/, '');
    if (SKIP.has(tag)) return;

    // Compose this element's own transform onto the inherited CTM. Containers pass
    // it to their children; leaf drawables map their own geometry through it (so a
    // per-leaf `transform` is honoured, not silently dropped).
    const et = applyElementTransform(el, t);
    const { tx, ty, sX, sY } = et;
    const PX = (v: number) => (tx + sX * v - vbX) * regX;
    const PY = (v: number) => (ty + sY * v - vbY) * regY;
    const mapPt = (x: number, y: number) => ({ x: PX(x), y: PY(y) });
    const gAvg = (Math.abs(sX) + Math.abs(sY)) / 2;
    const rAvg = (regX + regY) / 2;

    if (tag === 'g' || tag === 'a' || tag === 'svg') {
      const style = parseStyleAttr(el);
      const inh: StyleMap = {
        fill: prop(el, style, 'fill', inherited),
        stroke: prop(el, style, 'stroke', inherited),
        'fill-opacity': prop(el, style, 'fill-opacity', inherited),
        'stroke-opacity': prop(el, style, 'stroke-opacity', inherited),
        'fill-rule': prop(el, style, 'fill-rule', inherited),
        'stroke-width': prop(el, style, 'stroke-width', inherited),
        opacity: undefined, // group opacity does not inherit as a property; applied per-leaf
      };
      for (const child of el.children) await visit(child, et, inh);
      return;
    }

    // ── leaf shapes: build a `d`, resolve paint, emit a path prim ──
    const style = parseStyleAttr(el);
    const elemOpacity = parseFloat(prop(el, style, 'opacity', null) ?? '1');
    if (elemOpacity < 0.01) return;

    let d = '';
    let forceStrokeOnly = false;
    if (tag === 'path')        d = el.getAttribute('d') || '';
    else if (tag === 'rect')   d = rectPath(len(prop(el, style, 'x'), vbW), len(prop(el, style, 'y'), vbH),
                                            len(prop(el, style, 'width'), vbW), len(prop(el, style, 'height'), vbH),
                                            len(prop(el, style, 'rx')), len(prop(el, style, 'ry') ?? prop(el, style, 'rx')));
    else if (tag === 'circle') d = circlePath(len(prop(el, style, 'cx'), vbW), len(prop(el, style, 'cy'), vbH), len(prop(el, style, 'r'), vbW));
    else if (tag === 'ellipse') d = ellipsePath(len(prop(el, style, 'cx'), vbW), len(prop(el, style, 'cy'), vbH), len(prop(el, style, 'rx'), vbW), len(prop(el, style, 'ry'), vbH));
    else if (tag === 'polygon') d = pointsPath(el.getAttribute('points'), true);
    else if (tag === 'polyline') d = pointsPath(el.getAttribute('points'), false);
    else if (tag === 'line') { d = `M${len(prop(el, style, 'x1'), vbW)},${len(prop(el, style, 'y1'), vbH)} L${len(prop(el, style, 'x2'), vbW)},${len(prop(el, style, 'y2'), vbH)}`; forceStrokeOnly = true; }
    else if (tag === 'text') { await emitText(el, style, { PX, PY, mapPt, gAvg, rAvg, elemOpacity }); return; }
    else if (tag === 'image') {
      // The vector rasterise escape-hatch (visitSvgNode) emits <image href="data:…">
      // for a node whose CSS the walker can't express. Decode it to an opaque RGB
      // prim so it survives to EMF/EPS bytes instead of being dropped. Everything
      // vectorisable stays a path — this is the last resort.
      const href = el.getAttribute('href') || el.getAttribute('xlink:href')
        || el.getAttributeNS?.('http://www.w3.org/1999/xlink', 'href') || '';
      if (!href) { warn('image with no href (skipped)'); return; }
      const dec = await decodeImageToRgb(href, bg);
      if (!dec) { warn('image could not be rasterised for this format (skipped)'); return; }
      const bx = PX(len(prop(el, style, 'x'), vbW));
      const by = PY(len(prop(el, style, 'y'), vbH));
      const bw = len(prop(el, style, 'width'), vbW) * Math.abs(sX) * regX;
      const bh = len(prop(el, style, 'height'), vbH) * Math.abs(sY) * regY;
      if (bw < 0.5 || bh < 0.5) return;
      // Honour preserveAspectRatio. The escape-hatch always emits 'none' with a box
      // matched to the node (so none == meet there). Tool-authored <image>s (tool-logo,
      // asset-export, filter-*) use the SVG default 'meet' → fit the source aspect
      // inside the box and align (default xMidYMid = centred) so a non-square asset
      // letterboxes instead of squishing. 'slice' is approximated as meet (EMF/EPS
      // can't cheaply source-crop) — aspect preserved, no distortion.
      const par = (prop(el, style, 'preserveAspectRatio') || 'xMidYMid meet').trim();
      let x = bx, y = by, w = bw, h = bh;
      if (!/^none/i.test(par) && dec.w > 0 && dec.h > 0) {
        const scale = Math.min(bw / dec.w, bh / dec.h);
        w = dec.w * scale; h = dec.h * scale;
        const ax = /xMin/i.test(par) ? 0 : /xMax/i.test(par) ? 1 : 0.5;
        const ay = /YMin/i.test(par) ? 0 : /YMax/i.test(par) ? 1 : 0.5;
        x = bx + (bw - w) * ax;
        y = by + (bh - h) * ay;
      }
      prims.push({ type: 'image', x, y, w, h, pxW: dec.w, pxH: dec.h, rgb: dec.rgb });
      return;
    }
    else if (tag === 'use') { warn('use elements are not supported (skipped)'); return; }
    else { for (const child of el.children || []) await visit(child, t, inherited); return; }

    if (!d || !d.trim()) return;

    // paint
    const fillStr = forceStrokeOnly ? 'none' : (prop(el, style, 'fill', inherited) ?? 'black');
    const strokeStr = prop(el, style, 'stroke', inherited) ?? 'none';
    const fillOp = elemOpacity * parseFloat(prop(el, style, 'fill-opacity', inherited) ?? '1');
    const strkOp = elemOpacity * parseFloat(prop(el, style, 'stroke-opacity', inherited) ?? '1');
    let fillRgb = fillOp >= 0.01 ? parseColor(fillStr) : null;
    let strokeRgb = strkOp >= 0.01 ? parseColor(strokeStr) : null;
    if (!fillRgb && !strokeRgb) return;
    if (fillRgb) fillRgb = flatten(fillRgb, fillOp, bg);
    if (strokeRgb) strokeRgb = flatten(strokeRgb, strkOp, bg);

    // non-scaling-stroke (street-map roads) keeps user-unit width through the
    // group transform → region scale only; otherwise group×region scale.
    const nonScaling = (prop(el, style, 'vector-effect', inherited)) === 'non-scaling-stroke';
    const strokeMul = (nonScaling ? 1 : gAvg) * rAvg;
    const strokeWidth = parseFloat(prop(el, style, 'stroke-width', inherited) ?? '1') * strokeMul;

    const subpaths = parseSvgPath(d).map(sub => ({
      closed: sub.closed,
      segments: sub.segments.map(seg => mapSeg(seg, mapPt)),
    }));
    if (!subpaths.length) return;

    prims.push({
      type: 'path',
      subpaths,
      fill: fillRgb ? rgbObj(fillRgb) : null,
      stroke: strokeRgb ? { ...rgbObj(strokeRgb), width: Math.max(1, strokeWidth) } : null,
      fillRule: (prop(el, style, 'fill-rule', inherited) === 'evenodd') ? 'evenodd' : 'nonzero',
    });
  }

  // Outline a <text> run to a filled path prim via host.text.toPath.
  async function emitText(el: Element, style: StyleMap, m: LeafTextGeometry): Promise<void> {
    const raw = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!raw) return;

    const fillStr = prop(el, style, 'fill', null) ?? '#000000';
    const opacity = m.elemOpacity * parseFloat(prop(el, style, 'fill-opacity', null) ?? prop(el, style, 'opacity', null) ?? '1');
    let rgb = opacity >= 0.01 ? parseColor(fillStr) : null;
    if (!rgb) return;
    rgb = flatten(rgb, opacity, bg);

    // Resolve font: attributes first, then computed style (chart-creator sets
    // font-family via a <style> block, not an attribute).
    const cs = getComputedStyle ? safeComputed(getComputedStyle, el) : null;
    const family = prop(el, style, 'font-family', null) ?? cs?.fontFamily ?? '';
    const weight = String(prop(el, style, 'font-weight', null) ?? cs?.fontWeight ?? '400');
    const italic = (prop(el, style, 'font-style', null) ?? cs?.fontStyle) === 'italic';
    const fontSize = parseFloat(prop(el, style, 'font-size', null) ?? cs?.fontSize ?? '16');
    const letterSpacingCss = prop(el, style, 'letter-spacing', null) ?? cs?.letterSpacing;
    const fontStyleObj = { fontFamily: family, fontWeight: weight, fontStyle: italic ? 'italic' : 'normal',
      letterSpacing: letterSpacingCss };
    // SUSE statics, the user's own Google fonts, or the platform face — this
    // format has no <text> fallback, so an unresolvable family is fatal.
    const vf = textApi ? await resolveVectorFont(fontStyleObj, raw) : null;
    const fontUrl = vf?.url ?? null;

    if (!canVectoriseText(fontStyleObj, fontUrl, Boolean(textApi))) {
      throw new Error(
        `${LABEL} export requires outlined text, but the run "${raw.slice(0, 24)}" could not be ` +
        `vectorized (font-family "${family || 'inherited'}"${textApi ? '' : '; no text-shaping in this shell'}). ` +
        `Add the font under Profile → Your brand, or export SVG/PDF.`);
    }

    // Tracking + OpenType feature toggles bake into the shaped path (kept outlined).
    const letterSpacing = letterSpacingPx(letterSpacingCss);
    const features = featureSettingsToHb(prop(el, style, 'font-feature-settings', null) ?? cs?.fontFeatureSettings);

    let result: TextPathResult;
    try {
      result = await textApi!.toPath({ text: raw, fontUrl: fontUrl!, fontSize, features: features as string[], letterSpacing, variations: vf!.variations, fallbackFonts: vf!.fallbacks });
    } catch (e) {
      throw new Error(`EMF export: text shaping failed for "${raw.slice(0, 24)}" — ${(e as Error).message}`);
    }
    if (!result?.d) return;            // whitespace-only / no glyphs

    const x = len(prop(el, style, 'x'), vbW);
    const y = len(prop(el, style, 'y'), vbH);
    const anchor = prop(el, style, 'text-anchor', null) ?? cs?.textAnchor ?? 'start';
    const adv = result.advanceWidth || 0;
    const xAdj = anchor === 'middle' ? x - adv / 2 : anchor === 'end' ? x - adv : x;

    // toPath `d` has baseline at y=0; place each glyph point at (xAdj+gx, y+gy)
    // in user space, then map through the group/region transform.
    const place = (gx: number, gy: number) => m.mapPt(xAdj + gx, y + gy);
    const subpaths = parseSvgPath(result.d).map(sub => ({
      closed: true,                    // glyph contours are always closed fills
      segments: sub.segments.map(seg => mapSeg(seg, place)),
    }));
    if (!subpaths.length) return;

    prims.push({ type: 'path', subpaths, fill: rgbObj(rgb), stroke: null, fillRule: 'nonzero' });
  }

  await visit(svgEl, { tx: 0, ty: 0, sX: 1, sY: 1 }, null);

  return { width: Math.round(canvasW), height: Math.round(canvasH), prims };
}

function mapSeg(seg: PathSegment, mapPt: (x: number, y: number) => { x: number; y: number }): PathSegment {
  if (seg.op === 'C') {
    const a = mapPt(seg.x1, seg.y1), b = mapPt(seg.x2, seg.y2), c = mapPt(seg.x, seg.y);
    return { op: 'C', x1: a.x, y1: a.y, x2: b.x, y2: b.y, x: c.x, y: c.y };
  }
  const p = mapPt(seg.x, seg.y);
  return { op: seg.op, x: p.x, y: p.y } as PathSegment;
}

function safeComputed(fn: (el: Element) => CSSStyleDeclaration, el: Element): CSSStyleDeclaration | null {
  try { return fn(el); } catch { return null; }
}
