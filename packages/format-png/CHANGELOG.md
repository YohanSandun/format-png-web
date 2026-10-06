# Changelog

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
