#pragma once

#include "./defaults.h"

bool mal_hex_encoded_length(usize input_length, usize limit, usize *out);

i32 mal_hex_decode_digit(u32 unit);

void mal_hex_encode_byte_lower(byte value, byte output[2]);

void mal_hex_encode_lower(const byte *input, usize input_length, byte *output);
