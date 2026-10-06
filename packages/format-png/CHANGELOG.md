# Changelog

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
