//! WebAssembly bindings for `format-png`. The TypeScript package wraps these;
//! they aren't meant to be used from JavaScript directly.

use format_png::png::metadata::{
    Chromaticities, CodingIndependentCodePoints, Exif, ExifByteOrder, Gamma, IccProfile, PhysicalDimensions,
    RenderingIntent, TextKind, Time, Unit,
};
use format_png::png::{ChunkType, FilterType};
use format_png::{
    ChunkPosition, ColorType, CompressionLevel, CompressionStrategy, FilterStrategy, ImageHeader, ImageRef,
    Interlace, OwnedChunk, Palette, PaletteAlpha, PaletteMode, PixelFormat, StripChunks, Transparency,
};
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

    /// `iCCP`: the profile's name.
    #[wasm_bindgen(getter, js_name = iccProfileName)]
    pub fn icc_profile_name(&self) -> Option<String> {
        self.0.icc_profile().map(|icc| icc.name.clone())
    }

    /// `iCCP`: the ICC profile, decompressed.
    #[wasm_bindgen(getter, js_name = iccProfile)]
    pub fn icc_profile(&self) -> Option<Vec<u8>> {
        self.0.icc_profile().map(|icc| icc.profile.clone())
    }

    /// `cICP`: color primaries, transfer function, matrix coefficients and the
    /// full-range flag (1 or 0), in that order.
    #[wasm_bindgen(getter)]
    pub fn cicp(&self) -> Option<Vec<u8>> {
        self.0.cicp().map(|c| {
            vec![c.color_primaries, c.transfer_function, c.matrix_coefficients, u8::from(c.full_range)]
        })
    }

    /// `eXIf`: the Exif data, raw, starting with its TIFF header.
    #[wasm_bindgen(getter)]
    pub fn exif(&self) -> Option<Vec<u8>> {
        self.0.exif().map(|exif| exif.data().to_vec())
    }

    /// `eXIf`: "big-endian" or "little-endian".
    #[wasm_bindgen(getter, js_name = exifByteOrder)]
    pub fn exif_byte_order(&self) -> Option<String> {
        self.0.exif().map(|exif| {
            match exif.byte_order() {
                ExifByteOrder::BigEndian => "big-endian",
                ExifByteOrder::LittleEndian => "little-endian",
            }
                .to_owned()
        })
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
        self.transparency.as_ref().map(transparency_kind)
    }

    /// `tRNS`: the transparent gray value, the transparent red, green and blue,
    /// or an alpha for each palette entry.
    #[wasm_bindgen(getter, js_name = transparencyValues)]
    pub fn transparency_values(&self) -> Option<Vec<u16>> {
        self.transparency.as_ref().map(transparency_values)
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

/// "gray", "rgb" or "palette".
fn transparency_kind(transparency: &Transparency) -> String {
    match transparency {
        Transparency::Gray(_) => "gray",
        Transparency::Rgb(_) => "rgb",
        Transparency::Palette(_) => "palette",
    }
        .to_owned()
}

/// The transparent gray value, the transparent red, green and blue, or an
/// alpha for each palette entry.
fn transparency_values(transparency: &Transparency) -> Vec<u16> {
    match transparency {
        Transparency::Gray(value) => vec![*value],
        Transparency::Rgb(values) => values.to_vec(),
        Transparency::Palette(alpha) => alpha.values().iter().map(|&a| a.into()).collect(),
    }
}

/// A decoded image in the file's own format, from `decode`. JavaScript reads
/// the header, palette, transparency, `metadata()` and `takeChunks()`, then
/// calls `intoData()` once, which copies the samples out and frees this object.
#[wasm_bindgen]
pub struct RawImage(format_png::Image);

#[wasm_bindgen]
impl RawImage {
    pub fn header(&self) -> Header {
        (*self.0.header()).into()
    }

    /// `PLTE`: red, green and blue for each entry, in index order.
    #[wasm_bindgen(getter)]
    pub fn palette(&self) -> Option<Vec<u8>> {
        self.0.palette().map(|p| p.colors().concat())
    }

    /// `tRNS`: "gray", "rgb" or "palette".
    #[wasm_bindgen(getter, js_name = transparencyKind)]
    pub fn transparency_kind(&self) -> Option<String> {
        self.0.transparency().map(transparency_kind)
    }

    /// `tRNS`, as `ChunkList.transparencyValues`.
    #[wasm_bindgen(getter, js_name = transparencyValues)]
    pub fn transparency_values(&self) -> Option<Vec<u16>> {
        self.0.transparency().map(transparency_values)
    }

    /// The parsed ancillary chunks; empty unless `preserveMetadata` was set.
    pub fn metadata(&self) -> Metadata {
        Metadata(self.0.metadata().clone())
    }

    /// The raw ancillary chunks; empty unless `preserveChunks` was set.
    #[wasm_bindgen(js_name = takeChunks)]
    pub fn take_chunks(&self) -> Vec<Chunk> {
        self.0.ancillary_chunks().iter().cloned().map(Chunk).collect()
    }

    /// The samples in the file's own layout: rows of the header's stride, 16-bit
    /// samples big-endian, pixels under 8 bits packed with each row padded to a
    /// whole byte, palette indices for indexed images. Consumes the image.
    #[wasm_bindgen(js_name = intoData)]
    pub fn into_data(self) -> Vec<u8> {
        self.0.into_data()
    }
}

/// Decodes a PNG in its own format with a one-off decoder.
#[wasm_bindgen]
pub fn decode(
    bytes: &[u8],
    validate_crc: bool,
    preserve_metadata: bool,
    preserve_chunks: bool,
    strict_ancillary: bool,
) -> Result<RawImage, JsError> {
    WasmDecoder::new(validate_crc, preserve_metadata, preserve_chunks, strict_ancillary).decode(bytes)
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

    pub fn decode(&mut self, bytes: &[u8]) -> Result<RawImage, JsError> {
        Ok(RawImage(self.inner.decode(bytes)?))
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

/// An image to encode, built up from JavaScript: the constructor takes the
/// header and pixels, and each setter adds a chunk. Pass it to `encode` or
/// `Encoder.encode`, then call `free()`.
#[wasm_bindgen]
pub struct EncodeImage {
    header: ImageHeader,
    data: Vec<u8>,
    palette: Option<Palette>,
    transparency: Option<Transparency>,
    metadata: format_png::Metadata,
    chunks: Vec<OwnedChunk>,
}

#[wasm_bindgen]
impl EncodeImage {
    /// `colorType` is one of the strings `Header.colorType` returns. `data` is
    /// in the PNG's own pixel format; see `format_png::ImageRef`.
    #[wasm_bindgen(constructor)]
    pub fn new(
        width: u32,
        height: u32,
        bit_depth: u8,
        color_type: &str,
        interlaced: bool,
        data: Vec<u8>,
    ) -> Result<EncodeImage, JsError> {
        let color_type = match color_type {
            "grayscale" => ColorType::Grayscale,
            "rgb" => ColorType::Rgb,
            "indexed" => ColorType::Indexed,
            "grayscale-alpha" => ColorType::GrayscaleAlpha,
            "rgba" => ColorType::Rgba,
            _ => return Err(JsError::new(&format!("{color_type} isn't a color type"))),
        };
        let interlace = if interlaced { Interlace::Adam7 } else { Interlace::None };
        Ok(Self {
            header: ImageHeader { width, height, bit_depth, color_type, interlace },
            data,
            palette: None,
            transparency: None,
            metadata: format_png::Metadata::default(),
            chunks: Vec::new(),
        })
    }

    /// `PLTE`: red, green and blue for each entry, in index order.
    #[wasm_bindgen(js_name = setPalette)]
    pub fn set_palette(&mut self, colors: &[u8]) -> Result<(), JsError> {
        let (colors, rest) = colors.as_chunks::<3>();
        if !rest.is_empty() {
            return Err(JsError::new("the palette's length isn't a multiple of 3"));
        }
        self.palette = Some(Palette::from_colors(colors)?);
        Ok(())
    }

    /// `tRNS`: `kind` is "gray", "rgb" or "palette", and `values` as
    /// `ChunkList.transparencyValues` returns them.
    #[wasm_bindgen(js_name = setTransparency)]
    pub fn set_transparency(&mut self, kind: &str, values: &[u16]) -> Result<(), JsError> {
        self.transparency = Some(match (kind, values) {
            ("gray", &[value]) => Transparency::Gray(value),
            ("rgb", &[r, g, b]) => Transparency::Rgb([r, g, b]),
            ("palette", _) => {
                let alpha = values
                    .iter()
                    .map(|&a| u8::try_from(a).map_err(|_| JsError::new("a palette alpha is above 255")))
                    .collect::<Result<Vec<u8>, _>>()?;
                Transparency::Palette(PaletteAlpha::from_values(&alpha)?)
            }
            ("gray" | "rgb", _) => return Err(JsError::new(&format!("wrong number of values for {kind} transparency"))),
            _ => return Err(JsError::new(&format!("{kind} isn't a transparency kind"))),
        });
        Ok(())
    }

    /// `gAMA`, for example 0.45455.
    #[wasm_bindgen(js_name = setGamma)]
    pub fn set_gamma(&mut self, gamma: f64) -> Result<(), JsError> {
        self.metadata = std::mem::take(&mut self.metadata).with_gamma(Gamma::new(scaled(gamma, "gamma")?)?);
        Ok(())
    }

    /// `cHRM`: white, red, green and blue x and y, in that order, as fractions.
    #[wasm_bindgen(js_name = setChromaticities)]
    pub fn set_chromaticities(&mut self, values: &[f64]) -> Result<(), JsError> {
        let &[white_x, white_y, red_x, red_y, green_x, green_y, blue_x, blue_y] = values else {
            return Err(JsError::new("chromaticities need 8 values"));
        };
        let s = |value| scaled(value, "chromaticity");
        let chromaticities = Chromaticities {
            white_x: s(white_x)?,
            white_y: s(white_y)?,
            red_x: s(red_x)?,
            red_y: s(red_y)?,
            green_x: s(green_x)?,
            green_y: s(green_y)?,
            blue_x: s(blue_x)?,
            blue_y: s(blue_y)?,
        };
        self.metadata = std::mem::take(&mut self.metadata).with_chromaticities(chromaticities);
        Ok(())
    }

    /// `sRGB`, with one of the intents `Metadata.srgb` returns.
    #[wasm_bindgen(js_name = setSrgb)]
    pub fn set_srgb(&mut self, intent: &str) -> Result<(), JsError> {
        let intent = match intent {
            "perceptual" => RenderingIntent::Perceptual,
            "relative-colorimetric" => RenderingIntent::RelativeColorimetric,
            "saturation" => RenderingIntent::Saturation,
            "absolute-colorimetric" => RenderingIntent::AbsoluteColorimetric,
            _ => return Err(JsError::new(&format!("{intent} isn't a rendering intent"))),
        };
        self.metadata = std::mem::take(&mut self.metadata).with_srgb(intent);
        Ok(())
    }

    /// `pHYs`: pixels per unit, with unit "meter" or "unknown".
    #[wasm_bindgen(js_name = setPhysicalDimensions)]
    pub fn set_physical_dimensions(&mut self, x: u32, y: u32, unit: &str) -> Result<(), JsError> {
        let unit = match unit {
            "meter" => Unit::Meter,
            "unknown" => Unit::Unknown,
            _ => return Err(JsError::new(&format!("{unit} isn't a pHYs unit"))),
        };
        self.metadata = std::mem::take(&mut self.metadata).with_physical_dimensions(PhysicalDimensions { x, y, unit });
        Ok(())
    }

    /// `tIME`: year, month, day, hour, minute and second, in UTC. The encoder
    /// checks the ranges.
    #[wasm_bindgen(js_name = setTime)]
    pub fn set_time(&mut self, year: u16, month: u8, day: u8, hour: u8, minute: u8, second: u8) {
        let time = Time { year, month, day, hour, minute, second };
        self.metadata = std::mem::take(&mut self.metadata).with_time(time);
    }

    /// `iCCP`: an ICC profile, uncompressed, and its name. The encoder checks
    /// the name and compresses the profile.
    #[wasm_bindgen(js_name = setIccProfile)]
    pub fn set_icc_profile(&mut self, name: String, profile: Vec<u8>) {
        self.metadata = std::mem::take(&mut self.metadata).with_icc_profile(IccProfile { name, profile });
    }

    /// `cICP`: H.273 color primaries, transfer function and matrix coefficients,
    /// and whether samples use the full range.
    #[wasm_bindgen(js_name = setCicp)]
    pub fn set_cicp(&mut self, color_primaries: u8, transfer_function: u8, matrix_coefficients: u8, full_range: bool) {
        let cicp = CodingIndependentCodePoints { color_primaries, transfer_function, matrix_coefficients, full_range };
        self.metadata = std::mem::take(&mut self.metadata).with_cicp(cicp);
    }

    /// `eXIf`: Exif data, starting with its TIFF header, which is checked.
    #[wasm_bindgen(js_name = setExif)]
    pub fn set_exif(&mut self, data: &[u8]) -> Result<(), JsError> {
        self.metadata = std::mem::take(&mut self.metadata).with_exif(Exif::parse(data)?);
        Ok(())
    }

    /// Adds a `tEXt`, `zTXt` or `iTXt` chunk. `compressed` only matters for
    /// `iTXt`, and the language tag and translated keyword are only written
    /// there.
    #[wasm_bindgen(js_name = addText)]
    pub fn add_text(
        &mut self,
        chunk_type: &str,
        keyword: String,
        text: String,
        language_tag: String,
        translated_keyword: String,
        compressed: bool,
    ) -> Result<(), JsError> {
        let kind = match chunk_type {
            "tEXt" => TextKind::Plain,
            "zTXt" => TextKind::Compressed,
            "iTXt" => TextKind::International { compressed },
            _ => return Err(JsError::new(&format!("{chunk_type} isn't a text chunk"))),
        };
        let text = format_png::png::metadata::Text { keyword, text, language_tag, translated_keyword, kind };
        self.metadata = std::mem::take(&mut self.metadata).with_text(text);
        Ok(())
    }

    /// Adds a raw chunk, written at `position`: one of the strings
    /// `Chunk.position` returns.
    #[wasm_bindgen(js_name = addChunk)]
    pub fn add_chunk(&mut self, chunk_type: &str, data: Vec<u8>, position: &str) -> Result<(), JsError> {
        let bytes: [u8; 4] = chunk_type
            .as_bytes()
            .try_into()
            .map_err(|_| JsError::new(&format!("{chunk_type} isn't a four-letter chunk type")))?;
        let position = match position {
            "before-palette" => ChunkPosition::BeforePalette,
            "before-image-data" => ChunkPosition::BeforeImageData,
            "after-image-data" => ChunkPosition::AfterImageData,
            _ => return Err(JsError::new(&format!("{position} isn't a chunk position"))),
        };
        self.chunks.push(OwnedChunk::from_data(ChunkType::from_bytes(bytes)?, data, position));
        Ok(())
    }
}

impl EncodeImage {
    fn image_ref(&self) -> ImageRef<'_> {
        let mut image = ImageRef::new(self.header, &self.data).with_chunks(&self.chunks);
        if let Some(palette) = &self.palette {
            image = image.with_palette(palette);
        }
        if let Some(transparency) = &self.transparency {
            image = image.with_transparency(transparency);
        }
        if !self.metadata.is_empty() {
            image = image.with_metadata(&self.metadata);
        }
        image
    }
}

/// `value` times 100000, rounded, as `gAMA` and `cHRM` store it.
fn scaled(value: f64, what: &str) -> Result<u32, JsError> {
    let scaled = (value * 100_000.0).round();
    if !(0.0..=f64::from(u32::MAX)).contains(&scaled) {
        return Err(JsError::new(&format!("{what} {value} is out of range")));
    }
    Ok(scaled as u32)
}

/// Encodes an image with a one-off encoder.
#[wasm_bindgen]
pub fn encode(
    image: &EncodeImage,
    compression: u8,
    compression_strategy: &str,
    filter: &str,
    keep_unsafe_chunks: bool,
    palette: &str,
    strip: &str,
) -> Result<Vec<u8>, JsError> {
    WasmEncoder::new(compression, compression_strategy, filter, keep_unsafe_chunks, palette, strip)?.encode(image)
}

/// An encoder that keeps its compressor and buffers between images.
#[wasm_bindgen(js_name = Encoder)]
pub struct WasmEncoder {
    inner: format_png::Encoder,
}

#[wasm_bindgen(js_class = Encoder)]
impl WasmEncoder {
    /// `compression` is 0 to 9. `compressionStrategy` is "dynamic", "fixed" or
    /// "stored"; `filter` is "adaptive", "none", "sub", "up", "average" or
    /// "paeth"; `palette` is "keep" or "auto"; `strip` is "keep", "safe" or "all".
    #[wasm_bindgen(constructor)]
    pub fn new(
        compression: u8,
        compression_strategy: &str,
        filter: &str,
        keep_unsafe_chunks: bool,
        palette: &str,
        strip: &str,
    ) -> Result<WasmEncoder, JsError> {
        if compression > 9 {
            return Err(JsError::new(&format!("compression level {compression} isn't 0 to 9")));
        }
        let compression_strategy = match compression_strategy {
            "dynamic" => CompressionStrategy::Dynamic,
            "fixed" => CompressionStrategy::Fixed,
            "stored" => CompressionStrategy::Stored,
            _ => return Err(JsError::new(&format!("{compression_strategy} isn't a compression strategy"))),
        };
        let filter = match filter {
            "adaptive" => FilterStrategy::Adaptive,
            "none" => FilterStrategy::Fixed(FilterType::None),
            "sub" => FilterStrategy::Fixed(FilterType::Sub),
            "up" => FilterStrategy::Fixed(FilterType::Up),
            "average" => FilterStrategy::Fixed(FilterType::Average),
            "paeth" => FilterStrategy::Fixed(FilterType::Paeth),
            _ => return Err(JsError::new(&format!("{filter} isn't a filter strategy"))),
        };
        let palette = match palette {
            "keep" => PaletteMode::Keep,
            "auto" => PaletteMode::Auto,
            _ => return Err(JsError::new(&format!("{palette} isn't a palette mode"))),
        };
        let strip = match strip {
            "keep" => StripChunks::Keep,
            "safe" => StripChunks::Safe,
            "all" => StripChunks::All,
            _ => return Err(JsError::new(&format!("{strip} isn't a strip mode"))),
        };
        let options = format_png::EncodeOptions {
            compression: CompressionLevel::new(compression),
            compression_strategy,
            filter,
            keep_unsafe_chunks,
            palette,
            strip,
        };
        Ok(Self { inner: format_png::Encoder::with_options(options) })
    }

    pub fn encode(&mut self, image: &EncodeImage) -> Result<Vec<u8>, JsError> {
        Ok(self.inner.encode(image.image_ref())?)
    }
}
