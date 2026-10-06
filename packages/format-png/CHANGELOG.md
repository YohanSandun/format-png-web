# Changelog

## 0.1.3

- The WebAssembly module is embedded in the package, and `init()` with no
  argument uses it, in browsers, bundlers and Node alike. Nothing is fetched:
  the package makes no network requests, and Vite no longer needs
  `optimizeDeps.exclude`. Node no longer needs to read the `.wasm` file.
- **Breaking:** `init` no longer takes a URL or string to fetch the module
  from. Pass a `Response` instead, for example `init(fetch(url))`.

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
