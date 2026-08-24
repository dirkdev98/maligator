#include "hex.h"

#include "checked_size.h"
#include "heap_string.h"
#include "profile.h"

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

MalString *mal_hex_encode_string(
    MalHeap *heap, const byte *input, usize input_length
) {
    usize output_length;
    if (!mal_hex_encoded_length(
            input_length, MAL_STRING_MAX_CODE_UNITS, &output_length)) {
        return nullptr;
    }
    if (output_length <= MAL_STRING_INLINE_CODE_UNITS) {
        byte output[MAL_STRING_INLINE_CODE_UNITS];
        mal_hex_encode_lower(input, input_length, output);
        return mal_string_new_ascii(heap, output, output_length);
    }

    c16 *output = mal_heap_alloc_raw_profiled(
        heap, sizeof(c16) * output_length,
        MAL_PROFILE_ALLOCATION_FAMILY_STRING);
    for (usize i = 0; i < input_length; i++) {
        u8 octet = (u8) input[i];
        output[i * 2] = mal_hex_lower_digits[octet >> 4];
        output[i * 2 + 1] = mal_hex_lower_digits[octet & 0x0f];
    }
    return mal_string_new_owned(heap, output, output_length);
}
