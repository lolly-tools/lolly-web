// SPDX-License-Identifier: MPL-2.0
/**
 * Capabilities content — a human-readable map of what Lolly can actually do,
 * as data. Extracted from the old Capabilities view so the merged Dashboard
 * (#/d) can render it with progressive disclosure. Content here is descriptive
 * prose about settled capabilities; kept in step with docs/exporting.md,
 * docs/using.md and the export bridge. `desc` strings may carry safe inline
 * <code>/<strong>/<a> (authored here, not user input).
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
    flag: 'experiences', id: 'cap-experiences', title: 'Experiences', icon: ICONS.edit,
    desc: 'The ways people actually use Lolly — from a thumb-typed edit on a phone to a one-link share or an automated render. The same tool, met where you are.',
    cards: [
      { icon: ICONS.edit, title: 'Live tool editing', features: [
        { name: 'Split view', desc: 'Controls on one side, a live canvas on the other — change any input and the preview updates instantly.' },
        { name: 'The preview is the file', desc: 'What you see is exactly what exports — no separate render step.' },
        { name: 'Zoom & pan', desc: 'Cmd/Ctrl-scroll or pinch to zoom; <code>Space</code>-drag or middle-drag to pan; <code>0</code> fit, <code>1</code> = 100%.' },
        { name: 'System dark mode', desc: 'Tools that support it adapt their canvas to your device’s light/dark preference.' },
      ] },
      { icon: ICONS.canvas, title: 'Free-canvas layout', features: [
        { name: 'Direct manipulation', desc: 'Some tools open as a chromeless free canvas (<strong>Layout Studio</strong>): drag, resize and rotate boxes of text, shapes and images, with smart guides that snap to edges and centres.' },
        { name: 'Edit in place', desc: 'Double-click a text box to type; pick fills and images from the same shared controls — then export through the exact same render path as every other tool, so the canvas <em>is</em> the file.' },
      ] },
      { icon: ICONS.camera, title: 'Live camera', features: [
        { name: 'Motion-reactive filters', desc: 'Hit “Go live” on a photo filter — halftone, scanline, posterize, duotone or pixel-stretch — and it tracks your webcam in real time, so the effect responds to movement.' },
        { name: 'Stays on your device', desc: 'Frames are read and processed locally and never leave the device; the camera is released the moment you stop or leave the tool.' },
        { name: 'Or just a snapshot', desc: '“Take a photo” in any image picker grabs a single frame as an on-device image — no upload, no camera roll.' },
      ] },
      { icon: ICONS.mobile, title: 'On a phone', features: [
        { name: 'Controls sheet', desc: 'The inputs become a sheet with a drag grip that snaps to peek / half / full; the preview stays visible while you edit.' },
        { name: 'Render sheet', desc: 'A floating Render button opens every format, size, copy, save and share control — sized for touch.' },
        { name: 'Touch canvas', desc: 'Pinch to zoom, drag to pan, double-tap to fit.' },
      ] },
      { icon: ICONS.install, title: 'Install & full-screen', features: [
        { name: 'Installable PWA', desc: 'Add to home screen / install from the address bar for an app-like, full-screen experience; updates itself when online.' },
        { name: 'Deep-link modes', desc: '<code>full</code> opens fullscreen (sidebar collapsed); <code>options</code> opens with the export panel expanded.' },
      ] },
      { icon: ICONS.link, title: 'Share a link', features: [
        { name: 'The URL is the design', desc: 'Every input lives in the link — paste it to a colleague, bookmark it, or commit it.' },
        { name: 'Shortest link', desc: 'A big design would make a long URL; the Share dialog offers a <strong>Shortest link</strong> that packs the whole state into a compact token so it stays short enough to paste anywhere — the readable form is always there too.' },
        { name: 'Act-on-open flags', desc: 'Add <code>&amp;export</code> to download on open, or <code>&amp;copy</code> to arm copy-to-clipboard.' },
      ] },
      { icon: ICONS.save, title: 'Save, organise & share', features: [
        { name: 'Named sessions', desc: 'Keep multiple saved sessions per tool, all device-local; Continue resumes your most recent.' },
        { name: 'Projects & folders', desc: 'Organise saved work in the <strong>Projects</strong> view — group sessions into folders that nest as deep as you like, drag to move, rename, and file new sessions straight into a folder.' },
        { name: 'Share a saved session', desc: 'Right-click any saved session for a link that reopens it with the exact same inputs — the full Share dialog, from Projects.' },
        { name: 'Copy to clipboard', desc: 'Paste an image straight into Slack, email or a doc; falls back to a download where the browser can’t.' },
      ] },
      { icon: ICONS.batchcube, title: 'Render many at once', features: [
        { name: 'Render a whole project', desc: 'From Projects, export every saved session in a folder — recursing every sub-folder — as one nested zip that mirrors your folder tree. No Batch/Pro needed.' },
        { name: 'Render a selection', desc: 'Multi-select tiles (tick a checkbox, drag a marquee, or Shift-click) and render the lot in one pass; a single session renders straight to its native file.' },
        { name: 'Render everything', desc: 'The Storage panel can render <em>every</em> saved session across all your tools to files in one nested zip — a full snapshot of your work — produced alongside the profile/data backup, so a single export carries both the editable state and the finished files.' },
      ] },
      { icon: ICONS.grid, title: 'Batch (Pro) mode', features: [
        { name: 'Many at once', desc: 'A grid where each row is a set of inputs, all exported together — a dozen languages or every size variant in one pass.' },
      ] },
      { icon: ICONS.extension, title: 'Browser extension', features: [
        { name: 'Capture into a tool', desc: 'Pull a page or screenshot from the browser into a Lolly tool to finish and export it.' },
      ] },
      { icon: ICONS.transfer, title: 'Move to another device', features: [
        { name: 'Portable backup', desc: 'Export one checksummed zip — profile, every session + thumbnail, your images and preferences — and import-merge it on another install. No account, no cloud.' },
      ] },
      { icon: ICONS.cube, title: 'Use Tools like any asset', features: [
        { name: 'Just an asset URL', desc: 'Tools can become composed renders, just an asset URL from where the user is, so a template can drop it into an <code>&lt;img src&gt;</code> or a CSS <code>url()</code> background exactly like a library image.' },
      ] },
    ],
  },
  {
    flag: 'platforms', id: 'cap-platforms', title: 'Platforms & runtimes', icon: ICONS.layers,
    desc: 'One platform-agnostic engine and the same render path on every surface, so a tool — and its output — behaves identically wherever it runs.',
    cards: [
      { icon: ICONS.globe, title: 'Web PWA', features: [
        { name: 'Installable & offline', desc: 'Works fully offline after the first load; installs as an app; auto-updates online.' },
      ] },
      { icon: ICONS.desktop, title: 'Desktop', features: [
        { name: 'macOS & Linux', desc: 'Native packages via Tauri — the same engine in a desktop shell.' },
      ] },
      { icon: ICONS.phone, title: 'Mobile', features: [
        { name: 'iOS & Android', desc: 'Installable mobile packages via Tauri, with the touch-first UI.' },
      ] },
      { icon: ICONS.terminal, title: 'Command line', features: [
        { name: 'Headless render', desc: 'Run any tool from the CLI (jsdom + the same engine); write to a file or stdout.' },
        { name: 'Same parameters', desc: '<code>--flag=value</code> arguments are the URL params — a web link runs unchanged on the CLI.' },
      ] },
      { icon: ICONS.tui, title: 'Terminal app (TUI)', features: [
        { name: 'Interactive in the shell', desc: 'Run <code>npm run tui</code> for a full keyboard-driven terminal app — browse the gallery, edit any tool’s inputs and organise saved projects into folders, all without leaving the shell.' },
        { name: 'Preview inline', desc: 'Press <code>p</code> to render the current design straight into the terminal as a truecolor half-block image — no window, no browser.' },
        { name: 'Same engine, same file', desc: 'It reuses the CLI’s host bridge and the one shared engine, so a tool renders and exports exactly as it does in the browser or on the desktop.' },
      ] },
      { icon: ICONS.layers, title: 'One engine everywhere', features: [
        { name: 'No drift', desc: 'The engine knows nothing about the DOM, storage or networking; a capability bridge injects each host’s specifics, so GUI and CLI never diverge.' },
      ] },
    ],
  },
  {
    flag: 'formats', id: 'cap-formats', title: 'Export formats', icon: ICONS.image,
    desc: 'Thirty formats across vector, raster, print, motion, documents and data. A tool offers only the formats its author declared, and the picker hides any your browser can’t produce.',
    cards: [
      { icon: ICONS.vector, title: 'Vector', features: [
        { name: 'SVG', desc: 'Infinitely scalable and self-contained — text is outlined to paths (HarfBuzz-shaped) so it renders identically without the font installed.' },
        { name: 'EMF · EPS · EPS (CMYK)', desc: 'EMF pastes as editable vector into PowerPoint and Word; EPS is PostScript vector for Illustrator and press workflows, with a DeviceCMYK variant. Text is outlined to paths in all of them.' },
        { name: 'DXF (cut file)', desc: 'AutoCAD R12 interchange for laser cutters, vinyl plotters and CNC/CAD — outline paths in millimetres, colour as the nearest AutoCAD Color Index. Line-art only.' },
      ] },
      { icon: ICONS.image, title: 'Raster', features: [
        { name: 'PNG · JPG · WebP · AVIF · ICO', desc: 'Lossless or compact, alpha where supported, with the real DPI and an embedded sRGB ICC profile so colour reproduces faithfully.' },
      ] },
      { icon: ICONS.printer, title: 'Print', features: [
        { name: 'PDF · Print PDF (CMYK) · CMYK TIFF', desc: 'True page sizes and DeviceCMYK output for the press — see Print production below.' },
      ] },
      { icon: ICONS.film, title: 'Motion', features: [
        { name: 'MP4 · WebM · GIF · APNG · Animated WebP', desc: 'Animated tools record to video (the picker shows what your browser can encode), or to GIF, lossless animated PNG, and colour-plus-alpha animated WebP — all of which work everywhere.' },
        { name: 'Animated SVG', desc: 'A self-contained vector animation — stacks vector snapshots with embedded CSS keyframes, so it scales to any size with no codec and loops in a browser tab or an <code>&lt;img&gt;</code>.' },
      ] },
      { icon: ICONS.doc, title: 'Documents & data', features: [
        { name: 'PowerPoint (PPTX)', desc: 'Multi-page and layout tools export an editable deck — each page decomposed into native text boxes, real shapes, and extractable images and vectors (logos embedded as real SVG). Built to hand a colleague content they can edit and reuse, not a flat screenshot.' },
        { name: 'HTML · MD · TXT', desc: 'HTML pastes formatted into mail clients; Markdown and plain text for content.' },
        { name: 'JSON · CSV · ICS · VCF', desc: 'Structured data straight from the input model — calendar invites, contacts, tabular and machine-readable payloads.' },
      ] },
      { icon: ICONS.zip, title: 'Bundles', features: [
        { name: 'ZIP', desc: 'Bundle several formats of one design into a single download — optionally password-locked (ZipCrypto or AES-256), with any PDF inside individually locked too.' },
      ] },
    ],
  },
  {
    flag: 'import', id: 'cap-import', title: 'Import formats', icon: ICONS.install,
    desc: 'Bring existing work in — photos, design files, tables and video. Every file is parsed on your device and never uploaded: design files open as an editable layout, images join your local library, and data fills a tool’s blocks.',
    cards: [
      { icon: ICONS.image, title: 'Images', features: [
        { name: 'PNG · JPG · WebP · AVIF · HEIC/HEIF', desc: 'Drop a photo or graphic into any image picker or your <strong>My images</strong> library. Stills are downscaled and stripped of EXIF/GPS on ingest; iPhone HEIC/HEIF decodes even where the browser can’t, via a bundled fallback. AVIF reads wherever the browser decodes it.' },
        { name: 'Animated GIF · APNG · animated WebP', desc: 'Animated rasters are recognised and kept <em>verbatim</em> — frames intact — so a looping GIF or animated PNG stays animated when you place it.' },
        { name: 'SVG', desc: 'Vector artwork is sanitised — scripts, <code>on*</code> handlers and <code>javascript:</code> URLs are stripped — and normalised to a clean viewBox before it’s stored.' },
      ] },
      { icon: ICONS.vector, title: 'Design files', features: [
        { name: 'Figma · Penpot · Illustrator · InDesign · PDF', desc: 'Layout Studio imports a native Figma <code>.fig</code>, a Penpot export, an Illustrator <code>.ai</code> or any <code>.pdf</code>, and an InDesign <code>.idml</code> — each parsed in the browser into editable boxes. Text stays text, shapes stay shapes, complex art flattens faithfully.' },
        { name: 'Any SVG is the wide door', desc: 'Almost every design app can export SVG, so an SVG export becomes an editable, brand-conformed layout — the universal way in.' },
      ] },
      { icon: ICONS.doc, title: 'Data & animation', features: [
        { name: 'CSV · JSON', desc: 'Paste or drop a table and a tool’s repeating blocks fill from it — RFC 4180 CSV (quoted fields, embedded newlines) or JSON rows/arrays, up to a thousand rows.' },
        { name: 'Lottie (.json · .lottie)', desc: 'Bodymovin JSON and dotLottie animations validate and place as live vector animations.' },
      ] },
      { icon: ICONS.film, title: 'Video', features: [
        { name: 'MP4 · MOV · WebM', desc: 'Video files are stored <em>verbatim</em> — never transcoded — and their dimensions probed locally, ready to place in motion tools.' },
      ] },
      { icon: ICONS.credential, title: 'Content Credentials (verify)', features: [
        { name: 'Read provenance from any file', desc: 'Verify checks a signed <a href="https://c2pa.org" target="_blank" rel="noopener">C2PA</a> manifest embedded in PDF, PNG/APNG, JPG, GIF, SVG, TIFF, WebP, MP4 and WebM/MKV — cryptographically, entirely on-device. See <a href="#/verify">Verify</a>.' },
      ] },
    ],
  },
  {
    flag: 'print', id: 'cap-print', title: 'Print production', icon: ICONS.printer,
    desc: 'Press-ready output computed entirely on-device — the engine owns the dimension and colour maths, and each shell draws it. No print service, no upload.',
    cards: [
      { icon: ICONS.ruler, title: 'Physical sizing', features: [
        { name: 'Real units & DPI', desc: 'Set width × height in <code>mm/cm/in/pt/pc</code> at a DPI (default 300). PDF becomes a true page, raster renders the exact pixel count (and embeds the resolution), SVG keeps the physical unit with a px viewBox.' },
      ] },
      { icon: ICONS.layers, title: 'Multi-page documents', features: [
        { name: 'Real pages, not one long image', desc: 'A tool can build a paginated PDF — a cover, content, and a back page — where every page is a true, separately-sized PDF page (A4, US Letter or A5; portrait or landscape).' },
        { name: 'Content that flows', desc: 'Text and image blocks flow onto as many pages as they need; new pages are created automatically, with a manual page break where you want one. See the <strong>Multi-Page PDF</strong> tool.' },
        { name: 'Vector & lockable', desc: 'Each page is drawn as vectors with text outlined to paths (so it renders without the font), and the document can carry a password (a basic link-lock or strong AES-256). These are RGB documents; crop/bleed marks stay on the single-page <em>Print PDF</em> path.' },
      ] },
      { icon: ICONS.swatch, title: 'CMYK colour', features: [
        { name: 'DeviceCMYK output', desc: 'Print PDF and CMYK TIFF write CMYK, not RGB.' },
        { name: 'Exact brand inks', desc: 'Brand swatches with measured CMYK values are substituted exactly; other colours use a standard device conversion.' },
      ] },
      { icon: ICONS.id, title: 'Press conditions', features: [
        { name: 'OutputIntent', desc: 'A CMYK PDF declares its target press condition (Coated FOGRA39 by default; FOGRA51, SWOP and more) so a RIP knows how the inks are meant to read. On-screen and raster stay sRGB.' },
      ] },
      { icon: ICONS.marks, title: 'Bleed & marks', features: [
        { name: 'Trim, bleed & marks', desc: 'Add bleed (with declared TrimBox/BleedBox) plus crop, registration and bleed marks in the margin; registration prints on every plate.' },
      ] },
      { icon: ICONS.swatch, title: 'Colour bars', features: [
        { name: 'Calibration + verification', desc: 'A solid C/M/Y/K process strip to calibrate against, then RGB↔CMYK pairs for the brand inks actually used — so a press operator can confirm the conversion landed.' },
      ] },
      { icon: ICONS.stamp, title: 'Provenance stamps', features: [
        { name: 'Proof-margin credits', desc: 'Optional timestamp, “Made with…”, and tool/author credit in the margin — a proof annotation, trimmed at the final cut.' },
      ] },
      { icon: ICONS.lock, title: 'Lockable output', features: [
        { name: 'Password-protect the press file', desc: 'Any PDF — including Print and CMYK PDFs — can carry a <strong>Standard</strong> (40-bit, link-embeddable) or <strong>Strong</strong> (AES-256) open-password. Full PDF, zip and share-link encryption lives under <strong>Security &amp; access control</strong> below.' },
      ] },
    ],
  },
  {
    flag: 'automation', id: 'cap-automation', title: 'Automation & AI', icon: ICONS.bot,
    desc: 'Built to be driven by scripts, pipelines and agents as easily as by a person.',
    cards: [
      { icon: ICONS.terminal, title: 'CLI & pipelines', features: [
        { name: 'Generate at build time', desc: 'Produce OG images, QR codes, social cards and data visuals from the command line — repeatably, as part of CI, instead of checking binaries into Git.' },
      ] },
      { icon: ICONS.url, title: 'URL mode', features: [
        { name: 'Everything is a parameter', desc: 'Inputs plus reserved controls — <code>format</code>, <code>export</code>, <code>copy</code>, size/unit/dpi, bleed and marks — all expressible in a link.' },
      ] },
      { icon: ICONS.bot, title: 'AI agents', features: [
        { name: 'Cheap & deterministic', desc: 'A parameterised URL is a few tokens and always renders the same press-quality result locally — no prompt drift, no stochastic surprises in production.' },
      ] },
      { icon: ICONS.mcp, title: 'MCP server (add-on)', features: [
        { name: 'Native agent endpoint', desc: 'An optional <a href="https://modelcontextprotocol.io" target="_blank" rel="noopener">Model Context Protocol</a> server that any MCP client — an agent runtime, an IDE, a script — connects to: discover a tool, fill its declared inputs, and get back a finished file plus an editable link. Tools sync as data, so it needs no app update.' },
        { name: 'Every format an agent asks for', desc: 'One <code>lolly_render</code> call returns vector (SVG/PDF/EPS/DXF), raster (PNG/JPG/WebP/AVIF/TIFF), motion (MP4/WebM/GIF/APNG/Animated WebP/Animated SVG), documents (PowerPoint) or data — the server picks how to render each; the agent just names a format the tool declares.' },
        { name: 'A hosted add-on — not offline or edge', desc: 'Unlike the rest of Lolly, the MCP server is a <strong>server-side component</strong>: producing the full format range drives a headless browser against a built web shell, so it runs as a hosted service and is <strong>not suitable for offline or edge deployments</strong>. The on-device shells — web, desktop, mobile and CLI — stay the offline / air-gapped path.' },
        { name: 'Connect any MCP client', desc: 'Register the hosted endpoint as a <strong>custom connector</strong> (OAuth 2.1) in any client that supports one, or point an MCP-capable agent or IDE at it with a bearer token. Either way the client authenticates before it can render, and access is verified statelessly on every call — no session store to breach. See <strong>Security &amp; access control</strong>.' },
      ] },
    ],
  },
  {
    flag: 'determinism', id: 'cap-determinism', title: 'Determinism & reproducibility', icon: ICONS.repeat,
    desc: 'The same inputs produce the same file — on every device, today and next year. Output is a build artifact, not a stochastic guess.',
    cards: [
      { icon: ICONS.repeat, title: 'One render path', features: [
        { name: 'No surprises', desc: 'Web, mobile, desktop and CLI share the engine; there is one code path that turns inputs into a file.' },
      ] },
      { icon: ICONS.url, title: 'URL = state', features: [
        { name: 'Reproducible from a link', desc: 'Every input is expressible as a URL parameter, so a link reproduces the design exactly — commit it, diff it, regenerate on demand.' },
      ] },
      { icon: ICONS.tag, title: 'Version pinning', features: [
        { name: 'Forward-compatible', desc: 'Pin a tool version with <code>_v</code> so a saved link keeps rendering the way it did when you made it.' },
      ] },
      { icon: ICONS.shield, title: 'Auditable', features: [
        { name: 'Reviewable output', desc: 'No model, no server, no randomness — outputs are inspectable and version-controllable.' },
      ] },
    ],
  },
  {
    flag: 'brand', id: 'cap-brand', title: 'Brand & design system', icon: ICONS.swatch,
    desc: 'Design decisions are locked at the template level; only the inputs that are meant to vary are exposed — so whatever anyone makes stays inside the rules the author set.',
    cards: [
      { icon: ICONS.brush, title: 'Constraint-first tools', features: [
        { name: 'Guardrails, not guidelines', desc: 'Authors hard-code typography, colour and spacing; users just fill in content. The tool is the brand guardrail.' },
      ] },
      { icon: ICONS.swatch, title: 'Tokens, themes & palette', features: [
        { name: 'Defined once, used everywhere', desc: 'Shared design tokens and multiple themes; the brand palette appears in every colour picker, with measured CMYK ink values where known.' },
      ] },
      { icon: ICONS.circles, title: 'Themable icons & backgrounds', features: [
        { name: 'Recolour to any brand pairing', desc: 'A library of two-colour icons and decorative backgrounds that recolour to a chosen brand pairing right in the asset picker; the colour choice rides in the asset id, so it round-trips through URL mode and re-bakes on every render.' },
      ] },
      { icon: ICONS.font, title: 'Bundled type', features: [
        { name: 'Local variable fonts', desc: 'SUSE and SUSE Mono ship with the app — no webfont or CDN dependency at render time.' },
      ] },
      { icon: ICONS.user, title: 'Personalisation', features: [
        { name: 'Bind to your profile', desc: 'Any input can pre-fill from your saved name, contact details or headshot (opt-in); override per session.' },
      ] },
      { icon: ICONS.tag, title: 'Maturity tags', features: [
        { name: 'Approved by default', desc: 'Every tool declares official / community / experimental; experimental tools watermark their exports — applied by the host, so it can’t be edited out.' },
      ] },
    ],
  },
  {
    flag: 'privacy', id: 'cap-privacy', title: 'Privacy & data ownership', icon: ICONS.shield,
    desc: 'Creative production stays on the device, under your control — there is no place for a file to leak to.',
    cards: [
      { icon: ICONS.shield, title: 'On-device by default', features: [
        { name: 'Nothing transmitted', desc: 'No cloud rendering, no analytics, no telemetry. What you create stays on your machine.' },
      ] },
      { icon: ICONS.device, title: 'Local storage', features: [
        { name: 'Your browser’s database', desc: 'Profile, saved sessions, uploaded images and the catalogue cache live in IndexedDB; Storage tools show usage and let you clear it.' },
      ] },
      { icon: ICONS.image, title: 'Image hygiene', features: [
        { name: 'Stripped & local', desc: 'Images you add are downscaled and stripped of EXIF/GPS, then kept in a local My images library — never uploaded.' },
      ] },
      { icon: ICONS.credential, title: 'Content Credentials', features: [
        { name: 'Signed, tamper-evident provenance', desc: 'Exports can carry a signed <a href="https://c2pa.org" target="_blank" rel="noopener">C2PA</a> manifest — the <a href="https://contentauthenticity.org" target="_blank" rel="noopener">Content Authenticity Initiative</a> standard for tamper-evident provenance — created entirely on your device, so a file can prove what made it without any cloud signing service. PDF, PNG, JPG, GIF, SVG, TIFF, WebP, MP4 and WebM all take the credential, recording the tool, the author (profile opt-in) and where the export happened; <a href="#/verify">Verify</a> checks any file on-device.' },
      ] },
      { icon: ICONS.shield, title: 'On-device utilities', features: [
        { name: 'File in → clean file out', desc: 'Content-transform utilities take a file you supply, process it entirely on your device and hand back a cleaned copy — never uploaded, never watermarked. Strip Hidden Data removes EXIF/GPS, camera, author and editor metadata from JPEG, PNG, SVG and PDF. This replaces handing confidential files to single-purpose websites.' },
      ] },
      { icon: ICONS.lock, title: 'Self-host / air-gap', features: [
        { name: 'No backend', desc: 'No server-side processing or database — deploy on your own infrastructure and run entirely behind your firewall.' },
      ] },
    ],
  },
  {
    flag: 'security encryption', id: 'cap-security', title: 'Security & access control', icon: ICONS.lock,
    desc: 'When work does leave the device — a share link, a download, a PDF — you decide who can open it. Every lock is applied on-device; passwords and keys are never sent to a server, and no tool can reach the page, your storage or the network on its own.',
    cards: [
      { icon: ICONS.link, title: 'Password-gated links', features: [
        { name: 'Encrypted share links', desc: 'Any share link can be encrypted: the design is AES-256-GCM-encrypted under a key stretched from the password with PBKDF2-SHA256 (210k iterations). The link carries <em>only</em> the ciphertext — opening it prompts the recipient for the password and rebuilds the design in their browser. The password never travels in the link and nothing is sent to a server.' },
      ] },
      { icon: ICONS.lock, title: 'Locked PDFs', features: [
        { name: 'Two lock strengths', desc: 'A PDF can carry a <strong>Standard</strong> open-password (a basic 40-bit lock that opens in any PDF app and can ride in a share link — a deterrent for short-lived material) or a <strong>Strong</strong> one (AES-256; opens in newer PDF apps only, and its password is typed at export, never in a link). Strong locks also apply to Print/CMYK and multi-page PDFs.' },
      ] },
      { icon: ICONS.zip, title: 'Locked downloads', features: [
        { name: 'Whole-zip encryption (defense-in-depth)', desc: 'A folder or multi-file download can lock the whole zip — <strong>Standard</strong> (ZipCrypto; opens in any unzip tool including Windows Explorer) or <strong>Strong</strong> (WinZip AES-256; needs 7-Zip / WinZip / macOS, not Windows Explorer’s built-in extract). One password protects <em>every</em> member — images and all — and any PDFs inside are <em>also</em> individually AES-256-locked, so they stay locked even after the zip is unpacked.' },
      ] },
      { icon: ICONS.shield, title: 'Sandboxed tools', features: [
        { name: 'A tool can’t reach out', desc: 'A tool’s optional logic runs with only the <code>host.*</code> bridge in scope — no <code>window</code>, no ambient <code>fetch</code>, no DOM or filesystem access — and each call is time-boxed. A malicious or buggy template can’t touch the page, read your storage or phone home.' },
        { name: 'Allowlisted network only', desc: 'The one network path a tool has is the host’s allowlisted fetch, which the host can deny per the tool’s manifest. There is no other route out, so a template can’t exfiltrate what you type.' },
      ] },
      { icon: ICONS.mcp, title: 'Access-controlled agent endpoint', features: [
        { name: 'OAuth 2.1 on the MCP server', desc: 'The optional hosted MCP server is gated by <strong>OAuth 2.1</strong> — register it as a custom connector in any MCP client, or bring a bearer token from an MCP-capable agent or IDE. Client registration, authorization codes and tokens are short-lived signed values (PKCE-protected) verified on each call, so there is no session store to breach. The on-device shells need no server at all and stay behind your firewall.' },
      ] },
      { icon: ICONS.credential, title: 'Tamper-evident provenance', features: [
        { name: 'Prove what made a file', desc: 'Exports can carry a signed, on-device <a href="https://c2pa.org" target="_blank" rel="noopener">C2PA</a> credential recording the tool, author and export — no cloud signing service — and <a href="#/verify">Verify</a> checks any file locally. See <strong>Privacy &amp; data ownership</strong>.' },
      ] },
    ],
  },
  {
    flag: 'architecture', id: 'cap-architecture', title: 'Architecture (for builders)', icon: ICONS.bridge,
    desc: 'The structure that makes the rest possible: tools are data, not bundled code, so new tools ship without an app update.',
    cards: [
      { icon: ICONS.doc, title: 'Declarative tools', features: [
        { name: 'Manifest + template + hooks', desc: 'A tool is a manifest, a template and optional hooks; inputs are declared, not inferred. Non-developers can author the template; hooks are the escape hatch for real logic.' },
      ] },
      { icon: ICONS.bridge, title: 'Capability bridge', features: [
        { name: 'One tool, every shell', desc: 'Tools call a versioned <code>host.*</code> API — profile, assets, state, clipboard, export and text-to-path, plus optional capability-gated extras (design tokens, PDF tools, page capture, network and tool composition) — and never touch the DOM, filesystem or network directly, which is why one tool runs unchanged in browser, Tauri and CLI.' },
      ] },
      { icon: ICONS.cube, title: 'Tool composition', features: [
        { name: 'Tools compose tools', desc: 'A tool can embed another tool’s rendered output as an image — declared in the manifest (<code>composes</code>) and placed with <code>{{asset …}}</code>. It renders through the same engine path, so the embed is pixel-identical, and recursion is depth- and cycle-guarded. One tool reuses another instead of copying its code.' },
      ] },
      { icon: ICONS.sync, title: 'Synced as data', features: [
        { name: 'No app update needed', desc: 'Tools and assets sync from a signed manifest; new tools appear automatically on clients.' },
      ] },
      { icon: ICONS.id, title: 'Stable asset IDs', features: [
        { name: 'Permanent contracts', desc: 'An asset id is forever — never reused or renamed; versioning lives in the manifest, never the path.' },
      ] },
      { icon: ICONS.open, title: 'Open-source engine', features: [
        { name: 'MPL-licensed core', desc: 'The engine, shells, schemas and docs are designed to be open-sourceable; brand content stays separate.' },
      ] },
    ],
  },
];
