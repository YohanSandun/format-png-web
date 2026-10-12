import {
    PngEncoder,
    WorkerPoolError,
    createWorkerPool,
    decodeAnimationRgba8Async,
    decodeRgba8,
    encodeAnimation,
    encodeAnimationRgba8Async,
    encodeRgba8,
    frameDelayMs,
    init,
    parseText,
    pixelsPerInch,
    readChunks,
    readHeader,
    toImageData,
    type Cicp,
    type EncodeOptions,
    type FrameControl,
    type PhysicalDimensions,
    type PngChunks,
    type PngFrame,
    type PngHeader,
    type PngRawChunk,
    type PngText,
    type PngTime,
    type PngTransparency,
    type PngImage,
    type RawAnimation,
    type RawImage,
    type RgbaAnimation,
    type RgbaImage,
    type RgbaImageInput,
    type StripChunks,
    type WorkerPool,
} from "format-png";
import "./style.css";

await init();

function element<T extends HTMLElement>(id: string): T {
    return document.getElementById(id) as T;
}

/** Calls `handle` with the chosen file and its bytes whenever the input changes. */
function onFile(input: HTMLInputElement, handle: (file: File, bytes: Uint8Array) => void) {
    input.addEventListener("change", async () => {
        const file = input.files?.[0];
        if (file) handle(file, new Uint8Array(await file.arrayBuffer()));
    });
}

function showStatus(status: HTMLElement, text: string, isError = false) {
    status.textContent = text;
    status.classList.toggle("error", isError);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

/** A table row with a header cell followed by data cells. */
function fieldRow([name, ...values]: string[]): HTMLTableRowElement {
    const row = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = name;
    row.append(th);
    for (const value of values) {
        const td = document.createElement("td");
        td.textContent = value;
        row.append(td);
    }
    return row;
}

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** Every filter strategy, adaptive first. */
const FILTERS = ["adaptive", "none", "sub", "up", "average", "paeth"] as const;

/** A card with a title and a list of terms and values. */
function infoCard(title: string, entries: [string, string | Node][]): HTMLElement {
    const list = document.createElement("dl");
    for (const [term, value] of entries) {
        const dt = document.createElement("dt");
        dt.textContent = term;
        const dd = document.createElement("dd");
        dd.append(value);
        list.append(dt, dd);
    }
    const heading = document.createElement("h4");
    heading.textContent = title;
    const card = document.createElement("div");
    card.className = "card";
    card.append(heading, list);
    return card;
}

function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/** "identical ✓" in green, or "different ✗" in red. */
function pixelCheck(identical: boolean): HTMLElement {
    const check = document.createElement("span");
    check.className = identical ? "ok" : "bad";
    check.textContent = identical ? "identical ✓" : "different ✗";
    return check;
}

const objectUrls = new WeakMap<HTMLAnchorElement, string>();

/** Points `link` at a PNG of `bytes`, saved as `name`, freeing the PNG it pointed at before. */
function setDownload(link: HTMLAnchorElement, bytes: Uint8Array, name: string) {
    const old = objectUrls.get(link);
    if (old) URL.revokeObjectURL(old);
    const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/png" }));
    objectUrls.set(link, url);
    link.href = url;
    link.download = name;
}

/** `name` without its extension, plus `suffix`. */
const renamed = (name: string, suffix: string) => `${name.replace(/\.[^.]*$/, "")}${suffix}`;

/** Gives `input` the files `files`, as if the user had picked them, so its change handlers run. */
function loadInto(input: HTMLInputElement, files: File | File[]) {
    const transfer = new DataTransfer();
    for (const file of [files].flat()) transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change"));
}

/** Shows the tab named `name`, as clicking it does. */
const showTab = (name: string) => void (location.hash = `#${name}`);

/** "plays forever" or "plays N times", from an `acTL` chunk's number of plays. */
const playsText = (numPlays: number) => (numPlays === 0 ? "forever" : plural(numPlays, "time"));

/** A frame's delay, for example "100 ms". */
const delayText = (frame: { delayNum: number; delayDen: number }) => `${+frameDelayMs(frame).toFixed(1)} ms`;

// Tabs: one panel per feature, the selected one kept in the URL's hash so it survives a reload and can be linked.
{
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const names = tabs.map((tab) => tab.dataset.tab!);

    function select(name: string, focus = false) {
        for (const tab of tabs) {
            const selected = tab.dataset.tab === name;
            tab.setAttribute("aria-selected", String(selected));
            tab.tabIndex = selected ? 0 : -1; // arrow keys move between tabs; Tab moves into the panel
            element(tab.getAttribute("aria-controls")!).hidden = !selected;
            if (selected && focus) tab.focus();
        }
        if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
    }

    for (const [i, tab] of tabs.entries()) {
        tab.addEventListener("click", () => select(names[i]));
        tab.addEventListener("keydown", (event) => {
            const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[event.key];
            if (next === undefined) return;
            event.preventDefault();
            select(names[(next + tabs.length) % tabs.length], true);
        });
    }

    const fromHash = () => location.hash.slice(1);
    window.addEventListener("hashchange", () => names.includes(fromHash()) && select(fromHash()));
    select(names.includes(fromHash()) ? fromHash() : "chunks");
}

// Drop zones: drop a file on one to load it into its input. Anywhere else, a dropped file is ignored rather than
// opened by the browser, which would leave the demo.
{
    for (const zone of document.querySelectorAll<HTMLElement>(".dropzone")) {
        const input = zone.querySelector<HTMLInputElement>('input[type="file"]')!;
        let depth = 0; // dragenter and dragleave fire for every child, so count them
        zone.addEventListener("dragenter", (event) => {
            event.preventDefault();
            depth++;
            zone.classList.add("dragging");
        });
        zone.addEventListener("dragleave", () => {
            if (--depth === 0) zone.classList.remove("dragging");
        });
        zone.addEventListener("dragover", (event) => event.preventDefault());
        zone.addEventListener("drop", (event) => {
            event.preventDefault();
            depth = 0;
            zone.classList.remove("dragging");
            const files = [...(event.dataTransfer?.files ?? [])];
            if (files.length > 0) loadInto(input, input.multiple ? files : files[0]);
        });
    }
    window.addEventListener("dragover", (event) => event.preventDefault());
    window.addEventListener("drop", (event) => event.preventDefault());
}

// Sample images, made with format-png itself, so every tab can be tried without a file at hand.
{
    /** A little-endian TIFF header with an empty directory: the smallest valid Exif. */
    const EMPTY_EXIF = new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

    function now(): PngTime {
        const d = new Date();
        return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() };
    }

    /**
     * A 320×200 gradient with soft translucent circles: many colors and alpha,
     * with color, size, time and text metadata and a private chunk, for the
     * chunk viewer, decoding and encoding.
     */
    function gradientSample(): File {
        const width = 320;
        const height = 200;
        const data = new Uint8Array(width * height * 4);
        const circles = [
            { x: 90, y: 80, r: 60, color: [255, 120, 80] },
            { x: 200, y: 120, r: 70, color: [80, 200, 255] },
            { x: 260, y: 60, r: 40, color: [255, 220, 90] },
        ];
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                let [r, g, b] = [40 + (x / width) * 120, 30 + (y / height) * 60, 120 + (x / width) * 100];
                for (const c of circles) {
                    const t = Math.max(0, 1 - Math.hypot(x - c.x, y - c.y) / c.r) ** 0.7;
                    [r, g, b] = [r + (c.color[0] - r) * t, g + (c.color[1] - g) * t, b + (c.color[2] - b) * t];
                }
                // Fade the corners out, so the alpha channel has something to show.
                const edge = Math.min(x, y, width - 1 - x, height - 1 - y);
                const i = (y * width + x) * 4;
                data.set([r, g, b, Math.min(255, 80 + edge * 6)], i);
            }
        }
        const png = encodeRgba8({
            width,
            height,
            data,
            metadata: {
                srgb: "perceptual",
                gamma: 0.45455,
                physicalDimensions: { x: 3780, y: 3780, unit: "meter" },
                time: now(),
                text: [
                    { keyword: "Title", text: "format-png sample" },
                    { keyword: "Software", text: "format-png demo" },
                    { keyword: "Description", text: "A gradient with translucent circles, made in your browser.", chunkType: "zTXt" },
                    { keyword: "Title", text: "Eksempelbilde fra format-png", chunkType: "iTXt", languageTag: "nb", translatedKeyword: "Tittel" },
                ],
            },
            chunks: [{ type: "smPl", data: new TextEncoder().encode("a private, safe-to-copy chunk"), position: "after-image-data" }],
        });
        return new File([png as Uint8Array<ArrayBuffer>], "sample-gradient.png", { type: "image/png" });
    }

    /**
     * A 240×160 flat-color picture written as wastefully as possible:
     * uncompressed, interlaced, RGBA with only a few colors, and padded with
     * metadata. Minimize gets a lot to remove and a palette to find.
     */
    function bloatedSample(): File {
        const width = 240;
        const height = 160;
        const sky = [125, 200, 250, 255];
        const sun = [255, 205, 60, 255];
        const hill = [70, 160, 90, 255];
        const far = [120, 190, 130, 255];
        const house = [200, 80, 60, 255];
        const door = [90, 50, 40, 255];
        const data = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                let color = sky;
                if (Math.hypot(x - 190, y - 40) < 20) color = sun;
                if (y > 100 + 18 * Math.sin(x / 30)) color = far;
                if (y > 115 + 12 * Math.sin(x / 22 + 2)) color = hill;
                if (x >= 60 && x < 110 && y >= 85 && y < 125) color = house;
                if (x >= 78 && x < 92 && y >= 105 && y < 125) color = door;
                data.set(color, (y * width + x) * 4);
            }
        }
        const png = encodeRgba8(
            {
                width,
                height,
                data,
                interlaced: true,
                metadata: {
                    srgb: "perceptual",
                    physicalDimensions: { x: 2835, y: 2835, unit: "meter" },
                    time: now(),
                    exif: { data: EMPTY_EXIF },
                    text: [
                        { keyword: "Title", text: "A house on a hill" },
                        { keyword: "Comment", text: "Written uncompressed and interlaced on purpose. ".repeat(20) },
                    ],
                },
                chunks: [{ type: "smPl", data: new Uint8Array(4096), position: "after-image-data" }],
            },
            { compression: 0 },
        );
        return new File([png as Uint8Array<ArrayBuffer>], "sample-bloated.png", { type: "image/png" });
    }

    /** `width × height` RGBA pixels of a soft-edged ellipse of `color`, transparent around it. */
    function ellipse(width: number, height: number, color: number[]): Uint8Array {
        const data = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const d = Math.hypot((x + 0.5 - width / 2) / (width / 2), (y + 0.5 - height / 2) / (height / 2));
                const alpha = Math.max(0, Math.min(1, (1 - d) * Math.min(width, height) / 2));
                const light = 1 - 0.35 * Math.hypot((x - width * 0.35) / width, (y - height * 0.3) / height);
                data.set([color[0] * light, color[1] * light, color[2] * light, alpha * 255], (y * width + x) * 4);
            }
        }
        return data;
    }

    /**
     * A 160×120 bouncing ball, written with `encodeAnimation` the way an
     * editor would: the first frame is the whole scene, and each later frame
     * is only the ball, blended over it and put back afterwards (`dispose:
     * "previous"`), so the background is stored once.
     */
    function animatedSample(): File {
        const width = 160;
        const height = 120;
        const ground = 100;
        const scene = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const sky = [110 + y, 170 + y / 2, 245, 255];
                const grass = [70 + ((x * 7 + y * 3) % 9), 150 + ((x + y) % 7), 80, 255];
                scene.set(y < ground ? sky : grass, (y * width + x) * 4);
            }
        }
        const frames: PngFrame[] = [{ data: scene, delayNum: 1, delayDen: 25 }];
        const steps = 20;
        for (let i = 0; i < steps; i++) {
            const t = i / steps;
            const bounce = Math.abs(Math.sin(Math.PI * t * 2)); // two bounces across the scene
            const squash = bounce < 0.15 ? 1 - (0.15 - bounce) * 2 : 1; // flattened as it lands
            const w = Math.round(22 / squash);
            const h = Math.round(22 * squash);
            const x = Math.round(8 + t * (width - 40));
            const y = Math.round(ground - h - bounce * 70);
            frames.push({ data: ellipse(w, h, [235, 70, 60]), width: w, height: h, x, y, delayNum: 1, delayDen: 25, blend: "over", dispose: "previous" });
        }
        const png = encodeAnimation({
            header: { width, height, bitDepth: 8, colorType: "rgba", interlaced: false },
            frames,
            metadata: { text: [{ keyword: "Title", text: "format-png bouncing ball" }] },
        });
        return new File([png as Uint8Array<ArrayBuffer>], "sample-animation.png", { type: "image/png" });
    }

    /** Twelve 120×120 PNGs of a turning pinwheel, as frames to make an animation from. */
    function sampleFrames(): File[] {
        const size = 120;
        const colors = [[239, 68, 68], [245, 158, 11], [16, 185, 129], [59, 130, 246]];
        return Array.from({ length: 12 }, (_, frame) => {
            const data = new Uint8Array(size * size * 4);
            for (let y = 0; y < size; y++) {
                for (let x = 0; x < size; x++) {
                    const dx = x + 0.5 - size / 2;
                    const dy = y + 0.5 - size / 2;
                    const r = Math.hypot(dx, dy);
                    const angle = (Math.atan2(dy, dx) / (2 * Math.PI) + 1 + frame / 48) % 1;
                    const color = r < 6 ? [60, 60, 70] : r < 52 ? colors[Math.floor(angle * 8) % 4] : [250, 248, 240];
                    data.set([...color, 255], (y * size + x) * 4);
                }
            }
            const png = encodeRgba8({ width: size, height: size, data });
            const name = `pinwheel-${String(frame + 1).padStart(2, "0")}.png`;
            return new File([png as Uint8Array<ArrayBuffer>], name, { type: "image/png" });
        });
    }

    const samples: Record<string, () => File | File[]> = {
        "minimize-input": bloatedSample,
        "animation-input": animatedSample,
        "create-input": sampleFrames,
    };
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-sample]")) {
        button.addEventListener("click", (event) => {
            event.preventDefault(); // don't also open the file picker of the drop zone around it
            const input = element<HTMLInputElement>(button.dataset.sample!);
            loadInto(input, (samples[input.id] ?? gradientSample)());
        });
    }
}

