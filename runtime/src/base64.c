#include "base64.h"

#include "checked_size.h"

const byte mal_base64_alphabet_standard[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const byte mal_base64_alphabet_url[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

bool mal_base64_encoded_length(
    usize input_length, bool padding, usize limit, usize *out
) {
    usize full_length;
    if (!mal_checked_size_multiply(input_length / 3, 4, limit, &full_length)) {
        return false;
    }
    usize remaining = input_length % 3;
    usize tail_length = remaining == 0 ? 0 : padding ? 4 : remaining + 1;
    return mal_checked_size_add(full_length, tail_length, limit, out);
}

bool mal_base64_is_ascii_whitespace(u32 unit) {
    return unit == 0x09 || unit == 0x0a || unit == 0x0c
        || unit == 0x0d || unit == 0x20;
}

i32 mal_base64_decode_digit(u32 unit, MalBase64Alphabet alphabet) {
    if (unit >= 'A' && unit <= 'Z') return (i32) (unit - 'A');
    if (unit >= 'a' && unit <= 'z') return (i32) (unit - 'a' + 26);
    if (unit >= '0' && unit <= '9') return (i32) (unit - '0' + 52);
    if (unit == '+' && alphabet != MAL_BASE64_ALPHABET_URL) return 62;
    if (unit == '/' && alphabet != MAL_BASE64_ALPHABET_URL) return 63;
    if (unit == '-' && alphabet != MAL_BASE64_ALPHABET_STANDARD) return 62;
    if (unit == '_' && alphabet != MAL_BASE64_ALPHABET_STANDARD) return 63;
    return -1;
}

usize mal_base64_encode_block(
    const byte *input, usize input_length, MalBase64Alphabet alphabet,
    bool padding, byte output[4]
) {
    if (input_length == 0) return 0;
    const byte *digits = alphabet == MAL_BASE64_ALPHABET_URL
        ? mal_base64_alphabet_url
        : mal_base64_alphabet_standard;
    u32 word = (u32) (u8) input[0] << 16;
    if (input_length > 1) word |= (u32) (u8) input[1] << 8;
    if (input_length > 2) word |= (u8) input[2];
    output[0] = digits[(word >> 18) & 0x3f];
    output[1] = digits[(word >> 12) & 0x3f];
    if (input_length > 1) output[2] = digits[(word >> 6) & 0x3f];
    else if (padding) output[2] = '=';
    if (input_length > 2) output[3] = digits[word & 0x3f];
    else if (padding) output[3] = '=';
    return input_length == 3 || padding ? 4 : input_length + 1;
}

usize mal_base64_encode(
    const byte *input, usize input_length, MalBase64Alphabet alphabet,
    bool padding, byte *output
) {
    usize read = 0;
    usize written = 0;
    while (read < input_length) {
        usize remaining = input_length - read;
        usize block_length = remaining < 3 ? remaining : 3;
        written += mal_base64_encode_block(
            input + read, block_length, alphabet, padding, output + written);
        read += block_length;
    }
    return written;
}
