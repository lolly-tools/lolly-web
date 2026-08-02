// SPDX-License-Identifier: MPL-2.0
/**
 * markdownToSpokenText is the dialog's one pure piece — the rest is element
 * wiring over host.speech, verified in a real browser. What matters here is the
 * speech contract: structure goes, words stay, and nothing unspeakable (code,
 * image URLs, table plumbing) leaks into the synthesized clip.
 *
 * The module imports its stylesheet (a Vite-only construct), so the run relies
 * on the stylesheet-import stub the `test` script registers (tests/css-stub.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToSpokenText, SOFT_CHAR_CAP } from './script-audio.ts';

test('plain text passes through unchanged', () => {
  assert.equal(markdownToSpokenText('Hello there. Two sentences.'), 'Hello there. Two sentences.');
});

test('empty and whitespace-only input come back empty', () => {
  assert.equal(markdownToSpokenText(''), '');
  assert.equal(markdownToSpokenText('   \n\t\n  '), '');
});

test('fenced code blocks drop entirely, including an unterminated one', () => {
  assert.equal(
    markdownToSpokenText('Before.\n```js\nconst x = 1;\n```\nAfter.'),
    'Before.\nAfter.',
  );
  assert.equal(markdownToSpokenText('Before.\n```\nnever closed'), 'Before.');
});

test('images drop, links keep their text', () => {
  assert.equal(
    markdownToSpokenText('See ![a chart](chart.png) and [the docs](https://example.com/docs).'),
    'See and the docs.',
  );
});

test('inline code keeps its content, loses the ticks', () => {
  assert.equal(markdownToSpokenText('Run `npm install` first.'), 'Run npm install first.');
});

test('headings keep their text', () => {
  assert.equal(markdownToSpokenText('## Welcome\n\nBody text.'), 'Welcome\n\nBody text.');
});

test('quote and list markers strip, the words stay', () => {
  assert.equal(
    markdownToSpokenText('> A quote.\n- First\n- Second\n1. Third\n2) Fourth'),
    'A quote.\nFirst\nSecond\nThird\nFourth',
  );
});

test('emphasis markers strip pairwise', () => {
  assert.equal(
    markdownToSpokenText('This is **bold**, *italic*, __also bold__ and ~~gone~~.'),
    'This is bold, italic, also bold and gone.',
  );
});

test('a lone underscore inside a word survives', () => {
  assert.equal(markdownToSpokenText('The snake_case name stays.'), 'The snake_case name stays.');
});

test('horizontal rules drop and are not read as list items', () => {
  assert.equal(markdownToSpokenText('Above.\n\n---\n\nBelow.'), 'Above.\n\nBelow.');
  assert.equal(markdownToSpokenText('Above.\n- - -\nBelow.'), 'Above.\nBelow.');
});

test('table separator rows drop and cell pipes become spaces', () => {
  assert.equal(
    markdownToSpokenText('| Name | Role |\n| --- | --- |\n| Ada | Engineer |'),
    'Name Role\nAda Engineer',
  );
});

test('runs of blank lines collapse to one', () => {
  assert.equal(markdownToSpokenText('One.\n\n\n\nTwo.'), 'One.\n\nTwo.');
});

test('the soft cap is exported and sane', () => {
  assert.equal(typeof SOFT_CHAR_CAP, 'number');
  assert.ok(SOFT_CHAR_CAP >= 1000);
});

// ── Record-side Content Credential (EU AI Act Article 50) ───────────────────
// saveTtsClip signs a sidecar-style store onto the record so the runtime's
// ingredient sweep chains the AI origin into composed exports. The chain
// itself is pinned engine-side (tests/tts-provenance-chain.test.ts); here the
// save path: the store lands on the record with the recipe in the created
// action's parameters, and a signing failure never loses the clip.
import { saveTtsClip, buildTtsCredential, type TtsClip, type ScriptAudioHost } from './script-audio.ts';

const clipFixture = (over: Partial<TtsClip> = {}): TtsClip => ({
  result: { duration: 1.2, words: [], granularity: 'word' } as any,
  wavBlob: new Blob([new TextEncoder().encode('RIFF....WAVEfmt fake')], { type: 'audio/wav' }),
  spokenText: 'Hello from Lolly, this voice is synthetic.',
  voice: 'af_heart',
  speed: 1,
  ...over,
});

function fakeHost(uploads: any[]): ScriptAudioHost {
  return {
    version: '1',
    profile: { get: async () => ({}) },
    log: () => {},
    assets: {
      _uploadUserAsset: async (record: any) => { uploads.push(record); },
      get: async (id: string) => ({ source: 'user', id, type: 'audio', format: 'wav', url: 'blob:x' }),
    },
  } as any;
}

test('saveTtsClip persists a signed credential store carrying the script recipe', async () => {
  const uploads: any[] = [];
  const ref = await saveTtsClip(fakeHost(uploads), clipFixture());
  assert.ok(ref, 'the saved ref resolves');
  assert.equal(uploads.length, 1);
  const rec = uploads[0];
  assert.ok(rec.credential instanceof Uint8Array && rec.credential.length > 0, 'a credential store rides the record');
  assert.equal(rec.credentialFormat, 'wav');
  // The store reads back: AI source type on the created step, the exact
  // script + voice/model/lang in its parameters — the machine-readable mark.
  const { prepareC2paIngredientFromStore, GENERATED_SOURCE_TYPE } = await import('@lolly/engine');
  const ing = prepareC2paIngredientFromStore(rec.credential, rec.credentialFormat);
  assert.equal(ing?.digitalSourceType, GENERATED_SOURCE_TYPE);
  const { collectActionChain } = await import('../../../../engine/src/c2pa-extract.ts');
  const created = collectActionChain(rec.credential).find((s: any) => s.action === 'c2pa.created');
  const params = created?.parameters as Map<string, unknown>;
  assert.equal(params.get('script'), 'Hello from Lolly, this voice is synthetic.');
  assert.equal(params.get('voice'), 'af_heart');
  assert.equal(params.get('model'), 'kokoro-82m-q8');
  assert.equal(params.get('lang'), 'en');
});

test('a signing failure logs and still saves the clip uncredentialed (never-throws posture)', async () => {
  const uploads: any[] = [];
  const clip = clipFixture();
  // Booby-trap the bytes read so buildTtsCredential's try/catch has to absorb it.
  (clip.wavBlob as any).arrayBuffer = async () => { throw new Error('quota'); };
  const ref = await saveTtsClip(fakeHost(uploads), clip);
  assert.ok(ref, 'the clip still saves');
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].credential, undefined, 'no credential fields on a failed signing');
  assert.equal(uploads[0].credentialFormat, undefined);
  assert.equal(uploads[0].aiGenerated, 'full', 'the Gen AI disclosure never depends on signing');
});

test('buildTtsCredential alone returns null on failure, a store on success', async () => {
  const uploads: any[] = [];
  const host = fakeHost(uploads);
  const good = await buildTtsCredential(host, clipFixture());
  assert.ok(good && good.store.length > 0 && good.format === 'wav');
  const bad = clipFixture();
  (bad.wavBlob as any).arrayBuffer = async () => { throw new Error('gone'); };
  assert.equal(await buildTtsCredential(host, bad), null);
});
