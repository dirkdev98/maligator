use brotli::enc::encode::{
    BrotliEncoderDestroyInstance, BrotliEncoderOperation, BrotliEncoderParameter,
    BrotliEncoderStateStruct,
};
use brotli_decompressor::{BrotliDecompressStream, BrotliResult, BrotliState, StandardAlloc};

use super::{
    Codec, PumpResult, MAL_ZLIB_STATUS_DATA_ERROR, MAL_ZLIB_STATUS_INVALID_ARGUMENT,
    MAL_ZLIB_STATUS_NEED_INPUT, MAL_ZLIB_STATUS_NEED_OUTPUT, MAL_ZLIB_STATUS_STREAM_END,
};

pub(super) struct BrotliDecoder {
    decoder: BrotliState<StandardAlloc, StandardAlloc, StandardAlloc>,
    total_out: usize,
    complete: bool,
}

impl BrotliDecoder {
    pub(super) fn new() -> Self {
        Self {
            decoder: BrotliState::new(
                StandardAlloc::default(),
                StandardAlloc::default(),
                StandardAlloc::default(),
            ),
            total_out: 0,
            complete: false,
        }
    }
}

impl Codec for BrotliDecoder {
    fn pump(&mut self, input: &[u8], output: &mut [u8], _flush: i32) -> PumpResult {
        let Self {
            decoder,
            total_out,
            complete,
        } = self;
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

    fn is_finished(&mut self) -> bool {
        self.complete
    }

    fn reset(&mut self) {
        *self = Self::new();
    }
}

pub(super) struct BrotliEncoder {
    encoder: BrotliEncoderStateStruct<StandardAlloc>,
    complete: bool,
}

impl BrotliEncoder {
    pub(super) fn new() -> Self {
        Self {
            encoder: BrotliEncoderStateStruct::new(StandardAlloc::default()),
            complete: false,
        }
    }
}

impl Drop for BrotliEncoder {
    fn drop(&mut self) {
        BrotliEncoderDestroyInstance(&mut self.encoder);
    }
}

impl Codec for BrotliEncoder {
    fn pump(&mut self, input: &[u8], output: &mut [u8], flush: i32) -> PumpResult {
        let Self { encoder, complete } = self;
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
            } else if encoder.has_more_output() || available_out == 0 || input_offset < input.len()
            {
                MAL_ZLIB_STATUS_NEED_OUTPUT
            } else {
                MAL_ZLIB_STATUS_NEED_INPUT
            };
            (input_offset, output_offset, status)
        }
    }

    fn is_finished(&mut self) -> bool {
        self.complete
    }

    fn reset(&mut self) {
        *self = Self::new();
    }

    fn set_brotli_parameter(&mut self, id: u32, value: u32) -> i32 {
        match brotli_parameter(id) {
            Some(parameter) if self.encoder.set_parameter(parameter, value) => {
                MAL_ZLIB_STATUS_NEED_INPUT
            }
            _ => MAL_ZLIB_STATUS_INVALID_ARGUMENT,
        }
    }
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
