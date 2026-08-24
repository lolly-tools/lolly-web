// SPDX-License-Identifier: MPL-2.0
/**
 * Script audio (#/script) - the writing surface over on-device speech.
 *
 * The dialog (views/script-audio.ts) is a quick capture point inside the asset
 * picker and the catalog; this is the same synthesis with room to actually
 * WRITE. The script sheet is the hero: generous type, a tall page, and the
 * numbers a narrator cares about sitting quietly under it - how many words, and
 * roughly how long they take to listen to at a comfortable pace. Everything
 * mechanical (voice, speed, generate, save) lives in a side rail so the words
 * keep the widest column.
 *
 * All the plumbing is the dialog's, imported rather than re-implemented:
 * markdownToSpokenText strips structure from speech, generateSpeechAsJob runs
 * the synthesis as a background job (so a long script survives a nav away and
 * saves itself), speechProgressPainter drives the same thin progress track,
 * saveTtsClip writes the identical `user/tts/*` asset record (Gen AI pill,
 * `meta.tts` captioning block). The two surfaces cannot drift because they share
 * one recipe.
 *
 * A routed view like the Colour Lab, not an overlay: no tab, the shared back
 * pill (lib/back-nav.ts) names wherever you came from. Deep links onto a shell
 * without `host.speech` get an honest empty state, never a dead form.
 */

import '../styles/script-audio.css';          // the shared progress track + preview row
import '../styles/parts/script-studio.css';   // this view's own layout (lazy chunk)
import {
  generateSpeechAsJob, markdownToSpokenText, saveTtsClip, speechProgressPainter, SOFT_CHAR_CAP,
  type ScriptAudioHost, type TtsClip,
} from './script-audio.ts';
import { pcmToWavBlob } from '../lib/pcm-wav.ts';
import { audioTransportHtml, wireAudioTransport, type AudioTransport } from '../lib/audio-transport.ts';
import { fmtBytes } from '../lib/format.ts';
import { escape } from '../utils.ts';
import { icon } from '../lib/icons.ts';
import { t, tRaw } from '../i18n.ts';
import { armViewEnter } from '../view-enter.ts';
import { langFabHtml, attachLangMenu } from '../components/lang-menu.ts';
import { backHomeHtml, mountBackPill } from '../components/back-pill.ts';
import { mountHomeFab } from '../components/home-fab.ts';
import { mountThemeFab } from '../components/theme-toggle.ts';
import { mountProfileFab } from '../components/profile-menu.ts';
import type { SpeechResult } from '@lolly-tools/core/host-v1';

/**
 * The honest listening pace: ~150 words a minute is the well-worn narration
 * average, and the label that renders this number always says it is an
 * estimate - the model's actual pace varies with the words.
 */
export const LISTEN_WPM = 150;

/** Words a voice would actually speak - counted on the SPOKEN text, so code
 *  blocks and image URLs never inflate the number. Pure, tested. */
export function countWords(spoken: string): number {
  return spoken.match(/\S+/g)?.length ?? 0;
}

/** Estimated listening seconds for `words` at LISTEN_WPM, scaled by the speed
 *  multiplier. 0 words is 0 seconds; a degenerate speed falls back to 1. */
export function estimateListenSeconds(words: number, speed = 1): number {
  const rate = speed > 0 ? speed : 1;
  return (words / (LISTEN_WPM * rate)) * 60;
}

/** The estimate as a whole sentence (translators need the sentence, not glued
 *  fragments - the pdf-extract count convention). Always says "an estimate". */
export function formatListenEstimate(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return t('About {s} sec to listen, an estimate', { s: Math.max(s, 1) });
  if (s === 0) return t('About {m} min to listen, an estimate', { m });
  return t('About {m} min {s} sec to listen, an estimate', { m, s });
}

/**
 * One short audition line per voice, synthesized on first request and kept for
 * the session (module-level, so revisiting the view replays instantly). The
 * value is an object URL over a small WAV - a second or two of audio.
 */
const auditionUrls = new Map<string, Promise<string>>();

