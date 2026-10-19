//! Streaming codec primitives for the node:zlib adapter.
//!
//! Input and output are borrowed only for one `mal_zlib_pump` call. Persistent
//! state contains codec state and scalar counters, never pointers into JS or C.

use brotli::enc::encode::{
    BrotliEncoderDestroyInstance, BrotliEncoderOperation, BrotliEncoderParameter,
    BrotliEncoderStateStruct,
};
use brotli_decompressor::{BrotliDecompressStream, BrotliResult, BrotliState, StandardAlloc};
use flate2::{Compress, Compression, Decompress, FlushCompress, FlushDecompress, Status};

pub const MAL_ZLIB_ABI_VERSION: u32 = 2;

pub const MAL_ZLIB_FORMAT_ZLIB: u32 = 1;
pub const MAL_ZLIB_FORMAT_GZIP: u32 = 2;
pub const MAL_ZLIB_FORMAT_BROTLI: u32 = 3;
pub const MAL_ZLIB_FORMAT_RAW: u32 = 4;
pub const MAL_ZLIB_FORMAT_UNZIP: u32 = 5;

pub const MAL_ZLIB_STATUS_NEED_INPUT: i32 = 1;
pub const MAL_ZLIB_STATUS_NEED_OUTPUT: i32 = 2;
pub const MAL_ZLIB_STATUS_STREAM_END: i32 = 3;
pub const MAL_ZLIB_STATUS_DATA_ERROR: i32 = -1;
pub const MAL_ZLIB_STATUS_TRUNCATED: i32 = -2;
pub const MAL_ZLIB_STATUS_INVALID_ARGUMENT: i32 = -3;

type BrotliDecoder = BrotliState<StandardAlloc, StandardAlloc, StandardAlloc>;
type BrotliEncoder = BrotliEncoderStateStruct<StandardAlloc>;

// MalZlibStream itself is boxed at the ABI boundary; boxing BrotliState again
// would add an allocation and indirection without reducing per-handle memory.
#[allow(clippy::large_enum_variant)]
enum Decoder {
    Zlib {
        decoder: Decompress,
        complete: bool,
    },
    Gzip {
        decoder: Decompress,
        members: usize,
        at_member_boundary: bool,
        finished: bool,
    },
    Brotli {
        decoder: BrotliDecoder,
        total_out: usize,
        complete: bool,
    },
    Unzip,
    Deflate {
        encoder: Compress,
        complete: bool,
    },
    BrotliEncode {
        encoder: BrotliEncoder,
        complete: bool,
    },
}

#[derive(Clone, Copy)]
struct Config {
    format: u32,
    encode: bool,
    level: i32,
    window_bits: i32,
}

/// Opaque to C. The sticky error makes calls after malformed input deterministic.
pub struct MalZlibStream {
    config: Config,
    decoder: Decoder,
    error: Option<i32>,
}

impl Drop for MalZlibStream {
    fn drop(&mut self) {
        if let Decoder::BrotliEncode { encoder, .. } = &mut self.decoder {
            BrotliEncoderDestroyInstance(encoder);
        }
    }
}

fn deflate_level(level: i32) -> Compression {
    if (0..=9).contains(&level) {
        Compression::new(level as u32)
    } else {
        Compression::default()
    }
}

fn new_codec(config: Config) -> Option<Decoder> {
    // zlib silently raises an 8-bit deflate window to 9; flate2 panics instead.
    let bits = config.window_bits.clamp(9, 15) as u8;
    if config.encode {
        let level = deflate_level(config.level);
        return Some(match config.format {
            MAL_ZLIB_FORMAT_ZLIB => Decoder::Deflate {
                encoder: Compress::new_with_window_bits(level, true, bits),
                complete: false,
            },
            MAL_ZLIB_FORMAT_RAW => Decoder::Deflate {
                encoder: Compress::new_with_window_bits(level, false, bits),
                complete: false,
            },
            MAL_ZLIB_FORMAT_GZIP => Decoder::Deflate {
                encoder: Compress::new_gzip(level, bits),
                complete: false,
            },
            MAL_ZLIB_FORMAT_BROTLI => Decoder::BrotliEncode {
                encoder: BrotliEncoder::new(StandardAlloc::default()),
                complete: false,
            },
            _ => return None,
        });
    }
    Some(match config.format {
        MAL_ZLIB_FORMAT_ZLIB => Decoder::Zlib {
            decoder: Decompress::new(true),
            complete: false,
        },
        MAL_ZLIB_FORMAT_RAW => Decoder::Zlib {
            decoder: Decompress::new(false),
            complete: false,
        },
        MAL_ZLIB_FORMAT_GZIP => Decoder::Gzip {
            decoder: Decompress::new_gzip(15),
            members: 0,
            at_member_boundary: false,
            finished: false,
        },
        MAL_ZLIB_FORMAT_UNZIP => Decoder::Unzip,
        MAL_ZLIB_FORMAT_BROTLI => Decoder::Brotli {
            decoder: BrotliState::new(
                StandardAlloc::default(),
                StandardAlloc::default(),
                StandardAlloc::default(),
            ),
            total_out: 0,
            complete: false,
        },
        _ => return None,
    })
}

