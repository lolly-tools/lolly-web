// SPDX-License-Identifier: MPL-2.0
/**
 * Capabilities content — a human-readable map of what Lolly can actually do,
 * as data. Extracted from the old Capabilities view so the merged Dashboard
 * (#/d) can render it with progressive disclosure. Content here is descriptive
 * prose about settled capabilities; kept in step with docs/exporting.md,
 * docs/using.md and the export bridge. `desc` strings may carry safe inline
 * <code>/<strong>/<a> (authored here, not user input).
 *
 * THE RULE FOR THIS FILE: every line states something checkable. A format id, a
 * parameter name, a key, a count, an algorithm, a file it lives in. Where a
 * capability has a limit or is not available yet, the limit is written down
 * rather than left out — an omission reads as a claim. Adjectives that can't be
 * verified ("powerful", "seamless") do not belong here; a reader who disagrees
 * with a line should be able to open the app or the repo and settle it.
 *
 * The numbers cited (30 format ids, 29 reserved params, HostV1 1.92) are read
 * from: schemas/tool.schema.json `formats` enum, engine/src/url-mode.ts
 * RESERVED, engine/src/version.ts. Re-check them when those change.
 *
 * HIERARCHY (2026-07-31 rework): sections run in the order a person actually
 * asks the questions — what can I make, what comes out, what can I bring in,
 * will it print, where does my work live, where does it run, can I drive it
 * from code, is it the same every time, does it stay on brand, who can see it,
 * and finally how it is built. The old "Experiences" section was three
 * different questions in one 13-card pile (editing + sharing + batch + backup);
 * it is now split into "Making things" and "Your work: save, organise, share".
 * Automation and Determinism were near-duplicates around URL mode and are one
 * section. Every card carries `keywords` — untranslated search fodder (format
 * ids, synonyms, the words people type) so the Capabilities search finds a card
 * by "cmyk" or "figma" even when the visible copy words it differently.
 */