// Decode: read the header alone, then decode the whole image to RGBA and draw it.
{
    const MIN_PREVIEW_SIZE = 160;

    const status = element<HTMLParagraphElement>("decode-status");
    const headerCard = element<HTMLDivElement>("header-card");
    const table = element<HTMLTableElement>("header-table");
    const canvas = element<HTMLCanvasElement>("preview-canvas");

    const fields = (file: File, header: PngHeader, headerTime: number): [string, string][] => [
        ["File", file.name],
        ["File size", formatBytes(file.size)],
        ["Width", `${header.width} px`],
        ["Height", `${header.height} px`],
        ["Color type", header.colorType],
        ["Bit depth", `${header.bitDepth}`],
        ["Interlaced", header.interlaced ? "yes (Adam7)" : "no"],
        ["Size as RGBA", formatBytes(header.width * header.height * 4)],
        ["Header read in", `${headerTime.toFixed(2)} ms`],
    ];

    onFile(element("decode-input"), (file, bytes) => {
        headerCard.hidden = true;
        canvas.hidden = true;
        try {
            let start = performance.now();
            const header = readHeader(bytes);
            const headerTime = performance.now() - start;
            table.tBodies[0].replaceChildren(...fields(file, header, headerTime).map(fieldRow));
            headerCard.hidden = false;

            start = performance.now();
            const image = decodeRgba8(bytes);
            const elapsed = performance.now() - start;

            canvas.width = image.width;
            canvas.height = image.height;
            canvas.getContext("2d")!.putImageData(toImageData(image), 0, 0);
            // Zoom small images so the shorter side is at least MIN_PREVIEW_SIZE px.
            const zoom = Math.max(1, MIN_PREVIEW_SIZE / Math.min(image.width, image.height));
            canvas.style.width = zoom > 1 ? `${image.width * zoom}px` : "";
            canvas.hidden = false;
            const zoomNote = zoom > 1 ? `, shown at ${Math.round(zoom * 100)}%` : "";
            showStatus(status, `${file.name}: ${image.width}×${image.height} decoded to RGBA in ${elapsed.toFixed(1)} ms${zoomNote}`);

            // decodeRgba8 reads an APNG's default image only; the Animation tab plays every frame.
            const { animationControl } = readChunks(bytes);
            if (animationControl) {
                const play = document.createElement("button");
                play.type = "button";
                play.className = "link";
                play.textContent = "play it in the Animation tab";
                play.addEventListener("click", () => {
                    loadInto(element("animation-input"), file);
                    showTab("animation");
                });
                status.append(`. This is an animated PNG of ${plural(animationControl.numFrames, "frame")}, shown as its default image: `, play);
            }
        } catch (error) {
            showStatus(status, `${file.name}: ${errorMessage(error)}`, true);
        }
    });
}