fn brotli_parameter(id: u32) -> Option<BrotliEncoderParameter> {
    Some(match id {
        0 => BrotliEncoderParameter::BROTLI_PARAM_MODE,
        1 => BrotliEncoderParameter::BROTLI_PARAM_QUALITY,
        2 => BrotliEncoderParameter::BROTLI_PARAM_LGWIN,
        3 => BrotliEncoderParameter::BROTLI_PARAM_LGBLOCK,
        4 => BrotliEncoderParameter::BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING,
        5 => BrotliEncoderParameter::BROTLI_PARAM_SIZE_HINT,
        6 => BrotliEncoderParameter::BROTLI_PARAM_LARGE_WINDOW,
        _ => return None,
    })
}

impl MalZlibStream {
    fn new(format: u32) -> Option<Self> {
        Self::with_config(Config {
            format,
            encode: false,
            level: -1,
            window_bits: 15,
        })
    }

    fn with_config(config: Config) -> Option<Self> {
        Some(Self {
            config,
            decoder: new_codec(config)?,
            error: None,
        })
    }

    fn fail(&mut self, status: i32) -> i32 {
        self.error = Some(status);
        status
    }

    #[cfg(test)]
    fn pump(&mut self, input: &[u8], output: &mut [u8]) -> (usize, usize, i32) {
        self.pump_flush(input, output, 0)
    }

