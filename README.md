# format-png-web

The [`format-png`](packages/format-png) npm package, the PNG codec from the `format-png` Rust crate compiled to WebAssembly, and a demo of everything it does.

| Path | What it is |
|---|---|
| [`packages/format-png`](packages/format-png) | The npm package: TypeScript API, types and the `.wasm` module. See its [README](packages/format-png/README.md). |
| [`crates/format-png-wasm`](crates/format-png-wasm) | The Rust bindings the package wraps, built with `wasm-bindgen`. |
| [`examples/demo`](examples/demo) | A Vite app with a tab per feature: inspect chunks, decode, encode and minimize. |

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

## Release

Pushing a version tag publishes the package to npm through [`.github/workflows/publish.yml`](.github/workflows/publish.yml):

```sh
# Bump "version" in packages/format-png/package.json and commit it, then:
git tag -a v0.1.1 -m "format-png 0.1.1"
git push origin v0.1.1
```
