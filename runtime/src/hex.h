#pragma once

#include "./defaults.h"

struct MalHeap;
struct MalString;

bool mal_hex_encoded_length(usize input_length, usize limit, usize *out);

i32 mal_hex_decode_digit(u32 unit);

void mal_hex_encode_byte_lower(byte value, byte output[2]);

void mal_hex_encode_lower(const byte *input, usize input_length, byte *output);

/** Encode directly into one managed UTF-16 String allocation. */
struct MalString *mal_hex_encode_string(
    struct MalHeap *heap, const byte *input, usize input_length);