    fn pump_flush(&mut self, input: &[u8], output: &mut [u8], flush: i32) -> (usize, usize, i32) {
        if let Some(error) = self.error {
            return (0, 0, error);
        }
        if matches!(self.decoder, Decoder::Unzip) {
            let Some(&first) = input.first() else {
                return (0, 0, MAL_ZLIB_STATUS_NEED_INPUT);
            };
            // 0x1f can only start a gzip member: as a zlib CMF it names compression method 15.
            let format = if first == 0x1f {
                MAL_ZLIB_FORMAT_GZIP
            } else {
                MAL_ZLIB_FORMAT_ZLIB
            };
            self.decoder = new_codec(Config {
                format,
                ..self.config
            })
            .expect("unzip resolves to a supported decoder");
        }

        let result = match &mut self.decoder {
            Decoder::Unzip => unreachable!(),
            Decoder::Zlib { decoder, complete } => {
                if *complete {
                    (0, 0, MAL_ZLIB_STATUS_STREAM_END)
                } else {
                    let before_in = decoder.total_in();
                    let before_out = decoder.total_out();
                    match decoder.decompress(input, output, FlushDecompress::None) {
                        Ok(status) => {
                            let consumed = (decoder.total_in() - before_in) as usize;
                            let produced = (decoder.total_out() - before_out) as usize;
                            if status == Status::StreamEnd {
                                *complete = true;
                            }
                            (
                                consumed,
                                produced,
                                stream_status(status, input, output, consumed, produced),
                            )
                        }
                        Err(_) => (
                            (decoder.total_in() - before_in) as usize,
                            (decoder.total_out() - before_out) as usize,
                            MAL_ZLIB_STATUS_DATA_ERROR,
                        ),
                    }
                }
            }
            Decoder::Gzip {
                decoder,
                members,
                at_member_boundary,
                finished,
            } => {
                if *finished {
                    (0, 0, MAL_ZLIB_STATUS_STREAM_END)
                } else {
                    pump_gzip(decoder, members, at_member_boundary, input, output)
                }
            }
            Decoder::Brotli {
                decoder,
                total_out,
                complete,
            } => {
                if *complete {
                    (0, 0, MAL_ZLIB_STATUS_STREAM_END)
                } else {
                    let mut available_in = input.len();
                    let mut input_offset = 0;
                    let mut available_out = output.len();
                    let mut output_offset = 0;
                    let status = BrotliDecompressStream(
                        &mut available_in,
                        &mut input_offset,
                        input,
                        &mut available_out,
                        &mut output_offset,
                        output,
                        total_out,
                        decoder,
                    );
                    let abi_status = match status {
                        BrotliResult::ResultSuccess => {
                            *complete = true;
                            MAL_ZLIB_STATUS_STREAM_END
                        }
                        BrotliResult::NeedsMoreInput => MAL_ZLIB_STATUS_NEED_INPUT,
                        BrotliResult::NeedsMoreOutput => MAL_ZLIB_STATUS_NEED_OUTPUT,
                        BrotliResult::ResultFailure => MAL_ZLIB_STATUS_DATA_ERROR,
                    };
                    (input_offset, output_offset, abi_status)
                }
            }
            Decoder::Deflate { encoder, complete } => {
                if *complete {
                    (0, 0, MAL_ZLIB_STATUS_STREAM_END)
                } else {
                    let mode = match flush {
                        0 => FlushCompress::None,
                        2 => FlushCompress::Sync,
                        3 => FlushCompress::Full,
                        4 => FlushCompress::Finish,
                        _ => FlushCompress::Partial,
                    };
                    let before_in = encoder.total_in();
                    let before_out = encoder.total_out();
                    let status = encoder.compress(input, output, mode);
                    let consumed = (encoder.total_in() - before_in) as usize;
                    let produced = (encoder.total_out() - before_out) as usize;
                    match status {
                        Ok(Status::StreamEnd) => {
                            *complete = true;
                            (consumed, produced, MAL_ZLIB_STATUS_STREAM_END)
                        }
                        Ok(_) if produced == output.len() || consumed < input.len() => {
                            (consumed, produced, MAL_ZLIB_STATUS_NEED_OUTPUT)
                        }
                        Ok(_) => (consumed, produced, MAL_ZLIB_STATUS_NEED_INPUT),
                        Err(_) => (consumed, produced, MAL_ZLIB_STATUS_INVALID_ARGUMENT),
                    }
                }
            }
            Decoder::BrotliEncode { encoder, complete } => {
                if *complete {
                    (0, 0, MAL_ZLIB_STATUS_STREAM_END)
                } else {
                    let op = match flush {
                        1 => BrotliEncoderOperation::BROTLI_OPERATION_FLUSH,
                        2 => BrotliEncoderOperation::BROTLI_OPERATION_FINISH,
                        _ => BrotliEncoderOperation::BROTLI_OPERATION_PROCESS,
                    };
                    let mut available_in = input.len();
                    let mut input_offset = 0;
                    let mut available_out = output.len();
                    let mut output_offset = 0;
                    let mut total_out = None;
                    let ok = encoder.compress_stream(
                        op,
                        &mut available_in,
                        input,
                        &mut input_offset,
                        &mut available_out,
                        output,
                        &mut output_offset,
                        &mut total_out,
                        &mut |_, _, _, _| (),
                    );
                    let status = if !ok {
                        MAL_ZLIB_STATUS_INVALID_ARGUMENT
                    } else if encoder.is_finished() {
                        *complete = true;
                        MAL_ZLIB_STATUS_STREAM_END
                    } else if encoder.has_more_output()
                        || available_out == 0
                        || input_offset < input.len()
                    {
                        MAL_ZLIB_STATUS_NEED_OUTPUT
                    } else {
                        MAL_ZLIB_STATUS_NEED_INPUT
                    };
                    (input_offset, output_offset, status)
                }
            }
        };

        if result.2 == MAL_ZLIB_STATUS_DATA_ERROR {
            self.fail(result.2);
        }
        result
    }

    fn finish(&mut self) -> i32 {
        if let Some(error) = self.error {
            return error;
        }
        let complete = match &mut self.decoder {
            Decoder::Unzip => false,
            Decoder::Zlib { complete, .. }
            | Decoder::Brotli { complete, .. }
            | Decoder::Deflate { complete, .. }
            | Decoder::BrotliEncode { complete, .. } => *complete,
            Decoder::Gzip {
                members,
                at_member_boundary,
                finished,
                ..
            } => {
                if *members > 0 && *at_member_boundary {
                    *finished = true;
                }
                *finished
            }
        };
        if complete {
            MAL_ZLIB_STATUS_STREAM_END
        } else {
            self.fail(MAL_ZLIB_STATUS_TRUNCATED)
        }
    }

    fn reset(&mut self) -> i32 {
        match new_codec(self.config) {
            Some(codec) => {
                if let Decoder::BrotliEncode { encoder, .. } = &mut self.decoder {
                    BrotliEncoderDestroyInstance(encoder);
                }
                self.decoder = codec;
                self.error = None;
                MAL_ZLIB_STATUS_NEED_INPUT
            }
            None => MAL_ZLIB_STATUS_INVALID_ARGUMENT,
        }
    }

