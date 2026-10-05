# format-png

[![npm](https://img.shields.io/npm/v/format-png.svg)](https://www.npmjs.com/package/format-png)
[![CI](https://github.com/YohanSandun/format-png-web/actions/workflows/ci.yml/badge.svg)](https://github.com/YohanSandun/format-png-web/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/YohanSandun/format-png-web/blob/main/LICENSE)

A PNG decoder and encoder for the browser and Node, compiled from Rust to WebAssembly.

- **Decodes every PNG:** every color type, bit depth from 1 to 16, and Adam7 interlacing. Decode to 8-bit RGBA for a canvas, or in the file's own format with nothing lost.
- **Encodes losslessly**, with control over compression level, DEFLATE strategy and row filters.
- **Reads every chunk** without decompressing the image: header, palette, transparency, `gAMA`, `cHRM`, `sRGB`, `iCCP`, `cICP`, `pHYs`, `tIME`, `eXIf`, `tEXt`, `zTXt`, `iTXt`, plus private and unknown chunks raw.
- **Writes metadata** back: color space, ICC profiles, Exif, text and your own chunks.
- **Makes files smaller:** converts images with up to 256 colors to a palette, and strips the chunks you don't need, without changing a pixel.
- **No dependencies.** About 130 kB packed, mostly the WebAssembly module. Ships with TypeScript types.

## Install

```sh
npm install format-png
```

## Load the module

Call `init()` once before anything else.

**Browsers and bundlers** (Vite, webpack, Rollup, esbuild): the `.wasm` file is fetched from next to the module.

```js
import { init } from "format-png";

await init();
```

With Vite, exclude the package from dependency pre-bundling, so the module stays next to its `.wasm` file:

```js
// vite.config.js
export default { optimizeDeps: { exclude: ["format-png"] } };
```

**Node 20.6 and later**: pass the file's bytes.

```js
import { readFile } from "node:fs/promises";
import { init } from "format-png";

await init(await readFile(new URL(import.meta.resolve("format-png/format_png_wasm_bg.wasm"))));
```

`init` also takes a URL to fetch the module from, or a compiled `WebAssembly.Module`.

## Display a PNG

```js
import { decodeRgba8, toImageData } from "format-png";

const bytes = new Uint8Array(await (await fetch("image.png")).arrayBuffer());
const image = decodeRgba8(bytes); // { width, height, data: Uint8ClampedArray }

canvas.width = image.width;
canvas.height = image.height;
canvas.getContext("2d").putImageData(toImageData(image), 0, 0);
```

## Encode pixels

`encodeRgba8` takes 8-bit RGBA, for example a canvas's `ImageData`:

```js
import { encodeRgba8 } from "format-png";

const imageData = context.getImageData(0, 0, width, height);
const png = encodeRgba8(imageData, { compression: 9 });

const blob = new Blob([png], { type: "image/png" });
```

## Inspect a file

`readChunks` parses every chunk without decompressing the image data, so it's fast even for large files:

```js
import { readChunks } from "format-png";

const png = readChunks(bytes);
png.header;    // { width, height, bitDepth, colorType, interlaced }
png.metadata;  // { gamma, srgb, iccProfile, cicp, exif, time, text: [...], ... }
png.palette;   // [[r, g, b], ...] for indexed images
png.chunks;    // every chunk in file order: { type, offset, data, crc, known, critical, public, safeToCopy }
```

`readHeader(bytes)` reads only the header. `parseText(type, data)` decodes one text chunk.

## Lossless round trips, 16-bit included

`decodeRgba8` converts to 8 bits per channel, because that's what a canvas holds. To keep the file's own format, use `decode`, and pass the result to `encode`:

```js
import { decode, encode } from "format-png";

const image = decode(bytes, { preserveMetadata: true, preserveChunks: true });
// image.header.bitDepth is 1, 2, 4, 8 or 16; image.data holds the samples as stored.
const copy = encode(image); // the same pixels, metadata and chunks
```

`data` uses the PNG's own layout: rows top to bottom, 16-bit samples big-endian, pixels under 8 bits packed with each row padded to a whole byte, and palette indices for indexed images. Indexed images come with `palette`, and `transparency` holds the `tRNS` chunk.

## Make a PNG smaller

```js
import { decode, encode } from "format-png";

const image = decode(bytes, { preserveMetadata: true, preserveChunks: true });
const smaller = encode(
    { ...image, header: { ...image.header, interlaced: false } },
    { compression: 9, palette: "auto", strip: "safe" },
);
```

- `palette: "auto"` writes 8-bit RGB and RGBA images with at most 256 colors as indexed color, at the smallest bit depth that fits. Small images are also encoded as given, and the smaller file wins.
- `strip` leaves out ancillary chunks:
  - `"keep"` writes everything (the default).
  - `"safe"` keeps what changes how the image looks (`cICP`, `iCCP`, `sRGB`, `gAMA`, `cHRM`, `pHYs`) and drops text, `tIME`, `eXIf` and private chunks.
  - `"all"` keeps only what the pixels need.
- Interlacing almost always makes files bigger, and turning it off doesn't change the pixels.
- To squeeze out the last bytes, try each `filter` and keep the smallest result.

## Metadata

Decode with `preserveMetadata: true` to get `metadata`, or use `readChunks`, which always parses it. To write metadata, pass it with the image:

```js
const png = encodeRgba8({
    width,
    height,
    data,
    metadata: {
        srgb: "perceptual",
        physicalDimensions: { x: 3780, y: 3780, unit: "meter" }, // 96 ppi
        iccProfile: { name: "Display P3", profile: iccBytes },
        text: [
            { keyword: "Title", text: "Sunset" },
            { keyword: "Title", text: "Solnedgang", chunkType: "iTXt", languageTag: "nb", translatedKeyword: "Tittel" },
        ],
    },
    // Your own chunks: a lowercase second letter marks them private.
    chunks: [{ type: "myAp", data: settingsBytes, position: "after-image-data" }],
});
```

## Many images

`PngDecoder` and `PngEncoder` keep their buffers in WebAssembly memory between images. Call `free()` when you're done with them.

```js
import { PngEncoder } from "format-png";

const encoder = new PngEncoder({ compression: 9, palette: "auto" });
const pngs = frames.map((frame) => encoder.encodeRgba8(frame));
encoder.free();
```

Each instance runs on the thread that created it. To encode in parallel, use one per Web Worker, each with its own `init()`.

## API

| Function | What it does |
|---|---|
| `init(source?)` | Loads the WebAssembly module. |
| `decodeRgba8(bytes, options?)` | Decodes to 8-bit RGBA, with optional metadata and raw chunks. |
| `decode(bytes, options?)` | Decodes in the file's own format, losslessly. |
| `readHeader(bytes)` | Reads only `IHDR`. |
| `readChunks(bytes, options?)` | Reads and parses every chunk, without decompressing the image. |
| `parseText(type, data)` | Decodes a `tEXt`, `zTXt` or `iTXt` chunk. |
| `encodeRgba8(image, options?)` | Encodes 8-bit RGBA, such as an `ImageData`. |
| `encode(image, options?)` | Encodes any color type and bit depth, with palette, transparency, metadata and chunks. |
| `toImageData(image)` | Wraps decoded RGBA for `putImageData`. Browser only. |
| `pixelsPerInch(dimensions)` | Converts `pHYs` to pixels per inch. |
| `PngDecoder`, `PngEncoder` | Reusable decoder and encoder. |

**Decode options:**
- `validateCrc` (default `true`): check each chunk's checksum.
- `preserveMetadata`: parse known ancillary chunks into `metadata`.
- `preserveChunks`: keep every ancillary chunk raw in `chunks`.
- `strictAncillary`: throw for an invalid, misplaced or repeated metadata chunk instead of skipping it.

**Encode options:**

| Option | Values | Default |
|---|---|---|
| `compression` | `0` (none) to `9` (smallest) | `6` |
| `compressionStrategy` | `"dynamic"`, `"fixed"`, `"stored"` | `"dynamic"` |
| `filter` | `"adaptive"`, `"none"`, `"sub"`, `"up"`, `"average"`, `"paeth"` | `"adaptive"` |
| `palette` | `"keep"`, `"auto"` | `"keep"` |
| `strip` | `"keep"`, `"safe"`, `"all"` | `"keep"` |
| `keepUnsafeChunks` | Also write raw chunks whose data depends on the pixels, such as `bKGD` and `sBIT`. Only when the pixels are unchanged. | `false` |

Every type is exported, and documented in the bundled `.d.ts` file.

## Errors

Malformed PNGs, and images that can't be encoded, throw a `PngError` whose `message` says what's wrong:

```js
import { decodeRgba8, PngError } from "format-png";

try {
    decodeRgba8(bytes);
} catch (error) {
    if (error instanceof PngError) console.warn(`Not a valid PNG: ${error.message}`);
}
```

## Browser support

The package is ES2022 with WebAssembly: Chrome and Edge 85, Firefox 90, Safari 14.1 and later.

## License

MIT
