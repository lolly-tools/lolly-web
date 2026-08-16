// SPDX-License-Identifier: MPL-2.0
/**
 * Lower a rendered document DOM node into the flat heading/paragraph block model the
 * engine's `writeDocx` / `writeOdt` writers consume. The bridge only ever receives
 * the RENDERED node (a tool's ProseMirror JSON and its `mdSource` extra never cross
 * to the host), so the block model is read back off the DOM - exactly as `mdBlockDom`
 * does for Markdown export.
 *
 * doc-studio splits its content across `.doc-page > .doc-body`; walking every
 * `.doc-body`'s children in document order reconstructs the flow while dropping the
 * running header/footer chrome (`.doc-footer-*`), which lives outside `.doc-body`.
 *
 * Lossy BY DESIGN: the writers support headings + plain paragraphs only, so lists
 * flatten to one paragraph per item and inline marks (bold/italic/links/colour),
 * tables-as-structure, and images are dropped (`textContent` keeps only the words).
 * Keep any UI/register copy honest - "headings and paragraphs stay editable", never
 * "full fidelity".
 */

/** One block in the engine writers' `{ blocks }` model. */
export interface DocBlock {
  type: 'heading' | 'paragraph';
  /** Heading outline level 1-6; omitted for paragraphs. */
  level?: number;
  text: string;
}

const clean = (s: string | null): string => (s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Extract ordered heading/paragraph blocks from a rendered document node, plus a
 * `title` seeded from the first heading (used by `writeOdt`'s `dc:title`). Empty
 * blocks are dropped. If the node has no `.doc-body` (a non-doc-studio document),
 * falls back to walking the node's own block-level children.
 */
export function domToDocBlocks(root: Element): { title?: string; blocks: DocBlock[] } {
  const blocks: DocBlock[] = [];
  const bodies = root.querySelectorAll('.doc-body');
  const scopes = bodies.length ? Array.from(bodies) : [root];

  for (const scope of scopes) {
    for (const el of Array.from(scope.children)) {
      const tag = el.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        blocks.push({ type: 'heading', level: Number(tag[1]), text: clean(el.textContent) });
      } else if (tag === 'ul' || tag === 'ol') {
        // Flatten each list item to its own paragraph (the writers have no list model).
        for (const li of el.querySelectorAll(':scope > li')) {
          blocks.push({ type: 'paragraph', text: clean(li.textContent) });
        }
      } else {
        // p / blockquote / pre / table cells → a flat paragraph. hr / figure / img
        // carry no text and fall away via the empty-text filter below.
        blocks.push({ type: 'paragraph', text: clean(el.textContent) });
      }
    }
  }

  const kept = blocks.filter((b) => b.text.length > 0);
  const title = kept.find((b) => b.type === 'heading')?.text;
  return { title, blocks: kept };
}
