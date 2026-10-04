//! WebAssembly bindings for `format-png`. The TypeScript package wraps these;
//! they aren't meant to be used from JavaScript directly.

use format_png::png::metadata::{RenderingIntent, TextKind, Unit};
use format_png::{ChunkPosition, ColorType, Interlace, OwnedChunk, PixelFormat, Transparency};
use wasm_bindgen::prelude::*;

/// A decoded RGBA8 image. JavaScript reads `width`, `height`, `metadata()` and
/// `takeChunks()`, then calls `intoPixels()` once, which copies the pixels out
/// and frees this object.
#[wasm_bindgen]
pub struct DecodedImage {
    #[wasm_bindgen(readonly)]
    pub width: u32,
    #[wasm_bindgen(readonly)]
    pub height: u32,
    pixels: Vec<u8>,
    metadata: format_png::Metadata,
    chunks: Vec<OwnedChunk>,
}

#[wasm_bindgen]
impl DecodedImage {
    /// The parsed ancillary chunks; empty unless `preserveMetadata` was set.
    pub fn metadata(&self) -> Metadata {
        Metadata(self.metadata.clone())
    }

    /// The raw ancillary chunks; empty unless `preserveChunks` was set. Moves
    /// them out, so a second call returns none.
    #[wasm_bindgen(js_name = takeChunks)]
    pub fn take_chunks(&mut self) -> Vec<Chunk> {
        std::mem::take(&mut self.chunks).into_iter().map(Chunk).collect()
    }

    /// The RGBA pixels, `width * height * 4` bytes. Consumes the image.
    #[wasm_bindgen(js_name = intoPixels)]
    pub fn into_pixels(self) -> Vec<u8> {
        self.pixels
    }
}

/// The known ancillary chunks. Each getter is `undefined` if the chunk is absent.
#[wasm_bindgen]
pub struct Metadata(format_png::Metadata);

#[wasm_bindgen]
impl Metadata {
    /// `gAMA`, for example 0.45455.
    #[wasm_bindgen(getter)]
    pub fn gamma(&self) -> Option<f64> {
        self.0.gamma().map(|gamma| gamma.value())
    }

    /// `cHRM`: white, red, green and blue x and y, in that order, as fractions.
    #[wasm_bindgen(getter)]
    pub fn chromaticities(&self) -> Option<Vec<f64>> {
        self.0.chromaticities().map(|c| {
            [c.white_x, c.white_y, c.red_x, c.red_y, c.green_x, c.green_y, c.blue_x, c.blue_y]
                .map(|value| f64::from(value) / 100_000.0)
                .to_vec()
        })
    }

    /// `sRGB`: "perceptual", "relative-colorimetric", "saturation" or "absolute-colorimetric".
    #[wasm_bindgen(getter)]
    pub fn srgb(&self) -> Option<String> {
        self.0.srgb().map(|intent| {
            match intent {
                RenderingIntent::Perceptual => "perceptual",
                RenderingIntent::RelativeColorimetric => "relative-colorimetric",
                RenderingIntent::Saturation => "saturation",
                RenderingIntent::AbsoluteColorimetric => "absolute-colorimetric",
            }
                .to_owned()
        })
    }

    /// `pHYs`: pixels per unit, x then y.
    #[wasm_bindgen(getter, js_name = physicalPixelsPerUnit)]
    pub fn physical_pixels_per_unit(&self) -> Option<Vec<u32>> {
        self.0.physical_dimensions().map(|p| vec![p.x, p.y])
    }

    /// `pHYs` unit: "meter" or "unknown" (the values are only an aspect ratio).
    #[wasm_bindgen(getter, js_name = physicalUnit)]
    pub fn physical_unit(&self) -> Option<String> {
        self.0.physical_dimensions().map(|p| {
            match p.unit {
                Unit::Meter => "meter",
                Unit::Unknown => "unknown",
            }
                .to_owned()
        })
    }

    /// `tIME`: year, month, day, hour, minute and second, in UTC.
    #[wasm_bindgen(getter)]
    pub fn time(&self) -> Option<Vec<u16>> {
        self.0.time().map(|t| {
            vec![t.year, t.month.into(), t.day.into(), t.hour.into(), t.minute.into(), t.second.into()]
        })
    }

    /// `tEXt`, `zTXt` and `iTXt`, in file order.
    pub fn text(&self) -> Vec<Text> {
        self.0.text().iter().cloned().map(Text).collect()
    }
}

/// A `tEXt`, `zTXt` or `iTXt` chunk, decoded. JavaScript reads the getters, then
/// calls `free()`.
#[wasm_bindgen]
pub struct Text(format_png::png::metadata::Text);