// Chunks: read every chunk without decoding pixels, and show what's in them.
{
    const IDAT_RUN_MIN = 4; // consecutive IDATs collapse into one row from this many
    const HEX_DUMP_LIMIT = 512;

    const status = element<HTMLParagraphElement>("chunks-status");
    const output = element<HTMLDivElement>("chunks-output");
    const layout = element<HTMLDivElement>("chunks-layout");
    const legend = element<HTMLUListElement>("chunks-legend");
    const cards = element<HTMLDivElement>("chunks-cards");
    const tbody = element<HTMLTableElement>("chunks-table").tBodies[0];
    const validateCrc = element<HTMLInputElement>("chunks-validate-crc");
    const strict = element<HTMLInputElement>("chunks-strict");

    type Child = Node | string | null | undefined | false;
    interface Props {
        className?: string;
        title?: string;
        style?: string;
        colSpan?: number;
        onClick?: () => void;
    }

    /** Creates an element with `props` and `children`; falsy children are left out. */
    function h(tag: string, props: Props = {}, ...children: Child[]): HTMLElement {
        const el = document.createElement(tag);
        const { className, title, style, colSpan, onClick } = props;
        if (className) el.className = className;
        if (title) el.title = title;
        if (style) el.style.cssText = style;
        if (colSpan) (el as HTMLTableCellElement).colSpan = colSpan;
        if (onClick) el.addEventListener("click", onClick);
        el.append(...children.filter((child): child is Node | string => !!child));
        return el;
    }

    const CATEGORIES = {
        structure: "Structure (IHDR, IEND)",
        palette: "Palette and transparency",
        data: "Image data (IDAT, fdAT)",
        animation: "Animation (acTL, fcTL)",
        metadata: "Color and metadata",
        text: "Text",
        unknown: "Unknown",
    } as const;
    type Category = keyof typeof CATEGORIES;

    function categoryOf(chunk: PngRawChunk): Category {
        switch (chunk.type) {
            case "IHDR":
            case "IEND":
                return "structure";
            case "PLTE":
            case "tRNS":
                return "palette";
            case "IDAT":
            case "fdAT":
                return "data";
            case "acTL":
            case "fcTL":
                return "animation";
            case "tEXt":
            case "zTXt":
            case "iTXt":
                return "text";
        }
        return chunk.known ? "metadata" : "unknown";
    }

    const hex = (n: number, width: number) => n.toString(16).toUpperCase().padStart(width, "0");
    const rgb = ([r, g, b]: readonly number[]) => `rgb(${r}, ${g}, ${b})`;
    const isPrintable = (b: number) => b >= 0x20 && b < 0x7f;

    /** Lines of offset, 16 bytes in hex and the same as ASCII, with `start` the file offset of `data`. */
    function hexDump(data: Uint8Array, start: number): string {
        const lines: string[] = [];
        for (let i = 0; i < Math.min(data.length, HEX_DUMP_LIMIT); i += 16) {
            const row = data.subarray(i, i + 16);
            const bytes = [...row].map((b) => hex(b, 2)).join(" ").padEnd(16 * 3 - 1);
            const ascii = [...row].map((b) => (isPrintable(b) ? String.fromCharCode(b) : ".")).join("");
            lines.push(`${hex(start + i, 8)}  ${bytes.slice(0, 23)}  ${bytes.slice(24)}  ${ascii}`);
        }
        if (data.length > HEX_DUMP_LIMIT) lines.push(`… ${formatBytes(data.length - HEX_DUMP_LIMIT)} more`);
        return lines.join("\n") || "(empty)";
    }

    /** A swatch of `color` over a checkerboard, so alpha shows. */
    const swatch = (color: string, title: string) => h("span", { className: "swatch", title, style: `--color: ${color}` });

    const badge = (text: string, title: string, kind = "") => h("span", { className: `badge ${kind}`, title }, text);

    function flags(chunk: PngRawChunk): HTMLElement {
        return h(
            "span",
            { className: "flags" },
            chunk.critical
                ? badge("critical", "Uppercase 1st letter: needed to display the image", "critical")
                : badge("ancillary", "Lowercase 1st letter: decoders may ignore it"),
            // APNG's acTL, fcTL and fdAT keep the lowercase 2nd letter they had before PNG's 3rd edition registered them.
            !chunk.public && !chunk.known && badge("private", "Lowercase 2nd letter: application-specific", "private"),
            !chunk.critical && chunk.safeToCopy && badge("safe to copy", "Lowercase 4th letter: editors may keep it after changing the image"),
            !chunk.known && badge("unknown", "format-png doesn't parse this chunk type", "unknown"),
        );
    }

    /** One line about what a chunk holds. */
    function summary(png: PngChunks, chunk: PngRawChunk, index: number): string {
        const { header, metadata: m, palette, transparency } = png;
        // Singleton chunks: only the first of a type is used, and only if it was valid.
        const first = png.chunks.findIndex((c) => c.type === chunk.type) === index;
        const skipped = "ignored: invalid, misplaced or repeated";
        switch (chunk.type) {
            case "IHDR": {
                const interlace = header.interlaced ? ", Adam7 interlaced" : "";
                return `${header.width}×${header.height}, ${header.colorType}, ${header.bitDepth}-bit${interlace}`;
            }
            case "PLTE":
                return palette ? plural(palette.length, "color") : skipped;
            case "tRNS":
                if (!transparency) return skipped;
                if (transparency.kind === "palette") return `alpha for ${plural(transparency.alpha.length, "palette entry", "palette entries")}`;
                if (transparency.kind === "gray") return `gray ${transparency.value} is transparent`;
                return `${rgb(transparency.value)} is transparent`;
            case "IDAT":
                return "zlib-compressed image data";
            case "acTL":
                return first && png.animationControl
                    ? `animated: ${plural(png.animationControl.numFrames, "frame")}, plays ${playsText(png.animationControl.numPlays)}`
                    : "ignored: the animation chunks are broken, so this reads as a still image";
            case "fcTL": {
                // The frame's sequence number starts its data: find its parsed control by it.
                const sequence = new DataView(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength).getUint32(0);
                const frame = png.frameControls.findIndex((c) => c.sequenceNumber === sequence);
                if (frame < 0) return "ignored: the animation chunks are broken";
                const c = png.frameControls[frame];
                return `frame ${frame + 1}: ${c.width}×${c.height} at ${c.x}, ${c.y}, ${delayText(c)}, dispose ${c.dispose}, blend ${c.blend}`;
            }
            case "fdAT":
                return "zlib-compressed frame data";
            case "IEND":
                return "end of image";
            case "gAMA":
                return first && m.gamma !== undefined ? `gamma ${m.gamma}` : skipped;
            case "sRGB":
                return first && m.srgb ? `sRGB, ${m.srgb}` : skipped;
            case "cHRM":
                return first && m.chromaticities ? `white point ${m.chromaticities.white.x}, ${m.chromaticities.white.y}` : skipped;
            case "pHYs":
                return first && m.physicalDimensions ? physical(m.physicalDimensions) : skipped;
            case "tIME":
                return first && m.time ? time(m.time) : skipped;
            case "iCCP":
                return first && m.iccProfile ? `“${m.iccProfile.name}”, ${formatBytes(m.iccProfile.profile.length)} ICC profile` : skipped;
            case "cICP":
                return first && m.cicp ? cicpName(m.cicp) : skipped;
            case "eXIf":
                return first && m.exif ? `${formatBytes(m.exif.data.length)} of Exif, ${m.exif.byteOrder}` : skipped;
            case "tEXt":
            case "zTXt":
            case "iTXt":
                try {
                    const text = parseText(chunk.type, chunk.data);
                    const value = text.text.length > 60 ? `${text.text.slice(0, 60)}…` : text.text;
                    return `${text.keyword}: ${value.replace(/\s+/g, " ")}`;
                } catch (error) {
                    return `invalid: ${errorMessage(error)}`;
                }
        }
        const ascii = [...chunk.data.subarray(0, 40)].every(isPrintable);
        if (ascii && chunk.data.length > 0) {
            const text = new TextDecoder("latin1").decode(chunk.data.subarray(0, 40));
            return `“${text}${chunk.data.length > 40 ? "…" : ""}”`;
        }
        return chunk.public ? "public chunk format-png doesn't parse yet" : "private chunk";
    }

    function physical(p: PhysicalDimensions): string {
        const ppi = pixelsPerInch(p);
        return ppi ? `${p.x} × ${p.y} px/m (${ppi.x.toFixed(0)} × ${ppi.y.toFixed(0)} ppi)` : `aspect ratio ${p.x}:${p.y}`;
    }

    function time(t: PngTime): string {
        const pad = (n: number) => String(n).padStart(2, "0");
        return `${t.year}-${pad(t.month)}-${pad(t.day)} ${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)} UTC`;
    }

    /** The color space a `cICP` chunk names, for the common combinations, or its code points. */
    function cicpName(c: Cicp): string {
        const names: Record<string, string> = { "1/13": "sRGB", "12/13": "Display P3", "9/16": "BT.2100 PQ (HDR)", "9/18": "BT.2100 HLG (HDR)" };
        const codes = `primaries ${c.colorPrimaries}, transfer ${c.transferFunction}`;
        const name = names[`${c.colorPrimaries}/${c.transferFunction}`];
        return `${name ? `${name} (${codes})` : codes}${c.fullRange ? "" : ", narrow range"}`;
    }

    // A chunk takes 12 bytes besides its data: length, type and CRC.
    const chunkSize = (chunk: PngRawChunk) => chunk.data.length + 12;

    /** Chunks in file order, with runs of IDAT or fdAT grouped so a file split into many doesn't flood the view. */
    function groups(chunks: PngRawChunk[]): { index: number; chunks: PngRawChunk[] }[] {
        const result: { index: number; chunks: PngRawChunk[] }[] = [];
        chunks.forEach((chunk, index) => {
            const last = result.at(-1);
            if ((chunk.type === "IDAT" || chunk.type === "fdAT") && last?.chunks[0].type === chunk.type) last.chunks.push(chunk);
            else result.push({ index, chunks: [chunk] });
        });
        // Split short IDAT runs back into single chunks.
        return result.flatMap((group) =>
            group.chunks.length > 1 && group.chunks.length < IDAT_RUN_MIN
                ? group.chunks.map((chunk, i) => ({ index: group.index + i, chunks: [chunk] }))
                : [group],
        );
    }

    function renderLayout(png: PngChunks, fileSize: number, rows: HTMLTableRowElement[]) {
        const segment = (bytes: number, category: Category | "signature", label: string, title: string, onClick?: () => void) =>
            h("div", { className: `segment cat-${category}`, title, style: `flex-grow: ${bytes}`, onClick }, h("span", {}, label));

        layout.replaceChildren(
            segment(8, "signature", "sig", "PNG signature, 8 bytes"),
            ...groups(png.chunks).map((group, i) => {
                const [chunk] = group.chunks;
                const bytes = group.chunks.reduce((sum, c) => sum + chunkSize(c), 0);
                const label = group.chunks.length > 1 ? `${chunk.type} ×${group.chunks.length}` : chunk.type;
                const title = `${label} at 0x${hex(chunk.offset, 8)}, ${formatBytes(bytes)} (${((bytes / fileSize) * 100).toFixed(1)}% of the file)`;
                return segment(bytes, categoryOf(chunk), label, title, () => focusRow(rows[i]));
            }),
        );

        const used = new Set(png.chunks.map(categoryOf));
        legend.replaceChildren(
            ...(Object.keys(CATEGORIES) as Category[])
                .filter((category) => used.has(category))
                .map((category) => h("li", {}, h("span", { className: `dot cat-${category}` }), CATEGORIES[category])),
        );
    }

    function focusRow(row: HTMLTableRowElement) {
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        row.classList.remove("flash");
        void row.offsetWidth; // restart the animation
        row.classList.add("flash");
    }

    function card(title: string, ...content: Child[]): HTMLElement {
        return h("div", { className: "card" }, h("h4", {}, title), ...content);
    }

    function definitions(entries: [string, Child][]): HTMLElement {
        return h("dl", {}, ...entries.flatMap(([term, value]) => [h("dt", {}, term), h("dd", {}, value)]));
    }

    function renderCards(png: PngChunks, fileSize: number) {
        const { header, palette, transparency, metadata: m } = png;
        const imageData = png.chunks.filter((c) => c.type === "IDAT").reduce((sum, c) => sum + c.data.length, 0);
        const rawSize = header.width * header.height * 4;

        const image: [string, Child][] = [
            ["Size", `${header.width} × ${header.height} px`],
            ["Format", `${header.colorType}, ${header.bitDepth}-bit`],
            ["Interlaced", header.interlaced ? "yes (Adam7)" : "no"],
            ["Image data", `${formatBytes(imageData)} (${((imageData / fileSize) * 100).toFixed(0)}% of the file, ${(rawSize / Math.max(imageData, 1)).toFixed(1)}× smaller than RGBA)`],
        ];
        if (transparency?.kind === "gray") image.push(["Transparent", `gray ${transparency.value}`]);
        if (transparency?.kind === "rgb") {
            const color = transparency.value;
            const eightBit = header.bitDepth === 16 ? color.map((v) => v >> 8) : color;
            image.push(["Transparent", h("span", {}, swatch(rgb(eightBit), rgb(color)), ` ${rgb(color)}`)]);
        }

        const color: [string, Child][] = [];
        if (m.cicp) color.push(["cICP", cicpName(m.cicp)]);
        if (m.iccProfile) color.push(["ICC profile", `“${m.iccProfile.name}”, ${formatBytes(m.iccProfile.profile.length)}`]);
        if (m.srgb) color.push(["sRGB", m.srgb]);
        if (m.gamma !== undefined) color.push(["Gamma", `${m.gamma} (1/${(1 / m.gamma).toFixed(2)})`]);
        if (m.chromaticities) {
            const c = m.chromaticities;
            const point = ({ x, y }: { x: number; y: number }) => `${x}, ${y}`;
            color.push(["White point", point(c.white)], ["Primaries", `R ${point(c.red)} · G ${point(c.green)} · B ${point(c.blue)}`]);
        }
        if (m.physicalDimensions) color.push(["Pixel size", physical(m.physicalDimensions)]);
        if (m.time) color.push(["Modified", time(m.time)]);
        if (m.exif) color.push(["Exif", `${formatBytes(m.exif.data.length)}, ${m.exif.byteOrder}`]);

        let animation: HTMLElement | false = false;
        if (png.animationControl) {
            const frames = png.frameControls;
            const frameData = png.chunks.filter((c) => c.type === "fdAT").reduce((sum, c) => sum + c.data.length - 4, 0); // less each sequence number
            // The default image is the first frame when an fcTL comes before the IDAT chunks.
            const types = png.chunks.map((c) => c.type);
            const defaultIsFrame = types.indexOf("fcTL") < types.indexOf("IDAT");
            const play = h("button", { className: "link", onClick: () => (loadInto(element("animation-input"), current!.file), showTab("animation")) }, "Play it");
            animation = card(
                "Animation",
                definitions([
                    ["Frames", `${frames.length}; the default image ${defaultIsFrame ? "is the first frame" : "is separate"}`],
                    ["Plays", playsText(png.animationControl.numPlays)],
                    ["Duration", `${(frames.reduce((sum, c) => sum + frameDelayMs(c), 0) / 1000).toFixed(2)} s per play`],
                    ["Frame data", `${formatBytes(frameData)} in fdAT chunks`],
                    ["", play],
                ]),
            );
        }

        cards.replaceChildren(
            ...[
                card("Image", definitions(image)),
                animation,
                color.length > 0 && card("Color and metadata", definitions(color)),
                palette && card(`Palette, ${plural(palette.length, "color")}`, paletteGrid(palette, transparency)),
                m.text.length > 0 && card(`Text, ${plural(m.text.length, "entry", "entries")}`, textList(m.text)),
            ].filter((c): c is HTMLElement => !!c),
        );
    }

    function paletteGrid(palette: [number, number, number][], transparency?: PngTransparency): HTMLElement {
        const alpha = transparency?.kind === "palette" ? transparency.alpha : undefined;
        return h(
            "div",
            { className: "palette" },
            ...palette.map((color, i) => {
                const a = alpha?.[i] ?? 255;
                const css = `rgba(${color.join(", ")}, ${(a / 255).toFixed(3)})`;
                return swatch(css, `#${i}: ${rgb(color)}${a < 255 ? `, alpha ${a}` : ""}`);
            }),
        );
    }

    function textList(texts: PngText[]): HTMLElement {
        return h(
            "dl",
            { className: "text-list" },
            ...texts.flatMap((t) => [
                h(
                    "dt",
                    {},
                    t.keyword,
                    t.translatedKeyword && ` (${t.translatedKeyword})`,
                    " ",
                    badge(t.chunkType, t.compressed ? "zlib-compressed in the file" : "stored uncompressed", t.compressed ? "compressed" : ""),
                    t.languageTag && badge(t.languageTag, "Language"),
                ),
                h("dd", {}, t.text),
            ]),
        );
    }

    /** The expandable details of one row: a hex dump, or a list for a run of IDATs. */
    function details(group: PngRawChunk[]): HTMLElement {
        if (group.length > 1) {
            const lines = group.map((c, i) => `${String(i + 1).padStart(5)}  0x${hex(c.offset, 8)}  ${formatBytes(c.data.length).padStart(10)}  CRC ${hex(c.crc, 8)}`);
            return h("pre", { className: "dump" }, lines.join("\n"));
        }
        const [chunk] = group;
        return h("pre", { className: "dump" }, hexDump(chunk.data, chunk.offset + 8));
    }

    function renderTable(png: PngChunks): HTMLTableRowElement[] {
        const rows: HTMLTableRowElement[] = [];
        tbody.replaceChildren(
            ...groups(png.chunks).flatMap(({ index, chunks }) => {
                const [chunk] = chunks;
                const run = chunks.length > 1;
                const size = chunks.reduce((sum, c) => sum + c.data.length, 0);
                const detailRow = h("tr", { className: "detail" }, h("td", { colSpan: 8 })) as HTMLTableRowElement;
                detailRow.hidden = true;

                const toggle = h("button", { className: "toggle", title: "Show bytes" }, "▸") as HTMLButtonElement;
                toggle.setAttribute("aria-expanded", "false");
                const row = h(
                    "tr",
                    { className: `cat-${categoryOf(chunk)}` },
                    h("td", {}, toggle),
                    h("td", { className: "num" }, run ? `${index + 1}–${index + chunks.length}` : `${index + 1}`),
                    h("td", { className: "mono" }, `0x${hex(chunk.offset, 8)}`),
                    h("td", {}, h("span", { className: `dot cat-${categoryOf(chunk)}` }), h("code", { className: "type" }, chunk.type), run && ` ×${chunks.length}`),
                    h("td", {}, flags(chunk)),
                    h("td", { className: "num" }, formatBytes(size)),
                    h("td", { className: "mono" }, run ? "" : hex(chunk.crc, 8)),
                    h("td", { className: "contents" }, run ? `zlib-compressed ${chunk.type === "fdAT" ? "frame" : "image"} data, split over ${chunks.length} chunks` : summary(png, chunk, index)),
                ) as HTMLTableRowElement;

                const open = () => {
                    const expanded = detailRow.hidden;
                    if (expanded && !detailRow.cells[0].firstChild) detailRow.cells[0].append(details(chunks));
                    detailRow.hidden = !expanded;
                    toggle.textContent = expanded ? "▾" : "▸";
                    toggle.setAttribute("aria-expanded", String(expanded));
                };
                row.addEventListener("click", open);
                rows.push(row);
                return [row, detailRow];
            }),
        );
        return rows;
    }

    let current: { file: File; bytes: Uint8Array } | undefined;

    function render() {
        if (!current) return;
        const { file, bytes } = current;
        output.hidden = true;
        try {
            const start = performance.now();
            const png = readChunks(bytes, { validateCrc: validateCrc.checked, strictAncillary: strict.checked });
            const elapsed = performance.now() - start;

            const rows = renderTable(png);
            renderLayout(png, bytes.length, rows);
            renderCards(png, bytes.length);
            output.hidden = false;

            const unknown = png.chunks.filter((c) => !c.known).length;
            const unknownNote = unknown > 0 ? `, ${unknown} unknown` : "";
            showStatus(status, `${file.name}: ${plural(png.chunks.length, "chunk")}${unknownNote}, ${formatBytes(bytes.length)}, read in ${elapsed.toFixed(2)} ms`);
        } catch (error) {
            showStatus(status, `${file.name}: ${errorMessage(error)}`, true);
        }
    }

    onFile(element("chunks-input"), (file, bytes) => {
        current = { file, bytes };
        render();
    });
    validateCrc.addEventListener("change", render);
    strict.addEventListener("change", render);
}