    fn set_level(&mut self, level: i32) -> i32 {
        self.config.level = level;
        match &mut self.decoder {
            Decoder::Deflate { encoder, .. } => match encoder.set_level(deflate_level(level)) {
                Ok(()) => MAL_ZLIB_STATUS_NEED_INPUT,
                Err(_) => MAL_ZLIB_STATUS_NEED_OUTPUT,
            },
            _ => MAL_ZLIB_STATUS_NEED_INPUT,
        }
    }

    fn set_brotli_parameter(&mut self, id: u32, value: u32) -> i32 {
        match &mut self.decoder {
            Decoder::BrotliEncode { encoder, .. } => match brotli_parameter(id) {
                Some(parameter) if encoder.set_parameter(parameter, value) => {
                    MAL_ZLIB_STATUS_NEED_INPUT
                }
                _ => MAL_ZLIB_STATUS_INVALID_ARGUMENT,
            },
            // Decoder parameters only tune memory reuse; every stream still decodes.
            _ => MAL_ZLIB_STATUS_NEED_INPUT,
        }
    }
}

fn stream_status(
    status: Status,
    input: &[u8],
    output: &[u8],
    consumed: usize,
    produced: usize,
) -> i32 {
    if status == Status::StreamEnd {
        MAL_ZLIB_STATUS_STREAM_END
    } else if output.is_empty() || produced == output.len() {
        MAL_ZLIB_STATUS_NEED_OUTPUT
    } else if input.is_empty() || consumed == input.len() {
        MAL_ZLIB_STATUS_NEED_INPUT
    } else {
        // A non-terminal codec call can stop only at one of its bounded buffers.
        MAL_ZLIB_STATUS_NEED_INPUT
    }
}

fn pump_gzip(
    decoder: &mut Decompress,
    members: &mut usize,
    at_member_boundary: &mut bool,
    input: &[u8],
    output: &mut [u8],
) -> (usize, usize, i32) {
    let mut consumed = 0;
    let mut produced = 0;

    loop {
        if *at_member_boundary {
            if consumed == input.len() {
                return (consumed, produced, MAL_ZLIB_STATUS_NEED_INPUT);
            }
            *decoder = Decompress::new_gzip(15);
            *at_member_boundary = false;
        }

        let before_in = decoder.total_in();
        let before_out = decoder.total_out();
        let status = match decoder.decompress(
            &input[consumed..],
            &mut output[produced..],
            FlushDecompress::None,
        ) {
            Ok(status) => status,
            Err(_) => {
                consumed += (decoder.total_in() - before_in) as usize;
                produced += (decoder.total_out() - before_out) as usize;
                return (consumed, produced, MAL_ZLIB_STATUS_DATA_ERROR);
            }
        };
        consumed += (decoder.total_in() - before_in) as usize;
        produced += (decoder.total_out() - before_out) as usize;

        if status == Status::StreamEnd {
            *members += 1;
            *at_member_boundary = true;
            if produced == output.len() && consumed < input.len() {
                return (consumed, produced, MAL_ZLIB_STATUS_NEED_OUTPUT);
            }
            continue;
        }
        return (
            consumed,
            produced,
            stream_status(status, input, output, consumed, produced),
        );
    }
}

/// Returns the ABI version compiled into the archive.
#[no_mangle]
pub extern "C" fn mal_zlib_abi_version() -> u32 {
    MAL_ZLIB_ABI_VERSION
}

/// Allocate a decoder handle into `out_handle`. Unsupported formats leave it null.
///
/// # Safety
///
/// `out_handle` must be null or point to aligned, writable storage for one pointer.
#[no_mangle]
pub unsafe extern "C" fn mal_zlib_create(format: u32, out_handle: *mut *mut MalZlibStream) -> i32 {
    unsafe { mal_zlib_create_codec(format, 0, -1, 15, out_handle) }
}

/// Allocate an encoder (`encode != 0`) or decoder handle into `out_handle`.
///
/// # Safety
///
/// `out_handle` must be null or point to aligned, writable storage for one pointer.
#[no_mangle]
pub unsafe extern "C" fn mal_zlib_create_codec(
    format: u32,
    encode: u32,
    level: i32,
    window_bits: i32,
    out_handle: *mut *mut MalZlibStream,
) -> i32 {
    if out_handle.is_null() {
        return MAL_ZLIB_STATUS_INVALID_ARGUMENT;
    }
    unsafe { out_handle.write(core::ptr::null_mut()) };
    let Some(stream) = MalZlibStream::with_config(Config {
        format,
        encode: encode != 0,
        level,
        window_bits,
    }) else {
        return MAL_ZLIB_STATUS_INVALID_ARGUMENT;
    };
    unsafe { out_handle.write(Box::into_raw(Box::new(stream))) };
    MAL_ZLIB_STATUS_NEED_INPUT
}