// Small, monochrome line icons (inherit the heading colour via currentColor).
const I = (p: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;

const ICONS = {
  edit:      I('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  mobile:    I('<rect x="7" y="2" width="10" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/>'),
  install:   I('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8"/><path d="M8 12l4 4 4-4"/>'),
  link:      I('<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>'),
  save:      I('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>'),
  grid:      I('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
  extension: I('<path d="M4 7h4V5a2 2 0 1 1 4 0v2h4v4h2a2 2 0 1 1 0 4h-2v4H4z"/>'),
  transfer:  I('<path d="M4 7h13M13 3l4 4-4 4"/><path d="M20 17H7M11 21l-4-4 4-4"/>'),
  globe:     I('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18"/>'),
  desktop:   I('<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>'),
  phone:     I('<rect x="6" y="2" width="12" height="20" rx="2"/><line x1="10" y1="18" x2="14" y2="18"/>'),
  terminal:  I('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m6 9 3 3-3 3M13 15h4"/>'),
  tui:       I('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M8 4v16"/><path d="M4 8h2M4 11h2M4 14h2"/><path d="m12 10 2 2-2 2"/>'),
  layers:    I('<path d="m12 2 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>'),
  vector:    I('<rect x="2" y="2" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M8 5h7a4 4 0 0 1 4 4v7"/>'),
  image:     I('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>'),
  printer:   I('<path d="M6 9V2h12v7"/><rect x="6" y="13" width="12" height="8"/><path d="M6 17H4a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-2"/>'),
  film:      I('<rect x="2" y="3" width="20" height="18" rx="2"/><path d="M7 3v18M17 3v18M2 9h5M2 15h5M17 9h5M17 15h5"/>'),
  doc:       I('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>'),
  zip:       I('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M12 7v2M12 11v2M12 15v3"/>'),
  ruler:     I('<path d="M3 17 17 3l4 4L7 21z"/><path d="M7 11l2 2M11 7l2 2M15 11l2 2"/>'),
  swatch:    I('<rect x="3" y="3" width="7" height="18" rx="1"/><path d="M10 14 17 7l4 4-9 9H10z"/>'),
  marks:     I('<path d="M9 3v6H3M21 9h-6V3M3 15h6v6M15 21v-6h6"/>'),
  stamp:     I('<path d="M5 21h14"/><path d="M9 12a3 3 0 0 1-3-3 3 3 0 0 1 6 0 3 3 0 0 1-3 3z"/><path d="M9 12v3h6v-3"/>'),
  lock:      I('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  repeat:    I('<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'),
  url:       I('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18"/>'),
  bot:       I('<rect x="4" y="8" width="16" height="11" rx="2"/><path d="M12 8V4M9 13h.01M15 13h.01M9 16h6"/>'),
  shield:    I('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
  device:    I('<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8M12 18v3"/><path d="M7 9h6"/>'),
  brush:     I('<path d="M3 21c3 0 4-3 4-3a3 3 0 1 0-4-4s-3 1-3 4a3 3 0 0 0 3 3z"/><path d="M11 13 19 5a2.8 2.8 0 0 0-4-4l-8 8"/>'),
  font:      I('<path d="M4 7V5h16v2M9 19h6M12 5v14"/>'),
  user:      I('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  tag:       I('<path d="M20.6 13.4 12 22l-9-9V3h10z"/><circle cx="7.5" cy="7.5" r="1.5"/>'),
  cube:      I('<path d="m12 2 9 5v10l-9 5-9-5V7z"/><path d="m12 12 9-5M12 12v10M12 12 3 7"/>'),
  bridge:    I('<path d="M3 18v-5a9 9 0 0 1 18 0v5M3 13h18M8 13v5M16 13v5M12 13v5"/>'),
  sync:      I('<path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>'),
  id:        I('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M14 9h4M14 13h4M6 16h6"/>'),
  open:      I('<path d="M7 11V7a5 5 0 0 1 10 0M4 11h16v9H4z"/>'),
  canvas:    I('<path d="m4 4 7 17 2.5-6.5L20 12z"/>'),
  camera:    I('<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>'),
  batchcube: I('<path d="m12 2 9 5v10l-9 5-9-5V7z"/><path d="m3 7 9 5 9-5M12 12v10"/><path d="m9.5 15 2 1.5 3.5-3"/>'),
  mcp:       I('<path d="M9 2v5M15 2v5"/><path d="M6 7h12v4a6 6 0 0 1-12 0z"/><path d="M12 17v5"/>'),
  credential:I('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>'),
  circles:   I('<circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/>'),
} as const;

/** One named feature line within a card. */
export interface CapFeature {
  name: string;
  desc: string;
}
/** One feature-group card: an icon, a title, and its stacked list of features. */
export interface CapCard {
  icon: string;
  title: string;
  features: CapFeature[];
  /**
   * Extra search terms for this card — NOT rendered and NOT translated.
   * The visible copy is already indexed by the Capabilities search; this is for
   * the words a person types that the copy doesn't literally use (format ids,
   * competitor/app names, spelling variants, the thing they call it at work).
   */
  keywords?: string;
}
/** One section of the capabilities map (a labelled group of cards). */
export interface CapSection {
  flag: string;
  id: string;
  title: string;
  /** One representative glyph for the whole sub-section (the big banner icon). */
  icon: string;
  desc: string;
  cards: CapCard[];
}

// Each section becomes a labelled group in the Dashboard's Capabilities panel;
// `flag` is the deep-link key (e.g. #/d?print force-opens the panel and jumps).
export const CAPABILITY_SECTIONS: CapSection[] = [
  {
    flag: 'making editing', id: 'cap-making', title: 'Making things', icon: ICONS.edit,
    desc: 'The surfaces you work on. All of them drive the same engine and the same render path, so the preview on screen is the file that comes out — there is no separate render step to be surprised by.',
    cards: [
      { icon: ICONS.edit, title: 'Tool editing', keywords: 'editor sidebar preview wysiwyg zoom pan shortcuts keyboard dark mode', features: [
        { name: 'Controls left, canvas right', desc: 'Change any input and the canvas re-renders on the spot — no “generate” button, no queue.' },
        { name: 'The preview is the file', desc: 'The canvas is rendered by the same engine that writes the export, from the same inputs. What you are looking at is what the file will contain.' },
        { name: 'Zoom & pan', desc: 'Cmd/Ctrl-scroll or pinch to zoom; <code>Space</code>-drag or middle-drag to pan; <code>0</code> fits the canvas, <code>1</code> sets 100%.' },
        { name: 'Light & dark canvas', desc: 'Tools that declare it read your device’s light/dark preference and adapt the canvas. Tools that don’t declare it render one fixed way, on purpose — a printed piece has no dark mode.' },
      ] },
      { icon: ICONS.canvas, title: 'Free-canvas layout', keywords: 'layout studio drag resize rotate snap guides text box shapes design', features: [
        { name: 'Direct manipulation', desc: 'Some tools open as a chromeless free canvas (<strong>Layout Studio</strong>): drag, resize and rotate boxes of text, shapes and images, with guides that snap to edges and centres.' },
        { name: 'Edit in place', desc: 'Double-click a text box to type; fills and images come from the same shared pickers as every other tool.' },
        { name: 'Still one render path', desc: 'A free canvas exports through the identical engine path as a template-driven tool — so the canvas <em>is</em> the file, and every export format below applies to it unchanged.' },
      ] },
      { icon: ICONS.doc, title: 'Documents & decks', keywords: 'multi page pdf pagination deck slides presentation pptx doc editor', features: [
        { name: 'Pages that flow', desc: 'Text and image blocks flow onto as many pages as they need, with a manual page break where you want one. Each page is a true, separately-sized PDF page — A4, US Letter or A5, portrait or landscape. See the <strong>Multi-Page PDF</strong> tool.' },
        { name: 'Editable hand-off', desc: 'A deck exports to PPTX as native text boxes, real shapes and extractable images — not slides of flat screenshots. See <strong>Export formats → Documents &amp; data</strong>.' },
      ] },
      { icon: ICONS.camera, title: 'Live camera', keywords: 'webcam video motion filter halftone duotone posterize snapshot photo', features: [
        { name: 'Motion-reactive filters', desc: 'Hit “Go live” on a photo filter — halftone, scanline, posterize, duotone or pixel-stretch — and it tracks your webcam frame by frame, so the effect responds to movement.' },
        { name: 'Frames never leave the device', desc: 'The shell reads frames locally and hands the tool plain RGBA pixels; nothing is uploaded, and the camera is released the moment you stop or leave the tool.' },
        { name: 'Or just a snapshot', desc: '“Take a photo” in any image picker grabs a single frame straight into your local image library — no upload, no camera roll.' },
      ] },
      { icon: ICONS.mobile, title: 'On a phone', keywords: 'mobile touch sheet gestures pinch tablet ipad android', features: [
        { name: 'Controls sheet', desc: 'Inputs become a sheet with a drag grip that snaps to peek / half / full, so the preview stays visible while you edit.' },
        { name: 'Render sheet', desc: 'A floating Render button opens every format, size, copy, save and share control, sized for touch.' },
        { name: 'Touch canvas', desc: 'Pinch to zoom, drag to pan, double-tap to fit.' },
      ] },
      { icon: ICONS.install, title: 'Install & full-screen', keywords: 'pwa offline home screen app install fullscreen kiosk deep link', features: [
        { name: 'Installable PWA', desc: 'Install from the address bar or add to your home screen for a full-screen app; it updates itself when online and keeps working when you are not.' },
        { name: 'Open in a set mode', desc: '<code>full</code> opens fullscreen with the sidebar collapsed; <code>options</code> opens with the export panel already expanded.' },
      ] },
    ],
  },
  {
    flag: 'formats export', id: 'cap-formats', title: 'Export formats', icon: ICONS.image,
    desc: '30 format ids across vector, raster, print, motion, documents and data (jpg and jpeg are one encoder under two names). A tool offers only the formats its manifest declares, and the picker hides any this browser cannot encode — so the list you see is the list that will actually write a file.',
    cards: [
      { icon: ICONS.vector, title: 'Vector', keywords: 'svg eps emf dxf illustrator postscript outlines paths cut file laser cnc plotter', features: [
        { name: 'SVG', desc: 'Scalable and self-contained. Text runs are shaped with HarfBuzz and written as real <code>&lt;path&gt;</code> outlines, so the file renders identically on a machine that has never had the font. A run with no resolvable font file falls back to a live <code>&lt;text&gt;</code> element rather than silently dropping.' },
        { name: 'EMF · EPS · EPS (CMYK)', desc: 'EMF pastes into PowerPoint and Word as editable vector; EPS is PostScript vector for Illustrator and press workflows, with a DeviceCMYK variant. Text is outlined to paths in all three.' },
        { name: 'DXF (cut file)', desc: 'AutoCAD R12 interchange for laser cutters, vinyl plotters and CNC/CAD: outline paths in millimetres, colour mapped to the nearest AutoCAD Color Index. Line-art only — no fills, gradients or images.' },
      ] },
      { icon: ICONS.image, title: 'Raster', keywords: 'png jpg jpeg webp avif ico bitmap dpi icc srgb transparent alpha hdr', features: [
        { name: 'PNG · JPG · WebP · AVIF · ICO', desc: 'Alpha where the format supports it, the real DPI written into the file (PNG carries a <code>pHYs</code> chunk), and an embedded sRGB ICC profile so colour reproduces rather than drifts.' },
        { name: 'HDR (Rec.2100 PQ)', desc: '<code>hdr</code> is available on PNG, JPG, AVIF and TIFF. HDR PNG is written as a genuine 16-bit IDAT; HDR JPG is an ordinary SDR JPEG with the HDR rendition appended as an ISO 21496-1 gain map. WebP is deliberately excluded — it has no working HDR decode path, so a PQ WebP would just look dark.' },
      ] },
      { icon: ICONS.printer, title: 'Print', keywords: 'pdf cmyk tiff press prepress fogra swop bleed', features: [
        { name: 'PDF · Print PDF (CMYK) · Print TIFF (CMYK)', desc: 'True page sizes and DeviceCMYK separations. Print TIFF needs desktop-class canvas readback and is hidden where it cannot be produced. Full detail in <strong>Print production</strong> below.' },
      ] },
      { icon: ICONS.film, title: 'Motion', keywords: 'mp4 webm gif apng animated webp video animation loop svg keyframes fps', features: [
        { name: 'MP4 · WebM', desc: 'Animated tools record to video; the picker shows only the containers this browser can actually encode, so MP4 and WebM appear independently rather than as a promise.' },
        { name: 'GIF · aPNG · Animated WebP', desc: 'Codec-free animation that plays anywhere: GIF, lossless animated PNG, and animated WebP with colour plus alpha.' },
        { name: 'Animated SVG', desc: 'A self-contained vector animation — vector snapshots stacked with embedded CSS keyframes. No codec, scales to any size, and loops in a browser tab or an <code>&lt;img&gt;</code>.' },
      ] },
      { icon: ICONS.doc, title: 'Documents & data', keywords: 'pptx powerpoint keynote html markdown md txt json csv ics calendar vcf contact vcard', features: [
        { name: 'PowerPoint (PPTX)', desc: 'Multi-page and layout tools export an editable deck: each page decomposed into native text boxes, real shapes, and extractable images and vectors (logos embedded as real SVG). Built so a colleague gets content they can edit, not a flat screenshot.' },
        { name: 'HTML · MD · TXT', desc: 'HTML pastes formatted into mail clients; Markdown and plain text for content pipelines.' },
        { name: 'JSON · CSV · ICS · VCF', desc: 'Written straight from the input model, so the data file and the picture agree by construction — calendar invites, contacts, tables and machine-readable payloads.' },
      ] },
      { icon: ICONS.zip, title: 'Bundles', keywords: 'zip archive multiple formats password encrypt download', features: [
        { name: 'ZIP', desc: 'Several formats of one design in a single download, optionally password-locked (ZipCrypto or AES-256), with any PDF inside individually locked too. Visual formats only — data and video are not bundled.' },
      ] },
      { icon: ICONS.layers, title: 'Deep pixels (float)', keywords: 'exr openexr radiance hdr rgbe float 32 bit vfx compositing nuke depth', features: [
        { name: 'OpenEXR · Radiance HDR', desc: 'Float interchange for compositing and VFX. The engine has both writers; they are fed by a float rasterisation only the Node/CLI shell can supply today, so on the web they never enter the picker — you will see them from the CLI, not from this browser.' },
        { name: 'Bit depth is stated, not chosen', desc: 'Where the pipeline writes 16 bits the export panel says so rather than offering a control over a decision that has already been made. The one honest opt-out is the other direction — <code>?depth=8</code>, to keep a file small.' },
      ] },
    ],
  },
  {
    flag: 'import', id: 'cap-import', title: 'Import formats', icon: ICONS.install,
    desc: 'What you can bring in. Every file is parsed on your device and none of them are uploaded: design files open as an editable layout, images join your local library, tables fill a tool’s repeating blocks.',
    cards: [
      { icon: ICONS.image, title: 'Images', keywords: 'png jpg jpeg webp avif heic heif iphone photo exif gps strip gif apng animated svg sanitise', features: [
        { name: 'PNG · JPG · WebP · AVIF · HEIC/HEIF', desc: 'Drop a photo into any image picker or your <strong>My images</strong> library. Stills are downscaled and stripped of EXIF/GPS on ingest; iPhone HEIC/HEIF decodes through a bundled fallback even where the browser cannot. AVIF reads wherever the browser decodes it.' },
        { name: 'Animated GIF · aPNG · animated WebP', desc: 'Recognised and kept <em>verbatim</em>, frames intact — a looping GIF stays a looping GIF when you place it, rather than collapsing to its first frame.' },
        { name: 'SVG', desc: 'Sanitised on the way in — scripts, <code>on*</code> handlers and <code>javascript:</code> URLs are stripped — then normalised to a clean viewBox before it is stored.' },
      ] },
      { icon: ICONS.vector, title: 'Design files', keywords: 'figma fig penpot illustrator ai indesign idml pdf sketch import layout editable', features: [
        { name: 'Figma · Penpot · Illustrator · InDesign · PDF', desc: 'Layout Studio parses a native Figma <code>.fig</code>, a Penpot export, an Illustrator <code>.ai</code>, an InDesign <code>.idml</code> or any <code>.pdf</code> in the browser into editable boxes. Text stays text, shapes stay shapes, and art too complex to decompose flattens faithfully rather than disappearing.' },
        { name: 'Any SVG is the wide door', desc: 'Nearly every design app exports SVG, and an SVG becomes an editable, brand-conformed layout. If your app is not named above, this is the route in.' },
      ] },
      { icon: ICONS.doc, title: 'Data & animation', keywords: 'csv json table rows paste spreadsheet lottie bodymovin dotlottie', features: [
        { name: 'CSV · JSON', desc: 'Paste or drop a table and a tool’s repeating blocks fill from it — RFC 4180 CSV (quoted fields, embedded newlines) or JSON rows/arrays, up to a thousand rows.' },
        { name: 'Lottie (.json · .lottie)', desc: 'Bodymovin JSON and dotLottie animations are validated and placed as live vector animations.' },
      ] },
      { icon: ICONS.film, title: 'Video', keywords: 'mp4 mov webm footage clip verbatim transcode', features: [
        { name: 'MP4 · MOV · WebM', desc: 'Stored <em>verbatim</em> — never transcoded — with dimensions probed locally, ready to place in motion tools.' },
      ] },
      { icon: ICONS.credential, title: 'Content Credentials (read)', keywords: 'c2pa verify provenance manifest signature authenticity cai check', features: [
        { name: 'Verify provenance in any file', desc: 'Verify checks a signed <a href="https://c2pa.org" target="_blank" rel="noopener">C2PA</a> manifest in PDF, PNG/aPNG, JPG, GIF, SVG, TIFF, WebP, MP4 and WebM/MKV — cryptographically, entirely on-device, on files Lolly did not make. See <a href="#/verify">Verify</a>.' },
      ] },
    ],
  },
  {
    flag: 'print', id: 'cap-print', title: 'Print production', icon: ICONS.printer,
    desc: 'Press-ready output computed on your device. The engine owns the dimension and colour maths and each shell draws it, so a CLI-rendered press file and a browser-rendered one are the same file. No print service, nothing uploaded.',
    cards: [
      { icon: ICONS.ruler, title: 'Physical sizing', keywords: 'mm cm inch points picas dpi resolution 300 size dimensions bleed page', features: [
        { name: 'Real units & DPI', desc: 'Set width × height in <code>mm</code>, <code>cm</code>, <code>in</code>, <code>pt</code> or <code>pc</code> at a DPI (300 by default). PDF becomes a true page, raster renders the exact pixel count and records the resolution, SVG keeps the physical unit with a px viewBox.' },
        { name: 'One implementation of the maths', desc: 'Unit conversion lives in a single engine module and each shell’s export bridge applies it per format — which is why the CLI and the browser cannot drift on page size.' },
      ] },
      { icon: ICONS.layers, title: 'Multi-page PDF', keywords: 'pages a4 letter a5 portrait landscape cover paginate flow booklet', features: [
        { name: 'Real pages, not one long image', desc: 'A cover, content and a back page, where every page is a true separately-sized PDF page — A4, US Letter or A5, portrait or landscape.' },
        { name: 'Vector & lockable', desc: 'Each page is drawn as vectors with text outlined to paths, and the document can carry a password (basic link-lock or AES-256).' },
        { name: 'Known limit: RGB only', desc: 'Multi-page documents are RGB. Crop and bleed marks and CMYK separation stay on the single-page <em>Print PDF</em> path.' },
      ] },
      { icon: ICONS.swatch, title: 'CMYK colour', keywords: 'cmyk devicecmyk separation ink press conversion brand swatch', features: [
        { name: 'DeviceCMYK output', desc: 'Print PDF, EPS (CMYK) and Print TIFF write CMYK, not RGB — a real separation, not an RGB file with a CMYK label.' },
        { name: 'Exact brand inks', desc: 'A brand swatch with a measured CMYK value is substituted exactly, so the ink is the one the brand specified. Colours without a measured value use a standard device conversion.' },
      ] },
      { icon: ICONS.id, title: 'Press conditions', keywords: 'outputintent fogra39 fogra51 swop icc rip coated uncoated profile', features: [
        { name: 'OutputIntent', desc: 'A CMYK PDF declares its target press condition — Coated FOGRA39 by default, with FOGRA51, SWOP and others available — so a RIP knows how the inks are meant to read. Screen and raster output stay sRGB.' },
      ] },
      { icon: ICONS.marks, title: 'Bleed & marks', keywords: 'crop marks registration trimbox bleedbox trim plate printer', features: [
        { name: 'Trim, bleed & marks', desc: 'Add bleed with declared TrimBox/BleedBox, plus crop, registration and bleed marks in the margin. Registration marks print on every plate, which is what makes them useful.' },
      ] },
      { icon: ICONS.swatch, title: 'Colour bars', keywords: 'colour bar calibration verification strip process control operator', features: [
        { name: 'Calibrate, then verify', desc: 'A solid C/M/Y/K process strip to calibrate against, followed by RGB↔CMYK pairs for the brand inks actually used — so a press operator can confirm the conversion landed rather than take it on trust.' },
      ] },
      { icon: ICONS.stamp, title: 'Proof-margin credits', keywords: 'timestamp made with credit annotation proof margin trimmed', features: [
        { name: 'Trimmed at the final cut', desc: 'An optional timestamp, “Made with…” line and tool/author credit sit in the margin. They are a proof annotation and are cut off in the finished piece.' },
      ] },
      { icon: ICONS.lock, title: 'Lockable press files', keywords: 'password protect pdf encrypt aes open password', features: [
        { name: 'Passwords apply here too', desc: 'Any PDF, Print and CMYK PDFs included, can carry a <strong>Standard</strong> (40-bit, link-embeddable) or <strong>Strong</strong> (AES-256) open-password. Full detail under <strong>Security &amp; access control</strong>.' },
      ] },
    ],
  },
  {
    flag: 'work sessions projects sharing', id: 'cap-work', title: 'Your work: save, organise, share', icon: ICONS.save,
    desc: 'Where what you make lives, and how it gets to other people. All of it is device-local by default — there is no account and no sync server — and every route out is one you trigger.',
    cards: [
      { icon: ICONS.save, title: 'Sessions & projects', keywords: 'save named session continue folders organise nest drag rename projects', features: [
        { name: 'Named sessions', desc: 'Keep as many saved sessions per tool as you like, all device-local; Continue reopens your most recent.' },
        { name: 'Projects & folders', desc: 'Group sessions into folders that nest as deep as you like in the <strong>Projects</strong> view — drag to move, rename, and file a new session straight into a folder as you save it.' },
      ] },
      { icon: ICONS.link, title: 'Share a link', keywords: 'url share permalink short link copy paste bookmark commit query params', features: [
        { name: 'The URL is the design', desc: 'Every input lives in the link. Paste it to a colleague, bookmark it, or commit it to a repo — it is text, so it diffs.' },
        { name: 'Shortest link', desc: 'A large design would make a long URL, so the Share dialog offers a <strong>Shortest link</strong> that packs the whole state into a compact token. The readable long form is always available alongside it.' },
        { name: 'Act on open', desc: 'Append <code>&amp;export</code> to download the file on open, or <code>&amp;copy</code> to arm copy-to-clipboard.' },
        { name: 'Share a saved session', desc: 'Right-click any saved session in Projects for a link that reopens it with exactly those inputs.' },
      ] },
      { icon: ICONS.batchcube, title: 'Render many at once', keywords: 'batch bulk export folder zip multi select marquee all sessions', features: [
        { name: 'A whole project', desc: 'Export every saved session in a folder, recursing sub-folders, as one nested zip that mirrors your folder tree. No Pro mode required.' },
        { name: 'A selection', desc: 'Multi-select tiles (checkbox, marquee drag, or Shift-click) and render the lot in one pass; a single session renders straight to its native file.' },
        { name: 'Everything you have', desc: 'The Storage panel renders <em>every</em> saved session across all tools into one nested zip, produced alongside the profile/data backup — so a single export carries both the editable state and the finished files.' },
      ] },
      { icon: ICONS.grid, title: 'Batch (Pro) mode', keywords: 'grid rows variants languages sizes matrix csv batch pro', features: [
        { name: 'A grid of variants', desc: 'Each row is a set of inputs and the whole grid exports together — a dozen languages, or every size variant, in one pass.' },
      ] },
      { icon: ICONS.transfer, title: 'Move to another device', keywords: 'backup restore export import migrate zip checksum no account offline', features: [
        { name: 'Portable backup', desc: 'One checksummed zip carries your profile, every session and thumbnail, your images and your preferences; import merges it into another install. No account, no cloud, no sync service to depend on.' },
      ] },
      { icon: ICONS.image, title: 'Copy to clipboard', keywords: 'clipboard paste slack email doc copy image', features: [
        { name: 'Straight into a message', desc: 'Paste an image directly into Slack, email or a document. Where the browser blocks clipboard images, it falls back to a download rather than failing silently.' },
      ] },
      { icon: ICONS.extension, title: 'Browser extension', keywords: 'chrome extension capture screenshot page grab', features: [
        { name: 'Capture into a tool', desc: 'Pull a page or a screenshot out of the browser and into a Lolly tool to finish and export it.' },
      ] },
      { icon: ICONS.cube, title: 'A tool as an image URL', keywords: 'embed img src css url background live render hotlink asset', features: [
        { name: 'Just an asset URL', desc: 'A tool render is addressable as an image, so a template can drop it into an <code>&lt;img src&gt;</code> or a CSS <code>url()</code> exactly like a library image — and it re-renders from the link rather than going stale as a copied file would.' },
      ] },
    ],
  },
  {
    flag: 'platforms', id: 'cap-platforms', title: 'Platforms & runtimes', icon: ICONS.layers,
    desc: 'One platform-agnostic engine — currently HostV1 1.92 — behind every surface. The engine has no knowledge of the DOM, storage or networking; each host injects those through a versioned capability bridge, which is the mechanism that stops the GUI and the CLI from diverging.',
    cards: [
      { icon: ICONS.globe, title: 'Web (PWA)', keywords: 'browser chrome safari firefox offline installable service worker', features: [
        { name: 'Installable & offline', desc: 'Fully usable offline after the first load, installs as an app, and updates itself when it next has a connection.' },
      ] },
      { icon: ICONS.desktop, title: 'Desktop', keywords: 'mac macos linux windows tauri native app', features: [
        { name: 'macOS & Linux', desc: 'Native packages built with Tauri, running the same engine with filesystem-backed storage instead of IndexedDB.' },
      ] },
      { icon: ICONS.phone, title: 'Mobile', keywords: 'ios android tauri app store native', features: [
        { name: 'iOS & Android', desc: 'Installable mobile packages via Tauri, with the touch-first UI described under <strong>Making things</strong>.' },
      ] },
      { icon: ICONS.terminal, title: 'Command line', keywords: 'cli headless script ci pipeline stdout node npm', features: [
        { name: 'Headless render', desc: 'Run any tool from the CLI and write to a file or to stdout — same engine, jsdom in place of a browser.' },
        { name: 'The arguments are the URL', desc: '<code>--flag=value</code> arguments parse into the same values the web shell reads from <code>?flag=value</code>, so a link someone sent you runs unchanged on the command line.' },
      ] },
      { icon: ICONS.tui, title: 'Terminal app (TUI)', keywords: 'tui terminal keyboard ssh remote ansi truecolor preview', features: [
        { name: 'Interactive in the shell', desc: '<code>npm run tui</code> opens a keyboard-driven terminal app: browse the gallery, edit any tool’s inputs, and organise saved projects into folders without leaving the shell.' },
        { name: 'Preview inline', desc: 'Press <code>p</code> to render the current design into the terminal as a truecolor half-block image. No window, no browser.' },
      ] },
      { icon: ICONS.layers, title: 'One engine everywhere', keywords: 'parity consistency drift bridge portable same output', features: [
        { name: 'Why there is no drift', desc: 'Web, desktop, mobile, CLI and TUI all call one engine through one bridge. A format is implemented once, so “it looks different on the CLI” is a bug with a single place to fix, not a fact of life.' },
      ] },
    ],
  },
  {
    flag: 'automation determinism ai', id: 'cap-automation', title: 'Automation & reproducibility', icon: ICONS.bot,
    desc: 'Built to be driven by a script, a pipeline or an agent as easily as by a person — and to produce the same bytes when it is. Output here is a build artifact, not a stochastic guess.',
    cards: [
      { icon: ICONS.url, title: 'URL mode', keywords: 'query params link api get request deep link parameters reserved', features: [
        { name: 'Every input is a parameter', desc: 'Inputs are URL parameters by design — this is the contract, not a convenience feature layered on top.' },
        { name: '29 reserved controls', desc: 'Alongside your inputs: <code>format</code>, <code>export</code>, <code>copy</code>, <code>width</code>/<code>w</code>, <code>height</code>/<code>h</code>, <code>unit</code>, <code>dpi</code>, <code>bleed</code>, <code>marks</code>, <code>cuts</code>, <code>c2pa</code>, <code>imprint</code>, <code>durable</code>, <code>hdr</code>, <code>depth</code>, <code>password</code>, <code>profile</code>, <code>slot</code>, <code>output</code>, <code>filename</code>, <code>lang</code>, <code>full</code>, <code>options</code>, <code>nostage</code>, <code>_v</code>, <code>z</code>, <code>zx</code>. Those names are reserved, so a tool input can never shadow one.' },
        { name: 'Compact encoding', desc: 'A tool can opt into short parameter aliases, <code>#</code>-less colours and tilde-delimited arrays, which is what keeps a rich design inside a pasteable link.' },
      ] },
      { icon: ICONS.terminal, title: 'CLI & pipelines', keywords: 'ci cd build script og image social card generate makefile github actions', features: [
        { name: 'Generate at build time', desc: 'Produce OG images, QR codes, social cards and data visuals as a build step, repeatably — instead of committing binaries to Git and hoping someone remembers to regenerate them.' },
      ] },
      { icon: ICONS.mcp, title: 'MCP server (add-on)', keywords: 'model context protocol agent claude ide connector oauth bearer token render', features: [
        { name: 'A native agent endpoint', desc: 'An optional <a href="https://modelcontextprotocol.io" target="_blank" rel="noopener">Model Context Protocol</a> server any MCP client can connect to: discover a tool, fill its declared inputs, get back a finished file plus an editable link. Tools sync as data, so a new tool needs no server or app update.' },
        { name: 'Every format an agent asks for', desc: 'One <code>lolly_render</code> call returns vector, raster, motion, PowerPoint or data. The server decides how to render each; the agent just names a format the tool declares.' },
        { name: 'Known limit: this one is hosted', desc: 'Unlike the rest of Lolly the MCP server is <strong>server-side</strong> — covering the full format range means driving a headless browser against a built web shell — so it is <strong>not suitable for offline or air-gapped deployments</strong>. The on-device shells remain the offline path.' },
        { name: 'Connecting a client', desc: 'Register the endpoint as a custom connector (OAuth 2.1) in any client that supports one, or point an MCP-capable agent or IDE at it with a bearer token. Either way it authenticates before it can render — see <strong>Security &amp; access control</strong>.' },
      ] },
      { icon: ICONS.bot, title: 'Why agents suit this', keywords: 'llm ai prompt tokens deterministic cheap no drift hallucination', features: [
        { name: 'Cheap and deterministic', desc: 'A parameterised URL is a handful of tokens and renders the same press-quality result every time, locally. There is no model in the render path, so there is no prompt drift and no stochastic surprise in production.' },
      ] },
      { icon: ICONS.repeat, title: 'Same inputs, same file', keywords: 'deterministic reproducible byte identical version pin audit diff regression', features: [
        { name: 'One render path', desc: 'Web, mobile, desktop and CLI share the engine; there is exactly one code path from inputs to a file.' },
        { name: 'Pin the version', desc: 'Pin a tool version with <code>_v</code> and a saved link keeps rendering the way it did the day you made it, even after the tool moves on.' },
        { name: 'Auditable by inspection', desc: 'No model, no server and no randomness in the render path, so an output can be reviewed, diffed and version-controlled like any other build artifact.' },
      ] },
    ],
  },
  {
    flag: 'brand', id: 'cap-brand', title: 'Brand & design system', icon: ICONS.swatch,
    desc: 'Design decisions are fixed at the template level and only the inputs meant to vary are exposed. The constraint is the product: whatever anyone makes lands inside the rules the tool author set.',
    cards: [
      { icon: ICONS.brush, title: 'Constraint-first tools', keywords: 'guardrails brand guidelines compliance lock template author', features: [
        { name: 'Guardrails, not guidelines', desc: 'Authors hard-code typography, colour and spacing; users fill in content. A guideline asks people to comply — a tool that only permits on-brand output does not have to.' },
      ] },
      { icon: ICONS.swatch, title: 'Tokens, themes & palette', keywords: 'design tokens dtcg theme palette colour picker cmyk swatch variables', features: [
        { name: 'Defined once, used everywhere', desc: 'Shared design tokens and multiple themes; the brand palette appears in every colour picker, carrying measured CMYK ink values wherever they are known.' },
      ] },
      { icon: ICONS.circles, title: 'Themable icons & backgrounds', keywords: 'icon library recolour two colour background pattern decorative pairing', features: [
        { name: 'Recolour to a brand pairing', desc: 'A library of two-colour icons and decorative backgrounds recolour to a chosen brand pairing in the asset picker. The colour choice rides inside the asset id, so it survives URL mode and re-bakes on every render instead of being flattened once.' },
      ] },
      { icon: ICONS.font, title: 'Type', keywords: 'font variable ttf otf woff google fonts upload family weight local', features: [
        { name: 'Local variable fonts', desc: 'The brand faces ship with the app — no webfont request and no CDN dependency at render time, which is also why export works offline.' },
        { name: 'Bring your own', desc: 'Upload a TTF/OTF/WOFF or pick a Google Font that is fetched once and then kept on-device; family, weight and style are parsed from the file itself. Uploaded faces feed the same text-outlining path, so they export as paths like the bundled ones.' },
      ] },
      { icon: ICONS.user, title: 'Personalisation', keywords: 'profile name email headshot prefill bind opt in signature', features: [
        { name: 'Bind an input to your profile', desc: 'Any input can pre-fill from your saved name, contact details or headshot — opt-in, and overridable per session.' },
      ] },
      { icon: ICONS.tag, title: 'Maturity tags', keywords: 'official community experimental watermark status review approved', features: [
        { name: 'Approved by default', desc: 'Every tool declares official, community or experimental. Experimental tools watermark their exports — applied by the host at export time, so it cannot be edited out of the tool.' },
      ] },
    ],
  },
  {
    flag: 'privacy', id: 'cap-privacy', title: 'Privacy & data ownership', icon: ICONS.shield,
    desc: 'Rendering, storage and export never require a server, so creative production stays on the device by default. The two optional hosted add-ons are named explicitly rather than folded into the claim.',
    cards: [
      { icon: ICONS.shield, title: 'On-device by default', keywords: 'no cloud local analytics telemetry tracking server private', features: [
        { name: 'No cloud rendering, no telemetry', desc: 'Rendering happens locally and there is no analytics or telemetry collection. What you create is on your machine.' },
      ] },
      { icon: ICONS.device, title: 'Local storage', keywords: 'indexeddb browser database quota clear storage usage sessions', features: [
        { name: 'Your browser’s database', desc: 'Profile, saved sessions, uploaded images and the catalogue cache live in IndexedDB (the filesystem on desktop). The Storage panel shows what is stored, how much space it takes, and clears it.' },
      ] },
      { icon: ICONS.image, title: 'Image hygiene', keywords: 'exif gps metadata strip downscale my images library location', features: [
        { name: 'Stripped on the way in', desc: 'Images you add are downscaled and stripped of EXIF/GPS before they are stored in your local library — so a photo you place cannot leak the location it was taken.' },
      ] },
      { icon: ICONS.shield, title: 'On-device utilities', keywords: 'strip hidden data metadata remove clean pdf jpeg png svg transform file', features: [
        { name: 'File in, clean file out', desc: 'Transform utilities take a file you supply, process it entirely on your device and hand back a cleaned copy — never uploaded, never watermarked. <strong>Strip Hidden Data</strong> removes EXIF/GPS, camera, author and editor metadata from JPEG, PNG, SVG and PDF. This is the replacement for pasting a confidential file into a single-purpose website.' },
      ] },
      { icon: ICONS.credential, title: 'Content Credentials (write)', keywords: 'c2pa cai provenance sign manifest tamper evident authorship', features: [
        { name: 'Signed on your device', desc: 'Exports can carry a signed <a href="https://c2pa.org" target="_blank" rel="noopener">C2PA</a> manifest — the <a href="https://contentauthenticity.org" target="_blank" rel="noopener">Content Authenticity Initiative</a> standard — created locally, so a file can prove what made it with no cloud signing service in the loop. PDF, PNG, JPG, GIF, SVG, TIFF, WebP, MP4 and WebM all take the credential, recording the tool, the author (profile opt-in) and the export.' },
      ] },
      { icon: ICONS.lock, title: 'Self-host & air-gap', keywords: 'firewall on premise intranet offline deploy static no backend', features: [
        { name: 'There is no render backend to run', desc: 'The shells render, export and store on-device: no server-side render pipeline, no database. Deploy the static shell on your own infrastructure and run entirely behind your firewall. The two hosted add-ons — the MCP endpoint and identity enrolment — are separate opt-ins you can simply not deploy.' },
      ] },
    ],
  },
  {
    flag: 'security encryption', id: 'cap-security', title: 'Security & access control', icon: ICONS.lock,
    desc: 'When work does leave the device — a link, a download, a PDF — you decide who can open it. Every lock is applied on-device, and no password or key is ever sent to a server.',
    cards: [
      { icon: ICONS.link, title: 'Password-gated links', keywords: 'encrypted share link aes gcm pbkdf2 password recipient ciphertext', features: [
        { name: 'AES-256-GCM in the URL', desc: 'Any share link can be encrypted: the design is AES-256-GCM-encrypted under a key stretched from your password with PBKDF2-SHA256 at 210,000 iterations. The link carries <em>only</em> ciphertext — opening it prompts the recipient and rebuilds the design in their browser. The password never travels in the link and never reaches a server.' },
      ] },
      { icon: ICONS.lock, title: 'Locked PDFs', keywords: 'pdf password encrypt aes 256 rc4 40 bit open password acrobat', features: [
        { name: 'Two strengths, stated plainly', desc: '<strong>Standard</strong> is a 40-bit open-password: it opens in any PDF app and can ride inside a share link — a deterrent for short-lived material, not real cryptography. <strong>Strong</strong> is AES-256: it opens only in newer PDF apps, and its password is typed at export and never carried in a link. Strong also applies to Print/CMYK and multi-page PDFs.' },
      ] },
      { icon: ICONS.zip, title: 'Locked downloads', keywords: 'zip encryption zipcrypto winzip aes 7zip windows explorer unzip', features: [
        { name: 'Whole-zip encryption', desc: '<strong>Standard</strong> (ZipCrypto) opens in any unzip tool including Windows Explorer; <strong>Strong</strong> (WinZip AES-256) needs 7-Zip, WinZip or macOS — Windows Explorer’s built-in extract cannot open it.' },
        { name: 'Defense in depth', desc: 'One password protects <em>every</em> member, images included, and any PDF inside is <em>also</em> individually AES-256-locked — so the contents stay locked after the zip is unpacked.' },
      ] },
      { icon: ICONS.shield, title: 'Tool code & review', keywords: 'sandbox isolation worker hooks host bridge allowlist network review first party', features: [
        { name: 'A portability contract, not a sandbox', desc: 'A tool’s optional logic is written against the <code>host.*</code> bridge and its calls are time-boxed. Stated precisely: this is a portability contract, <em>not</em> an isolation boundary — hook code runs in the page’s realm. What makes it safe today is that every tool in the catalogue is first-party and reviewed before it ships; Worker-based isolation is on the roadmap and is what would make third-party tools safe to run.' },
        { name: 'Allowlisted network by policy', desc: '<code>host.net</code> is the sanctioned network path, allowlisted per the tool’s manifest, and templates are logic-less with escaping on by default. Network use outside the allowlist is a review failure, caught before a tool ships.' },
      ] },
      { icon: ICONS.mcp, title: 'Agent endpoint access', keywords: 'oauth 2.1 pkce bearer token connector mcp stateless session', features: [
        { name: 'OAuth 2.1 on the MCP server', desc: 'The hosted MCP server is gated by OAuth 2.1 — register it as a custom connector, or bring a bearer token from an MCP-capable agent or IDE. Client registration, authorization codes and tokens are short-lived signed values, PKCE-protected and verified on every call, so there is no session store to breach. The on-device shells need no server at all.' },
      ] },
      { icon: ICONS.credential, title: 'Tamper-evident provenance', keywords: 'c2pa verify signature integrity chain of custody', features: [
        { name: 'Prove what made a file', desc: 'Exports can carry a signed on-device C2PA credential recording the tool, author and export, and <a href="#/verify">Verify</a> checks any file locally. Full detail under <strong>Privacy &amp; data ownership</strong>.' },
      ] },
    ],
  },
  {
    flag: 'architecture', id: 'cap-architecture', title: 'Architecture (for builders)', icon: ICONS.bridge,
    desc: 'The structure the rest of this page rests on. Tools are data — a manifest, a template and optional hooks — not bundled code, which is why a new tool ships without an app update.',
    cards: [
      { icon: ICONS.doc, title: 'Declarative tools', keywords: 'manifest template handlebars hooks json schema inputs declared authoring', features: [
        { name: 'Manifest + template + hooks', desc: 'Inputs are declared in the manifest, never inferred from the template — which is what lets every shell render the same controls without interpreting the tool itself.' },
        { name: 'Logic-less templates', desc: 'Templates are Handlebars with no logic, so a non-developer can author one and there is no per-template XSS audit. Real logic goes in <code>hooks.js</code>, the deliberate escape hatch.' },
      ] },
      { icon: ICONS.bridge, title: 'Capability bridge (HostV1 1.92)', keywords: 'host api versioned contract profile assets state clipboard export text net tokens pdf capture compose audio media recorder', features: [
        { name: 'One tool, every shell', desc: 'Tools call a versioned <code>host.*</code> API — profile, assets, state, clipboard, export and log are required; tokens, network, text-to-path, PDF tools, page capture, tool composition, audio analysis, camera frames and recording are optional additions. Tools never touch the DOM, filesystem or network directly, which is why one runs unchanged in a browser, in Tauri and on the CLI.' },
        { name: 'Additive by rule', desc: 'Methods may be added in a minor version and never removed or signature-changed without a major one — so a tool written against an older bridge keeps working.' },
      ] },
      { icon: ICONS.cube, title: 'Tool composition', keywords: 'compose nested render embed recursion depth guard reuse', features: [
        { name: 'Tools compose tools', desc: 'A tool can embed another tool’s render as an image, declared in the manifest and placed with <code>{{asset …}}</code>. It goes through the same engine path, so the embed is pixel-identical to the standalone render, and recursion is depth- and cycle-guarded.' },
      ] },
      { icon: ICONS.sync, title: 'Synced as data', keywords: 'catalog sync manifest signed no app update ship tools', features: [
        { name: 'No app update needed', desc: 'Tools and assets sync from a signed manifest and appear on clients automatically. Shipping a tool is publishing data, not releasing software.' },
      ] },
      { icon: ICONS.id, title: 'Stable asset IDs', keywords: 'permanent id contract rename version replacedby checksum', features: [
        { name: 'An id is forever', desc: 'An asset or tool id is never reused or renamed; versioning lives in the manifest, never in the path. A link made today therefore still resolves years later — which is what makes URL-as-state a real guarantee rather than a hope.' },
      ] },
      { icon: ICONS.open, title: 'Open-source core', keywords: 'mpl licence open source engine schemas docs brand separate', features: [
        { name: 'MPL-licensed', desc: 'The engine, shells, schemas and docs are built to be open-sourceable, with brand content kept in separate packs — so the platform can be public without the brand assets being public.' },
      ] },
    ],
  },
];
