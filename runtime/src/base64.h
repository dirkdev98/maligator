#pragma once

#include "./defaults.h"

typedef enum MalBase64Alphabet {
    MAL_BASE64_ALPHABET_STANDARD,
    MAL_BASE64_ALPHABET_URL,
    MAL_BASE64_ALPHABET_EITHER,
} MalBase64Alphabet;

extern const byte mal_base64_alphabet_standard[];
extern const byte mal_base64_alphabet_url[];

struct MalHeap;
struct MalString;

bool mal_base64_encoded_length(
    usize input_length, bool padding, usize limit, usize *out);

bool mal_base64_is_ascii_whitespace(u32 unit);

i32 mal_base64_decode_digit(u32 unit, MalBase64Alphabet alphabet);

usize mal_base64_encode_block(
    const byte *input, usize input_length, MalBase64Alphabet alphabet,
    bool padding, byte output[4]);

usize mal_base64_encode(
    const byte *input, usize input_length, MalBase64Alphabet alphabet,
    bool padding, byte *output);

/** Encode directly into one managed UTF-16 String allocation. */
struct MalString *mal_base64_encode_string(
    struct MalHeap *heap, const byte *input, usize input_length,
    MalBase64Alphabet alphabet, bool padding);
