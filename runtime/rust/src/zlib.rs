//! Streaming decompression primitives for the node:zlib adapter.
//!
//! Input and output are borrowed only for one `mal_zlib_pump` call. Persistent
//! state contains codec state and scalar counters, never pointers into JS or C.

use brotli_decompressor::{BrotliDecompressStream, BrotliResult, BrotliState, StandardAlloc};
use flate2::{Decompress, FlushDecompress, Status};

pub const MAL_ZLIB_ABI_VERSION: u32 = 1;

pub const MAL_ZLIB_FORMAT_ZLIB: u32 = 1;
pub const MAL_ZLIB_FORMAT_GZIP: u32 = 2;
pub const MAL_ZLIB_FORMAT_BROTLI: u32 = 3;

pub const MAL_ZLIB_STATUS_NEED_INPUT: i32 = 1;
pub const MAL_ZLIB_STATUS_NEED_OUTPUT: i32 = 2;
pub const MAL_ZLIB_STATUS_STREAM_END: i32 = 3;
pub const MAL_ZLIB_STATUS_DATA_ERROR: i32 = -1;
pub const MAL_ZLIB_STATUS_TRUNCATED: i32 = -2;
pub const MAL_ZLIB_STATUS_INVALID_ARGUMENT: i32 = -3;

type BrotliDecoder = BrotliState<StandardAlloc, StandardAlloc, StandardAlloc>;

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
}

/// Opaque to C. The sticky error makes calls after malformed input deterministic.
pub struct MalZlibStream {
    decoder: Decoder,
    error: Option<i32>,
}

impl MalZlibStream {
    fn new(format: u32) -> Option<Self> {
        let decoder = match format {
            MAL_ZLIB_FORMAT_ZLIB => Decoder::Zlib {
                decoder: Decompress::new(true),
                complete: false,
            },
            MAL_ZLIB_FORMAT_GZIP => Decoder::Gzip {
                decoder: Decompress::new_gzip(15),
                members: 0,
                at_member_boundary: false,
                finished: false,
            },
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
        };
        Some(Self {
            decoder,
            error: None,
        })
    }

    fn fail(&mut self, status: i32) -> i32 {
        self.error = Some(status);
        status
    }

    fn pump(&mut self, input: &[u8], output: &mut [u8]) -> (usize, usize, i32) {
        if let Some(error) = self.error {
            return (0, 0, error);
        }

        let result = match &mut self.decoder {
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
            Decoder::Zlib { complete, .. } | Decoder::Brotli { complete, .. } => *complete,
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

/// Allocate a codec handle into `out_handle`. Unsupported formats leave it null.
///
/// # Safety
///
/// `out_handle` must be null or point to aligned, writable storage for one pointer.
#[no_mangle]
pub unsafe extern "C" fn mal_zlib_create(format: u32, out_handle: *mut *mut MalZlibStream) -> i32 {
    if out_handle.is_null() {
        return MAL_ZLIB_STATUS_INVALID_ARGUMENT;
    }
    unsafe { out_handle.write(core::ptr::null_mut()) };
    let Some(stream) = MalZlibStream::new(format) else {
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
    let (used, written, status) = unsafe { &mut *handle }.pump(input, output);
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
