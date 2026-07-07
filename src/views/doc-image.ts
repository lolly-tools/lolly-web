// doc-image.ts — makes images MANAGEABLE in Doc Studio's TipTap editor.
//
// Two pieces, kept in their own module so they don't fight doc-editor.ts's live edits:
//   • DocImage — the Image node extended with `width` (% of the column) and `align`
//     (left / center / right) attributes, so an image can be resized and floated.
//   • mountImageToolbar — a floating toolbar shown whenever a single image is selected:
//     align · width presets · replace (re-pick via host) · delete. Positioned over the
//     image, reflows on scroll/selection. The hook (tools/doc-studio/hooks.js) renders the
//     same width/align so the export matches.
import { Image } from '@tiptap/extension-image';
import { NodeSelection } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/core';

export const DocImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).style.width || (el as HTMLElement).getAttribute('width') || null,
        renderHTML: (attrs) => (attrs.width ? { style: `width:${attrs.width as string}` } : {}),
      },
      align: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-align'),
        renderHTML: (attrs) => (attrs.align ? { 'data-align': attrs.align as string } : {}),
      },
    };
  },
});

interface ImageToolbarOpts {
  editor: Editor;
  stageEl: HTMLElement;
  host: { assets?: { pick?: (o: unknown) => Promise<{ url?: string } | null> } };
  editTool?: (url: string, mode?: string) => void;
  cleanups: (() => void)[];
}

const ICON = {
  alignL: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="14" y2="12"/><line x1="4" y1="17" x2="18" y2="17"/></svg>',
  alignC: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="5" y1="17" x2="19" y2="17"/></svg>',
  alignR: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="6" y1="17" x2="20" y2="17"/></svg>',
  replace: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>',
};

export function mountImageToolbar(opts: ImageToolbarOpts): void {
  const { editor, stageEl, cleanups } = opts;
  const doc = document;
  const bar = doc.createElement('div');
  bar.className = 'doc-ribbon doc-imgbar';
  bar.setAttribute('data-export-hide', '');
  bar.style.display = 'none';

  const btn = (html: string, title: string, onClick: () => void): HTMLButtonElement => {
    const b = doc.createElement('button');
    b.type = 'button'; b.className = 'fc-cbtn'; b.innerHTML = html; b.title = title; b.setAttribute('aria-label', title);
    b.addEventListener('pointerdown', (e) => e.preventDefault());   // keep the node selected
    b.addEventListener('click', onClick);
    return b;
  };
  const label = (text: string): HTMLElement => { const s = doc.createElement('span'); s.className = 'doc-imgbar-lbl'; s.textContent = text; return s; };

  const setAttr = (attrs: Record<string, unknown>): void => { editor.chain().focus().updateAttributes('image', attrs).run(); };

  const bAL = btn(ICON.alignL, 'Align left (wrap text)', () => setAttr({ align: 'left' }));
  const bAC = btn(ICON.alignC, 'Centre', () => setAttr({ align: 'center' }));
  const bAR = btn(ICON.alignR, 'Align right (wrap text)', () => setAttr({ align: 'right' }));
  const bS = btn('S', 'Small (30%)', () => setAttr({ width: '30%' }));
  const bM = btn('M', 'Medium (60%)', () => setAttr({ width: '60%' }));
  const bF = btn('L', 'Full width', () => setAttr({ width: '100%' }));
  const bReplace = btn(ICON.replace, 'Replace image', async () => {
    const pick = opts.host.assets?.pick;
    if (!pick) return;
    const ref = await pick({ title: 'Replace image', type: 'image', allowUpload: true, editTool: opts.editTool }).catch(() => null);
    if (ref?.url) setAttr({ src: ref.url });
  });
  const bDel = btn(ICON.trash, 'Delete image', () => editor.chain().focus().deleteSelection().run());

  const sep = (): HTMLElement => { const s = doc.createElement('span'); s.className = 'fc-sep-v'; return s; };
  bar.append(bAL, bAC, bAR, sep(), label('Size'), bS, bM, bF, sep(), bReplace, bDel);
  stageEl.appendChild(bar);
  cleanups.push(() => bar.remove());

  const selectedImage = (): NodeSelection | null => {
    const s = editor.state.selection as NodeSelection;
    return (s instanceof NodeSelection && s.node?.type.name === 'image') ? s : null;
  };
  const imgEl = (sel: NodeSelection): HTMLElement | null => {
    const dom = editor.view.nodeDOM(sel.from) as HTMLElement | null;
    if (!dom) return null;
    return dom.tagName === 'IMG' ? dom : (dom.querySelector?.('img') as HTMLElement | null);
  };

  const setOn = (b: HTMLElement, v: boolean): void => { b.classList.toggle('is-on', v); };
  const update = (): void => {
    const sel = selectedImage();
    const img = sel ? imgEl(sel) : null;
    if (!sel || !img) { bar.style.display = 'none'; return; }
    const r = img.getBoundingClientRect();
    const sr = stageEl.getBoundingClientRect();
    bar.style.display = '';
    bar.style.left = Math.round(r.left - sr.left + r.width / 2) + 'px';
    bar.style.top = Math.round(r.top - sr.top - 46) + 'px';
    const a = (sel.node.attrs || {}) as { align?: string; width?: string };
    setOn(bAL, a.align === 'left'); setOn(bAC, a.align === 'center' || !a.align); setOn(bAR, a.align === 'right');
    setOn(bS, a.width === '30%'); setOn(bM, a.width === '60%'); setOn(bF, a.width === '100%' || !a.width);
  };

  editor.on('selectionUpdate', update);
  editor.on('transaction', update);
  const surface = stageEl.querySelector('.doc-tt-surface');
  if (surface) surface.addEventListener('scroll', update, { passive: true });
  cleanups.push(() => {
    editor.off('selectionUpdate', update);
    editor.off('transaction', update);
    surface?.removeEventListener('scroll', update);
  });
}