export async function mountScriptStudio(viewEl: HTMLElement, host: ScriptAudioHost): Promise<void> {
  document.title = tRaw('{name} - Lolly', { name: t('Script audio') });
  const speech = host.speech;

  // A deep link onto a shell without the speech bridge: say so, plainly.
  if (!speech?.isAvailable()) {
    viewEl.innerHTML = `
      ${backHomeHtml()}
      <div class="gallery-topright"></div>
      <div class="platform-layout scriptst-layout">
        <header class="plat-header">
          <h1 class="plat-title">${t('Script audio')}</h1>
          <div class="plat-header-text">
            <p class="plat-sub">${t('Speech generation is not available in this browser. Open Lolly in a current desktop or mobile browser to write and voice a script.')}</p>
          </div>
        </header>
      </div>`;
    mountBackPill(viewEl);
    // A deep link onto an unsupported shell is still a dead end without this - 
    // the back pill needs somewhere to have come from; Home always answers.
    mountHomeFab(viewEl);
    mountThemeFab(viewEl.querySelector('.gallery-topright'), host);
    mountProfileFab(viewEl.querySelector('.gallery-topright'), host);
    return;
  }

  viewEl.innerHTML = `
    ${backHomeHtml()}
    <div class="gallery-topright">${langFabHtml()}</div>
    <div class="platform-layout scriptst-layout">
      <header class="plat-header">
        <h1 class="plat-title">${t('Script audio')}</h1>
        <div class="plat-header-text">
          <p class="plat-sub">${t('Write a script and hear it in a natural voice, generated on this device. Save the clip to your uploads and use it anywhere audio goes.')}</p>
        </div>
      </header>
      <div class="scriptst-cols">
        <section class="scriptst-sheet">
          <label class="scriptst-sheet-label" for="scriptst-text">${t('Your script')}</label>
          <textarea id="scriptst-text" class="field-input scriptst-text" spellcheck="true"
            placeholder="${escape(t('Type or paste the words to speak. Markdown is fine, only the words are read.'))}"></textarea>
          <p class="scriptst-meter" data-meter aria-live="polite"></p>
        </section>
        <aside class="scriptst-rail" aria-label="${escape(t('Voice and export'))}">
          <label class="scriptst-field">
            <span>${t('Voice')}</span>
            <select class="field-select" data-voice disabled><option>${t('Loading…')}</option></select>
          </label>
          <button type="button" class="btn scriptst-audition" data-audition disabled>
            <span class="scriptst-audition-icon" aria-hidden="true">${icon('play')}</span>${t('Hear this voice')}
          </button>
          <label class="scriptst-field">
            <span>${t('Speed')}</span>
            <select class="field-select" data-speed>
              <option value="0.8">${t('Slower (0.8×)')}</option>
              <option value="1" selected>${t('Normal')}</option>
              <option value="1.2">${t('Faster (1.2×)')}</option>
            </select>
          </label>
          <p class="scriptst-consent" data-consent hidden></p>
          <button type="button" class="btn btn--primary scriptst-generate" data-generate>${t('Generate speech')}</button>
          <p class="scriptst-kbd" data-kbd></p>
          <div class="script-audio-progress" data-progress role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="${escape(t('Generating speech'))}" hidden>
            <div class="script-audio-progress-fill" data-progress-fill></div>
          </div>
          <p class="scriptst-status" data-status aria-live="polite" hidden></p>
          <div class="script-audio-preview scriptst-preview" data-preview hidden></div>
          <button type="button" class="btn btn--primary scriptst-save" data-save hidden>${t('Save to your uploads')}</button>
          <p class="scriptst-saved" data-saved hidden></p>
        </aside>
      </div>
    </div>`;
  armViewEnter(viewEl, '.plat-header, .scriptst-sheet, .scriptst-rail');
  mountBackPill(viewEl);
  mountHomeFab(viewEl);
  mountThemeFab(viewEl.querySelector('.gallery-topright'), host);
  mountProfileFab(viewEl.querySelector('.gallery-topright'), host);
  attachLangMenu(viewEl.querySelector<HTMLElement>('.lang-fab'), host);

  const textarea    = viewEl.querySelector<HTMLTextAreaElement>('.scriptst-text')!;
  const meterEl     = viewEl.querySelector<HTMLElement>('[data-meter]')!;
  const voiceSel    = viewEl.querySelector<HTMLSelectElement>('[data-voice]')!;
  const speedSel    = viewEl.querySelector<HTMLSelectElement>('[data-speed]')!;
  const auditionBtn = viewEl.querySelector<HTMLButtonElement>('[data-audition]')!;
  const consentEl   = viewEl.querySelector<HTMLElement>('[data-consent]')!;
  const kbdEl       = viewEl.querySelector<HTMLElement>('[data-kbd]')!;
  const progressEl  = viewEl.querySelector<HTMLElement>('[data-progress]')!;
  const fillEl      = viewEl.querySelector<HTMLElement>('[data-progress-fill]')!;
  const statusEl    = viewEl.querySelector<HTMLElement>('[data-status]')!;
  const previewEl   = viewEl.querySelector<HTMLElement>('[data-preview]')!;
  const generateBtn = viewEl.querySelector<HTMLButtonElement>('[data-generate]')!;
  const saveBtn     = viewEl.querySelector<HTMLButtonElement>('[data-save]')!;
  const savedEl     = viewEl.querySelector<HTMLElement>('[data-saved]')!;

  // The generate shortcut, named in the platform's own words (textContent - no
  // markup, so no sink).
  const isMac = /Mac|iP(hone|ad|od)/.test(navigator.platform);
  kbdEl.textContent = tRaw('{keys} generates', { keys: isMac ? '⌘ Enter' : 'Ctrl Enter' });

  let transport: AudioTransport | null = null;
  let previewUrl: string | null = null;
  // The last generated clip + the exact inputs that produced it (Save stores
  // these, not the live form - the dialog's discipline).
  let result: SpeechResult | null = null;
  let wavBlob: Blob | null = null;
  let spokenText = '';
  let usedVoice = '';
  let usedSpeed = 1;
  // One shared element for voice auditions, replaced per play.
  let auditionAudio: HTMLAudioElement | null = null;

  const showStatus = (msg: string, isError = false): void => {
    statusEl.hidden = false;
    statusEl.textContent = msg;
    statusEl.classList.toggle('scriptst-status-error', isError);
  };
  const hideStatus = (): void => { statusEl.hidden = true; statusEl.classList.remove('scriptst-status-error'); };

  // ── The margin note: words and listening time, live ────────────────────────
  const paintMeter = (): void => {
    const spoken = markdownToSpokenText(textarea.value);
    const words = countWords(spoken);
    if (words === 0) {
      meterEl.textContent = t('Start writing and the listening time appears here.');
      meterEl.classList.remove('scriptst-meter-over');
      return;
    }
    const count = words === 1 ? t('1 word') : t('{n} words', { n: words });
    const estimate = formatListenEstimate(estimateListenSeconds(words, Number(speedSel.value) || 1));
    const over = textarea.value.length > SOFT_CHAR_CAP;
    meterEl.textContent = over
      ? `${count} · ${estimate} · ${t('Long scripts take a while to generate.')}`
      : `${count} · ${estimate}`;
    meterEl.classList.toggle('scriptst-meter-over', over);
  };
  paintMeter();

  // An edit to the script, voice or speed makes the preview stale - drop it so
  // Save can only ever store what the listener just heard.
  const dropPreview = (): void => {
    if (!result) return;
    result = null; wavBlob = null;
    transport?.destroy(); transport = null;
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    previewEl.hidden = true; previewEl.innerHTML = '';
    saveBtn.hidden = true;
    savedEl.hidden = true; savedEl.innerHTML = '';
    generateBtn.textContent = t('Generate speech');
  };
  textarea.addEventListener('input', () => { paintMeter(); dropPreview(); });
  voiceSel.addEventListener('change', dropPreview);
  speedSel.addEventListener('change', () => { paintMeter(); dropPreview(); });

  // Voices load async; audition stays disabled until they arrive.
  void speech.voices().then((voices) => {
    if (!viewEl.isConnected) return;
    voiceSel.innerHTML = voices.map(v =>
      `<option value="${escape(v.id)}">${escape(v.name)} (${escape(v.lang)})</option>`).join('');
    voiceSel.disabled = voices.length === 0;
    auditionBtn.disabled = voices.length === 0;
  }).catch(() => {
    if (viewEl.isConnected) showStatus(t("Couldn't load the voice list."), true);
  });

  // First use: say what is about to happen BEFORE any bytes move.
  void speech.cached().then((cached) => {
    if (cached || !viewEl.isConnected) return;
    consentEl.hidden = false;
    consentEl.textContent = t('The first run downloads a {size} voice model once. It runs on-device and your script is never uploaded.', { size: fmtBytes(speech.modelBytes()) });
  }).catch(() => { /* unknown cache state → skip the consent line, never block */ });

  const paintProgress = speechProgressPainter(progressEl, fillEl, (phase) => {
    showStatus(phase === 'download' ? t('Downloading the voice model…') : t('Generating speech…'));
  });

  // ── One-click voice audition, cached per voice per session ─────────────────
  const auditionUrlFor = (voiceId: string, voiceName: string): Promise<string> => {
    let p = auditionUrls.get(voiceId);
    if (!p) {
      p = speech.synthesize(tRaw("Hi, I'm {name}", { name: voiceName }), {
        voice: voiceId || undefined,
        onProgress: paintProgress,
      }).then((res) =>
        URL.createObjectURL(pcmToWavBlob({ left: res.pcm, right: res.pcm, sampleRate: res.sampleRate })));
      p.catch(() => auditionUrls.delete(voiceId)); // a failed audition retries next click
      auditionUrls.set(voiceId, p);
    }
    return p;
  };
  auditionBtn.addEventListener('click', async () => {
    const voiceName = voiceSel.selectedOptions[0]?.textContent?.replace(/\s*\(.*\)$/, '') || voiceSel.value;
    auditionBtn.disabled = true;
    try {
      const url = await auditionUrlFor(voiceSel.value, voiceName);
      if (!viewEl.isConnected) return;
      hideStatus();
      auditionAudio?.pause();
      auditionAudio = new Audio(url);
      void auditionAudio.play();
    } catch (e) {
      if (!viewEl.isConnected) return;
      host.log('error', 'Voice audition failed', { error: String(e) });
      showStatus(t("Couldn't play the voice sample. Try again."), true);
    } finally {
      if (viewEl.isConnected) { auditionBtn.disabled = false; progressEl.hidden = true; }
    }
  });

  // ── Generate ───────────────────────────────────────────────────────────────
  const generate = async (): Promise<void> => {
    const spoken = markdownToSpokenText(textarea.value);
    if (!spoken) { showStatus(t('Type something to speak first.'), true); return; }
    dropPreview();
    hideStatus();
    generateBtn.disabled = true;
    try {
      const clip = await generateSpeechAsJob(host, {
        spokenText: spoken, voice: voiceSel.value, speed: Number(speedSel.value) || 1,
      }, {
        alive: () => viewEl.isConnected,
        onProgress: paintProgress,
        onQueued: () => showStatus(t('Waiting for other work to finish…')),
      });
      // No clip to paint: cancelled from the toast, or the view was replaced and
      // the take was saved to Your uploads without us. Never touch the DOM that
      // has since been swapped out.
      if (!clip || !viewEl.isConnected) return;
      result = clip.result;
      wavBlob = clip.wavBlob;
      spokenText = clip.spokenText;
      usedVoice = clip.voice;
      usedSpeed = clip.speed;
      previewUrl = URL.createObjectURL(wavBlob);
      previewEl.hidden = false;
      previewEl.innerHTML = audioTransportHtml({
        play: t('Play'), pause: t('Pause'), seek: t('Seek'),
        mute: t('Mute'), unmute: t('Unmute'), volume: t('Volume'),
      });
      const audioEl = document.createElement('audio');
      audioEl.src = previewUrl;
      audioEl.preload = 'metadata';
      previewEl.appendChild(audioEl);
      transport = wireAudioTransport(previewEl, audioEl);
      consentEl.hidden = true;   // the download (if any) has happened now
      hideStatus();
      saveBtn.hidden = false;
      generateBtn.textContent = t('Regenerate');
      saveBtn.focus();
    } catch (e) {
      if (!viewEl.isConnected) return;
      if ((e as Error | null)?.name !== 'AbortError') {
        host.log('error', 'Speech synthesis failed', { error: String(e) });
        showStatus(t("Couldn't generate the audio. Try again."), true);
      }
    } finally {
      if (viewEl.isConnected) { generateBtn.disabled = false; progressEl.hidden = true; }
    }
  };
  generateBtn.addEventListener('click', () => void generate());

  // Keyboard-first: Cmd/Ctrl+Enter generates from anywhere in the view.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !generateBtn.disabled) {
      e.preventDefault();
      void generate();
    }
  };
  viewEl.addEventListener('keydown', onKey);

  // ── Save, then say where it went ───────────────────────────────────────────
  saveBtn.addEventListener('click', async () => {
    if (!result || !wavBlob) return;
    saveBtn.disabled = true;
    const clip: TtsClip = { result, wavBlob, spokenText, voice: usedVoice, speed: usedSpeed };
    try {
      const ref = await saveTtsClip(host, clip);
      if (!viewEl.isConnected) return;
      saveBtn.hidden = true;
      savedEl.hidden = false;
      // The one interpolation is the asset id we just minted, URI- and
      // attribute-escaped; the link lands on the catalogue with the uploads
      // section open and the new clip highlighted.
      savedEl.innerHTML = `${escape(t('Saved to your uploads.'))} <a href="#/c?section=your-uploads&asset=${escape(encodeURIComponent(ref?.id ?? ''))}">${escape(t('View it in the Catalogue'))}</a>`;
    } catch (e) {
      if (!viewEl.isConnected) return;
      host.log('error', 'Script audio store failed', { error: String(e) });
      // Quota errors carry a user-ready message (code set); prefix only the rest.
      showStatus((e as { code?: unknown }).code
        ? (e as Error).message
        : tRaw("Couldn't save the audio: {message}", { message: (e as Error).message }), true);
    } finally {
      if (viewEl.isConnected) saveBtn.disabled = false;
    }
  });

  textarea.focus();

  (viewEl as HTMLElement & { _cleanup?: () => void })._cleanup = () => {
    // Deliberately does NOT abort an in-flight generation: it is a background
    // job now, so leaving the view keeps it running and the clip lands in Your
    // uploads on its own. The job's own ✕ in the global toast is the cancel.
    transport?.destroy();
    transport = null;
    auditionAudio?.pause();
    auditionAudio = null;
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    viewEl.removeEventListener('keydown', onKey);
  };
}
