// SPDX-License-Identifier: MPL-2.0
/**
 * deep-link - the one lolly:// grammar every intake (desktop poll loop, Android
 * bridge, iOS queue) routes through.
 *
 * Run with: node --test shells/web/src/lib/deep-link.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deepLinkToHash } from './deep-link.ts';

test('tool forms: t/, tool/, a bare id, and the embed extension', () => {
  assert.equal(deepLinkToHash('lolly://tool/qr-code?url=x'), '#/tool/qr-code?url=x');
  assert.equal(deepLinkToHash('lolly://t/qr-code?url=x'), '#/tool/qr-code?url=x', 'the canonical short form lands on the same route');
  assert.equal(deepLinkToHash('lolly://qr-code'), '#/tool/qr-code', 'a bare id is a tool');
  assert.equal(deepLinkToHash('lolly://design?z=1abc'), '#/tool/design?z=1abc', 'design rides the bare-id form');
  assert.equal(deepLinkToHash('lolly://tool/qr-code.svg?url=x'), '#/tool/qr-code?url=x&format=svg', 'an embed extension becomes format=');
  assert.equal(deepLinkToHash('lolly://tool/qr-code.png?format=svg'), '#/tool/qr-code?format=svg', 'an explicit format= wins over the extension');
});

test('app routes: any word from the frozen route vocabulary, query kept, fragment dropped', () => {
  assert.equal(deepLinkToHash('lolly://lab'), '#/lab');
  assert.equal(deepLinkToHash('lolly:///lab'), '#/lab', 'a third slash is tolerated');
  assert.equal(deepLinkToHash('lolly://verify?asset=lolly/logo/primary'), '#/verify?asset=lolly/logo/primary');
  assert.equal(deepLinkToHash('lolly://docs/build/authoring-tools'), '#/docs/build/authoring-tools');
  assert.equal(deepLinkToHash('lolly://profile/?focus=offline-section'), '#/profile?focus=offline-section', 'a trailing slash is dropped');
  assert.equal(deepLinkToHash('lolly://profile#anything'), '#/profile', 'a fragment inside a hash route is meaningless');
});

test('a copied https link turned into the scheme keeps working, host and all', () => {
  assert.equal(deepLinkToHash('lolly://lolly.tools/t/qr-code?url=x'), '#/tool/qr-code?url=x');
  assert.equal(deepLinkToHash('lolly://www.lolly.tools/lab'), '#/lab');
  assert.equal(deepLinkToHash('lolly://lolly.art/verify'), '#/verify');
  assert.equal(deepLinkToHash('lolly://lolly.tools'), null, 'the site root is not a route');
});

test('refused: not the scheme, invented routes, half addresses, injection characters, oversize', () => {
  assert.equal(deepLinkToHash('https://lolly.tools/t/qr-code'), null, 'only the scheme is a deep link');
  assert.equal(deepLinkToHash('lolly://'), null);
  assert.equal(deepLinkToHash('lolly://not-a-route/anything'), null, 'two segments that are neither a tool nor a route word');
  assert.equal(deepLinkToHash('lolly://tool/'), null, 'tool with no id');
  assert.equal(deepLinkToHash('lolly://t/Bad_Id'), null, 'an id outside the manifest grammar');
  assert.equal(deepLinkToHash('lolly://tool/qr-code/extra'), null, 'a tool address has exactly one id');
  assert.equal(deepLinkToHash('lolly://tool/qr-code?url=<script>'), null);
  assert.equal(deepLinkToHash('lolly://lab?x="y"'), null);
  assert.equal(deepLinkToHash('lolly://lab?x=a b'), null);
  assert.equal(deepLinkToHash(`lolly://lab?x=${'a'.repeat(5000)}`), null);
  assert.equal(deepLinkToHash(42 as unknown as string), null);
});
