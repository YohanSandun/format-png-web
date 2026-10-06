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
- **Runs off the main thread** with a built-in worker pool, so large images don't freeze the page.
- **No dependencies.** About 130 kB packed, mostly the WebAssembly module. Ships with TypeScript types.

## Install

```sh
npm install format-png
```

## Load the module

Call `init()` once before anything else. It works the same in browsers, bundlers (Vite, webpack, Rollup, esbuild), Web Workers and Node 20.6 and later: the WebAssembly module is embedded in the package, so nothing is fetched and no bundler setup is needed.

```js
import { init } from "format-png";

await init();
```

`init` also takes a compiled `WebAssembly.Module`, for example one a page compiled once and posted to its workers.

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

Each instance runs on the thread that created it. To decode or encode in parallel, use the async functions or a worker pool.

## Off the main thread

WebAssembly runs on the thread that calls it, so decoding or encoding a large PNG with the functions above blocks the page until it's done. Each function has an async version that runs it in a Web Worker instead (worker_threads in Node):

```js
import { decodeRgba8Async, encodeRgba8Async } from "format-png";

decodeRgba8Async(bytes).then((image) => {
    // the same RgbaImage as decodeRgba8(bytes)
});

const png = await encodeRgba8Async(imageData, { compression: 9 });
```

`decodeAsync`, `decodeRgba8Async`, `encodeAsync`, `encodeRgba8Async`, `readChunksAsync`, `readHeaderAsync` and `parseTextAsync` take the same arguments and options as the functions they're named after, resolve to the same results, and reject with the same `PngError`.

You don't need to call `init()` or set anything up. The functions share one worker pool, created on first use with the default size. Its workers start only as jobs need them, so one call starts one worker. To free the workers and their memory, call `terminateDefaultWorkerPool()`; the next call starts a new pool. `defaultWorkerPool()` returns that pool.

### Worker pools

For control over the workers, such as their number, or a pool per part of your app that you terminate separately, create a pool:

```js
import { createWorkerPool } from "format-png";

const pool = createWorkerPool(); // or { size: 4 }

const image = await pool.decodeRgba8(bytes);
const png = await pool.encodeRgba8(image, { palette: "auto" });
const pngs = await Promise.all(frames.map((frame) => pool.encodeRgba8(frame, { compression: 9 })));

await pool.terminate();
```

- **The same API, async.** A pool's `decode`, `decodeRgba8`, `encode`, `encodeRgba8`, `readChunks`, `readHeader` and `parseText` methods work like the async functions.
- **No `init()` needed.** Each worker loads the embedded WebAssembly module itself.
- **Size.** By default, one worker per CPU core (`navigator.hardwareConcurrency`, or `os.availableParallelism()` in Node), at most 8.
- **Lazy workers.** Creating a pool starts nothing. Workers start as jobs need them, up to `size`, and then stay alive between jobs, each keeping its own decoders and encoders, so a batch keeps their buffer reuse.
- **A queue.** When every worker is busy, jobs wait and start in the order they were submitted.
- **Node.** An idle pool doesn't keep the process alive, but call `terminate()` to free the workers' memory.

### When to use which

Use the async functions or a pool for large images, for batches that can run in parallel, and whenever the page has to stay responsive. Use the sync functions for small images such as icons: posting the bytes to a worker and back costs more than decoding them, and the sync call returns in well under a frame.

WebAssembly memory never shrinks, so each worker keeps as much as the largest image it handled until the pool is terminated. For very large images, use a smaller pool, or a short-lived one, or call `terminateDefaultWorkerPool()` when you're done.

### Copying and transferring buffers

By default the input bytes (or `image.data` for `encode` and `encodeRgba8`) are **copied** to the worker, so you can keep using them. Results always come back without a copy.

With `transfer: true`, the input's `ArrayBuffer` is **moved** to the worker instead, which saves the copy:

```js
const image = await decodeRgba8Async(bytes, { transfer: true });
bytes.byteLength; // 0: the buffer is detached as soon as decodeRgba8 is called
```

> [!WARNING]
> Transferring detaches the **whole** `ArrayBuffer`, including every other view of it, as soon as the method is called. It can't be a `SharedArrayBuffer`. In Node, don't transfer a small `Buffer` made by `Buffer.from` or `Buffer.allocUnsafe`: it may share Node's internal buffer pool.

`readChunks` returns each chunk's `data` as a view into its input, just as the sync function does: into your `bytes` by default, or into the buffer moved back from the worker with `transfer: true`.

### Cancelling and errors

Pass a `signal` to cancel a job. A queued job leaves the queue; a running one has its worker stopped and replaced, because WebAssembly can't be interrupted. The job rejects with `signal.reason`.

```js
const controller = new AbortController();
const job = encodeRgba8Async(image, { compression: 9, signal: controller.signal });
controller.abort(); // job rejects with an AbortError
```

Failures that come from the pool rather than the PNG reject with a `WorkerPoolError`:
- `code: "terminated"`: the pool was terminated. This applies to queued and running jobs, and to every call after `terminate()`.
- `code: "worker-crashed"`: the worker stopped unexpectedly. The pool starts a new one for the next job.

### Bundlers

Pools start their workers with `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })`.
- **Vite and webpack 5** find and bundle that worker with no setup. With Vite, set `worker: { format: "es" }`.
- **esbuild and Rollup** need it built as a second entry, `format-png/worker.js` (the file `node_modules/format-png/dist/worker.js`), given to the pool with `createWorker`:

```js
const pool = createWorkerPool({
    createWorker: () => new Worker(new URL("./worker.js", import.meta.url), { type: "module" }),
});
```

`createWorker` also lets you start workers your own way. In Node it may return a `worker_threads` `Worker`.

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
| `decodeAsync`, `decodeRgba8Async`, `encodeAsync`, `encodeRgba8Async`, `readChunksAsync`, `readHeaderAsync`, `parseTextAsync` | The functions above, in a Web Worker or worker_thread, returning promises. |
| `createWorkerPool(options?)` | A pool of workers with the same async methods, for control over the workers. |
| `defaultWorkerPool()`, `terminateDefaultWorkerPool()` | The pool behind the async functions, and a way to free it. |

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

The package is ES2022 with WebAssembly: Chrome and Edge 85, Firefox 90, Safari 14.1 and later. Worker pools use module workers: Firefox 114 and Safari 15 or later, and Safari 15.4 for `transfer: true`. A pool can also be created inside a Web Worker.

## License

MIT
