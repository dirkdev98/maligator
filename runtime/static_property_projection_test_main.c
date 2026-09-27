#include "vm_ops.h"

#include <stdio.h>
#include <string.h>

#define CHECK(condition) do { \
    if (!(condition)) { \
        fprintf(stderr, "numeric projection contract failed at line %d\n", __LINE__); \
        return 1; \
    } \
} while (0)

typedef struct {
    MalValue boxed;
    bool numeric;
    f64 expected;
} NumberCase;

static bool same_number(f64 actual, f64 expected) {
    if (isnan(expected)) return isnan(actual);
    u64 actual_bits, expected_bits;
    memcpy(&actual_bits, &actual, sizeof(actual_bits));
    memcpy(&expected_bits, &expected, sizeof(expected_bits));
    return actual_bits == expected_bits;
}

static bool project(int count, MalValue receiver, MalInlineCache *ic, f64 **out) {
    switch (count) {
        case 2: return mal_vm_property_try_load_static_number_pair(receiver, &ic[0], &ic[1], out[0], out[1]);
        case 3: return mal_vm_property_try_load_static_number_triple(receiver, &ic[0], &ic[1], &ic[2], out[0], out[1], out[2]);
        case 4: return mal_vm_property_try_load_static_number_quad(receiver, &ic[0], &ic[1], &ic[2], &ic[3], out[0], out[1], out[2], out[3]);
        default: return false;
    }
}

static bool check_projection(int count, MalValue receiver, MalInlineCache *ic,
                             const f64 *expected, bool hit) {
    f64 actual[4] = {13.5, 13.5, 13.5, 13.5};
    f64 *out[4] = {&actual[0], &actual[1], &actual[2], &actual[3]};
    if (project(count, receiver, ic, out) != hit) return false;
    for (int i = 0; i < 4; i++) {
        if (!same_number(actual[i], hit && i < count ? expected[i] : 13.5)) return false;
    }
    return true;
}

int main(void) {
    // Expected values are independent of the runtime's existing decoder.
    const NumberCase cases[] = {
        {MAL_VALUE_INT32, true, 0.0},
        {MAL_VALUE_INT32 | 0x7fffffffu, true, 2147483647.0},
        {MAL_VALUE_INT32 | 0x80000000u, true, -2147483648.0},
        {MAL_VALUE_INT32 | 0xffffffffu, true, -1.0},
        {MAL_VALUE_NAN, true, NAN},
        {MAL_VALUE_NEGATIVE_ZERO, true, -0.0},
        {MAL_VALUE_POSITIVE_INFINITY, true, INFINITY},
        {MAL_VALUE_NEGATIVE_INFINITY, true, -INFINITY},
        {0, true, 0.0},
        {0x8000000000000000ull, true, -0.0},
        {1, true, 0x1p-1074},
        {0x8000000000000001ull, true, -0x1p-1074},
        {0x3ff8000000000000ull, true, 1.5},
        {0xbff8000000000000ull, true, -1.5},
        {MAL_VALUE_TRUE, false, 0},
        {MAL_VALUE_FALSE, false, 0},
        {MAL_VALUE_UNDEFINED, false, 0},
        {MAL_VALUE_NULL, false, 0},
        {MAL_VALUE_EMPTY, false, 0},
    };
    for (unsigned choice = 0; choice < sizeof(cases) / sizeof(cases[0]); choice++) {
        f64 output = 13.5;
        CHECK(mal_ops_try_number_as_f64(cases[choice].boxed, &output) == cases[choice].numeric);
        CHECK(same_number(output, cases[choice].numeric ? cases[choice].expected : 13.5));
    }

    MalShape shape = {0}, other = {0};
    MalValue values[4];
    f64 expected[4];
    MalObject object = {.header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_OBJECT), .shape = &shape, .slots = values};
    MalInlineCache ic[4] = {0};
    for (int i = 0; i < 4; i++) {
        ic[i].shape = &shape;
        ic[i].slot = i;
        ic[i].mode = MAL_IC_MODE_SHAPE;
    }
    MalValue receiver = mal_value_from_object(&object);
    for (int count = 2; count <= 4; count++) {
        for (int changed = 0; changed < count; changed++) {
            for (unsigned choice = 0; choice < sizeof(cases) / sizeof(cases[0]); choice++) {
                for (int i = 0; i < 4; i++) {
                    values[i] = MAL_VALUE_INT32 | (i + 1);
                    expected[i] = i + 1;
                }
                values[changed] = cases[choice].boxed;
                expected[changed] = cases[choice].expected;
                CHECK(check_projection(count, receiver, ic, expected, cases[choice].numeric));
            }
            for (int i = 0; i < 4; i++) values[i] = MAL_VALUE_INT32 | (i + 1);
            ic[changed].mode = MAL_IC_MODE_INHERITED_VALUE;
            CHECK(check_projection(count, receiver, ic, expected, false));
            ic[changed].mode = MAL_IC_MODE_SHAPE;
            ic[changed].slot = MAL_IC_VALUE_SLOT;
            CHECK(check_projection(count, receiver, ic, expected, false));
            ic[changed].slot = changed;
            ic[changed].shape = &other;
            CHECK(check_projection(count, receiver, ic, expected, false));
            ic[changed].shape = &shape;
        }
        CHECK(check_projection(count, MAL_VALUE_NULL, ic, expected, false));
        object.shape = &other;
        CHECK(check_projection(count, receiver, ic, expected, false));
        object.shape = &shape;
        object.header.type = MAL_HEAP_ARRAY_OBJECT;
        CHECK(check_projection(count, receiver, ic, expected, false));
        object.header.type = MAL_HEAP_OBJECT;

        // Successful stores retain argument order even when caller outputs alias.
        f64 shared = 13.5;
        f64 *aliased[4] = {&shared, &shared, &shared, &shared};
        CHECK(project(count, receiver, ic, aliased));
        CHECK(shared == count);
        // A late miss must leave even aliased outputs untouched.
        shared = 13.5;
        values[count - 1] = MAL_VALUE_UNDEFINED;
        CHECK(!project(count, receiver, ic, aliased));
        CHECK(shared == 13.5);
    }
    puts("numeric-projection-contract PASS");
    return 0;
}
