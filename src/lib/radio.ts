// SPDX-License-Identifier: MPL-2.0
/**
 * Free net-radio stations for the Neurospicy player — an OPT-IN source that needs
 * the internet (Lolly is otherwise offline-first). A handful of curated SomaFM
 * ambient/focus channels. Streams play through a bare <audio> element (see
 * neurospicy.ts), OUTSIDE the Web Audio graph — so no CORS is needed for playback
 * and the level meter (a local-song feature) stays dark for radio.
 *
 * We resolve the actual stream URL from SomaFM's per-channel .pls at play time
 * (CORS is open on api.somafm.com), so we never ship a stale hard-coded server.
 * Please keep the SomaFM attribution + support link in the UI — they're free and
 * listener-supported.
 */
export interface RadioStation {
  /** Stable id, namespaced `radio/somafm/<channel>`. */
  id: string;
  name: string;
  /** SomaFM playlist URL; File1= inside is the current stream endpoint. */
  pls: string;
  /** One-line vibe, for the picker. */
  desc: string;
}

export const SOMAFM_HOME = 'https://somafm.com';

/** Curated Neurospicy-lane channels — mostly ambient/downtempo, plus a few lounge/beats picks. */
export const RADIO_STATIONS: RadioStation[] = [
  { id: 'radio/somafm/groovesalad',  name: 'Groove Salad',       pls: 'https://api.somafm.com/groovesalad130.pls',  desc: 'ambient / downtempo' },
  { id: 'radio/somafm/dronezone',    name: 'Drone Zone',         pls: 'https://api.somafm.com/dronezone130.pls',    desc: 'atmospheric ambient' },
  { id: 'radio/somafm/spacestation', name: 'Space Station Soma', pls: 'https://api.somafm.com/spacestation130.pls', desc: 'spaced-out ambient' },
  { id: 'radio/somafm/deepspaceone', name: 'Deep Space One',     pls: 'https://api.somafm.com/deepspaceone130.pls', desc: 'deep-space ambient' },
  { id: 'radio/somafm/fluid',        name: 'Fluid',              pls: 'https://api.somafm.com/fluid130.pls',        desc: 'instrumental hip-hop' },
  { id: 'radio/somafm/lush',         name: 'Lush',               pls: 'https://api.somafm.com/lush130.pls',         desc: 'mellow vocal chill' },
  { id: 'radio/somafm/secretagent',  name: 'Secret Agent',       pls: 'https://api.somafm.com/secretagent130.pls',  desc: 'lounge / spy jazz' },
  { id: 'radio/somafm/defcon',       name: 'DEF CON Radio',      pls: 'https://api.somafm.com/defcon130.pls',       desc: 'beats for hacking' },
];

/** True for a Neurospicy track id that's a radio station (vs a catalog asset). */
export function isRadioId(id: string): boolean {
  return id.startsWith('radio/');
}

export function radioStation(id: string): RadioStation | undefined {
  return RADIO_STATIONS.find((s) => s.id === id);
}

/** Are we online right now? Radio is hidden/disabled when not. */
export function radioAvailable(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/** Resolve a .pls to its first stream URL (CORS-open). Throws on network/parse failure. */
export async function resolveStreamUrl(pls: string): Promise<string> {
  const res = await fetch(pls);
  if (!res.ok) throw new Error(`playlist ${res.status}`);
  const text = await res.text();
  const m = text.match(/^\s*File\d+\s*=\s*(\S+)/im);
  if (!m) throw new Error('no stream URL in playlist');
  return m[1]!.trim();
}
