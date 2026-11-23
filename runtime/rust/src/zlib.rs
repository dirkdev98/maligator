//! Streaming codec primitives for the node:zlib adapter.
//!
//! Input and output are borrowed only for one `mal_zlib_pump` call. Persistent
//! state contains codec state and scalar counters, never pointers into JS or C.

mod brotli;
mod deflate;

use self::brotli::{BrotliDecoder, BrotliEncoder};
use deflate::{DeflateDecoder, DeflateEncoder};

pub const MAL_ZLIB_ABI_VERSION: u32 = 3;

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

type PumpResult = (usize, usize, i32);
type Pump = unsafe fn(*mut MalZlibStream, &[u8], &mut [u8], i32) -> PumpResult;

trait Codec {
    fn pump(&mut self, input: &[u8], output: &mut [u8], flush: i32) -> PumpResult;
    fn is_finished(&mut self) -> bool;
    fn reset(&mut self);

    fn set_level(&mut self, _level: i32) -> i32 {
        MAL_ZLIB_STATUS_NEED_INPUT
    }

    // Decoder parameters only tune memory reuse.
    fn set_brotli_parameter(&mut self, _id: u32, _value: u32) -> i32 {
        MAL_ZLIB_STATUS_NEED_INPUT
    }
}

struct StreamOperations {
    pump: Pump,
    is_finished: unsafe fn(*mut MalZlibStream) -> bool,
    reset: unsafe fn(*mut MalZlibStream),
    set_level: unsafe fn(*mut MalZlibStream, i32) -> i32,
    set_brotli_parameter: unsafe fn(*mut MalZlibStream, u32, u32) -> i32,
    free: unsafe fn(*mut MalZlibStream),
}

#[repr(C)]
pub struct MalZlibStream {
    operations: &'static StreamOperations,
    error: Option<i32>,
}

// The header and concrete codec share one allocation. Only the constructor for
// a codec references its operations, so a decoder does not link encoder code.
#[repr(C)]
struct CodecStream<C> {
    header: MalZlibStream,
    codec: C,
}

impl<C: Codec> CodecStream<C> {
    const OPERATIONS: StreamOperations = StreamOperations {
        pump: Self::pump,
        is_finished: Self::is_finished,
        reset: Self::reset,
        set_level: Self::set_level,
        set_brotli_parameter: Self::set_brotli_parameter,
        free: Self::free,
    };

    fn into_raw(codec: C) -> *mut MalZlibStream {
        Box::into_raw(Box::new(Self {
            header: MalZlibStream {
                operations: &Self::OPERATIONS,
                error: None,
            },
            codec,
        }))
        .cast()
    }

    // Every operation receives the original allocation pointer, with the table
    // selected by the same concrete type that allocated it.
    unsafe fn pump(
        handle: *mut MalZlibStream,
        input: &[u8],
        output: &mut [u8],
        flush: i32,
    ) -> PumpResult {
        unsafe { &mut (*handle.cast::<Self>()).codec }.pump(input, output, flush)
    }

    unsafe fn is_finished(handle: *mut MalZlibStream) -> bool {
        unsafe { &mut (*handle.cast::<Self>()).codec }.is_finished()
    }

    unsafe fn reset(handle: *mut MalZlibStream) {
        unsafe { &mut (*handle.cast::<Self>()).codec }.reset();
    }

    unsafe fn set_level(handle: *mut MalZlibStream, level: i32) -> i32 {
        unsafe { &mut (*handle.cast::<Self>()).codec }.set_level(level)
    }

    unsafe fn set_brotli_parameter(handle: *mut MalZlibStream, id: u32, value: u32) -> i32 {
        unsafe { &mut (*handle.cast::<Self>()).codec }.set_brotli_parameter(id, value)
    }

    unsafe fn free(handle: *mut MalZlibStream) {
        drop(unsafe { Box::from_raw(handle.cast::<Self>()) });
    }
}

unsafe fn pump_stream(
    handle: *mut MalZlibStream,
    input: &[u8],
    output: &mut [u8],
    flush: i32,
) -> PumpResult {
    if let Some(error) = unsafe { (*handle).error } {
        return (0, 0, error);
    }
    let result = unsafe { ((*handle).operations.pump)(handle, input, output, flush) };
    if result.2 == MAL_ZLIB_STATUS_DATA_ERROR {
        unsafe { (*handle).error = Some(result.2) };
    }
    result
}

unsafe fn create_stream<C: Codec>(
    out: *mut *mut MalZlibStream,
    create: impl FnOnce() -> Option<C>,
) -> i32 {
    if out.is_null() {
        return MAL_ZLIB_STATUS_INVALID_ARGUMENT;
    }
    unsafe { out.write(core::ptr::null_mut()) };
    let Some(codec) = create() else {
        return MAL_ZLIB_STATUS_INVALID_ARGUMENT;
    };
    unsafe { out.write(CodecStream::into_raw(codec)) };
    MAL_ZLIB_STATUS_NEED_INPUT
}

/// Returns the ABI version compiled into the archive.
#[no_mangle]
pub extern "C" fn mal_zlib_abi_version() -> u32 {
    MAL_ZLIB_ABI_VERSION
}

