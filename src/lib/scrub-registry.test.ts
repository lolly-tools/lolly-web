// SPDX-License-Identifier: MPL-2.0
/**
 * scrub-registry.test.ts - the bounds and the audio rule.
 *
 * Everything here is memory-only and synchronous, so it is fully provable in
 * node. Two properties matter and neither is cosmetic:
 *
 *  • EVERY map is bounded, and evicting a proxy URL REVOKES it. A proxy object
 *    URL pins its whole blob (a 60 s proxy is ~15 MB); an unbounded cache is
 *    hundreds of megabytes of unreachable blob data with no way to drop it short
 *    of a reload.
 *  • A proxy whose audio was discarded by the transcode must not answer a
 *    WAVEFORM read. It would draw flat silence over a clip that exports with
 *    sound - a lie in the UI, and one nothing else would ever catch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  noteScrubSource, scrubSourceId, peekScrubUrl, setProxyUrl, proxyUrlFor,
  markNoProxy, isKnownNoProxy, clearNoProxy, revokeProxyUrl, resetScrubCache,
  SCRUB_REGISTRY_LIMIT, PROXY_URL_LIMIT, NO_PROXY_LIMIT,
} from './scrub-registry.ts';

/** Record every revoke so eviction can be proven, not assumed. */
function captureRevokes(): { urls: string[]; restore: () => void } {
  const g = globalThis as { URL?: { revokeObjectURL?: (u: string) => void } };
  const urls: string[] = [];
  const had = typeof g.URL !== 'undefined';
  const prev = had ? g.URL!.revokeObjectURL : undefined;
  if (!had) (g as { URL?: unknown }).URL = {};
  (g.URL as { revokeObjectURL?: (u: string) => void }).revokeObjectURL = (u: string) => { urls.push(u); };
  return {
    urls,
    restore: () => {
      if (!had) delete (g as { URL?: unknown }).URL;
      else (g.URL as { revokeObjectURL?: unknown }).revokeObjectURL = prev;
    },
  };
}

test('the url→id registry is bounded, oldest-out', () => {
  resetScrubCache();
  for (let i = 0; i < SCRUB_REGISTRY_LIMIT + 10; i++) noteScrubSource(`blob:${i}`, `user/${i}`);
  assert.equal(scrubSourceId('blob:0'), undefined, 'the oldest pairing was dropped');
  assert.equal(scrubSourceId(`blob:${SCRUB_REGISTRY_LIMIT + 9}`), `user/${SCRUB_REGISTRY_LIMIT + 9}`);
  // A dropped pairing costs a wasted lookup, never a wrong picture: the swap is
  // keyed by asset id, so a URL we no longer recognise simply returns itself.
  assert.equal(peekScrubUrl('blob:0'), 'blob:0');
  resetScrubCache();
});

test('re-noting a url moves it to the front rather than duplicating it', () => {
  resetScrubCache();
  noteScrubSource('blob:a', 'user/a');
  noteScrubSource('blob:b', 'user/b');
  noteScrubSource('blob:a', 'user/a');
  for (let i = 0; i < SCRUB_REGISTRY_LIMIT - 1; i++) noteScrubSource(`blob:f${i}`, `user/f${i}`);
  assert.equal(scrubSourceId('blob:a'), 'user/a', 'the refreshed entry outlived the older one');
  assert.equal(scrubSourceId('blob:b'), undefined);
  resetScrubCache();
});

test('the proxy URL cache is bounded AND revokes what it evicts', () => {
  resetScrubCache();
  const cap = captureRevokes();
  try {
    for (let i = 0; i < PROXY_URL_LIMIT + 3; i++) setProxyUrl(`user/${i}`, `blob:proxy${i}`, true);
    assert.equal(cap.urls.length, 3, 'every eviction revoked its object URL - a blob left pinned is megabytes');
    assert.deepEqual(cap.urls, ['blob:proxy0', 'blob:proxy1', 'blob:proxy2']);
    assert.equal(proxyUrlFor('user/0'), undefined);
    assert.equal(proxyUrlFor(`user/${PROXY_URL_LIMIT + 2}`), `blob:proxy${PROXY_URL_LIMIT + 2}`);
  } finally {
    cap.restore();
    resetScrubCache();
  }
});

test('replacing an asset’s proxy URL revokes the previous one', () => {
  resetScrubCache();
  const cap = captureRevokes();
  try {
    setProxyUrl('user/x', 'blob:old', true);
    setProxyUrl('user/x', 'blob:new', true);
    assert.deepEqual(cap.urls, ['blob:old']);
    assert.equal(proxyUrlFor('user/x'), 'blob:new');
  } finally {
    cap.restore();
    resetScrubCache();
  }
});

test('peekScrubUrl swaps for a filmstrip, but NOT for a waveform when the proxy lost its audio', () => {
  resetScrubCache();
  noteScrubSource('blob:src', 'user/clip');
  setProxyUrl('user/clip', 'blob:proxy', false);   // WebM proxy of an AAC source
  assert.equal(peekScrubUrl('blob:src'), 'blob:proxy', 'pictures still come from the proxy');
  assert.equal(peekScrubUrl('blob:src', { audio: true }), 'blob:src',
    'a waveform must read the ORIGINAL rather than draw flat silence over audible sound');

  setProxyUrl('user/clip', 'blob:proxy2', true);   // a proxy that kept its audio
  assert.equal(peekScrubUrl('blob:src', { audio: true }), 'blob:proxy2');
  resetScrubCache();
});

test('an unregistered url, and a registered one with no proxy, are returned unchanged', () => {
  resetScrubCache();
  assert.equal(peekScrubUrl('blob:unknown'), 'blob:unknown');
  noteScrubSource('blob:known', 'user/known');
  assert.equal(peekScrubUrl('blob:known'), 'blob:known');
  resetScrubCache();
});

test('the no-proxy memo is bounded, and a built proxy clears it', () => {
  resetScrubCache();
  markNoProxy('user/a');
  assert.equal(isKnownNoProxy('user/a'), true);
  // THE POISONING BUG: a clip dropped on the timeline while its idle transcode is
  // still running memoises "no proxy". Nothing but this clears it, and without the
  // clear the very upload the feature exists for never uses its own proxy.
  clearNoProxy('user/a');
  assert.equal(isKnownNoProxy('user/a'), false);

  markNoProxy('user/a');
  setProxyUrl('user/a', 'blob:p', true);
  assert.equal(isKnownNoProxy('user/a'), false, 'priming a URL also clears the memo');

  for (let i = 0; i < NO_PROXY_LIMIT + 5; i++) markNoProxy(`user/n${i}`);
  assert.equal(isKnownNoProxy('user/n0'), false, 'the memo does not grow without bound');
  resetScrubCache();
});

test('revokeProxyUrl and resetScrubCache both release every blob they hold', () => {
  resetScrubCache();
  const cap = captureRevokes();
  try {
    setProxyUrl('user/a', 'blob:a', true);
    setProxyUrl('user/b', 'blob:b', true);
    revokeProxyUrl('user/a');
    assert.deepEqual(cap.urls, ['blob:a']);
    assert.equal(proxyUrlFor('user/a'), undefined);
    resetScrubCache();
    assert.deepEqual(cap.urls, ['blob:a', 'blob:b'], 'teardown revokes the rest');
    assert.equal(proxyUrlFor('user/b'), undefined);
  } finally {
    cap.restore();
    resetScrubCache();
  }
});