/// Consume and produce within caller-owned bounded buffers.
///
/// # Safety
///
/// `handle` must be a live handle with exclusive access for the call. Non-empty
/// input/output buffers with lengths at most `isize::MAX` must be readable/writable
/// for their stated lengths and must not overlap. Each non-null counter must be
/// writable; when both are non-null they must be distinct and must not alias either
/// buffer.
#[no_mangle]
pub unsafe extern "C" fn mal_zlib_pump(
    handle: *mut MalZlibStream,
    input: *const u8,
    input_len: usize,
    output: *mut u8,
    output_len: usize,
    flush: i32,
    consumed: *mut usize,
    produced: *mut usize,
) -> i32 {
    unsafe {
        if !consumed.is_null() {
            consumed.write(0);
        }
        if !produced.is_null() {
            produced.write(0);
        }
    }
    if consumed.is_null()
        || produced.is_null()
        || handle.is_null()
        || (input_len > 0 && input.is_null())
        || (output_len > 0 && output.is_null())
        || input_len > isize::MAX as usize
        || output_len > isize::MAX as usize
    {
        return MAL_ZLIB_STATUS_INVALID_ARGUMENT;
    }
    let input = if input_len == 0 {
        &[]
    } else {
        unsafe { core::slice::from_raw_parts(input, input_len) }
    };
    let output = if output_len == 0 {
        &mut []
    } else {
        unsafe { core::slice::from_raw_parts_mut(output, output_len) }
    };
    let (used, written, status) = unsafe { &mut *handle }.pump_flush(input, output, flush);
    unsafe {
        consumed.write(used);
        produced.write(written);
    }
    status
}

/// Confirm end-of-input. Returns TRUNCATED unless a complete stream/member ended.
///
/// # Safety
///
/// `handle` must be a live handle with exclusive access for the call.
#[no_mangle]
pub unsafe extern "C" fn mal_zlib_finish(handle: *mut MalZlibStream) -> i32 {
    if handle.is_null() {
        return MAL_ZLIB_STATUS_INVALID_ARGUMENT;
    }
    unsafe { &mut *handle }.finish()
}

/// Restart the codec with its creation parameters and the latest level.
///
/// # Safety
///
/// `handle` must be a live handle with exclusive access for the call.
#[no_mangle]
pub unsafe extern "C" fn mal_zlib_reset(handle: *mut MalZlibStream) -> i32 {
    if handle.is_null() {
        return MAL_ZLIB_STATUS_INVALID_ARGUMENT;
    }
    unsafe { &mut *handle }.reset()
}

/// Change a deflate encoder's level. NEED_OUTPUT means pending output must be flushed first.
///
/// # Safety
///
/// `handle` must be a live handle with exclusive access for the call.
#[no_mangle]
pub unsafe extern "C" fn mal_zlib_set_level(handle: *mut MalZlibStream, level: i32) -> i32 {
    if handle.is_null() {
        return MAL_ZLIB_STATUS_INVALID_ARGUMENT;
    }
    unsafe { &mut *handle }.set_level(level)
}

/// Set one Node `BROTLI_PARAM_*` encoder parameter before any input is pumped.
///
/// # Safety
///
/// `handle` must be a live handle with exclusive access for the call.
#[no_mangle]
pub unsafe extern "C" fn mal_zlib_set_brotli_param(
    handle: *mut MalZlibStream,
    param: u32,
    value: u32,
) -> i32 {
    if handle.is_null() {
        return MAL_ZLIB_STATUS_INVALID_ARGUMENT;
    }
    unsafe { &mut *handle }.set_brotli_parameter(param, value)
}

const fn crc32_table() -> [[u32; 256]; 8] {
    let mut table = [[0u32; 256]; 8];
    let mut i = 0;
    while i < 256 {
        let mut crc = i as u32;
        let mut bit = 0;
        while bit < 8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
            bit += 1;
        }
        table[0][i] = crc;
        i += 1;
    }
    let mut i = 0;
    while i < 256 {
        let mut slice = 1;
        while slice < 8 {
            let previous = table[slice - 1][i];
            table[slice][i] = (previous >> 8) ^ table[0][(previous & 0xff) as usize];
            slice += 1;
        }
        i += 1;
    }
    table
}

static CRC32_TABLE: [[u32; 256]; 8] = crc32_table();

