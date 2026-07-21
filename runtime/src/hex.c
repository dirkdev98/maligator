#include "hex.h"

#include "checked_size.h"

static const byte mal_hex_lower_digits[] = "0123456789abcdef";

bool mal_hex_encoded_length(usize input_length, usize limit, usize *out) {
    return mal_checked_size_multiply(input_length, 2, limit, out);
}

i32 mal_hex_decode_digit(u32 unit) {
    if (unit >= '0' && unit <= '9') return (i32) (unit - '0');
    if (unit >= 'a' && unit <= 'f') return (i32) (unit - 'a' + 10);
    if (unit >= 'A' && unit <= 'F') return (i32) (unit - 'A' + 10);
    return -1;
}

void mal_hex_encode_byte_lower(byte value, byte output[2]) {
    u8 octet = (u8) value;
    output[0] = mal_hex_lower_digits[octet >> 4];
    output[1] = mal_hex_lower_digits[octet & 0x0f];
}

void mal_hex_encode_lower(const byte *input, usize input_length, byte *output) {
    for (usize i = 0; i < input_length; i++) {
        mal_hex_encode_byte_lower(input[i], output + i * 2);
    }
}
