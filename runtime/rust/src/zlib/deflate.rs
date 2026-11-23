use flate2::{Compress, Compression, Decompress, FlushCompress, FlushDecompress, Status};

use super::{
    Codec, PumpResult, MAL_ZLIB_FORMAT_GZIP, MAL_ZLIB_FORMAT_RAW, MAL_ZLIB_FORMAT_UNZIP,
    MAL_ZLIB_FORMAT_ZLIB, MAL_ZLIB_STATUS_DATA_ERROR, MAL_ZLIB_STATUS_INVALID_ARGUMENT,
    MAL_ZLIB_STATUS_NEED_INPUT, MAL_ZLIB_STATUS_NEED_OUTPUT, MAL_ZLIB_STATUS_STREAM_END,
};

enum DecodeState {
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
    Unzip,
}

impl DecodeState {
    fn zlib(header: bool) -> Self {
        Self::Zlib {
            decoder: Decompress::new(header),
            complete: false,
        }
    }

    fn gzip() -> Self {
        Self::Gzip {
            decoder: Decompress::new_gzip(15),
            members: 0,
            at_member_boundary: false,
            finished: false,
        }
    }
}

pub(super) struct DeflateDecoder {
    format: u32,
    state: DecodeState,
}

impl DeflateDecoder {
    pub(super) fn new(format: u32) -> Option<Self> {
        let state = match format {
            MAL_ZLIB_FORMAT_ZLIB => DecodeState::zlib(true),
            MAL_ZLIB_FORMAT_RAW => DecodeState::zlib(false),
            MAL_ZLIB_FORMAT_GZIP => DecodeState::gzip(),
            MAL_ZLIB_FORMAT_UNZIP => DecodeState::Unzip,
            _ => return None,
        };
        Some(Self { format, state })
    }
}

impl Codec for DeflateDecoder {
    fn pump(&mut self, input: &[u8], output: &mut [u8], _flush: i32) -> PumpResult {
        if matches!(self.state, DecodeState::Unzip) {
            let Some(&first) = input.first() else {
                return (0, 0, MAL_ZLIB_STATUS_NEED_INPUT);
            };
            // 0x1f can only start gzip: as a zlib CMF it names compression method 15.
            self.state = if first == 0x1f {
                DecodeState::gzip()
            } else {
                DecodeState::zlib(true)
            };
        }

        match &mut self.state {
            DecodeState::Unzip => unreachable!(),
            DecodeState::Zlib { decoder, complete } => {
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
            DecodeState::Gzip {
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
        }
    }

    fn is_finished(&mut self) -> bool {
        match &mut self.state {
            DecodeState::Unzip => false,
            DecodeState::Zlib { complete, .. } => *complete,
            DecodeState::Gzip {
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
        }
    }

    fn reset(&mut self) {
        *self = Self::new(self.format).expect("reset uses the validated creation format");
    }
}

pub(super) struct DeflateEncoder {
    format: u32,
    level: i32,
    bits: u8,
    encoder: Compress,
    complete: bool,
}

impl DeflateEncoder {
    pub(super) fn new(format: u32, level: i32, window_bits: i32) -> Option<Self> {
        // zlib raises an 8-bit deflate window to 9; flate2 panics instead.
        let bits = window_bits.clamp(9, 15) as u8;
        let compression = deflate_level(level);
        let encoder = match format {
            MAL_ZLIB_FORMAT_ZLIB => Compress::new_with_window_bits(compression, true, bits),
            MAL_ZLIB_FORMAT_RAW => Compress::new_with_window_bits(compression, false, bits),
            MAL_ZLIB_FORMAT_GZIP => Compress::new_gzip(compression, bits),
            _ => return None,
        };
        Some(Self {
            format,
            level,
            bits,
            encoder,
            complete: false,
        })
    }
}

impl Codec for DeflateEncoder {
    fn pump(&mut self, input: &[u8], output: &mut [u8], flush: i32) -> PumpResult {
        let Self {
            encoder, complete, ..
        } = self;
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

    fn is_finished(&mut self) -> bool {
        self.complete
    }

    fn reset(&mut self) {
        *self = Self::new(self.format, self.level, self.bits.into())
            .expect("reset uses the validated creation format");
    }

    fn set_level(&mut self, level: i32) -> i32 {
        self.level = level;
        match self.encoder.set_level(deflate_level(level)) {
            Ok(()) => MAL_ZLIB_STATUS_NEED_INPUT,
            Err(_) => MAL_ZLIB_STATUS_NEED_OUTPUT,
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