// Animation: play an APNG frame by frame, show how each frame is stored, and re-encode it smaller.
{
    const MIN_PREVIEW_SIZE = 240;

    const status = element<HTMLParagraphElement>("animation-status");
    const output = element<HTMLDivElement>("animation-output");
    const canvas = element<HTMLCanvasElement>("animation-canvas");
    const context = canvas.getContext("2d")!;
    const playButton = element<HTMLButtonElement>("animation-play");
    const prevButton = element<HTMLButtonElement>("animation-prev");
    const nextButton = element<HTMLButtonElement>("animation-next");
    const scrub = element<HTMLInputElement>("animation-scrub");
    const frameLabel = element<HTMLOutputElement>("animation-frame");
    const showAreas = element<HTMLInputElement>("animation-areas");
    const cards = element<HTMLDivElement>("animation-cards");
    const framesBody = element<HTMLTableElement>("animation-frames").tBodies[0];
    const optimizeButton = element<HTMLButtonElement>("animation-optimize");
    const download = element<HTMLAnchorElement>("animation-download");

    interface Loaded {
        file: File;
        bytes: Uint8Array;
        animation: RgbaAnimation;
        /** Each frame's fcTL, read with readChunks: where it was drawn, before compositing. */
        controls: FrameControl[];
        /** Each frame as the viewer shows it, ready for putImageData. */
        images: ImageData[];
        rows: HTMLTableRowElement[];
    }

    let current: Loaded | undefined;
    let index = 0;
    let plays = 0;
    let timer: number | undefined;
    /** Bumped for each file, so work for an older one is dropped when it finishes. */
    let generation = 0;
    let optimizedCard: HTMLElement | undefined;

    function draw() {
        if (!current) return;
        const { animation, controls, images, rows } = current;
        context.putImageData(images[index], 0, 0);
        if (showAreas.checked) {
            // Outline the frame's own area: what the file stores for it.
            const c = controls[index];
            const line = Math.max(1, Math.round(animation.width / 200));
            context.save();
            context.lineWidth = line;
            context.setLineDash([line * 3, line * 2]);
            context.strokeStyle = "#ff1493";
            context.strokeRect(c.x + line / 2, c.y + line / 2, c.width - line, c.height - line);
            context.restore();
        }
        scrub.value = String(index);
        frameLabel.value = `${index + 1} / ${images.length} · ${delayText(animation.frames[index])}`;
        rows.forEach((row, i) => row.classList.toggle("current", i === index));
    }

    function pause() {
        clearTimeout(timer);
        timer = undefined;
        playButton.textContent = "Play";
    }

    /** Shows each frame for its delay, then the next, and stops after the animation's number of plays. */
    function play() {
        if (!current) return;
        const { numPlays } = current.animation;
        if (numPlays > 0 && plays >= numPlays) {
            plays = 0; // played out: start again
            index = 0;
            draw();
        }
        playButton.textContent = "Pause";
        const step = () => {
            if (!current) return;
            // Browsers show frames for at least about 10 ms; 0 would spin.
            timer = window.setTimeout(() => {
                if (!current) return;
                if (index === current.images.length - 1) {
                    plays++;
                    if (numPlays > 0 && plays >= numPlays) return pause();
                    index = 0;
                } else {
                    index++;
                }
                draw();
                step();
            }, Math.max(10, frameDelayMs(current.animation.frames[index])));
        };
        step();
    }

    function goTo(frame: number) {
        if (!current) return;
        pause();
        index = (frame + current.images.length) % current.images.length;
        draw();
    }

    /** Each frame's compressed size: the IDAT or fdAT chunks after its fcTL, less each fdAT's sequence number. */
    function frameSizes(png: PngChunks): number[] {
        const sizes: number[] = [];
        for (const chunk of png.chunks) {
            if (chunk.type === "fcTL") sizes.push(0);
            else if (sizes.length > 0 && chunk.type === "IDAT") sizes[sizes.length - 1] += chunk.data.length;
            else if (sizes.length > 0 && chunk.type === "fdAT") sizes[sizes.length - 1] += chunk.data.length - 4;
        }
        return sizes;
    }

    function frameRows(controls: FrameControl[], sizes: number[]): HTMLTableRowElement[] {
        return controls.map((c, i) => {
            const whole = c.x === 0 && c.y === 0 && c.width === current?.animation.width && c.height === current?.animation.height;
            const area = `${c.width}×${c.height}${whole ? ", whole canvas" : ` at ${c.x}, ${c.y}`}`;
            const row = fieldRow([`${i + 1}`, area, delayText(c), c.dispose, c.blend, formatBytes(sizes[i] ?? 0)]);
            for (const cell of [row.cells[0], row.cells[2], row.cells[5]]) cell.className = "num";
            row.addEventListener("click", () => goTo(i));
            return row;
        });
    }

    onFile(element("animation-input"), async (file, bytes) => {
        const run = ++generation;
        pause();
        current = undefined;
        output.hidden = true;
        download.hidden = true;
        optimizedCard = undefined;
        try {
            const png = readChunks(bytes); // fast: no pixels
            if (!png.animationControl) throw new Error("this PNG isn't animated: it has no acTL chunk. Try the sample, or make one below.");
            showStatus(status, `${file.name}: decoding ${plural(png.animationControl.numFrames, "frame")} in a worker…`);
            const start = performance.now();
            const animation = await decodeAnimationRgba8Async(bytes);
            const elapsed = performance.now() - start;
            if (run !== generation) return;

            const { width, height, frames, numPlays } = animation;
            const images = frames.map((frame) => new ImageData(frame.data as Uint8ClampedArray<ArrayBuffer>, width, height));
            current = { file, bytes, animation, controls: png.frameControls, images, rows: [] };
            current.rows = frameRows(png.frameControls, frameSizes(png));
            framesBody.replaceChildren(...current.rows);

            canvas.width = width;
            canvas.height = height;
            const zoom = Math.max(1, MIN_PREVIEW_SIZE / Math.min(width, height));
            canvas.style.width = zoom > 1 ? `${Math.round(width * zoom)}px` : "";
            scrub.max = String(frames.length - 1);

            const duration = frames.reduce((sum, frame) => sum + frameDelayMs(frame), 0);
            const { colorType, bitDepth } = png.header;
            cards.replaceChildren(
                infoCard("Animation", [
                    ["Canvas", `${width} × ${height} px`],
                    ["Frames", `${frames.length}`],
                    ["Plays", playsText(numPlays)],
                    ["Duration", `${(duration / 1000).toFixed(2)} s per play`],
                    ["Format", `${colorType}, ${bitDepth}-bit${png.palette ? `, ${png.palette.length} colors` : ""}`],
                ]),
                infoCard("File", [
                    ["File", file.name],
                    ["Size", formatBytes(bytes.length)],
                    ["As RGBA frames", `${formatBytes(frames.length * width * height * 4)}, ${((frames.length * width * height * 4) / bytes.length).toFixed(0)}× larger`],
                    ["Decoded in", `${elapsed.toFixed(1)} ms, in a worker`],
                ]),
            );

            index = 0;
            plays = 0;
            output.hidden = false;
            draw();
            play();
            showStatus(status, `${file.name}: ${plural(frames.length, "frame")}, ${width}×${height}, plays ${playsText(numPlays)}, decoded in ${elapsed.toFixed(1)} ms`);
        } catch (error) {
            if (run === generation) showStatus(status, `${file.name}: ${errorMessage(error)}`, true);
        }
    });

    /** Re-encodes the frames the viewer shows with cropFrames and a palette, and checks they come back the same. */
    async function optimize() {
        if (!current) return;
        const { file, bytes, animation } = current;
        const run = generation;
        optimizeButton.disabled = true;
        showStatus(status, `${file.name}: re-encoding ${plural(animation.frames.length, "frame")} in a worker…`);
        try {
            const start = performance.now();
            const png = await encodeAnimationRgba8Async(animation, { cropFrames: true, palette: "auto", compression: 9 });
            const elapsed = performance.now() - start;
            const check = await decodeAnimationRgba8Async(png);
            if (run !== generation) return;

            // What a viewer shows must not change: every frame, and its delay.
            const identical = check.numPlays === animation.numPlays
                && check.frames.length === animation.frames.length
                && check.frames.every((frame, i) => frameDelayMs(frame) === frameDelayMs(animation.frames[i]) && sameBytes(frame.data, animation.frames[i].data));
            const written = readChunks(png);
            const cropped = written.frameControls.filter((c) => c.width < animation.width || c.height < animation.height).length;
            const smaller = png.length < bytes.length;

            const card = infoCard("Re-encoded", [
                ["Size", `${formatBytes(png.length)}, ${((png.length / bytes.length) * 100).toFixed(0)}% of the original`],
                ["Format", `${written.header.colorType}, ${written.header.bitDepth}-bit${written.palette ? `, ${written.palette.length} colors` : ""}`],
                ["Cropped", `${cropped} of ${plural(written.frameControls.length, "frame")}`],
                ["Time", `${elapsed.toFixed(1)} ms`],
                ["Frames", pixelCheck(identical)],
            ]);
            if (optimizedCard) optimizedCard.replaceWith(card);
            else cards.append(card);
            optimizedCard = card;

            download.hidden = !smaller;
            if (smaller) setDownload(download, png, renamed(file.name, ".min.png"));
            showStatus(
                status,
                smaller
                    ? `${file.name}: ${formatBytes(bytes.length)} → ${formatBytes(png.length)} with cropFrames and palette: "auto"`
                    : `${file.name}: the original, ${formatBytes(bytes.length)}, is already smaller than ${formatBytes(png.length)}; it stores its frames more cleverly than cropping whole frames can`,
            );
        } catch (error) {
            if (run === generation) showStatus(status, `${file.name}: ${errorMessage(error)}`, true);
        } finally {
            optimizeButton.disabled = false;
        }
    }

    playButton.addEventListener("click", () => (timer === undefined ? play() : pause()));
    prevButton.addEventListener("click", () => goTo(index - 1));
    nextButton.addEventListener("click", () => goTo(index + 1));
    scrub.addEventListener("input", () => goTo(Number(scrub.value)));
    showAreas.addEventListener("change", draw);
    optimizeButton.addEventListener("click", () => void optimize());
}

