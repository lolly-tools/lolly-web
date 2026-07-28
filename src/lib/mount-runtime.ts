// SPDX-License-Identifier: MPL-2.0
/**
 * The single chokepoint every tool runtime in the web shell goes through.
 *
 * WHY IT EXISTS
 * `host.color` (v1.40) and `host.geom` (v1.64) are pure engine math attached
 * verbatim to the bridge so web/CLI/Tauri can never drift — but between them
 * they are ~39 KB gz (the ICC/gamut parsers and the whole bezier/boolean
 * kernel), and nothing in this shell ever reads them. Their only consumers are
 * tool hooks. So bridge/index.ts no longer attaches them eagerly; this module
 * installs them (one dynamic import, cached) immediately before the runtime
 * that will run those hooks exists.
 *
 * Both contracts are SYNCHRONOUS — `deltaE` returns a number, `union` returns a
 * path — so they cannot be wrapped in an async facade the way host.images and
 * host.audio are. A pre-mount await is the only shape that keeps tools seeing a
 * fully synchronous `host.geom.union(...)`.
 *
 * THE INVARIANT: no module under shells/web/src may call the engine's
 * `createRuntime` directly. Call this instead. A direct call compiles, typechecks
 * and renders fine — it just silently leaves `host.color`/`host.geom` undefined,
 * and tools feature-detect those, so a colour or vector tool would quietly fall
 * back to its own approximation with no error anywhere. mount-runtime.test.ts
 * greps the source tree to hold the line.
 */
import { createRuntime } from '@lolly/engine';
import { installToolApis } from '../bridge/index.ts';

type CreateRuntime = typeof createRuntime;

/**
 * `createRuntime`, with `host.color`/`host.geom` guaranteed present (or, if
 * their import failed, deliberately absent — tools feature-detect, and a failed
 * optional API must not block the mount).
 */
export const createToolRuntime: CreateRuntime = async (...args) => {
  await installToolApis(args[1] as Parameters<typeof installToolApis>[0]);
  return createRuntime(...args);
};