#[wasm_bindgen]
impl Text {
    #[wasm_bindgen(getter)]
    pub fn keyword(&self) -> String {
        self.0.keyword.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn text(&self) -> String {
        self.0.text.clone()
    }

    #[wasm_bindgen(getter, js_name = languageTag)]
    pub fn language_tag(&self) -> String {
        self.0.language_tag.clone()
    }

    #[wasm_bindgen(getter, js_name = translatedKeyword)]
    pub fn translated_keyword(&self) -> String {
        self.0.translated_keyword.clone()
    }

    /// "tEXt", "zTXt" or "iTXt".
    #[wasm_bindgen(getter, js_name = chunkType)]
    pub fn chunk_type(&self) -> String {
        self.0.chunk_type().to_string()
    }

    /// Whether the text was zlib-compressed in the file.
    #[wasm_bindgen(getter)]
    pub fn compressed(&self) -> bool {
        matches!(self.0.kind, TextKind::Compressed | TextKind::International { compressed: true })
    }
}

/// A raw ancillary chunk. JavaScript reads `chunkType` and `position`, then calls
/// `intoData()` once, which copies the data out and frees this object.
#[wasm_bindgen]
pub struct Chunk(OwnedChunk);

#[wasm_bindgen]
impl Chunk {
    /// The four-letter type, for example "tEXt".
    #[wasm_bindgen(getter, js_name = chunkType)]
    pub fn chunk_type(&self) -> String {
        self.0.chunk_type().to_string()
    }

    /// "before-palette", "before-image-data" or "after-image-data".
    #[wasm_bindgen(getter)]
    pub fn position(&self) -> String {
        match self.0.position() {
            ChunkPosition::BeforePalette => "before-palette",
            ChunkPosition::BeforeImageData => "before-image-data",
            ChunkPosition::AfterImageData => "after-image-data",
        }
            .to_owned()
    }

    /// The chunk's data, without length, type and CRC. Consumes the chunk.
    #[wasm_bindgen(js_name = intoData)]
    pub fn into_data(self) -> Vec<u8> {
        self.0.data().to_vec()
    }
}

/// The contents of the `IHDR` chunk.
#[wasm_bindgen]
pub struct Header {
    #[wasm_bindgen(readonly)]
    pub width: u32,
    #[wasm_bindgen(readonly)]
    pub height: u32,
    #[wasm_bindgen(readonly, js_name = bitDepth)]
    pub bit_depth: u8,
    #[wasm_bindgen(readonly)]
    pub interlaced: bool,
    color_type: ColorType,
}

#[wasm_bindgen]
impl Header {
    /// "grayscale", "rgb", "indexed", "grayscale-alpha" or "rgba".
    #[wasm_bindgen(getter, js_name = colorType)]
    pub fn color_type(&self) -> String {
        match self.color_type {
            ColorType::Grayscale => "grayscale",
            ColorType::Rgb => "rgb",
            ColorType::Indexed => "indexed",
            ColorType::GrayscaleAlpha => "grayscale-alpha",
            ColorType::Rgba => "rgba",
        }
            .to_owned()
    }
}

impl From<format_png::ImageHeader> for Header {
    fn from(header: format_png::ImageHeader) -> Self {
        Self {
            width: header.width,
            height: header.height,
            bit_depth: header.bit_depth,
            interlaced: header.interlace == Interlace::Adam7,
            color_type: header.color_type,
        }
    }
}

/// Decodes a PNG to RGBA8 with a one-off decoder.
#[wasm_bindgen(js_name = decodeRgba8)]
pub fn decode_rgba8(
    bytes: &[u8],
    validate_crc: bool,
    preserve_metadata: bool,
    preserve_chunks: bool,
    strict_ancillary: bool,
) -> Result<DecodedImage, JsError> {
    WasmDecoder::new(validate_crc, preserve_metadata, preserve_chunks, strict_ancillary).decode_rgba8(bytes)
}

/// Reads and parses every chunk without decompressing the image data.
#[wasm_bindgen(js_name = readChunks)]
pub fn read_chunks(bytes: &[u8], validate_crc: bool, strict_ancillary: bool) -> Result<ChunkList, JsError> {
    WasmDecoder::new(validate_crc, false, false, strict_ancillary).read_chunks(bytes)
}

/// Parses the data of a `tEXt`, `zTXt` or `iTXt` chunk on its own.
#[wasm_bindgen(js_name = parseText)]
pub fn parse_text(chunk_type: &str, data: &[u8]) -> Result<Text, JsError> {
    use format_png::png::metadata::Text as PngText;
    let text = match chunk_type {
        "tEXt" => PngText::parse_text(data)?,
        "zTXt" => PngText::parse_compressed(data)?,
        "iTXt" => PngText::parse_international(data)?,
        _ => return Err(JsError::new(&format!("{chunk_type} isn't a text chunk"))),
    };
    Ok(Text(text))
}

/// Every chunk of a PNG, from `read_chunks`. The raw chunks are flat arrays,
/// one entry per chunk in file order, so JavaScript can view their data in the
/// input it already has instead of copying it out of wasm memory.
#[wasm_bindgen]
pub struct ChunkList {
    header: format_png::ImageHeader,
    palette: Option<Vec<u8>>,
    transparency: Option<Transparency>,
    metadata: format_png::Metadata,
    types: String,
    offsets: Vec<u32>,
    lengths: Vec<u32>,
    crcs: Vec<u32>,
    known: Vec<u8>,
}

#[wasm_bindgen]
impl ChunkList {
    pub fn header(&self) -> Header {
        self.header.into()
    }

