# Changelog

## 0.4.0

Animated PNG (APNG) support, and worker pools that encode one large image on
all their workers. Built on the format-png crate 0.3.0.

### Animated PNG

- `decodeAnimationRgba8` decodes every frame of an APNG as a viewer shows
  it: drawn onto the canvas with its disposal and blending, as a whole canvas
  of 8-bit RGBA. It returns an `RgbaAnimation` of `RgbaFrame`s, each with its
  delay, and the number of plays.
- `decodeAnimation` decodes every frame as the file stores it, in its own
  pixel format, with its `fcTL` fields: size, position, delay, `dispose` and
  `blend`. It returns a `RawAnimation`, with the palette, transparency,
  metadata and chunks the frames share, and the default image if it isn't the
  first frame.
- `encodeAnimation` and `encodeAnimationRgba8` write an APNG from frames
  with positions, delays, disposal and blending, the number of plays, and an
  optional separate default image. A decoded `RawAnimation` or
  `RgbaAnimation` works as it is, and `encodeAnimation(decodeAnimation(bytes))`
  writes the same frames back.
- `cropFrames` encode option: crops each frame to the area that changed since
  the frame before, which makes animations of whole-canvas frames, such as
  those from `decodeAnimationRgba8`, much smaller. What viewers show doesn't
  change. `palette: "auto"` also applies to animations: they're written as
  indexed color when all their frames have at most 256 colors between them.
- `readChunks` returns an APNG's `animationControl` (`numFrames`,
  `numPlays`) and every frame's `frameControls`, without decoding anything.
- `frameDelayMs(frame)` gives a frame's delay in milliseconds.
- `PngDecoder` has `decodeAnimation` and `decodeAnimationRgba8`, and
  `PngEncoder` has `encodeAnimation` and `encodeAnimationRgba8`.
- Async versions run in the worker pool: `decodeAnimationAsync`,
  `decodeAnimationRgba8Async`, `encodeAnimationAsync` and
  `encodeAnimationRgba8Async`, and the pool methods of the same names. With
  `transfer: true`, every frame's buffer moves, even when frames share one.
- Types: `RawAnimation`, `RawFrame`, `RgbaAnimation`, `RgbaFrame`,
  `PngAnimation`, `PngFrame`, `RgbaAnimationInput`, `RgbaFrameInput`,
  `FrameControl`, `DisposeOp` and `BlendOp`.

### Faster

- A pool, and the async functions, compress a large image's data in 1 MiB
  segments across all the workers. A 2500x3800 photo-like image at level 6,
  in Node on a 20-core machine: 7.8 s on one worker, 4.3 s on two, 2.7 s on
  four, 2.0 s on eight (3.8x). Images with 1 MiB of filtered data or less are
  encoded whole, as before.
- Jobs take turns: while a large image is split, other jobs still start as
  soon as a worker is free, in the order they were submitted.

### Changed

- A pool's `encode` and `encodeRgba8`, and `encodeAsync` and
  `encodeRgba8Async`, default to `threads: "auto"`. For large images the file
  is a little larger (about 0.1% for that photo) and its bytes differ from the
  sync `encode`'s. Pass `threads: "single"` for the sync function's bytes.
- Cancelling a running job no longer stops its worker if that worker holds
  an image another job is splitting: the task finishes, and its result is
  dropped. The job still rejects at once.
- `readChunks` marks `acTL`, `fcTL` and `fdAT` chunks `known: true`.
- Raw `acTL`, `fcTL` and `fdAT` chunks given to `encode` are never written,
  even with `keepUnsafeChunks`. Re-encoding a decoded APNG with its chunks
  kept used to write the old animation chunks around the new image data,
  making a broken animation; it now writes a still image. Use
  `decodeAnimation` and `encodeAnimation` to keep the animation.

### Added

- `threads` encode option: "single" (the default for the sync API) or
  "auto", as the crate's `Threads`. In WebAssembly, "auto" isn't faster on its
  own; it gives the same bytes as a pool.

### Other

- Built against the format-png crate 0.3.0 (from 0.1.1).
- The WebAssembly module is 317 kB, up from 261 kB, and the package is about
  215 kB packed.
