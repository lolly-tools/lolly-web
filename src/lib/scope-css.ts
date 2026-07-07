// SPDX-License-Identifier: MPL-2.0
/**
 * Scope a tool's stylesheet so every rule only applies under the tool's canvas
 * node — the single canonical implementation shared by the live tool view
 * (views/tool.js) and the off-screen batch/compose renderer (pro/render-export.js).
 *
 * Replaces a regex (`/(^|\})\s*([^{}]+)\s*\{/g`) that only matched selectors
 * preceded by `}` or start-of-string. That had two real bugs tools worked
 * around (see tools/digi-ad/hooks.js and tools/strip-data/styles.css):
 *
 *   1. The FIRST rule inside any at-rule block (e.g. `@media { .a {…} }`) was
 *      never scoped — it leaked to the global document.
 *   2. Multi-step `@keyframes` corrupted: stops after the first (`50%`, `to`)
 *      are preceded by a `}`, so they got prefixed with the scope and became
 *      invalid keyframe selectors.
 *
 * This walks the stylesheet brace-by-brace instead — comment/string aware —
 * and scopes selectors only where they are real style-rule selectors:
 *   • top level and inside conditional group rules (@media/@supports/
 *     @container/@layer{}/@document/@scope) → every selector scoped;
 *   • @keyframes stops (from/to/%) and declaration blocks (@font-face, @page,
 *     a rule's own body) → left untouched;
 *   • at-statements (@import/@charset/@namespace/@layer a,b;) → left untouched.
 *
 * Two further invariants keep the lexical scoping correct:
 *   • Selector lists split on TOP-LEVEL commas only (splitSelectorList) — a comma
 *     inside :is()/:where()/:not(), an [attr="a,b"] value, or a comment is not a
 *     separator, so the scope prefix never lands inside parentheses or a string.
 *   • A conditional group scopes its children only when itself at scope level;
 *     nested inside a style rule (CSS nesting) its children stay relative/unscoped.
 */

type Ctx = 'scope' | 'keyframes' | 'raw';

// At-rules whose block contains style rules whose selectors must be scoped.
const CONDITIONAL_GROUP = new Set(['media', 'supports', 'container', 'layer', 'document', 'scope']);
// At-rules whose block contains keyframe selectors (from/to/%) — never scoped.
const KEYFRAMES = new Set(['keyframes', '-webkit-keyframes', '-moz-keyframes', '-o-keyframes']);

/** Index just past a `'…'`/`"…"` string literal starting at `start`. */
function scanQuoted(css: string, start: number): number {
  const quote = css[start];
  let i = start + 1;
  while (i < css.length) {
    const c = css[i];
    if (c === '\\') { i += 2; continue; }
    if (c === quote) return i + 1;
    i++;
  }
  return css.length;
}

/** Peel index i past leading whitespace + comments; returns [trivia, rest]. */
function scanTrivia(s: string, from: number): number {
  let i = from;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') { i++; continue; }
    if (c === '/' && s[i + 1] === '*') {
      const e = s.indexOf('*/', i + 2);
      i = e === -1 ? s.length : e + 2;
      continue;
    }
    break;
  }
  return i;
}

/** Split leading whitespace + comments off a prelude so the scope prefix lands
 *  on the real selector rather than in front of a leading comment. */
function peelLeadingTrivia(s: string): [string, string] {
  const i = scanTrivia(s, 0);
  return [s.slice(0, i), s.slice(i)];
}

/** Lower-cased at-rule keyword of a prelude, or null. */
function atName(prelude: string): string | null {
  const m = /^@(-?[a-z][\w-]*)/i.exec(prelude.trim());
  return m?.[1]?.toLowerCase() ?? null;
}

/**
 * Split a selector-list prelude on TOP-LEVEL commas only — bracket-, string-,
 * and comment-aware. A comma inside `:is()`/`:where()`/`:not()`/`:nth-child(… of …)`,
 * inside an `[attr="a,b"]` value, or inside a `/* … *​/` comment is NOT a list
 * separator, so it must not trigger a split (and thus a spurious scope prefix).
 * Returns raw (untrimmed) segments; the caller trims and filters empties.
 */
function splitSelectorList(selectors: string): string[] {
  const parts: string[] = [];
  let depth = 0;                    // ()/[] nesting depth
  let start = 0;
  let i = 0;
  const n = selectors.length;
  while (i < n) {
    const c = selectors[i];
    if (c === '/' && selectors[i + 1] === '*') {         // comment — skip whole
      const e = selectors.indexOf('*/', i + 2);
      i = e === -1 ? n : e + 2;
      continue;
    }
    if (c === '"' || c === "'") { i = scanQuoted(selectors, i); continue; }
    if (c === '(' || c === '[') { depth++; i++; continue; }
    if (c === ')' || c === ']') { if (depth > 0) depth--; i++; continue; } // clamp: no underflow on malformed input
    if (c === ',' && depth === 0) { parts.push(selectors.slice(start, i)); start = i + 1; i++; continue; }
    i++;
  }
  parts.push(selectors.slice(start));
  return parts;
}

/** Prefix every top-level comma-separated selector in a list with the scope. */
function scopeSelectorList(selectors: string, scope: string): string {
  return splitSelectorList(selectors)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `${scope} ${s}`)
    .join(', ');
}

export function scopeCss(css: string, scope: string): string {
  if (!css) return '';
  const stack: Ctx[] = ['scope'];
  const ctx = (): Ctx => stack[stack.length - 1]!;
  let out = '';
  let buf = '';
  let i = 0;
  const n = css.length;

  while (i < n) {
    const c = css[i];

    if (c === '/' && css[i + 1] === '*') {              // comment — copy verbatim
      const end = css.indexOf('*/', i + 2);
      const j = end === -1 ? n : end + 2;
      buf += css.slice(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {                        // string — copy verbatim
      const j = scanQuoted(css, i);
      buf += css.slice(i, j);
      i = j;
      continue;
    }
    if (c === '{') {                                     // block open: `buf` is the prelude
      const prelude = buf;
      buf = '';
      const trimmed = prelude.trim();
      if (trimmed.startsWith('@')) {
        const name = atName(trimmed);
        out += prelude + '{';
        stack.push(
          // A conditional group scopes its children ONLY when it is itself at
          // scope level. Nested inside a style rule (native CSS nesting, ctx
          // 'raw'), its children are relative to the parent rule and must stay
          // unscoped — otherwise `.card{@media …{.title{…}}}` would desugar to
          // `#c .card #c .title`, matching nothing.
          name && CONDITIONAL_GROUP.has(name) ? (ctx() === 'scope' ? 'scope' : 'raw')
          : name && KEYFRAMES.has(name) ? 'keyframes'
          : 'raw',                                       // @font-face/@page/… body
        );
      } else if (ctx() === 'scope' && trimmed) {         // a real style-rule selector list
        const [lead, rest] = peelLeadingTrivia(prelude);
        out += lead + scopeSelectorList(rest, scope) + ' {';
        stack.push('raw');                               // its body is declarations
      } else {                                           // keyframe stop, or nested (relative) rule
        out += prelude + '{';
        stack.push('raw');
      }
      i++;
      continue;
    }
    if (c === '}') {                                     // block close
      out += buf + '}';
      buf = '';
      if (stack.length > 1) stack.pop();
      i++;
      continue;
    }
    if (c === ';' && ctx() !== 'raw') {                  // at-statement terminator (not a declaration)
      out += buf + ';';
      buf = '';
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  return out + buf;
}
