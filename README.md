# format-png-web

[![npm](https://img.shields.io/npm/v/format-png.svg)](https://www.npmjs.com/package/format-png)
[![CI](https://github.com/YohanSandun/format-png-web/actions/workflows/ci.yml/badge.svg)](https://github.com/YohanSandun/format-png-web/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A fast, lossless PNG decoder and encoder for the browser and Node, compiled to
WebAssembly from the [`format-png`](https://github.com/YohanSandun/format-png-rust)
Rust crate. This repository holds the [`format-png`](https://www.npmjs.com/package/format-png)
npm package and a demo of everything it does.

**📖 Documentation: the [package README](packages/format-png/README.md)**, also on
[npmjs.com](https://www.npmjs.com/package/format-png). It covers loading the
module, every function and option, and error handling. See the
[changelog](packages/format-png/CHANGELOG.md) for what's new.

## Quick start

```sh
npm install format-png
```

```js
import { init, decodeRgba8, encodeRgba8, toImageData } from "format-png";

await init(); // once, before anything else

// Show a PNG on a canvas.
const bytes = new Uint8Array(await (await fetch("image.png")).arrayBuffer());
const image = decodeRgba8(bytes);
canvas.width = image.width;
canvas.height = image.height;
canvas.getContext("2d").putImageData(toImageData(image), 0, 0);

// Save the canvas as a PNG.
const png = encodeRgba8(canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height));
```

## What it does

- **Decodes every PNG:** every color type, bit depth from 1 to 16, and Adam7
  interlacing, to 8-bit RGBA for a canvas or in the file's own format.
- **Encodes losslessly**, 16-bit included, with control over compression and filters.
- **Reads every chunk** without decompressing the image, and writes metadata back:
  color space, ICC profiles, Exif, text and your own chunks.
- **Makes files smaller:** palette conversion and chunk stripping, without
  changing a pixel.
- **No dependencies**, about 130 kB packed, with TypeScript types.

Try it in the [demo](examples/demo), which has a tab for each feature: inspect,
decode, encode and minimize.

## Repository layout

| Path | What it is |
|---|---|
| [`packages/format-png`](packages/format-png) | The npm package: TypeScript API, types and the `.wasm` module. |
| [`crates/format-png-wasm`](crates/format-png-wasm) | The Rust bindings the package wraps, built with `wasm-bindgen`. |
| [`examples/demo`](examples/demo) | A Vite app with a tab per feature: inspect chunks, decode, encode and minimize. |

The PNG codec itself is the [`format-png`](https://crates.io/crates/format-png)
crate, in [its own repository](https://github.com/YohanSandun/format-png-rust).

## Develop

You need Rust with the `wasm32-unknown-unknown` target, `wasm-bindgen-cli` 0.2.128 (matching the crate's `wasm-bindgen`), and Node 20.6 or later. The `format-png` crate is expected next to this repository, at `../format-png`.

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.128
npm install

npm run build             # the wasm module and the package
npm test                  # the package's tests
npm run dev -w demo       # the demo, at http://localhost:5173
```

`prepublishOnly` rebuilds the package and runs the unit tests. It also runs `test:package`, which packs the package, installs the tarball into an empty project, and uses it from Node.

CI builds against a pinned commit of the crate, set in
[`.github/actions/setup/action.yml`](.github/actions/setup/action.yml). Update
it when the crate changes.

## Release

Pushing a version tag stages the package on npm through
[`.github/workflows/publish.yml`](.github/workflows/publish.yml), using trusted
publishing, so no npm token is stored in the repository:

```sh
# Bump the version and add it to packages/format-png/CHANGELOG.md:
npm version 0.1.3 -w format-png --no-git-tag-version
# Commit, push, then:
git tag -a v0.1.3 -m "format-png 0.1.3"
git push origin v0.1.3
```

The staged version isn't live until a maintainer approves it with 2FA, on
[npmjs.com](https://www.npmjs.com/package/format-png) or with
`npm stage approve <stage-id>`. Running the workflow by hand from the Actions tab
does everything but stage it: a dry run.

## License

MIT. See [LICENSE](LICENSE).