- `npm run bench:pool` times a pool splitting one image, at several sizes.

## 0.3.0

An async API that runs format-png in Web Workers, or worker_threads in Node,
so large images don't block the main thread. The sync API is unchanged.

### Added

- Async versions of the functions: `decodeAsync`, `decodeRgba8Async`,
  `encodeAsync`, `encodeRgba8Async`, `readChunksAsync`, `readHeaderAsync` and
  `parseTextAsync`. They need no setup: they share one worker pool, created on
  first use. `terminateDefaultWorkerPool()` frees it, and
  `defaultWorkerPool()` returns it.
- `createWorkerPool(options?)` returns a pool with async versions of `decode`,
  `decodeRgba8`, `encode`, `encodeRgba8`, `readChunks`, `readHeader` and
  `parseText`. They take the same arguments and options, resolve to the same
  results, and reject with the same `PngError`.
- Pools need no `init()`: each worker loads the embedded module. By default a
  pool has one worker per CPU core, at most 8.
- Workers start as jobs need them and stay alive until `terminate()`, each
  reusing its decoders and encoders. Jobs queue when every worker is busy and
  start in the order they were submitted.
- Inputs are copied to the worker by default. With `transfer: true` they're
  moved instead, which detaches the caller's buffer. Results always come back
  without a copy.
- Pass `signal` to cancel a queued or running job.
- `WorkerPoolError` with `code` "terminated" (rejected by `terminate()`, and
  by calls after it) or "worker-crashed" (the pool replaces the worker).
- `createWorker` option, for bundlers that don't bundle
  `new Worker(new URL(..., import.meta.url))`, such as esbuild and Rollup.
  Vite and webpack 5 need no setup.

### Faster

The WebAssembly module is now optimized for speed rather than size
(`opt-level = 3`). Outputs are byte for byte the same. Measured with
`npm run bench` in Node 22, on 2500x3800 RGBA images:

| | Photo-like | Smooth |
|---|---|---|
| `decodeRgba8` | 304 → 195 ms (36% faster) | 137 → 72 ms (48% faster) |
| Encode, level 6 | 7.3 → 7.1 s (3% faster) | 1.01 → 0.86 s (15% faster) |
| Encode, level 9 | 16.5 → 16.0 s (3% faster) | 15.6 → 14.9 s (5% faster) |
| Encode, filter "none" | 1.50 → 1.43 s (5% faster) | unchanged |

The module is 261 kB, up from 229 kB, and the package is about 170 kB packed.

### Other

- A `PngError` now has the underlying WebAssembly error as its `cause`.
- No new runtime dependencies, and no `SharedArrayBuffer` or WebAssembly
  threads, so no COOP/COEP headers are needed.

## 0.2.0

The WebAssembly module is now embedded in the package, and `init()` with no
argument uses it, in browsers, bundlers, Web Workers and Node alike. Nothing is
fetched: the package makes no network requests.

### Breaking

- The `.wasm` file is no longer in the package, so the
  `format-png/format_png_wasm_bg.wasm` export is gone.
- `init` no longer takes a URL or string to fetch the module from. It still
  takes a compiled `WebAssembly.Module`.

### Upgrading

- Node: replace `init(await readFile(...format_png_wasm_bg.wasm...))` with
  `init()`.
- Browsers and bundlers: `init()` keeps working as before. With Vite,
  `optimizeDeps: { exclude: ["format-png"] }` is no longer needed.
- If you passed a URL to `init`, call `init()` instead.

### Other

- The WebAssembly module is a third smaller (229 kB, down from 335 kB): it no
  longer carries symbol names and debug info. Speed is unchanged.

## 0.1.2

- Built against the `format-png` crate 0.1.1. The API and behavior are unchanged.
- Released with npm staged publishing: each version is approved by a maintainer
  with 2FA before it goes live, and is published with provenance.
- README: badges for npm, CI and the license.

## 0.1.1

- The first version released from GitHub Actions, with provenance. The code is
  the same as 0.1.0.

## 0.1.0

The first release: the `format-png` crate compiled to WebAssembly, with a
TypeScript API for decoding, encoding, reading chunks and making PNGs smaller.
