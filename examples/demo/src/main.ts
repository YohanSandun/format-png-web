import {
    decodeRgba8,
    init,
    parseText,
    pixelsPerInch,
    readChunks,
    readHeader,
    toImageData,
    type PhysicalDimensions,
    type PngChunks,
    type PngHeader,
    type PngRawChunk,
    type PngText,
    type PngTime,
    type PngTransparency,
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

// Preview: decode to RGBA and draw it on the canvas.
{
    const MIN_PREVIEW_SIZE = 100;

    const status = element<HTMLParagraphElement>("preview-status");
    const canvas = element<HTMLCanvasElement>("preview-canvas");

    onFile(element("preview-input"), (file, bytes) => {
        canvas.hidden = true;
        try {
            const start = performance.now();
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
            showStatus(status, `${file.name}: ${image.width}×${image.height}, decoded in ${elapsed.toFixed(1)} ms${zoomNote}`);
        } catch (error) {
            showStatus(status, `${file.name}: ${errorMessage(error)}`, true);
        }
    });
}

// Header: read only IHDR and list its fields.
{
    const status = element<HTMLParagraphElement>("header-status");
    const table = element<HTMLTableElement>("header-table");

    const fields = (file: File, header: PngHeader): [string, string][] => [
        ["File", file.name],
        ["File size", formatBytes(file.size)],
        ["Width", `${header.width} px`],
        ["Height", `${header.height} px`],
        ["Color type", header.colorType],
        ["Bit depth", `${header.bitDepth}`],
        ["Interlaced", header.interlaced ? "yes (Adam7)" : "no"],
        ["Size as RGBA", formatBytes(header.width * header.height * 4)],
    ];

    onFile(element("header-input"), (file, bytes) => {
        table.hidden = true;
        try {
            table.tBodies[0].replaceChildren(...fields(file, readHeader(bytes)).map(fieldRow));
            table.hidden = false;
            showStatus(status, "");
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
    const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
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
        if (m.srgb) color.push(["sRGB", m.srgb]);
        if (m.gamma !== undefined) color.push(["Gamma", `${m.gamma} (1/${(1 / m.gamma).toFixed(2)})`]);
        if (m.chromaticities) {
            const c = m.chromaticities;
            const point = ({ x, y }: { x: number; y: number }) => `${x}, ${y}`;
            color.push(["White point", point(c.white)], ["Primaries", `R ${point(c.red)} · G ${point(c.green)} · B ${point(c.blue)}`]);
        }
        if (m.physicalDimensions) color.push(["Pixel size", physical(m.physicalDimensions)]);
        if (m.time) color.push(["Modified", time(m.time)]);

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
