import {
    PngEncoder,
    decode,
    decodeRgba8,
    encodeRgba8,
    init,
    parseText,
    pixelsPerInch,
    readChunks,
    readHeader,
    toImageData,
    type Cicp,
    type EncodeOptions,
    type PhysicalDimensions,
    type PngChunks,
    type PngHeader,
    type PngRawChunk,
    type PngText,
    type PngTime,
    type PngTransparency,
    type PngImage,
    type RawImage,
    type RgbaImageInput,
    type StripChunks,
} from "format-png";
import type { WorkerRequest, WorkerResponse } from "./minimize-worker.ts";
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

/** Gives `input` the file `file`, as if the user had picked it, so its change handlers run. */
function loadInto(input: HTMLInputElement, file: File) {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change"));
}

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
            const file = event.dataTransfer?.files[0];
            if (file) loadInto(input, file);
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

    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-sample]")) {
        button.addEventListener("click", (event) => {
            event.preventDefault(); // don't also open the file picker of the drop zone around it
            const input = element<HTMLInputElement>(button.dataset.sample!);
            loadInto(input, input.id === "minimize-input" ? bloatedSample() : gradientSample());
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
        data: "Image data (IDAT)",
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
                return "data";
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
            !chunk.public && badge("private", "Lowercase 2nd letter: application-specific", "private"),
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

    /** Chunks in file order, with runs of IDAT grouped so a file split into many doesn't flood the view. */
    function groups(chunks: PngRawChunk[]): { index: number; chunks: PngRawChunk[] }[] {
        const result: { index: number; chunks: PngRawChunk[] }[] = [];
        chunks.forEach((chunk, index) => {
            const last = result.at(-1);
            if (chunk.type === "IDAT" && last?.chunks[0].type === "IDAT") last.chunks.push(chunk);
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

        cards.replaceChildren(
            ...[
                card("Image", definitions(image)),
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
                    h("td", { className: "contents" }, run ? `zlib-compressed image data, split over ${chunks.length} chunks` : summary(png, chunk, index)),
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
    let current: { file: File; image: RgbaImageInput; source: string } | undefined;

    /**
     * Reads `file` as RGBA. PNGs go through format-png, keeping their metadata
     * and raw chunks; anything else is decoded by the browser via a canvas.
     */
    async function load(file: File, bytes: Uint8Array): Promise<{ image: RgbaImageInput; source: string }> {
        if (file.type === "image/png") {
            const image = decodeRgba8(bytes, { preserveMetadata: true, preserveChunks: true });
            return { image, source: "decoded with format-png" };
        }
        const bitmap = await createImageBitmap(file, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
        const scratch = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = scratch.getContext("2d")!;
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        const { width, height, data } = context.getImageData(0, 0, scratch.width, scratch.height);
        return { image: { width, height, data }, source: "decoded by the browser" };
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
            showStatus(status, `${file.name}: ${formatBytes(file.size)} → ${formatBytes(png.length)} in ${elapsed.toFixed(1)} ms`);
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

    /** Workers created so far, kept between runs so each loads the wasm module once. */
    const pool: Worker[] = [];
    /** Bumped on every run; workers tag their results with it, so late results of an earlier run are dropped. */
    let poolRun = 0;
    /** Rejects the run in progress, if any, with `Superseded`. */
    let cancelRun: (() => void) | undefined;

    class Superseded extends Error {}

    /**
     * Terminates the workers past the first `count`. Wasm memory never shrinks,
     * so a worker that encoded a large image holds on to that much until it's
     * gone; terminating also stops one still busy with a superseded job.
     */
    function trimPool(count: number) {
        for (const worker of pool.splice(count)) worker.terminate();
    }

    /**
     * Encodes `image` once per entry of `jobs` on up to `count` workers, giving
     * each worker its next job as soon as it finishes one. Results are in the
     * order of `jobs`. Rejects with `Superseded` if another run starts first;
     * that run's workers finish the job they're on, then pick up the new run's.
     */
    function encodeInWorkers(
        image: PngImage,
        jobs: EncodeOptions[],
        count: number,
        onProgress: (done: number) => void,
    ): Promise<{ png: Uint8Array; elapsed: number }[]> {
        cancelRun?.();
        const run = ++poolRun;
        while (pool.length < count) {
            pool.push(new Worker(new URL("./minimize-worker.ts", import.meta.url), { type: "module" }));
        }
        const workers = pool.slice(0, Math.min(count, jobs.length));

        return new Promise((resolve, reject) => {
            const results: { png: Uint8Array; elapsed: number }[] = new Array(jobs.length);
            let next = 0;
            let done = 0;
            const cleanups: (() => void)[] = [];

            const finish = (settle: () => void) => {
                for (const cleanup of cleanups) cleanup();
                cancelRun = undefined;
                settle();
            };
            cancelRun = () => finish(() => reject(new Superseded()));

            const dispatch = (worker: Worker) => {
                if (next >= jobs.length) return;
                const id = next++;
                worker.postMessage({ kind: "job", run, id, options: jobs[id] } satisfies WorkerRequest);
            };

            for (const worker of workers) {
                const onMessage = (event: MessageEvent<WorkerResponse>) => {
                    const response = event.data;
                    if (response.run !== run) return; // a job of an earlier run, finishing late
                    if ("error" in response) return finish(() => reject(new Error(response.error)));

                    results[response.id] = { png: response.png, elapsed: response.elapsed };
                    onProgress(++done);
                    if (done === jobs.length) return finish(() => resolve(results));
                    dispatch(worker);
                };
                // Fires if the worker's script or the wasm module fails to load.
                const onError = (event: ErrorEvent) => finish(() => reject(new Error(`worker failed: ${event.message || "couldn't load"}`)));
                worker.addEventListener("message", onMessage);
                worker.addEventListener("error", onError);
                cleanups.push(() => {
                    worker.removeEventListener("message", onMessage);
                    worker.removeEventListener("error", onError);
                });

                // The pixels go to each worker once per run, not with every job.
                worker.postMessage({ kind: "image", run, image } satisfies WorkerRequest);
                dispatch(worker);
            }
        });
    }

    /**
     * Every encoding to try for `image`. Fast is one; thorough is every filter
     * at the best compression.
     *
     * A palette only applies to 8-bit RGB and RGBA, so other images skip it.
     * Thorough also tries without one for images over `PALETTE_COMPARE_LIMIT`;
     * smaller ones get that comparison from the encoder already.
     */
    function plans(image: PngImage): { palette: Candidate["palette"]; filter: Candidate["filter"]; compression: number }[] {
        const thorough = effort.value === "thorough";
        const { colorType, bitDepth } = image.header;
        const canPalettize = tryPalette.checked && bitDepth === 8 && (colorType === "rgb" || colorType === "rgba");
        const compareWithout = thorough && image.data.length > PALETTE_COMPARE_LIMIT;
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
    function samePixels(original: RawImage, originalBytes: Uint8Array, png: Uint8Array): boolean {
        const copy = decode(png);
        const [a, b] = [original.header, copy.header];
        if (a.width !== b.width || a.height !== b.height) return false;
        if (a.colorType === b.colorType && a.bitDepth === b.bitDepth) {
            // An RGB image's suggested palette isn't part of its pixels, and stripping may drop it.
            const palette = (image: RawImage) => (image.header.colorType === "indexed" ? image.palette : undefined);
            return sameBytes(copy.data, original.data)
                && json(palette(copy)) === json(palette(original))
                && json(copy.transparency) === json(original.transparency);
        }
        return sameBytes(decodeRgba8(png).data, decodeRgba8(originalBytes).data);
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
        `${png.header.colorType}, ${png.header.bitDepth}-bit${png.palette ? `, ${png.palette.length} colors` : ""}${png.header.interlaced ? ", interlaced" : ""}`;

    function render(
        file: File,
        bytes: Uint8Array,
        original: PngChunks,
        candidates: Candidate[],
        timing: { wall: number; workers: number; limited: boolean },
        pixelsMatch: (png: Uint8Array) => boolean,
    ) {
        const best = candidates.reduce((a, b) => (b.png.length < a.png.length ? b : a));
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
                ["Pixels", pixelCheck(pixelsMatch(best.png))],
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

        const decoded = decodeRgba8(best.png);
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
        output.hidden = true;
        try {
            const original = readChunks(bytes);
            // In the file's own format, so 16-bit samples and palettes come through exactly.
            const decoded = decode(bytes, { preserveMetadata: true, preserveChunks: true });
            // Adam7 almost always makes the file bigger. The samples are the whole image either way, so this is lossless.
            const image: PngImage = { ...decoded, header: { ...decoded.header, interlaced: false } };
            const strip = stripLevel();
            const todo = plans(image);
            const memoryCap = workersForImage(image.data.length);
            const limited = parallel.checked && memoryCap < Math.min(MAX_WORKERS, todo.length);
            const workers = Math.min(parallel.checked ? MAX_WORKERS : 1, memoryCap, todo.length);
            workersLabel.textContent = limited ? `${memoryCap} of ${MAX_WORKERS}` : `${MAX_WORKERS}`;
            // Workers past the cap, left from an earlier smaller image, still hold that image and their wasm memory.
            if (memoryCap < pool.length) {
                cancelRun?.();
                trimPool(memoryCap);
            }
            const on = limited
                ? `${plural(workers, "worker")}, limited by the image's size (about ${formatBytes(workerMemory(image.data.length))} each)`
                : plural(workers, "worker");

            showStatus(status, `${file.name}: encoding 0 of ${todo.length} on ${on}…`);
            const start = performance.now();
            // The pixels are unchanged, so chunks that depend on them, such as bKGD and sBIT, stay valid. The
            // encoder still drops them when it converts to a palette, and stripping drops them anyway.
            const jobs = todo.map(({ compression, filter, palette }): EncodeOptions => ({ compression, filter, palette, strip, keepUnsafeChunks: true }));
            const results = await encodeInWorkers(image, jobs, workers, (done) => {
                showStatus(status, `${file.name}: encoding ${done} of ${todo.length} on ${on}…`);
            });
            const wall = performance.now() - start;

            const candidates = todo.map((plan, i): Candidate => ({ palette: plan.palette, filter: plan.filter, ...results[i] }));
            render(file, bytes, original, candidates, { wall, workers, limited }, (png) => samePixels(decoded, bytes, png));
        } catch (error) {
            if (!(error instanceof Superseded)) showStatus(status, `${file.name}: ${errorMessage(error)}`, true);
        }
    }

    onFile(element("minimize-input"), (file, bytes) => {
        current = { file, bytes };
        void minimize();
    });
    for (const control of [tryPalette, effort, parallel, ...stripInputs]) control.addEventListener("change", () => void minimize());
}