// Make an animated PNG: one frame per image, encoded in a worker.
{
    const input = element<HTMLInputElement>("create-input");
    const delay = element<HTMLInputElement>("create-delay");
    const loop = element<HTMLInputElement>("create-loop");
    const crop = element<HTMLInputElement>("create-crop");
    const palette = element<HTMLInputElement>("create-palette");
    const status = element<HTMLParagraphElement>("create-status");
    const output = element<HTMLDivElement>("create-output");
    const cards = element<HTMLDivElement>("create-cards");
    const download = element<HTMLAnchorElement>("create-download");
    const openButton = element<HTMLButtonElement>("create-open");

    let frames: ImageData[] = [];
    let made: File | undefined;
    let generation = 0;

    /** Decodes each image with the browser and fits it, centered, onto a canvas the size of the first. */
    async function load(files: File[]): Promise<ImageData[]> {
        const bitmaps = await Promise.all(files.map((file) => createImageBitmap(file, { premultiplyAlpha: "none", colorSpaceConversion: "none" })));
        const { width, height } = bitmaps[0];
        const scratch = new OffscreenCanvas(width, height);
        const context = scratch.getContext("2d", { willReadFrequently: true })!;
        return bitmaps.map((bitmap) => {
            const scale = Math.min(width / bitmap.width, height / bitmap.height);
            const [w, h] = [bitmap.width * scale, bitmap.height * scale];
            context.clearRect(0, 0, width, height);
            context.drawImage(bitmap, (width - w) / 2, (height - h) / 2, w, h);
            bitmap.close();
            return context.getImageData(0, 0, width, height);
        });
    }

    async function create() {
        if (frames.length === 0) return;
        const run = ++generation;
        const ms = Math.min(10000, Math.max(10, Number(delay.value) || 100));
        const { width, height } = frames[0];
        output.hidden = true;
        showStatus(status, `Encoding ${plural(frames.length, "frame")} in a worker…`);
        try {
            const start = performance.now();
            const png = await encodeAnimationRgba8Async(
                {
                    width,
                    height,
                    // The delay as delayNum / delayDen seconds: in milliseconds.
                    frames: frames.map((frame) => ({ data: frame.data, delayNum: ms, delayDen: 1000 })),
                    numPlays: loop.checked ? 0 : 1,
                },
                { cropFrames: crop.checked, palette: palette.checked ? "auto" : "keep" },
            );
            const elapsed = performance.now() - start;
            if (run !== generation) return;

            const written = readChunks(png);
            const raw = frames.length * width * height * 4;
            cards.replaceChildren(
                infoCard("Animated PNG", [
                    ["Size", `${formatBytes(png.length)}, ${(raw / png.length).toFixed(1)}× smaller than the raw frames`],
                    ["Canvas", `${width} × ${height} px`],
                    ["Frames", `${frames.length}, ${ms} ms each, playing ${playsText(written.animationControl?.numPlays ?? 0)}`],
                    ["Format", `${written.header.colorType}, ${written.header.bitDepth}-bit${written.palette ? `, ${written.palette.length} colors` : ""}`],
                    ["Time", `${elapsed.toFixed(1)} ms`],
                ]),
            );
            made = new File([png as Uint8Array<ArrayBuffer>], "animation.png", { type: "image/png" });
            setDownload(download, png, made.name);
            output.hidden = false;
            showStatus(status, `${plural(frames.length, "frame")} → ${formatBytes(png.length)} in ${elapsed.toFixed(1)} ms`);
        } catch (error) {
            if (run === generation) showStatus(status, errorMessage(error), true);
        }
    }

    input.addEventListener("change", async () => {
        // In file name order, numbers by value: frame-2 before frame-10.
        const files = [...(input.files ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        if (files.length === 0) return;
        try {
            showStatus(status, `Reading ${plural(files.length, "image")}…`);
            frames = await load(files);
            await create();
        } catch (error) {
            frames = [];
            output.hidden = true;
            showStatus(status, errorMessage(error), true);
        }
    });
    for (const control of [delay, loop, crop, palette]) control.addEventListener("change", () => void create());
    openButton.addEventListener("click", () => {
        if (!made) return;
        loadInto(element("animation-input"), made);
        element("panel-animation").scrollIntoView({ behavior: "smooth" });
    });
}

// Encode: encode an image to PNG with the chosen options, and check it decodes back to the same pixels.
{
    const status = element<HTMLParagraphElement>("encode-status");
    const output = element<HTMLDivElement>("encode-output");
    const cards = element<HTMLDivElement>("encode-cards");
    const canvas = element<HTMLCanvasElement>("encode-canvas");
    const download = element<HTMLAnchorElement>("encode-download");
    const compareButton = element<HTMLButtonElement>("encode-compare");
    const compareTable = element<HTMLTableElement>("encode-compare-table");
    const compression = element<HTMLInputElement>("encode-compression");
    const compressionValue = element<HTMLOutputElement>("encode-compression-value");
    const strategy = element<HTMLSelectElement>("encode-strategy");
    const filter = element<HTMLSelectElement>("encode-filter");
    const interlaced = element<HTMLInputElement>("encode-interlaced");
    const keepMetadata = element<HTMLInputElement>("encode-metadata");
    const keepUnsafe = element<HTMLInputElement>("encode-unsafe");
    const comment = element<HTMLInputElement>("encode-comment");
    const palette = element<HTMLInputElement>("encode-palette");
    const strip = element<HTMLSelectElement>("encode-strip");


    /** The image to encode, and how it was read. */
    let current: { file: File; image: RgbaImageInput; source: string; animated: boolean } | undefined;

    /**
     * Reads `file` as RGBA. PNGs go through format-png, keeping their metadata
     * and raw chunks; anything else is decoded by the browser via a canvas.
     */
    async function load(file: File, bytes: Uint8Array): Promise<{ image: RgbaImageInput; source: string; animated: boolean }> {
        if (file.type === "image/png" || file.type === "image/apng") {
            const image = decodeRgba8(bytes, { preserveMetadata: true, preserveChunks: true });
            return { image, source: "decoded with format-png", animated: readChunks(bytes).animationControl !== undefined };
        }
        const bitmap = await createImageBitmap(file, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
        const scratch = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = scratch.getContext("2d")!;
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        const { width, height, data } = context.getImageData(0, 0, scratch.width, scratch.height);
        return { image: { width, height, data }, source: "decoded by the browser", animated: false };
    }

    function options(): EncodeOptions {
        return {
            compression: Number(compression.value),
            compressionStrategy: strategy.value as EncodeOptions["compressionStrategy"],
            filter: filter.value as EncodeOptions["filter"],
            keepUnsafeChunks: keepUnsafe.checked,
            palette: palette.checked ? "auto" : "keep",
            strip: strip.value as StripChunks,
        };
    }

    /** `image` with the metadata, chunks, comment and interlacing the controls ask for. */
    function input(image: RgbaImageInput): RgbaImageInput {
        const metadata = keepMetadata.checked ? { ...image.metadata } : {};
        const text = comment.value.trim();
        if (text) {
            // Long comments are worth compressing; iTXt takes any Unicode.
            metadata.text = [...(metadata.text ?? []), { keyword: "Comment", text, chunkType: "iTXt", compressed: text.length > 64 }];
        }
        return {
            width: image.width,
            height: image.height,
            data: image.data,
            metadata,
            chunks: keepMetadata.checked ? image.chunks : [],
            interlaced: interlaced.checked,
        };
    }

    function encode() {
        compressionValue.value = compression.value;
        if (!current) return;
        const { file, image, source } = current;
        output.hidden = true;
        compareTable.hidden = true;
        try {
            const start = performance.now();
            const png = encodeRgba8(input(image), options());
            const elapsed = performance.now() - start;

            // Decode what was written: the pixels must be exactly the ones encoded.
            const decoded = decodeRgba8(png);
            const identical = sameBytes(decoded.data, image.data);
            const written = readChunks(png);
            const types = [...new Set(written.chunks.map((c) => c.type))].join(", ");

            canvas.width = decoded.width;
            canvas.height = decoded.height;
            canvas.getContext("2d")!.putImageData(toImageData(decoded), 0, 0);

            const rawSize = image.width * image.height * 4;
            const { colorType, bitDepth } = written.header;

            cards.replaceChildren(
                infoCard("Encoded", [
                    ["Size", `${formatBytes(png.length)} (${((png.length / file.size) * 100).toFixed(0)}% of the original)`],
                    ["Raw RGBA", `${formatBytes(rawSize)}, ${(rawSize / png.length).toFixed(1)}× larger`],
                    ["Format", `${colorType}, ${bitDepth}-bit${written.palette ? `, ${written.palette.length} colors` : ""}`],
                    ["Time", `${elapsed.toFixed(1)} ms`],
                    ["Pixels", pixelCheck(identical)],
                ]),
                infoCard("Source", [
                    ["File", file.name],
                    ["Size", formatBytes(file.size)],
                    ["Image", `${image.width} × ${image.height} px, ${source}`],
                    ["Chunks written", types],
                ]),
            );

            setDownload(download, png, renamed(file.name, ".encoded.png"));

            output.hidden = false;
            const animated = current.animated ? " (an animated PNG: only its default image is encoded here; the Animation tab re-encodes every frame)" : "";
            showStatus(status, `${file.name}: ${formatBytes(file.size)} → ${formatBytes(png.length)} in ${elapsed.toFixed(1)} ms${animated}`);
        } catch (error) {
            showStatus(status, `${file.name}: ${errorMessage(error)}`, true);
        }
    }

    /** Encodes the image once per filter strategy, each with its own `PngEncoder`, and lists the sizes. */
    function compare() {
        if (!current) return;
        const image = input(current.image);
        const results = FILTERS.map((name) => {
            const encoder = new PngEncoder({ ...options(), filter: name });
            try {
                const start = performance.now();
                const size = encoder.encodeRgba8(image).length;
                return { name, size, elapsed: performance.now() - start };
            } finally {
                encoder.free();
            }
        });
        const smallest = Math.min(...results.map((r) => r.size));
        compareTable.tBodies[0].replaceChildren(
            ...results.map(({ name, size, elapsed }) => {
                const relative = size === smallest ? "smallest" : `+${(((size - smallest) / smallest) * 100).toFixed(1)}%`;
                const row = fieldRow([name, formatBytes(size), relative, `${elapsed.toFixed(1)} ms`]);
                for (const cell of [...row.cells].slice(1)) cell.className = "num";
                row.classList.toggle("best", size === smallest);
                return row;
            }),
        );
        compareTable.hidden = false;
    }

    onFile(element("encode-input"), async (file, bytes) => {
        try {
            current = { file, ...(await load(file, bytes)) };
            encode();
        } catch (error) {
            current = undefined;
            output.hidden = true;
            showStatus(status, `${file.name}: ${errorMessage(error)}`, true);
        }
    });
    compression.addEventListener("input", encode);
    for (const control of [strategy, filter, interlaced, keepMetadata, keepUnsafe, comment, palette, strip]) control.addEventListener("change", encode);
    compareButton.addEventListener("click", compare);
}

// Minimize: strip chunks, try a palette and every filter, and keep the smallest PNG with the same pixels.
{
    const status = element<HTMLParagraphElement>("minimize-status");
    const output = element<HTMLDivElement>("minimize-output");
    const cards = element<HTMLDivElement>("minimize-cards");
    const canvas = element<HTMLCanvasElement>("minimize-canvas");
    const download = element<HTMLAnchorElement>("minimize-download");
    const removedNone = element<HTMLParagraphElement>("minimize-removed-none");
    const removedTable = element<HTMLTableElement>("minimize-removed");
    const candidatesTable = element<HTMLTableElement>("minimize-candidates");
    const tryPalette = element<HTMLInputElement>("minimize-palette");
    const effort = element<HTMLSelectElement>("minimize-effort");
    const parallel = element<HTMLInputElement>("minimize-parallel");
    const stripInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="minimize-strip"]')];

    interface Candidate {
        palette: "auto" | "keep";
        filter: (typeof FILTERS)[number];
        png: Uint8Array;
        elapsed: number;
    }

    // At most one worker per encoding thorough mode tries, and per core.
    const MAX_WORKERS = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, FILTERS.length * 2));
    const workersLabel = element<HTMLSpanElement>("minimize-workers");
    workersLabel.textContent = `${MAX_WORKERS}`;

    /**
     * How much memory all the workers together may use while encoding: a quarter
     * of the device's memory where the browser says (Chromium's
     * `navigator.deviceMemory`, in GiB, which it caps at 8), else 1 GiB.
     */
    const MEMORY_BUDGET = (((navigator as { deviceMemory?: number }).deviceMemory ?? 4) / 4) * 1024 ** 3;

    /**
     * Roughly the most memory one worker uses to encode an image whose samples
     * take `size` bytes, as a multiple of that: the worker's copy of the image,
     * the encoder's copy in wasm memory, the filtered rows, the compressed stream
     * (as large as the input at worst), the palette indices, and the PNG.
     */
    const workerMemory = (size: number) => size * 5;

    /** How many workers fit in `MEMORY_BUDGET` for an image whose samples take `size` bytes, at least one. */
    const workersForImage = (size: number) => Math.max(1, Math.floor(MEMORY_BUDGET / workerMemory(size)));

    /**
     * Up to this much pixel data, the encoder's palette mode encodes both ways
     * itself and keeps the smaller file. Mirrors format-png's
     * `AUTO_PALETTE_COMPARE_LIMIT`.
     */
    const PALETTE_COMPARE_LIMIT = 16 * 1024;

    let current: { file: File; bytes: Uint8Array } | undefined;

    const stripLevel = () => (stripInputs.find((input) => input.checked)?.value ?? "safe") as StripChunks;

    /**
     * The workers that decode, encode and check images here, so the page stays
     * responsive however large the image. Created again with fewer workers for
     * a large image: wasm memory never shrinks, so a worker that encoded one
     * holds on to that much until it's terminated.
     */
    let pool: WorkerPool | undefined;
    /** Aborts the run in progress, if any: its queued jobs are dropped and its running ones stopped. */
    let cancelRun: AbortController | undefined;

    function poolOfSize(size: number): WorkerPool {
        if (pool?.size !== size) {
            void pool?.terminate();
            pool = createWorkerPool({ size });
        }
        return pool;
    }

    /**
     * Runs `encode` once per entry of `jobs`, at most `count` at a time, each
     * starting as soon as one finishes, so each one's time is its own. Results
     * are in the order of `jobs`.
     */
    async function encodeInWorkers(
        encode: (options: EncodeOptions & { signal: AbortSignal }) => Promise<Uint8Array>,
        jobs: EncodeOptions[],
        count: number,
        signal: AbortSignal,
        onProgress: (done: number) => void,
    ): Promise<{ png: Uint8Array; elapsed: number }[]> {
        const results: { png: Uint8Array; elapsed: number }[] = new Array(jobs.length);
        let next = 0;
        let done = 0;
        const lane = async () => {
            while (next < jobs.length) {
                const id = next++;
                const start = performance.now();
                // The pixels are copied for each job, so the image stays usable.
                const png = await encode({ ...jobs[id], signal });
                results[id] = { png, elapsed: performance.now() - start };
                onProgress(++done);
            }
        };
        await Promise.all(Array.from({ length: Math.min(count, jobs.length) }, lane));
        return results;
    }

    /**
     * Every encoding to try for an image with `header` and `size` bytes of
     * samples. Fast is one; thorough is every filter at the best compression.
     *
     * A palette only applies to 8-bit RGB and RGBA, so other images skip it.
     * Thorough also tries without one for images over `PALETTE_COMPARE_LIMIT`;
     * smaller ones get that comparison from the encoder already.
     */
    function plans(header: PngHeader, size: number): { palette: Candidate["palette"]; filter: Candidate["filter"]; compression: number }[] {
        const thorough = effort.value === "thorough";
        const { colorType, bitDepth } = header;
        const canPalettize = tryPalette.checked && bitDepth === 8 && (colorType === "rgb" || colorType === "rgba");
        const compareWithout = thorough && size > PALETTE_COMPARE_LIMIT;
        const palettes: Candidate["palette"][] = !canPalettize ? ["keep"] : compareWithout ? ["auto", "keep"] : ["auto"];
        const filters = thorough ? FILTERS : (["adaptive"] as const);
        return palettes.flatMap((palette) => filters.map((filter) => ({ palette, filter, compression: thorough ? 9 : 6 })));
    }

    /** JSON with typed arrays as plain arrays, to compare palettes and transparency. */
    const json = (value: unknown) => JSON.stringify(value, (_, v) => (ArrayBuffer.isView(v) ? [...(v as Uint8Array)] : v));

    /**
     * Whether `png` has exactly the pixels of `original`. In the same color type
     * and bit depth, the samples, an indexed image's palette and the
     * transparency must match byte for byte, 16-bit included. Otherwise the
     * encoder converted 8-bit RGB or RGBA to a palette, and 8-bit RGBA, which
     * `decodeRgba8` gives exactly for those, must match.
     */
    async function samePixels(pool: WorkerPool, original: RawImage, originalBytes: Uint8Array, png: Uint8Array, signal: AbortSignal): Promise<boolean> {
        const copy = await pool.decode(png, { signal });
        const [a, b] = [original.header, copy.header];
        if (a.width !== b.width || a.height !== b.height) return false;
        if (a.colorType === b.colorType && a.bitDepth === b.bitDepth) {
            // An RGB image's suggested palette isn't part of its pixels, and stripping may drop it.
            const palette = (image: RawImage) => (image.header.colorType === "indexed" ? image.palette : undefined);
            return sameBytes(copy.data, original.data)
                && json(palette(copy)) === json(palette(original))
                && json(copy.transparency) === json(original.transparency);
        }
        const [after, before] = await Promise.all([pool.decodeRgba8(png, { signal }), pool.decodeRgba8(originalBytes, { signal })]);
        return sameBytes(after.data, before.data);
    }

    /**
     * Whether the animation `png` shows exactly what `originalBytes` does: the
     * same number of plays, and every frame as a viewer draws it, with the same
     * delay. Its frames may be stored differently, cropped or as a palette.
     */
    async function sameAnimation(pool: WorkerPool, originalBytes: Uint8Array, png: Uint8Array, signal: AbortSignal): Promise<boolean> {
        const [after, before] = await Promise.all([pool.decodeAnimationRgba8(png, { signal }), pool.decodeAnimationRgba8(originalBytes, { signal })]);
        return after.numPlays === before.numPlays
            && after.frames.length === before.frames.length
            && after.frames.every((frame, i) => frameDelayMs(frame) === frameDelayMs(before.frames[i]) && sameBytes(frame.data, before.frames[i].data));
    }

    /** Each chunk type in `before` that `after` doesn't have, with how many there were and their size. */
    function removedChunks(before: PngRawChunk[], after: PngRawChunk[]): { type: string; count: number; bytes: number }[] {
        const kept = new Set(after.map((c) => c.type));
        const removed = new Map<string, { type: string; count: number; bytes: number }>();
        for (const chunk of before) {
            if (kept.has(chunk.type)) continue;
            const entry = removed.get(chunk.type) ?? { type: chunk.type, count: 0, bytes: 0 };
            entry.count += 1;
            entry.bytes += chunk.data.length + 12;
            removed.set(chunk.type, entry);
        }
        return [...removed.values()];
    }

    const format = (png: PngChunks) =>
        `${png.header.colorType}, ${png.header.bitDepth}-bit${png.palette ? `, ${png.palette.length} colors` : ""}${png.header.interlaced ? ", interlaced" : ""}`
        + (png.animationControl ? `, ${plural(png.animationControl.numFrames, "frame")}` : "");

    function render(
        file: File,
        bytes: Uint8Array,
        original: PngChunks,
        candidates: Candidate[],
        best: Candidate,
        timing: { wall: number; workers: number; limited: boolean },
        pixelsMatch: boolean,
        decoded: RgbaImage,
    ) {
        // Only the chunks, not the pixels: fast enough for the page itself.
        const result = readChunks(best.png);
        const saved = bytes.length - best.png.length;
        const smaller = saved > 0;

        cards.replaceChildren(
            infoCard("Before", [
                ["Size", formatBytes(bytes.length)],
                ["Format", format(original)],
                ["Chunks", plural(original.chunks.length, "chunk")],
            ]),
            infoCard("After", [
                ["Size", `${formatBytes(best.png.length)}${smaller ? `, ${((saved / bytes.length) * 100).toFixed(1)}% smaller` : ""}`],
                ["Format", format(result)],
                ["Chunks", plural(result.chunks.length, "chunk")],
                ["Encoding", `${best.palette === "auto" ? "palette allowed" : "no palette"}, ${best.filter} filter`],
                ["Pixels", pixelCheck(pixelsMatch)],
            ]),
        );

        const removed = removedChunks(original.chunks, result.chunks);
        removedNone.hidden = removed.length > 0;
        removedTable.hidden = removed.length === 0;
        removedTable.tBodies[0].replaceChildren(
            ...removed.map(({ type, count, bytes }) => {
                const row = fieldRow([type, `${count}`, formatBytes(bytes)]);
                for (const cell of [...row.cells].slice(1)) cell.className = "num";
                return row;
            }),
        );

        candidatesTable.tBodies[0].replaceChildren(
            ...[...candidates]
                .sort((a, b) => a.png.length - b.png.length)
                .map((c) => {
                    const relative = c === best ? "smallest" : `+${(((c.png.length - best.png.length) / best.png.length) * 100).toFixed(1)}%`;
                    // Read the format from the output: with a palette allowed, a small image may still keep its own.
                    const palette = c.palette === "auto" ? "allowed" : "no";
                    const row = fieldRow([format(readChunks(c.png)), palette, c.filter, formatBytes(c.png.length), relative, `${c.elapsed.toFixed(1)} ms`]);
                    for (const cell of [...row.cells].slice(3)) cell.className = "num";
                    row.classList.toggle("best", c === best);
                    return row;
                }),
        );

        canvas.width = decoded.width;
        canvas.height = decoded.height;
        canvas.getContext("2d")!.putImageData(toImageData(decoded), 0, 0);

        setDownload(download, smaller ? best.png : bytes, smaller ? renamed(file.name, ".min.png") : file.name);
        download.textContent = smaller ? "Download minimized PNG" : "Download original (already smallest)";
        output.hidden = false;

        // Encoding time summed over every worker, against the time it actually took.
        const busy = candidates.reduce((sum, c) => sum + c.elapsed, 0);
        const speedup = timing.workers > 1 ? `, ${(busy / timing.wall).toFixed(1)}× faster than one at a time` : "";
        const verdict = smaller
            ? `${formatBytes(bytes.length)} → ${formatBytes(best.png.length)}, saved ${formatBytes(saved)}`
            : `nothing smaller than the original ${formatBytes(bytes.length)} found`;
        showStatus(
            status,
            `${file.name}: ${verdict}. ${plural(candidates.length, "encoding")} in ${timing.wall.toFixed(0)} ms on ${plural(timing.workers, "worker")}${timing.limited ? ", limited by the image's size" : ""} (${busy.toFixed(0)} ms of encoding${speedup})`,
        );
    }

    async function minimize() {
        if (!current) return;
        const { file, bytes } = current;
        cancelRun?.abort();
        const run = (cancelRun = new AbortController());
        const { signal } = run;
        output.hidden = true;
        try {
            // Decoding a large image takes a while too, so it's in a worker like the rest.
            showStatus(status, `${file.name}: decoding…`);
            let pool = poolOfSize(MAX_WORKERS);
            const original = await pool.readChunks(bytes, { signal });
            // In the file's own format, so 16-bit samples and palettes come through exactly. An animated PNG is
            // decoded and encoded as an animation, so it stays one, with every frame as stored.
            const decodeOptions = { preserveMetadata: true, preserveChunks: true, signal };
            const decoded: RawImage | RawAnimation = original.animationControl
                ? await pool.decodeAnimation(bytes, decodeOptions)
                : await pool.decode(bytes, decodeOptions);
            // Adam7 almost always makes the file bigger. The samples are the whole image either way, so this is lossless.
            const header = { ...decoded.header, interlaced: false };
            const strip = stripLevel();
            let size: number;
            let encodeOne: (options: EncodeOptions & { signal: AbortSignal }) => Promise<Uint8Array>;
            if ("frames" in decoded) {
                const animation: RawAnimation = { ...decoded, header };
                size = decoded.frames.reduce((sum, frame) => sum + frame.data.length, decoded.defaultImage?.length ?? 0);
                // Cropping only applies where it can't change what's shown, so it's always worth trying.
                encodeOne = (options) => pool.encodeAnimation(animation, { ...options, cropFrames: true });
            } else {
                const image: PngImage = { ...decoded, header };
                size = image.data.length;
                encodeOne = (options) => pool.encode(image, options);
            }
            const todo = plans(header, size);
            const memoryCap = workersForImage(size);
            const limited = parallel.checked && memoryCap < Math.min(MAX_WORKERS, todo.length);
            const workers = Math.min(parallel.checked ? MAX_WORKERS : 1, memoryCap, todo.length);
            workersLabel.textContent = limited ? `${memoryCap} of ${MAX_WORKERS}` : `${MAX_WORKERS}`;
            pool = poolOfSize(Math.min(MAX_WORKERS, memoryCap));
            const on = limited
                ? `${plural(workers, "worker")}, limited by the image's size (about ${formatBytes(workerMemory(size))} each)`
                : plural(workers, "worker");

            showStatus(status, `${file.name}: encoding 0 of ${todo.length} on ${on}…`);
            const start = performance.now();
            // The pixels are unchanged, so chunks that depend on them, such as bKGD and sBIT, stay valid. The
            // encoder still drops them when it converts to a palette, and stripping drops them anyway.
            const jobs = todo.map(({ compression, filter, palette }): EncodeOptions => ({ compression, filter, palette, strip, keepUnsafeChunks: true }));
            const results = await encodeInWorkers(encodeOne, jobs, workers, signal, (done) => {
                showStatus(status, `${file.name}: encoding ${done} of ${todo.length} on ${on}…`);
            });
            const wall = performance.now() - start;

            const candidates = todo.map((plan, i): Candidate => ({ palette: plan.palette, filter: plan.filter, ...results[i] }));
            const best = candidates.reduce((a, b) => (b.png.length < a.png.length ? b : a));
            showStatus(status, `${file.name}: checking the pixels…`);
            const [pixelsMatch, preview] = await Promise.all([
                "frames" in decoded ? sameAnimation(pool, bytes, best.png, signal) : samePixels(pool, decoded, bytes, best.png, signal),
                // For an animation, its default image.
                pool.decodeRgba8(best.png, { signal }),
            ]);
            render(file, bytes, original, candidates, best, { wall, workers, limited }, pixelsMatch, preview);
        } catch (error) {
            // A newer run aborted this one, or replaced the pool it was using.
            if (signal.aborted || (error instanceof WorkerPoolError && error.code === "terminated")) return;
            showStatus(status, `${file.name}: ${errorMessage(error)}`, true);
        } finally {
            if (cancelRun === run) cancelRun = undefined;
        }
    }

    onFile(element("minimize-input"), (file, bytes) => {
        current = { file, bytes };
        void minimize();
    });
    for (const control of [tryPalette, effort, parallel, ...stripInputs]) control.addEventListener("change", () => void minimize());
}