/// # Safety
/// `out_handle` must be null or point to aligned, writable storage for one pointer.
#[no_mangle]
pub unsafe extern "C" fn mal_zlib_create_deflate_decoder(
    format: u32,
    _level: i32,
    _window_bits: i32,
    out_handle: *mut *mut MalZlibStream,
) -> i32 {
    unsafe { create_stream(out_handle, || DeflateDecoder::new(format)) }
}

/// # Safety
/// `out_handle` must be null or point to aligned, writable storage for one pointer.
#[no_mangle]
pub unsafe extern "C" fn mal_zlib_create_deflate_encoder(
    format: u32,
    level: i32,
    window_bits: i32,
    out_handle: *mut *mut MalZlibStream,
) -> i32 {
    unsafe {
        create_stream(out_handle, || {
            DeflateEncoder::new(format, level, window_bits)
        })
    }
}

/// # Safety
/// `out_handle` must be null or point to aligned, writable storage for one pointer.
#[no_mangle]
pub unsafe extern "C" fn mal_zlib_create_brotli_decoder(
    format: u32,
    _level: i32,
    _window_bits: i32,
    out_handle: *mut *mut MalZlibStream,
) -> i32 {
    unsafe {
        create_stream(out_handle, || {
            (format == MAL_ZLIB_FORMAT_BROTLI).then(BrotliDecoder::new)
        })
    }
}

/// # Safety
/// `out_handle` must be null or point to aligned, writable storage for one pointer.
#[no_mangle]
pub unsafe extern "C" fn mal_zlib_create_brotli_encoder(
    format: u32,
    _level: i32,
    _window_bits: i32,
    out_handle: *mut *mut MalZlibStream,
) -> i32 {
    unsafe {
        create_stream(out_handle, || {
            (format == MAL_ZLIB_FORMAT_BROTLI).then(BrotliEncoder::new)
        })
    }
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
    let (used, written, status) = unsafe { pump_stream(handle, input, output, flush) };
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
    unsafe {
        if let Some(error) = (*handle).error {
            return error;
        }
        if ((*handle).operations.is_finished)(handle) {
            MAL_ZLIB_STATUS_STREAM_END
        } else {
            (*handle).error = Some(MAL_ZLIB_STATUS_TRUNCATED);
            MAL_ZLIB_STATUS_TRUNCATED
        }
    }
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
    unsafe {
        ((*handle).operations.reset)(handle);
        (*handle).error = None;
    }
    MAL_ZLIB_STATUS_NEED_INPUT
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
    unsafe { ((*handle).operations.set_level)(handle, level) }
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
    unsafe { ((*handle).operations.set_brotli_parameter)(handle, param, value) }
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
/// a live codec handle. The slot must be exclusively held.
#[no_mangle]
pub unsafe extern "C" fn mal_zlib_free(handle: *mut *mut MalZlibStream) {
    if handle.is_null() {
        return;
    }
    let owned = unsafe { handle.read() };
    unsafe { handle.write(core::ptr::null_mut()) };
    if !owned.is_null() {
        unsafe { ((*owned).operations.free)(owned) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestStream(*mut MalZlibStream);

    impl TestStream {
        fn new(format: u32) -> Option<Self> {
            let create = if format == MAL_ZLIB_FORMAT_BROTLI {
                mal_zlib_create_brotli_decoder
            } else {
                mal_zlib_create_deflate_decoder
            };
            Self::create(create, format, -1)
        }

        fn create(
            create: unsafe extern "C" fn(u32, i32, i32, *mut *mut MalZlibStream) -> i32,
            format: u32,
            level: i32,
        ) -> Option<Self> {
            let mut handle = core::ptr::null_mut();
            (unsafe { create(format, level, 15, &mut handle) } == MAL_ZLIB_STATUS_NEED_INPUT)
                .then_some(Self(handle))
        }

        fn pump(&mut self, input: &[u8], output: &mut [u8]) -> PumpResult {
            self.pump_flush(input, output, 0)
        }

        fn pump_flush(&mut self, input: &[u8], output: &mut [u8], flush: i32) -> PumpResult {
            unsafe { pump_stream(self.0, input, output, flush) }
        }

        fn finish(&mut self) -> i32 {
            unsafe { mal_zlib_finish(self.0) }
        }
    }

    impl Drop for TestStream {
        fn drop(&mut self) {
            unsafe { mal_zlib_free(&mut self.0) };
        }
    }

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
        let mut stream = TestStream::new(format).unwrap();
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
        let create = if format == MAL_ZLIB_FORMAT_BROTLI {
            mal_zlib_create_brotli_encoder
        } else {
            mal_zlib_create_deflate_encoder
        };
        let mut stream = TestStream::create(create, format, level).unwrap();
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
        stream: &mut TestStream,
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
        let mut stream = TestStream::new(MAL_ZLIB_FORMAT_GZIP).unwrap();
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
            let mut malformed = TestStream::new(format).unwrap();
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
            let mut truncated = TestStream::new(format).unwrap();
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
            let mut truncated = TestStream::new(MAL_ZLIB_FORMAT_GZIP).unwrap();
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
                mal_zlib_create_deflate_decoder(MAL_ZLIB_FORMAT_ZLIB, -1, 15, &mut handle),
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
                mal_zlib_create_deflate_decoder(MAL_ZLIB_FORMAT_ZLIB, -1, 15, &mut handle),
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