fn crc32_update(value: u32, bytes: &[u8]) -> u32 {
    let mut crc = !value;
    let mut chunks = bytes.chunks_exact(8);
    for chunk in &mut chunks {
        let low = crc ^ u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        let t = &CRC32_TABLE;
        crc = t[7][(low & 0xff) as usize]
            ^ t[6][((low >> 8) & 0xff) as usize]
            ^ t[5][((low >> 16) & 0xff) as usize]
            ^ t[4][(low >> 24) as usize]
            ^ t[3][chunk[4] as usize]
            ^ t[2][chunk[5] as usize]
            ^ t[1][chunk[6] as usize]
            ^ t[0][chunk[7] as usize];
    }
    for &byte in chunks.remainder() {
        crc = (crc >> 8) ^ CRC32_TABLE[0][((crc ^ byte as u32) & 0xff) as usize];
    }
    !crc
}

/// Continue the standard (zlib) CRC-32 `value` over `length` bytes.
///
/// # Safety
///
/// `bytes` must be readable for `length` bytes when `length` is non-zero.
#[no_mangle]
pub unsafe extern "C" fn mal_zlib_crc32(value: u32, bytes: *const u8, length: usize) -> u32 {
    if length == 0 || bytes.is_null() {
        return value;
    }
    crc32_update(value, unsafe { core::slice::from_raw_parts(bytes, length) })
}