    /// `PLTE`: red, green and blue for each entry, in index order.
    #[wasm_bindgen(getter)]
    pub fn palette(&self) -> Option<Vec<u8>> {
        self.palette.clone()
    }

    /// `tRNS`: "gray", "rgb" or "palette".
    #[wasm_bindgen(getter, js_name = transparencyKind)]
    pub fn transparency_kind(&self) -> Option<String> {
        self.transparency.as_ref().map(|t| {
            match t {
                Transparency::Gray(_) => "gray",
                Transparency::Rgb(_) => "rgb",
                Transparency::Palette(_) => "palette",
            }
                .to_owned()
        })
    }

    /// `tRNS`: the transparent gray value, the transparent red, green and blue,
    /// or an alpha for each palette entry.
    #[wasm_bindgen(getter, js_name = transparencyValues)]
    pub fn transparency_values(&self) -> Option<Vec<u16>> {
        self.transparency.as_ref().map(|t| match t {
            Transparency::Gray(value) => vec![*value],
            Transparency::Rgb(values) => values.to_vec(),
            Transparency::Palette(alpha) => alpha.values().iter().map(|&a| a.into()).collect(),
        })
    }

    pub fn metadata(&self) -> Metadata {
        Metadata(self.metadata.clone())
    }

    /// The four-letter types of every chunk, joined.
    #[wasm_bindgen(getter)]
    pub fn types(&self) -> String {
        self.types.clone()
    }

    /// Where each chunk starts in the input: its length field.
    #[wasm_bindgen(getter)]
    pub fn offsets(&self) -> Vec<u32> {
        self.offsets.clone()
    }

    /// The length of each chunk's data.
    #[wasm_bindgen(getter)]
    pub fn lengths(&self) -> Vec<u32> {
        self.lengths.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn crcs(&self) -> Vec<u32> {
        self.crcs.clone()
    }

    /// 1 for each chunk this crate parses, 0 for unknown ones.
    #[wasm_bindgen(getter)]
    pub fn known(&self) -> Vec<u8> {
        self.known.clone()
    }
}

/// Reads only the header.
#[wasm_bindgen(js_name = readHeader)]
pub fn read_header(bytes: &[u8]) -> Result<Header, JsError> {
    Ok(format_png::read_header(bytes)?.into())
}

/// A decoder that keeps its buffers between images.
#[wasm_bindgen(js_name = Decoder)]
pub struct WasmDecoder {
    inner: format_png::Decoder,
}

#[wasm_bindgen(js_class = Decoder)]
impl WasmDecoder {
    #[wasm_bindgen(constructor)]
    pub fn new(validate_crc: bool, preserve_metadata: bool, preserve_chunks: bool, strict_ancillary: bool) -> Self {
        let options = format_png::DecodeOptions {
            validate_crc,
            preserve_metadata,
            preserve_chunks,
            strict_ancillary,
        };
        Self {
            inner: format_png::Decoder::with_options(options),
        }
    }

    #[wasm_bindgen(js_name = decodeRgba8)]
    pub fn decode_rgba8(&mut self, bytes: &[u8]) -> Result<DecodedImage, JsError> {
        let bitmap = self.inner.decode_bitmap(bytes, PixelFormat::Rgba8)?;
        Ok(DecodedImage {
            width: bitmap.width(),
            height: bitmap.height(),
            pixels: bitmap.into_data(),
            metadata: self.inner.metadata().clone(),
            chunks: self.inner.ancillary_chunks().to_vec(),
        })
    }

    #[wasm_bindgen(js_name = readChunks)]
    pub fn read_chunks(&mut self, bytes: &[u8]) -> Result<ChunkList, JsError> {
        let png = self.inner.read_chunks(bytes)?;
        // Chunk data borrows from `bytes`, so its offset there is where it points.
        // The length and type fields come before it.
        let offset_of = |data: &[u8]| (data.as_ptr() as usize - bytes.as_ptr() as usize - 8) as u32;
        let unknown: Vec<u32> = png.unknown_chunks().map(|chunk| offset_of(chunk.data())).collect();

        let chunks = png.chunks();
        let offsets: Vec<u32> = chunks.iter().map(|chunk| offset_of(chunk.data())).collect();
        Ok(ChunkList {
            header: *png.header(),
            palette: png.palette().map(|p| p.colors().concat()),
            transparency: png.transparency().cloned(),
            metadata: png.metadata().clone(),
            types: chunks.iter().map(|chunk| chunk.chunk_type().to_string()).collect(),
            lengths: chunks.iter().map(|chunk| chunk.data().len() as u32).collect(),
            crcs: chunks.iter().map(|chunk| chunk.crc()).collect(),
            known: offsets.iter().map(|offset| u8::from(!unknown.contains(offset))).collect(),
            offsets,
        })
    }
}