/// Null and release an owned handle. Repeating this call on the same slot is safe.
///
/// # Safety
///
/// `handle` must be null or point to an aligned, writable slot containing null or
/// a live handle returned by `mal_zlib_create`. The slot must be exclusively held.
#[no_mangle]
pub unsafe extern "C" fn mal_zlib_free(handle: *mut *mut MalZlibStream) {
    if handle.is_null() {
        return;
    }
    let owned = unsafe { handle.read() };
    unsafe { handle.write(core::ptr::null_mut()) };
    if !owned.is_null() {
        drop(unsafe { Box::from_raw(owned) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Generated with Node's zlibSync/gzipSync/brotliCompressSync. Keeping fixed
    // wire fixtures means backend tests do not rely on another codec implementation.
    const TEXT: &[u8] = b"bounded streaming output; split input; portable codecs";
    const ZLIB: &[u8] = &[
        120, 156, 75, 202, 47, 205, 75, 73, 77, 81, 40, 46, 41, 74, 77, 204, 205, 204, 75, 87, 200,
        47, 45, 41, 40, 45, 177, 86, 40, 46, 200, 201, 44, 81, 200, 204, 3, 115, 10, 242, 139, 74,
        18, 147, 114, 82, 21, 146, 243, 83, 82, 147, 139, 1, 62, 238, 20, 185,
    ];
    const BROTLI: &[u8] = &[
        27, 53, 0, 0, 140, 84, 181, 191, 28, 75, 115, 171, 157, 57, 240, 144, 133, 220, 205, 21,
        13, 216, 1, 27, 171, 109, 88, 216, 152, 147, 124, 163, 97, 107, 213, 148, 222, 36, 4, 164,
        156,
    ];
    const GZIP_A: &[u8] = &[
        31, 139, 8, 0, 0, 0, 0, 0, 0, 19, 75, 204, 41, 200, 72, 4, 0, 106, 57, 224, 208, 5, 0, 0, 0,
    ];
    const GZIP_B: &[u8] = &[
        31, 139, 8, 0, 0, 0, 0, 0, 0, 19, 75, 74, 45, 73, 4, 0, 99, 4, 145, 143, 4, 0, 0, 0,
    ];

    fn decode(format: u32, encoded: &[u8], input_chunk: usize, output_chunk: usize) -> Vec<u8> {
        let mut stream = MalZlibStream::new(format).unwrap();
        let mut decoded = Vec::new();
        for chunk in encoded.chunks(input_chunk) {
            let mut offset = 0;
            loop {
                let mut out = vec![0; output_chunk];
                let (used, written, status) = stream.pump(&chunk[offset..], &mut out);
                offset += used;
                decoded.extend_from_slice(&out[..written]);
                assert!(status > 0, "codec error {status}");
                if offset == chunk.len() && status != MAL_ZLIB_STATUS_NEED_OUTPUT {
                    break;
                }
                assert!(used > 0 || written > 0, "pump made no progress");
            }
        }
        loop {
            let mut out = vec![0; output_chunk];
            let (_, written, status) = stream.pump(&[], &mut out);
            decoded.extend_from_slice(&out[..written]);
            if status != MAL_ZLIB_STATUS_NEED_OUTPUT {
                break;
            }
            assert!(written > 0, "output resume made no progress");
        }
        assert_eq!(stream.finish(), MAL_ZLIB_STATUS_STREAM_END);
        decoded
    }

    fn encode(format: u32, level: i32, input: &[u8], output_chunk: usize) -> Vec<u8> {
        let mut stream = MalZlibStream::with_config(Config {
            format,
            encode: true,
            level,
            window_bits: 15,
        })
        .unwrap();
        let finish = if format == MAL_ZLIB_FORMAT_BROTLI {
            2
        } else {
            4
        };
        let mut encoded = Vec::new();
        let mut offset = 0;
        loop {
            let mut out = vec![0; output_chunk];
            let (used, written, status) = stream.pump_flush(&input[offset..], &mut out, finish);
            offset += used;
            encoded.extend_from_slice(&out[..written]);
            assert!(status > 0, "codec error {status}");
            if status == MAL_ZLIB_STATUS_STREAM_END {
                break;
            }
        }
        assert_eq!(stream.finish(), MAL_ZLIB_STATUS_STREAM_END);
        encoded
    }

    #[test]
    fn encoders_round_trip_through_their_decoders_with_bounded_output() {
        let text = TEXT.repeat(40);
        for format in [
            MAL_ZLIB_FORMAT_ZLIB,
            MAL_ZLIB_FORMAT_GZIP,
            MAL_ZLIB_FORMAT_RAW,
            MAL_ZLIB_FORMAT_BROTLI,
        ] {
            let encoded = encode(format, 6, &text, 7);
            assert!(encoded.len() < text.len());
            assert_eq!(decode(format, &encoded, 5, 11), text);
        }
        assert_eq!(decode(MAL_ZLIB_FORMAT_UNZIP, ZLIB, 4, 4), TEXT);
        assert_eq!(decode(MAL_ZLIB_FORMAT_UNZIP, GZIP_A, 4, 4), b"alpha");
    }

    #[test]
    fn crc32_matches_the_zlib_check_value_and_continues() {
        assert_eq!(crc32_update(0, b"123456789"), 0xcbf4_3926);
        assert_eq!(
            crc32_update(crc32_update(0, b"1234"), b"56789"),
            0xcbf4_3926
        );
    }

    fn pump_to_quiescence(
        stream: &mut MalZlibStream,
        input: &[u8],
        output_chunk: usize,
    ) -> (Vec<u8>, i32) {
        assert!(output_chunk > 0);
        let mut decoded = Vec::new();
        let mut offset = 0;
        loop {
            let mut out = vec![0; output_chunk];
            let (used, written, status) = stream.pump(&input[offset..], &mut out);
            offset += used;
            decoded.extend_from_slice(&out[..written]);
            assert!(status > 0, "unexpected codec error {status}");
            if status == MAL_ZLIB_STATUS_NEED_OUTPUT || offset < input.len() {
                assert!(used > 0 || written > 0, "pump made no progress");
                continue;
            }
            assert_eq!(offset, input.len());
            return (decoded, status);
        }
    }

    #[test]
    fn zlib_supports_split_input_and_bounded_output_resume() {
        assert_eq!(decode(MAL_ZLIB_FORMAT_ZLIB, ZLIB, 1, 3), TEXT);
    }

    #[test]
    fn brotli_supports_split_input_and_bounded_output_resume() {
        assert_eq!(decode(MAL_ZLIB_FORMAT_BROTLI, BROTLI, 2, 4), TEXT);
    }

    #[test]
    fn gzip_decodes_concatenated_members() {
        let encoded = [GZIP_A, GZIP_B].concat();
        assert_eq!(decode(MAL_ZLIB_FORMAT_GZIP, &encoded, 3, 2), b"alphabeta");
    }

    #[test]
    fn successful_gzip_finish_is_terminal() {
        let mut stream = MalZlibStream::new(MAL_ZLIB_FORMAT_GZIP).unwrap();
        let (decoded, status) = pump_to_quiescence(&mut stream, GZIP_A, 2);
        assert_eq!(decoded, b"alpha");
        assert_eq!(status, MAL_ZLIB_STATUS_NEED_INPUT);
        assert_eq!(stream.finish(), MAL_ZLIB_STATUS_STREAM_END);

        let mut out = [0; 8];
        assert_eq!(
            stream.pump(GZIP_B, &mut out),
            (0, 0, MAL_ZLIB_STATUS_STREAM_END)
        );
        assert_eq!(stream.finish(), MAL_ZLIB_STATUS_STREAM_END);
    }

    #[test]
    fn malformed_and_truncated_streams_are_distinct() {
        let mut out = [0; 32];
        let mut bad_gzip = GZIP_A.to_vec();
        bad_gzip[GZIP_A.len() - 8] ^= 0xff;
        for (format, malformed_input) in [
            (MAL_ZLIB_FORMAT_ZLIB, b"not zlib".as_slice()),
            (MAL_ZLIB_FORMAT_GZIP, bad_gzip.as_slice()),
            (MAL_ZLIB_FORMAT_BROTLI, [0xff; 32].as_slice()),
        ] {
            let mut malformed = MalZlibStream::new(format).unwrap();
            assert_eq!(
                malformed.pump(malformed_input, &mut out).2,
                MAL_ZLIB_STATUS_DATA_ERROR
            );
            assert_eq!(malformed.finish(), MAL_ZLIB_STATUS_DATA_ERROR);
        }

        for (format, encoded) in [
            (MAL_ZLIB_FORMAT_ZLIB, ZLIB),
            (MAL_ZLIB_FORMAT_BROTLI, BROTLI),
        ] {
            let mut truncated = MalZlibStream::new(format).unwrap();
            let (_, status) = pump_to_quiescence(&mut truncated, &encoded[..encoded.len() - 2], 2);
            assert_ne!(status, MAL_ZLIB_STATUS_NEED_OUTPUT);
            assert_eq!(truncated.finish(), MAL_ZLIB_STATUS_TRUNCATED);
        }

        let concatenated = [GZIP_A, GZIP_B].concat();
        let truncated_gzip = [
            ("header", GZIP_A[..5].to_vec()),
            ("trailer", GZIP_A[..GZIP_A.len() - 2].to_vec()),
            ("later member header", [GZIP_A, &GZIP_B[..5]].concat()),
            (
                "later member trailer",
                concatenated[..concatenated.len() - 2].to_vec(),
            ),
        ];
        for (case, encoded) in truncated_gzip {
            let mut truncated = MalZlibStream::new(MAL_ZLIB_FORMAT_GZIP).unwrap();
            let (_, status) = pump_to_quiescence(&mut truncated, &encoded, 2);
            assert_ne!(status, MAL_ZLIB_STATUS_NEED_OUTPUT, "{case}");
            assert_eq!(truncated.finish(), MAL_ZLIB_STATUS_TRUNCATED, "{case}");
        }
    }

    #[test]
    fn ffi_invalid_arguments_initialize_valid_counters_and_reject_oversized_lengths() {
        let mut handle = core::ptr::null_mut();
        unsafe {
            assert_eq!(
                mal_zlib_create(MAL_ZLIB_FORMAT_ZLIB, &mut handle),
                MAL_ZLIB_STATUS_NEED_INPUT
            );

            let mut consumed = 7;
            assert_eq!(
                mal_zlib_pump(
                    handle,
                    core::ptr::null(),
                    0,
                    core::ptr::null_mut(),
                    0,
                    0,
                    &mut consumed,
                    core::ptr::null_mut(),
                ),
                MAL_ZLIB_STATUS_INVALID_ARGUMENT
            );
            assert_eq!(consumed, 0);

            let mut produced = 9;
            assert_eq!(
                mal_zlib_pump(
                    handle,
                    core::ptr::null(),
                    0,
                    core::ptr::null_mut(),
                    0,
                    0,
                    core::ptr::null_mut(),
                    &mut produced,
                ),
                MAL_ZLIB_STATUS_INVALID_ARGUMENT
            );
            assert_eq!(produced, 0);

            let oversized = isize::MAX as usize + 1;
            let mut byte = 0;
            consumed = 7;
            produced = 9;
            assert_eq!(
                mal_zlib_pump(
                    handle,
                    &byte,
                    oversized,
                    core::ptr::null_mut(),
                    0,
                    0,
                    &mut consumed,
                    &mut produced,
                ),
                MAL_ZLIB_STATUS_INVALID_ARGUMENT
            );
            assert_eq!((consumed, produced), (0, 0));

            consumed = 7;
            produced = 9;
            assert_eq!(
                mal_zlib_pump(
                    handle,
                    core::ptr::null(),
                    0,
                    &mut byte,
                    oversized,
                    0,
                    &mut consumed,
                    &mut produced,
                ),
                MAL_ZLIB_STATUS_INVALID_ARGUMENT
            );
            assert_eq!((consumed, produced), (0, 0));
            mal_zlib_free(&mut handle);
        }
    }

    #[test]
    fn ffi_free_nulls_ownership_and_is_idempotent() {
        let mut handle = core::ptr::null_mut();
        unsafe {
            assert_eq!(
                mal_zlib_create(MAL_ZLIB_FORMAT_ZLIB, &mut handle),
                MAL_ZLIB_STATUS_NEED_INPUT
            );
            assert!(!handle.is_null());
            mal_zlib_free(&mut handle);
            assert!(handle.is_null());
            mal_zlib_free(&mut handle);
            mal_zlib_free(core::ptr::null_mut());
        }
    }
}
