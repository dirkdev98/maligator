#include "vm_load.h"

#include <stdlib.h>
#include <string.h>
#include "bigint128.h"
#include "builtin_math.h"
#include "endian.h"
#include "heap_bigint.h"
#include "heap_string.h"

/*
 * Inverse of src/compiler/target/emit-program-image.ts plus
 * src/compiler/target/program-image-codec.ts: decode the flat wire buffer into the
 * runtime structs. The per-opcode operand layout, the opcode tag
 * ordering (WireOp below), and the operator/intrinsic tables mirror the compiler
 * contracts. WIRE_VERSION guards incompatible layout changes.
 */

#define WIRE_MAGIC 0x574c414du // "MALW" little-endian
#define WIRE_VERSION 47u
#define WIRE_FLAG_HAS_DEBUG 1u

typedef enum WireOp {
#define BYTECODE_OPERATION(name) WIRE_##name,
#include "generated/bytecode_operations.inc"
#undef BYTECODE_OPERATION
    WIRE_OP_COUNT,
} WireOp;

/* Wire tag -> MalBinaryOp. MUST match WIRE_BINOPS in program-image-codec.ts. */
static const MalBinaryOp wire_binops[] = {
    MAL_BIN_ADD, MAL_BIN_SUB, MAL_BIN_MUL, MAL_BIN_DIV, MAL_BIN_REM, MAL_BIN_POW,
    MAL_BIN_BIT_AND, MAL_BIN_BIT_OR, MAL_BIN_BIT_XOR, MAL_BIN_SHL, MAL_BIN_SHR,
    MAL_BIN_USHR, MAL_BIN_LT, MAL_BIN_LTE, MAL_BIN_GT, MAL_BIN_GTE, MAL_BIN_EQ,
    MAL_BIN_NEQ, MAL_BIN_STRICT_EQ, MAL_BIN_STRICT_NEQ, MAL_BIN_IN, MAL_BIN_INSTANCEOF,
};

/* Wire tag -> MalUnaryOp. MUST match WIRE_UNOPS in program-image-codec.ts. */
static const MalUnaryOp wire_unops[] = {
    MAL_UNARY_NOT, MAL_UNARY_NEGATE, MAL_UNARY_PLUS, MAL_UNARY_BIT_NOT, MAL_UNARY_TYPEOF,
    MAL_UNARY_TO_NUMERIC, MAL_UNARY_INCREMENT, MAL_UNARY_DECREMENT, MAL_UNARY_TO_STRING,
};

/* Wire tags mirror VM_MATH_*_NUMBER_OPERATIONS in program-image.ts. */
static const MalMathUnaryOp wire_math_unary_number_ops[] = {
    MAL_MATH_UNARY_ABS,
    MAL_MATH_UNARY_FLOOR,
    MAL_MATH_UNARY_CEIL,
    MAL_MATH_UNARY_TRUNC,
    MAL_MATH_UNARY_SQRT,
    MAL_MATH_UNARY_CBRT,
    MAL_MATH_UNARY_SIGN,
    MAL_MATH_UNARY_LOG,
    MAL_MATH_UNARY_LOG2,
    MAL_MATH_UNARY_LOG10,
    MAL_MATH_UNARY_EXP,
    MAL_MATH_UNARY_SIN,
    MAL_MATH_UNARY_COS,
    MAL_MATH_UNARY_TAN,
    MAL_MATH_UNARY_ASIN,
    MAL_MATH_UNARY_ACOS,
    MAL_MATH_UNARY_ATAN,
    MAL_MATH_UNARY_SINH,
    MAL_MATH_UNARY_COSH,
    MAL_MATH_UNARY_TANH,
    MAL_MATH_UNARY_ASINH,
    MAL_MATH_UNARY_ACOSH,
    MAL_MATH_UNARY_ATANH,
    MAL_MATH_UNARY_LOG1P,
    MAL_MATH_UNARY_EXPM1,
    MAL_MATH_UNARY_FROUND,
    MAL_MATH_UNARY_ROUND,
};

static const MalMathBinaryOp wire_math_binary_number_ops[] = {
    MAL_MATH_BINARY_MIN,
    MAL_MATH_BINARY_MAX,
};

static const MalGuardedBuiltinCallOp wire_guarded_builtin_call_ops[] = {
    MAL_GUARDED_BUILTIN_MAP_GET,
    MAL_GUARDED_BUILTIN_MAP_SET,
    MAL_GUARDED_BUILTIN_MAP_HAS,
    MAL_GUARDED_BUILTIN_MAP_DELETE,
    MAL_GUARDED_BUILTIN_SET_ADD,
    MAL_GUARDED_BUILTIN_SET_HAS,
    MAL_GUARDED_BUILTIN_SET_DELETE,
    MAL_GUARDED_BUILTIN_ARRAY_PUSH,
};

static_assert(
    MAL_MATH_UNARY_ROUND == countof(wire_math_unary_number_ops),
    "guarded unary side tags must stay contiguous"
);
static_assert(
    MAL_MATH_BINARY_MAX == countof(wire_math_binary_number_ops),
    "guarded binary side tags must stay contiguous"
);
static_assert(
    MAL_GUARDED_BUILTIN_MAP_GET == 0 &&
        MAL_GUARDED_BUILTIN_ARRAY_PUSH + 1 ==
            countof(wire_guarded_builtin_call_ops),
    "guarded builtin call side tags must stay contiguous"
);

static const MalDirectBuiltinOp wire_direct_builtin_ops[] = {
#define MAL_DIRECT_BUILTIN_OP(operation) operation,
#include "generated/primordial_registry.inc"
};

/* Wire tag -> MalTypeofResult. MUST match WIRE_TYPEOF_RESULTS in program-image-codec.ts. */
static const MalTypeofResult wire_typeof_results[] = {
    MAL_TYPEOF_UNDEFINED,
    MAL_TYPEOF_OBJECT,
    MAL_TYPEOF_BOOLEAN,
    MAL_TYPEOF_NUMBER,
    MAL_TYPEOF_STRING,
    MAL_TYPEOF_SYMBOL,
    MAL_TYPEOF_BIGINT,
    MAL_TYPEOF_FUNCTION,
};

/* Wire tag -> MAL_INTRINSIC_*. MUST match WIRE_INTRINSICS in program-image-codec.ts. */
static const i32 wire_intrinsics[] = {
    MAL_INTRINSIC_OBJECT_CONSTRUCTOR,
    MAL_INTRINSIC_ARRAY_CONSTRUCTOR,
    MAL_INTRINSIC_FUNCTION_CONSTRUCTOR,
    MAL_INTRINSIC_ERROR_CONSTRUCTOR,
    MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR,
    MAL_INTRINSIC_RANGE_ERROR_CONSTRUCTOR,
    MAL_INTRINSIC_REFERENCE_ERROR_CONSTRUCTOR,
    MAL_INTRINSIC_SYNTAX_ERROR_CONSTRUCTOR,
    MAL_INTRINSIC_URI_ERROR_CONSTRUCTOR,
    MAL_INTRINSIC_EVAL_ERROR_CONSTRUCTOR,
    MAL_INTRINSIC_AGGREGATE_ERROR_CONSTRUCTOR,
    MAL_INTRINSIC_DISPOSABLE_STACK_CONSTRUCTOR,
    MAL_INTRINSIC_ASYNC_DISPOSABLE_STACK_CONSTRUCTOR,
    MAL_INTRINSIC_SUPPRESSED_ERROR_CONSTRUCTOR,
    MAL_INTRINSIC_STRING_CONSTRUCTOR,
    MAL_INTRINSIC_NUMBER_CONSTRUCTOR,
    MAL_INTRINSIC_BOOLEAN_CONSTRUCTOR,
    MAL_INTRINSIC_SYMBOL_CONSTRUCTOR,
    MAL_INTRINSIC_BIGINT_CONSTRUCTOR,
    MAL_INTRINSIC_ARRAY_BUFFER_CONSTRUCTOR,
    MAL_INTRINSIC_SHARED_ARRAY_BUFFER_CONSTRUCTOR,
    MAL_INTRINSIC_TYPED_ARRAY_INT8_CONSTRUCTOR,
    MAL_INTRINSIC_TYPED_ARRAY_UINT8_CONSTRUCTOR,
    MAL_INTRINSIC_TYPED_ARRAY_UINT8_CLAMPED_CONSTRUCTOR,
    MAL_INTRINSIC_TYPED_ARRAY_INT16_CONSTRUCTOR,
    MAL_INTRINSIC_TYPED_ARRAY_UINT16_CONSTRUCTOR,
    MAL_INTRINSIC_TYPED_ARRAY_INT32_CONSTRUCTOR,
    MAL_INTRINSIC_TYPED_ARRAY_UINT32_CONSTRUCTOR,
    MAL_INTRINSIC_TYPED_ARRAY_FLOAT32_CONSTRUCTOR,
    MAL_INTRINSIC_TYPED_ARRAY_FLOAT64_CONSTRUCTOR,
    MAL_INTRINSIC_TYPED_ARRAY_BIGINT64_CONSTRUCTOR,
    MAL_INTRINSIC_TYPED_ARRAY_BIGUINT64_CONSTRUCTOR,
    MAL_INTRINSIC_DATA_VIEW_CONSTRUCTOR,
    MAL_INTRINSIC_MAP_CONSTRUCTOR,
    MAL_INTRINSIC_SET_CONSTRUCTOR,
    MAL_INTRINSIC_WEAK_MAP_CONSTRUCTOR,
    MAL_INTRINSIC_WEAK_SET_CONSTRUCTOR,
    MAL_INTRINSIC_WEAK_REF_CONSTRUCTOR,
    MAL_INTRINSIC_FINALIZATION_REGISTRY_CONSTRUCTOR,
    MAL_INTRINSIC_PROMISE_CONSTRUCTOR,
    MAL_INTRINSIC_DATE_CONSTRUCTOR,
    MAL_INTRINSIC_REGEXP_CONSTRUCTOR,
    MAL_INTRINSIC_INTL,
    MAL_INTRINSIC_ITERATOR_CONSTRUCTOR,
    MAL_INTRINSIC_ASYNC_ITERATOR_CONSTRUCTOR,
    MAL_INTRINSIC_PARSE_INT,
    MAL_INTRINSIC_PARSE_FLOAT,
    MAL_INTRINSIC_IS_NAN,
    MAL_INTRINSIC_IS_FINITE,
    MAL_INTRINSIC_DECODE_URI,
    MAL_INTRINSIC_DECODE_URI_COMPONENT,
    MAL_INTRINSIC_ENCODE_URI,
    MAL_INTRINSIC_ENCODE_URI_COMPONENT,
    MAL_INTRINSIC_MATH,
    MAL_INTRINSIC_JSON,
    MAL_INTRINSIC_REFLECT,
    MAL_INTRINSIC_PROXY_CONSTRUCTOR,
    MAL_INTRINSIC_CONSOLE,
    MAL_INTRINSIC_GLOBAL_THIS,
    MAL_INTRINSIC_NAN_VALUE,
    MAL_INTRINSIC_INFINITY_VALUE,
    MAL_INTRINSIC_CJS_REQUIRE,
    MAL_INTRINSIC_ARRAY_ITERATION_ELIGIBLE,
    MAL_INTRINSIC_ARRAY_FLAT_MAP_APPEND,
    /* Appended last; mirrors the trailing "eval" / "__directEval" in WIRE_INTRINSICS. */
    MAL_INTRINSIC_EVAL,
    MAL_INTRINSIC_DIRECT_EVAL,
    MAL_INTRINSIC_ATOMICS,
    MAL_INTRINSIC_DYNAMIC_IMPORT,
    MAL_INTRINSIC_NEW_DISPOSE_CAPABILITY,
    MAL_INTRINSIC_ADD_DISPOSABLE_RESOURCE,
    MAL_INTRINSIC_DISPOSE_RESOURCES,
    MAL_INTRINSIC_CONFIGURE_DEFERRED_NAMESPACE,
    MAL_INTRINSIC_EVALUATE_MODULE_SYNC,
};

// ---- owned arena (chained calloc'd blocks; pointers stay stable, one free) ----

#define MAL_LOAD_ARENA_BLOCK ((usize) 64 * 1024)

typedef struct MalLoadArenaBlock {
    struct MalLoadArenaBlock *next;
    usize size;
    usize used;
    _Alignas(16) u8 data[];
} MalLoadArenaBlock;

struct MalLoadedRuntimeImage {
    MalLoadArenaBlock *arena;
    MalRuntimeImage runtime_image;
};

static usize align_up(usize value, usize align) {
    return (value + (align - 1)) & ~(align - 1);
}

static void *arena_raw(MalLoadedRuntimeImage *L, usize bytes, usize align) {
    if (bytes > SIZE_MAX - align - sizeof(MalLoadArenaBlock)) {
        return nullptr;
    }
    MalLoadArenaBlock *block = L->arena;
    usize offset = 0;
    if (block != nullptr) {
        if (block->used > SIZE_MAX - (align - 1)) {
            return nullptr;
        }
        offset = align_up(block->used, align);
    }
    if (block == nullptr || offset > block->size || bytes > block->size - offset) {
        usize capacity = MAL_LOAD_ARENA_BLOCK;
        if (bytes + align > capacity) {
            capacity = bytes + align;
        }
        MalLoadArenaBlock *fresh = calloc(1, sizeof(MalLoadArenaBlock) + capacity);
        if (fresh == nullptr) {
            return nullptr;
        }
        fresh->size = capacity;
        fresh->next = L->arena;
        L->arena = fresh;
        block = fresh;
        offset = 0;
    }
    void *p = block->data + offset;
    block->used = offset + bytes;
    return p;
}

// ---- sequential little-endian reader (bounds-checked; sticky failure) ----

typedef struct Rd {
    const u8 *buf;
    usize len;
    usize pos;
    bool ok;
} Rd;

static u8 rd_u8(Rd *r) {
    if (!r->ok || r->pos + 1 > r->len) {
        r->ok = false;
        return 0;
    }
    return r->buf[r->pos++];
}

static u16 rd_u16(Rd *r) {
    if (!r->ok || r->pos + 2 > r->len) {
        r->ok = false;
        return 0;
    }
    u16 v = mal_load_u16_le(r->buf + r->pos);
    r->pos += 2;
    return v;
}

static u32 rd_fixed_u32(Rd *r) {
    if (!r->ok || r->pos + 4 > r->len) {
        r->ok = false;
        return 0;
    }
    u32 v = mal_load_u32_le(r->buf + r->pos);
    r->pos += 4;
    return v;
}

static u32 rd_u32(Rd *r) {
    u32 value = 0;
    for (u32 shift = 0; shift <= 28; shift += 7) {
        u8 byte = rd_u8(r);
        if (!r->ok || (shift == 28 && (byte & 0xf0u) != 0)) {
            r->ok = false;
            return 0;
        }
        value |= (u32) (byte & 0x7fu) << shift;
        if ((byte & 0x80u) == 0) {
            if (shift > 0 && (byte & 0x7fu) == 0) {
                r->ok = false;
                return 0;
            }
            return value;
        }
    }
    r->ok = false;
    return 0;
}

static i32 rd_i32(Rd *r) {
    u32 value = rd_u32(r);
    return (i32) ((value >> 1) ^ (u32) -(i32) (value & 1u));
}

static u64 rd_u64(Rd *r) {
    if (!r->ok || r->pos + 8 > r->len) {
        r->ok = false;
        return 0;
    }
    u64 v = mal_load_u64_le(r->buf + r->pos);
    r->pos += 8;
    return v;
}

/* A count whose elements consume at least `min_each` bytes; rejects an absurd
 * value before it drives a loop or an allocation. */
static u32 rd_count(Rd *r, usize min_each) {
    u32 n = rd_u32(r);
    if (!r->ok) {
        return 0;
    }
    usize remaining = r->len - r->pos;
    if (min_each == 0) {
        min_each = 1;
    }
    if (n > (u32) INT32_MAX || (usize) n > remaining / min_each) {
        r->ok = false;
        return 0;
    }
    return n;
}

static void *arena(MalLoadedRuntimeImage *L, Rd *r, usize bytes, usize align) {
    if (!r->ok || bytes == 0) {
        return nullptr;
    }
    void *p = arena_raw(L, bytes, align);
    if (p == nullptr) {
        r->ok = false;
    }
    return p;
}

static void *arena_array(
    MalLoadedRuntimeImage *L, Rd *r, usize count, usize item_size, usize align
) {
    if (item_size != 0 && count > SIZE_MAX / item_size) {
        r->ok = false;
        return nullptr;
    }
    return arena(L, r, count * item_size, align);
}

static const i32 *rd_i32_array(MalLoadedRuntimeImage *L, Rd *r, i32 *count_out) {
    u32 n = rd_count(r, 1);
    *count_out = (i32) n;
    if (!r->ok || n == 0) {
        return nullptr;
    }
    i32 *arr = arena_array(L, r, n, sizeof(i32), alignof(i32));
    if (!r->ok) {
        return nullptr;
    }
    for (u32 i = 0; i < n; i++) {
        arr[i] = rd_i32(r);
    }
    return arr;
}

typedef struct I32Builder {
    i32 *data;
    usize count;
    usize capacity;
} I32Builder;

static bool i32_builder_reserve(I32Builder *builder, Rd *r, usize additional) {
    usize limit = (usize) INT32_MAX;
    if (SIZE_MAX / sizeof(i32) < limit) {
        limit = SIZE_MAX / sizeof(i32);
    }
    if (!r->ok || additional > limit - builder->count) {
        r->ok = false;
        return false;
    }
    usize needed = builder->count + additional;
    if (needed <= builder->capacity) {
        return true;
    }
    usize capacity = builder->capacity > 0 ? builder->capacity : 16;
    while (capacity < needed) {
        usize doubled = capacity * 2;
        capacity = doubled > limit ? limit : doubled;
    }
    i32 *data = realloc(builder->data, capacity * sizeof(i32));
    if (data == nullptr) {
        r->ok = false;
        return false;
    }
    builder->data = data;
    builder->capacity = capacity;
    return true;
}

static i32 rd_side_single(Rd *r, I32Builder *builder, i32 expected_count) {
    i32 offset = (i32) builder->count;
    u32 count = rd_count(r, 1);
    if (!r->ok || expected_count < 0 || count != (u32) expected_count ||
        !i32_builder_reserve(builder, r, (usize) count + 1)) {
        r->ok = false;
        return 0;
    }
    builder->data[builder->count++] = (i32) count;
    for (u32 i = 0; i < count; i++) {
        builder->data[builder->count++] = rd_i32(r);
    }
    return offset;
}

static i32 rd_side_guarded_call(
    Rd *r, I32Builder *builder, i32 exact_function_index, bool allow_guarded
) {
    i32 offset = (i32) builder->count;
    u32 target_count = rd_count(r, 2);
    i32 targets[4];
    for (u32 i = 0; r->ok && i < target_count && i < countof(targets); i++) {
        targets[i] = rd_i32(r);
    }
    i32 expected_count = rd_i32(r);
    u32 count = rd_count(r, 1);
    if (!r->ok || target_count > 4 || (!allow_guarded && target_count != 0) ||
        (exact_function_index >= 0 && target_count != 0) ||
        expected_count < 0 || count != (u32) expected_count ||
        !i32_builder_reserve(builder, r, (usize) count + target_count + 3)) {
        r->ok = false;
        return 0;
    }
    builder->data[builder->count++] = (i32) count;
    builder->data[builder->count++] = exact_function_index;
    builder->data[builder->count++] = (i32) target_count;
    for (u32 i = 0; i < target_count; i++) {
        builder->data[builder->count++] = targets[i];
    }
    for (u32 i = 0; i < count; i++) {
        builder->data[builder->count++] = rd_i32(r);
    }
    return offset;
}

static i32 rd_side_pair(Rd *r, I32Builder *builder) {
    i32 offset = (i32) builder->count;
    u32 first_count = rd_count(r, 1);
    if (!r->ok || first_count > (u32) ((INT32_MAX - 1) / 2) ||
        !i32_builder_reserve(builder, r, (usize) first_count * 2 + 1)) {
        r->ok = false;
        return 0;
    }
    builder->data[builder->count++] = (i32) first_count;
    for (u32 i = 0; i < first_count; i++) {
        builder->data[builder->count++] = rd_i32(r);
    }
    u32 second_count = rd_count(r, 1);
    if (!r->ok || second_count != first_count) {
        r->ok = false;
        return 0;
    }
    for (u32 i = 0; i < second_count; i++) {
        builder->data[builder->count++] = rd_i32(r);
    }
    return offset;
}

static i32 rd_side_fixed(Rd *r, I32Builder *builder, usize count) {
    i32 offset = (i32) builder->count;
    if (!i32_builder_reserve(builder, r, count)) {
        return 0;
    }
    for (usize i = 0; i < count; i++) {
        builder->data[builder->count++] = rd_i32(r);
    }
    return offset;
}

static i32 rd_side_known_own_slots(Rd *r, I32Builder *builder) {
    i32 offset = (i32) builder->count;
    i32 string_index = rd_i32(r);
    u32 candidate_count = rd_count(r, 3);
    if (!r->ok || candidate_count < 1 || candidate_count > 4 ||
        !i32_builder_reserve(builder, r, 2 + (usize) candidate_count * 3)) {
        r->ok = false;
        return 0;
    }
    builder->data[builder->count++] = string_index;
    builder->data[builder->count++] = (i32) candidate_count;
    for (u32 index = 0; index < candidate_count; index++) {
        builder->data[builder->count++] = rd_i32(r);
        builder->data[builder->count++] = rd_i32(r);
        builder->data[builder->count++] = rd_i32(r);
    }
    return offset;
}

static i32 rd_side_shape_case_candidates(
    Rd *r, I32Builder *builder, i32 *candidate_count_out
) {
    i32 offset = (i32) builder->count;
    u32 count = rd_count(r, 2);
    if (!r->ok || count < 1 || count > 4 ||
        !i32_builder_reserve(builder, r, (usize) count * 2)) {
        r->ok = false;
        return 0;
    }
    *candidate_count_out = (i32) count;
    for (u32 index = 0; index < count; index++) {
        builder->data[builder->count++] = rd_i32(r);
        builder->data[builder->count++] = rd_i32(r);
    }
    return offset;
}

static i32 rd_side_shape_case_load(Rd *r, I32Builder *builder) {
    i32 offset = (i32) builder->count;
    i32 string_index = rd_i32(r);
    u32 slot_count = rd_count(r, 2);
    if (!r->ok || slot_count < 1 || slot_count > 4 ||
        !i32_builder_reserve(builder, r, 3 + (usize) slot_count)) {
        r->ok = false;
        return 0;
    }
    builder->data[builder->count++] = string_index;
    builder->data[builder->count++] = -1;
    builder->data[builder->count++] = (i32) slot_count;
    for (u32 index = 0; index < slot_count; index++) {
        builder->data[builder->count++] = rd_i32(r);
    }
    return offset;
}

// ---- instruction decode (mirrors writeInstruction in program-image-codec.ts) ----

static void rd_instruction(Rd *r, MalInstruction *o, I32Builder *side_data) {
    u8 tag = rd_u8(r);
    if (!r->ok) {
        return;
    }
    switch ((WireOp) tag) {
        case WIRE_MOVE:
            o->opcode = MAL_OP_MOVE;
            o->as.move.dst = rd_i32(r);
            o->as.move.src = rd_i32(r);
            return;
        case WIRE_RETURN:
            o->opcode = MAL_OP_RETURN;
            o->as.ret.value = rd_i32(r);
            return;
        case WIRE_THROW:
            o->opcode = MAL_OP_THROW;
            o->as.thrown.value = rd_i32(r);
            return;
        case WIRE_JUMP_IF:
            o->opcode = MAL_OP_JUMP_IF;
            o->as.jump_if.cond = rd_i32(r);
            o->as.jump_if.target_ip = rd_i32(r);
            return;
        case WIRE_JUMP:
            o->opcode = MAL_OP_JUMP;
            o->as.jump.target_ip = rd_i32(r);
            return;
        case WIRE_CREATE_NUMBER:
            o->opcode = MAL_OP_CREATE_NUMBER;
            o->as.create_number.dst = rd_i32(r);
            o->as.create_number.value = rd_i32(r);
            return;
        case WIRE_CREATE_F64:
            o->opcode = MAL_OP_CREATE_F64;
            o->as.create_f64.dst = rd_i32(r);
            {
                u64 bits = rd_u64(r);
                o->as.create_f64.bits_low = (u32) bits;
                o->as.create_f64.bits_high = (u32) (bits >> 32);
            }
            return;
        case WIRE_CREATE_BOOLEAN:
            o->opcode = MAL_OP_CREATE_BOOLEAN;
            o->as.create_boolean.dst = rd_i32(r);
            o->as.create_boolean.value = rd_u8(r);
            return;
        case WIRE_CREATE_STRING:
            o->opcode = MAL_OP_CREATE_STRING;
            o->as.create_string.dst = rd_i32(r);
            o->as.create_string.string_index = rd_i32(r);
            return;
        case WIRE_CREATE_BIGINT:
            o->opcode = MAL_OP_CREATE_BIGINT;
            o->as.create_bigint.dst = rd_i32(r);
            o->as.create_bigint.bigint_index = rd_i32(r);
            return;
        case WIRE_CREATE_OBJECT:
            o->opcode = MAL_OP_CREATE_OBJECT;
            o->as.create_object.dst = rd_i32(r);
            return;
        case WIRE_CREATE_OBJECT_SHAPED: {
            o->opcode = MAL_OP_CREATE_OBJECT_SHAPED;
            o->as.create_object_shaped.dst = rd_i32(r);
            i32 count = rd_i32(r);
            if (count < 1 || count > MAL_SHAPE_MAX_INLINE_SLOTS) {
                r->ok = false;
                return;
            }
            o->as.create_object_shaped.data_offset = rd_side_pair(r, side_data);
            if (r->ok && side_data->data[o->as.create_object_shaped.data_offset] != count) {
                r->ok = false;
            }
            return;
        }
        case WIRE_CREATE_ARRAY:
            o->opcode = MAL_OP_CREATE_ARRAY;
            o->as.create_array.dst = rd_i32(r);
            o->as.create_array.length = rd_i32(r);
            return;
        case WIRE_INSTANTIATE_LITERAL_TEMPLATE:
            o->opcode = MAL_OP_INSTANTIATE_LITERAL_TEMPLATE;
            o->as.instantiate_literal_template.dst = rd_i32(r);
            o->as.instantiate_literal_template.template_offset = rd_i32(r);
            o->as.instantiate_literal_template.cache_slot = rd_i32(r);
            return;
        case WIRE_QUERY_STATIC_DATA: {
            o->opcode = MAL_OP_QUERY_STATIC_DATA;
            o->as.query_static_data.dst = rd_i32(r);
            o->as.query_static_data.needle = rd_i32(r);
            o->as.query_static_data.from_index = rd_i32(r);
            i32 offset = rd_i32(r), kind = rd_i32(r);
            if (!i32_builder_reserve(side_data, r, 2)) return;
            o->as.query_static_data.data_offset = (i32) side_data->count;
            side_data->data[side_data->count++] = offset;
            side_data->data[side_data->count++] = kind;
            return;
        }
        case WIRE_CREATE_MODULE_NAMESPACE: {
            o->opcode = MAL_OP_CREATE_MODULE_NAMESPACE;
            o->as.create_module_namespace.dst = rd_i32(r);
            o->as.create_module_namespace.cache_slot = rd_i32(r);
            o->as.create_module_namespace.data_offset = rd_side_pair(r, side_data);
            return;
        }
        case WIRE_CREATE_TEMPLATE_OBJECT: {
            o->opcode = MAL_OP_CREATE_TEMPLATE_OBJECT;
            o->as.create_template_object.dst = rd_i32(r);
            o->as.create_template_object.cache_slot = rd_i32(r);
            o->as.create_template_object.data_offset = rd_side_pair(r, side_data);
            return;
        }
        case WIRE_CREATE_UNDEFINED:
            o->opcode = MAL_OP_CREATE_UNDEFINED;
            o->as.create_undefined.dst = rd_i32(r);
            return;
        case WIRE_CREATE_EMPTY:
            o->opcode = MAL_OP_CREATE_EMPTY;
            o->as.create_empty.dst = rd_i32(r);
            return;
        case WIRE_CREATE_NULL:
            o->opcode = MAL_OP_CREATE_NULL;
            o->as.create_null.dst = rd_i32(r);
            return;
        case WIRE_CREATE_FUNCTION:
            o->opcode = MAL_OP_CREATE_FUNCTION;
            o->as.create_function.dst = rd_i32(r);
            o->as.create_function.function_index = rd_i32(r);
            return;
        case WIRE_CREATE_ARGUMENTS_OBJECT:
            o->opcode = MAL_OP_CREATE_ARGUMENTS_OBJECT;
            o->as.create_arguments_object.dst = rd_i32(r);
            return;
        case WIRE_LOAD_ARGUMENT_COUNT:
            o->opcode = MAL_OP_LOAD_ARGUMENT_COUNT;
            o->as.load_argument_count.dst = rd_i32(r);
            return;
        case WIRE_LOAD_ARGUMENT:
            o->opcode = MAL_OP_LOAD_ARGUMENT;
            o->as.load_argument.dst = rd_i32(r);
            o->as.load_argument.index = rd_i32(r);
            if (o->as.load_argument.index < 0) {
                r->ok = false;
            }
            return;
        case WIRE_LOAD_STATIC_ARGUMENT:
            o->opcode = MAL_OP_LOAD_STATIC_ARGUMENT;
            o->as.load_static_argument.dst = rd_i32(r);
            o->as.load_static_argument.direct = rd_i32(r);
            o->as.load_static_argument.fallback = rd_i32(r);
            o->as.load_static_argument.index = rd_i32(r);
            if (o->as.load_static_argument.index < 0) {
                r->ok = false;
            }
            return;
        case WIRE_LOAD_THIS:
            o->opcode = MAL_OP_LOAD_THIS;
            o->as.load_this.dst = rd_i32(r);
            return;
        case WIRE_LOAD_NEW_TARGET:
            o->opcode = MAL_OP_LOAD_NEW_TARGET;
            o->as.load_new_target.dst = rd_i32(r);
            return;
        case WIRE_LOAD_CALLEE:
            o->opcode = MAL_OP_LOAD_CALLEE;
            o->as.load_callee.dst = rd_i32(r);
            return;
        case WIRE_CALL: {
            o->opcode = MAL_OP_CALL;
            o->as.call.dst = rd_i32(r);
            o->as.call.callee = rd_i32(r);
            o->as.call.this_value = rd_i32(r);
            i32 exact_function_index = rd_i32(r);
            if (exact_function_index < -1) {
                r->ok = false;
            }
            o->as.call.data_offset = rd_side_guarded_call(
                r, side_data, exact_function_index, true);
            u8 guarded_tag = rd_u8(r);
            i32 guarded_side_tag = 0;
            if (guarded_tag > 0 &&
                guarded_tag <= countof(wire_math_unary_number_ops)) {
                guarded_side_tag = wire_math_unary_number_ops[guarded_tag - 1];
            } else if (guarded_tag > countof(wire_math_unary_number_ops)) {
                usize extended_tag =
                    guarded_tag - 1 - countof(wire_math_unary_number_ops);
                if (extended_tag < countof(wire_math_binary_number_ops)) {
                    guarded_side_tag = -wire_math_binary_number_ops[extended_tag];
                } else {
                    usize builtin_call_tag =
                        extended_tag - countof(wire_math_binary_number_ops);
                    if (builtin_call_tag >= countof(wire_guarded_builtin_call_ops)) {
                        r->ok = false;
                    } else {
                        guarded_side_tag = MAL_MATH_UNARY_ROUND + 1 +
                            wire_guarded_builtin_call_ops[builtin_call_tag];
                    }
                }
            }
            if (!i32_builder_reserve(side_data, r, 1)) {
                r->ok = false;
            } else {
                side_data->data[side_data->count++] = guarded_side_tag;
            }
            return;
        }
        case WIRE_CALL_KNOWN: {
            o->opcode = MAL_OP_CALL_KNOWN;
            o->as.call_known.dst = rd_i32(r);
            o->as.call_known.this_value = rd_i32(r);
            i32 count = rd_i32(r);
            o->as.call_known.data_offset = rd_side_single(r, side_data, count);
            u32 operation = rd_u32(r);
            u8 flags = rd_u8(r), specialization = rd_u8(r);
            if (operation >= MAL_KNOWN_OPERATION_COUNT || flags > 9 || ((flags >> 1) != 0 && count == 0) || (specialization != 0 && flags != 0) || specialization > countof(wire_direct_builtin_ops)) r->ok = false;
            static const i32 specialization_operations[] = {
#define MAL_KNOWN_SPECIALIZATION(index, operation) operation,
#include "generated/known_primordials.inc"
#undef MAL_KNOWN_SPECIALIZATION
            };
            if (specialization != 0 && (specialization > countof(specialization_operations) || specialization_operations[specialization - 1] != (i32) operation)) r->ok = false;
            o->as.call_known.operation = ((i32) operation << 4) | flags;
            return;
        }
        case WIRE_BUILTIN_ERROR:
            o->opcode = MAL_OP_BUILTIN_ERROR;
            o->as.builtin_error.dst = rd_i32(r);
            o->as.builtin_error.error = rd_u8(r);
            if (o->as.builtin_error.error >= MAL_BUILTIN_ERROR_COUNT) r->ok = false;
            return;
        case WIRE_PREPARED_STRING_COMPARE: {
            o->opcode = MAL_OP_PREPARED_STRING_COMPARE;
            o->as.prepared_string_compare.dst = rd_i32(r);
            o->as.prepared_string_compare.left = rd_i32(r);
            o->as.prepared_string_compare.right = rd_i32(r);
            u32 string_index = rd_u32(r);
            u8 options = rd_u8(r);
            o->as.prepared_string_compare.locale_options = (string_index << 6) | options;
            if (string_index > 0x03ffffffu || options >= 48 || (options & 3) > 2 || ((options & 4) != 0 && (options & 3) != 0)) r->ok = false;
            return;
        }
        case WIRE_CONSTRUCT: {
            o->opcode = MAL_OP_CONSTRUCT;
            o->as.construct.dst = rd_i32(r);
            o->as.construct.callee = rd_i32(r);
            i32 exact_function_index = rd_i32(r);
            if (exact_function_index < -1) {
                r->ok = false;
            }
            o->as.construct.data_offset = rd_side_guarded_call(
                r, side_data, exact_function_index, false);
            return;
        }
        case WIRE_CATCH:
            o->opcode = MAL_OP_CATCH;
            o->as.caught.dst = rd_i32(r);
            return;
        case WIRE_TRY_BEGIN:
            o->opcode = MAL_OP_TRY_BEGIN;
            return;
        case WIRE_TRY_END:
            o->opcode = MAL_OP_TRY_END;
            return;
        case WIRE_GENERATOR_START:
            o->opcode = MAL_OP_GENERATOR_START;
            return;
        case WIRE_ASYNC_START:
            o->opcode = MAL_OP_ASYNC_START;
            return;
        case WIRE_YIELD:
            o->opcode = MAL_OP_YIELD;
            o->as.yield.yielded_src = rd_i32(r);
            o->as.yield.value_dst = rd_i32(r);
            o->as.yield.mode_dst = rd_i32(r);
            return;
        case WIRE_TERMINAL_YIELD:
            o->opcode = MAL_OP_TERMINAL_YIELD;
            o->as.terminal_yield.yielded_src = rd_i32(r);
            return;
        case WIRE_AWAIT:
            o->opcode = MAL_OP_AWAIT;
            o->as.await.awaited_src = rd_i32(r);
            o->as.await.value_dst = rd_i32(r);
            o->as.await.mode_dst = rd_i32(r);
            return;
        case WIRE_LOAD_PRIMORDIAL: {
            o->opcode = MAL_OP_LOAD_PRIMORDIAL;
            o->as.load_intrinsic.dst = rd_i32(r);
            u32 node = rd_u32(r);
            if (node >= MAL_KNOWN_PRIMORDIAL_COUNT) r->ok = false;
            o->as.load_intrinsic.intrinsic = (i32) node;
            return;
        }
        case WIRE_LOAD_INTRINSIC: {
            o->opcode = MAL_OP_LOAD_INTRINSIC;
            o->as.load_intrinsic.dst = rd_i32(r);
            u16 idx = rd_u16(r);
            if (r->ok && idx < countof(wire_intrinsics)) {
                o->as.load_intrinsic.intrinsic = wire_intrinsics[idx];
            } else {
                r->ok = false;
            }
            return;
        }
        case WIRE_LOAD_CAPTURED:
            o->opcode = MAL_OP_LOAD_CAPTURED;
            o->as.load_captured.dst = rd_i32(r);
            o->as.load_captured.owner_function_index = rd_i32(r);
            o->as.load_captured.index = rd_i32(r);
            return;
        case WIRE_GUARD_FUNCTION_INDEX:
            o->opcode = MAL_OP_GUARD_FUNCTION_INDEX;
            o->as.guard_function_index.dst = rd_i32(r);
            o->as.guard_function_index.callee = rd_i32(r);
            o->as.guard_function_index.function_index = rd_i32(r);
            return;
        case WIRE_STORE_CAPTURED:
            o->opcode = MAL_OP_STORE_CAPTURED;
            o->as.store_captured.src = rd_i32(r);
            o->as.store_captured.owner_function_index = rd_i32(r);
            o->as.store_captured.index = rd_i32(r);
            return;
        case WIRE_ENV_PUSH:
            o->opcode = MAL_OP_ENV_PUSH;
            o->as.env_scope.scope_id = rd_i32(r);
            o->as.env_scope.slot_count = rd_i32(r);
            return;
        case WIRE_ENV_COPY:
            o->opcode = MAL_OP_ENV_COPY;
            o->as.env_scope.scope_id = rd_i32(r);
            o->as.env_scope.slot_count = rd_i32(r);
            return;
        case WIRE_ENV_POP:
            o->opcode = MAL_OP_ENV_POP;
            return;
        case WIRE_LOAD_GLOBAL_INDEX:
            o->opcode = MAL_OP_LOAD_GLOBAL_INDEX;
            o->as.load_global_index.dst = rd_i32(r);
            o->as.load_global_index.index = rd_i32(r);
            return;
        case WIRE_LOAD_GLOBAL:
            o->opcode = MAL_OP_LOAD_GLOBAL;
            o->as.load_global.dst = rd_i32(r);
            o->as.load_global.index = rd_i32(r);
            return;
        case WIRE_STORE_GLOBAL:
            o->opcode = MAL_OP_STORE_GLOBAL;
            o->as.store_global.src = rd_i32(r);
            o->as.store_global.index = rd_i32(r);
            return;
        case WIRE_LOAD_PROPERTY:
            o->opcode = MAL_OP_LOAD_PROPERTY;
            o->as.load_property.dst = rd_i32(r);
            o->as.load_property.object = rd_i32(r);
            o->as.load_property.key = rd_i32(r);
            return;
        case WIRE_LOAD_PROPERTY_STATIC:
            o->opcode = MAL_OP_LOAD_PROPERTY_STATIC;
            o->as.load_property_static.dst = rd_i32(r);
            o->as.load_property_static.object = rd_i32(r);
            o->as.load_property_static.string_index = rd_i32(r);
            return;
        case WIRE_LOAD_PROPERTY_STATIC_ARRAY_LENGTH:
            o->opcode = MAL_OP_LOAD_PROPERTY_STATIC_ARRAY_LENGTH;
            o->as.load_property_static.dst = rd_i32(r);
            o->as.load_property_static.object = rd_i32(r);
            o->as.load_property_static.string_index = rd_i32(r);
            return;
        case WIRE_LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT:
            o->opcode = MAL_OP_LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT;
            o->as.load_property_static_known_own_slot.dst = rd_i32(r);
            o->as.load_property_static_known_own_slot.object = rd_i32(r);
            o->as.load_property_static_known_own_slot.data_offset =
                rd_side_known_own_slots(r, side_data);
            return;
        case WIRE_STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT:
            o->opcode = MAL_OP_STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT;
            o->as.store_property_static_known_own_slot.object = rd_i32(r);
            o->as.store_property_static_known_own_slot.value = rd_i32(r);
            o->as.store_property_static_known_own_slot.data_offset =
                rd_side_known_own_slots(r, side_data);
            return;
        case WIRE_SELECT_SHAPE_CASE:
            o->opcode = MAL_OP_SELECT_SHAPE_CASE;
            o->as.select_shape_case.dst = rd_i32(r);
            o->as.select_shape_case.object = rd_i32(r);
            o->as.select_shape_case.data_offset = rd_side_shape_case_candidates(
                r, side_data, &o->as.select_shape_case.candidate_count);
            return;
        case WIRE_LOAD_PROPERTY_STATIC_SHAPE_CASE:
            o->opcode = MAL_OP_LOAD_PROPERTY_STATIC_SHAPE_CASE;
            o->as.load_property_static_shape_case.dst = rd_i32(r);
            o->as.load_property_static_shape_case.object = rd_i32(r);
            o->as.load_property_static_shape_case.shape_case = rd_i32(r);
            o->as.load_property_static_shape_case.data_offset =
                rd_side_shape_case_load(r, side_data);
            return;
        case WIRE_DELETE_PROPERTY:
            o->opcode = MAL_OP_DELETE_PROPERTY;
            o->as.delete_property.dst = rd_i32(r);
            o->as.delete_property.object = rd_i32(r);
            o->as.delete_property.key = rd_i32(r);
            return;
        case WIRE_TO_PROPERTY_KEY:
            o->opcode = MAL_OP_TO_PROPERTY_KEY;
            o->as.to_property_key.dst = rd_i32(r);
            o->as.to_property_key.object = rd_i32(r);
            o->as.to_property_key.key = rd_i32(r);
            return;
        case WIRE_LOAD_PRIVATE:
            o->opcode = MAL_OP_LOAD_PRIVATE;
            o->as.load_private.dst = rd_i32(r);
            o->as.load_private.object = rd_i32(r);
            o->as.load_private.key = rd_i32(r);
            return;
        case WIRE_HAS_PRIVATE:
            o->opcode = MAL_OP_HAS_PRIVATE;
            o->as.has_private.dst = rd_i32(r);
            o->as.has_private.object = rd_i32(r);
            o->as.has_private.key = rd_i32(r);
            return;
        case WIRE_STORE_PROPERTY:
            o->opcode = MAL_OP_STORE_PROPERTY;
            o->as.store_property.object = rd_i32(r);
            o->as.store_property.key = rd_i32(r);
            o->as.store_property.value = rd_i32(r);
            return;
        case WIRE_STORE_PROPERTY_STATIC:
            o->opcode = MAL_OP_STORE_PROPERTY_STATIC;
            o->as.store_property_static.object = rd_i32(r);
            o->as.store_property_static.value = rd_i32(r);
            o->as.store_property_static.string_index = rd_i32(r);
            return;
        case WIRE_DEFINE_PRIVATE:
            o->opcode = MAL_OP_DEFINE_PRIVATE;
            o->as.define_private.object = rd_i32(r);
            o->as.define_private.key = rd_i32(r);
            o->as.define_private.value = rd_i32(r);
            return;
        case WIRE_STORE_PRIVATE:
            o->opcode = MAL_OP_STORE_PRIVATE;
            o->as.store_private.object = rd_i32(r);
            o->as.store_private.key = rd_i32(r);
            o->as.store_private.value = rd_i32(r);
            return;
        case WIRE_STORE_SUPER_PROPERTY:
            o->opcode = MAL_OP_STORE_SUPER_PROPERTY;
            o->as.store_super_property.object = rd_i32(r);
            o->as.store_super_property.key = rd_i32(r);
            o->as.store_super_property.value = rd_i32(r);
            o->as.store_super_property.receiver = rd_i32(r);
            return;
        case WIRE_LOAD_SUPER_PROPERTY:
            o->opcode = MAL_OP_LOAD_SUPER_PROPERTY;
            o->as.load_super_property.dst = rd_i32(r);
            o->as.load_super_property.object = rd_i32(r);
            o->as.load_super_property.key = rd_i32(r);
            o->as.load_super_property.receiver = rd_i32(r);
            return;
        case WIRE_LOAD_PROTOTYPE:
            o->opcode = MAL_OP_LOAD_PROTOTYPE;
            o->as.load_prototype.dst = rd_i32(r);
            o->as.load_prototype.object = rd_i32(r);
            return;
        case WIRE_GET_ITERATOR:
            o->opcode = MAL_OP_GET_ITERATOR;
            o->as.get_iterator.iterator_dst = rd_i32(r);
            o->as.get_iterator.next_dst = rd_i32(r);
            o->as.get_iterator.source = rd_i32(r);
            return;
        case WIRE_GET_ASYNC_ITERATOR:
            o->opcode = MAL_OP_GET_ASYNC_ITERATOR;
            o->as.get_async_iterator.iterator_dst = rd_i32(r);
            o->as.get_async_iterator.next_dst = rd_i32(r);
            o->as.get_async_iterator.source = rd_i32(r);
            return;
        case WIRE_ITERATOR_NEXT:
            o->opcode = MAL_OP_ITERATOR_NEXT;
            o->as.iterator_next.result_dst = rd_i32(r);
            o->as.iterator_next.iterator = rd_i32(r);
            o->as.iterator_next.next = rd_i32(r);
            return;
        case WIRE_ITERATOR_STEP:
            o->opcode = MAL_OP_ITERATOR_STEP;
            o->as.iterator_step.value_dst = rd_i32(r);
            o->as.iterator_step.done_dst = rd_i32(r);
            o->as.iterator_step.iterator = rd_i32(r);
            o->as.iterator_step.next = rd_i32(r);
            return;
        case WIRE_ITERATOR_CLOSE:
            o->opcode = MAL_OP_ITERATOR_CLOSE;
            o->as.iterator_close.iterator = rd_i32(r);
            o->as.iterator_close.normal = rd_u8(r) != 0;
            return;
        case WIRE_FOR_IN_KEYS:
            o->opcode = MAL_OP_FOR_IN_KEYS;
            o->as.for_in_keys.dst = rd_i32(r);
            o->as.for_in_keys.source = rd_i32(r);
            return;
        case WIRE_CALL_SPREAD:
            o->opcode = MAL_OP_CALL_SPREAD;
            o->as.call_spread.dst = rd_i32(r);
            o->as.call_spread.callee = rd_i32(r);
            o->as.call_spread.this_value = rd_i32(r);
            o->as.call_spread.arguments_array = rd_i32(r);
            return;
        case WIRE_CALL_REST_ARGUMENTS: {
            o->opcode = MAL_OP_CALL_REST_ARGUMENTS;
            o->as.call_rest_arguments.dst = rd_i32(r);
            o->as.call_rest_arguments.callee = rd_i32(r);
            o->as.call_rest_arguments.this_value = rd_i32(r);
            i32 receiver = rd_i32(r);
            i32 start = rd_i32(r);
            bool apply = rd_u8(r) != 0;
            if (start < 0 || !i32_builder_reserve(side_data, r, 3)) {
                r->ok = false;
                return;
            }
            o->as.call_rest_arguments.data_offset = (i32) side_data->count;
            side_data->data[side_data->count++] = receiver;
            side_data->data[side_data->count++] = start;
            side_data->data[side_data->count++] = apply;
            return;
        }
        case WIRE_CALL_SPREAD_ITERABLE:
            o->opcode = MAL_OP_CALL_SPREAD_ITERABLE;
            o->as.call_spread_iterable.dst = rd_i32(r);
            o->as.call_spread_iterable.callee = rd_i32(r);
            o->as.call_spread_iterable.this_value = rd_i32(r);
            o->as.call_spread_iterable.iterable = rd_i32(r);
            return;
        case WIRE_CONSTRUCT_SPREAD:
            o->opcode = MAL_OP_CONSTRUCT_SPREAD;
            o->as.construct_spread.dst = rd_i32(r);
            o->as.construct_spread.callee = rd_i32(r);
            o->as.construct_spread.arguments_array = rd_i32(r);
            return;
        case WIRE_CONSTRUCT_SUPER:
            o->opcode = MAL_OP_CONSTRUCT_SUPER;
            o->as.construct_super.dst = rd_i32(r);
            o->as.construct_super.parent = rd_i32(r);
            o->as.construct_super.arguments_array = rd_i32(r);
            return;
        case WIRE_CONSTRUCT_SUPER_EXPLICIT:
            o->opcode = MAL_OP_CONSTRUCT_SUPER_EXPLICIT;
            o->as.construct_super_explicit.dst = rd_i32(r);
            o->as.construct_super_explicit.parent = rd_i32(r);
            o->as.construct_super_explicit.arguments_array = rd_i32(r);
            o->as.construct_super_explicit.new_target = rd_i32(r);
            return;
        case WIRE_SET_THIS:
            o->opcode = MAL_OP_SET_THIS;
            o->as.set_this.value = rd_i32(r);
            return;
        case WIRE_MERGE_DATA_PROPERTIES:
            o->opcode = MAL_OP_MERGE_DATA_PROPERTIES;
            o->as.merge_data_properties.target = rd_i32(r);
            o->as.merge_data_properties.src = rd_i32(r);
            return;
        case WIRE_DEFINE_ACCESSOR:
            o->opcode = MAL_OP_DEFINE_ACCESSOR;
            o->as.define_accessor.object = rd_i32(r);
            o->as.define_accessor.key = rd_i32(r);
            o->as.define_accessor.accessor = rd_i32(r);
            o->as.define_accessor.is_setter = rd_u8(r) != 0;
            o->as.define_accessor.enumerable = rd_u8(r) != 0;
            return;
        case WIRE_DEFINE_PROPERTY:
            o->opcode = MAL_OP_DEFINE_PROPERTY;
            o->as.define_property.object = rd_i32(r);
            o->as.define_property.key = rd_i32(r);
            o->as.define_property.value = rd_i32(r);
            o->as.define_property.enumerable = rd_u8(r) != 0;
            o->as.define_property.writable = rd_u8(r) != 0;
            o->as.define_property.configurable = rd_u8(r) != 0;
            return;
        case WIRE_SET_FUNCTION_NAME:
            o->opcode = MAL_OP_SET_FUNCTION_NAME;
            o->as.set_function_name.func = rd_i32(r);
            o->as.set_function_name.key = rd_i32(r);
            o->as.set_function_name.prefix = rd_u8(r);
            return;
        case WIRE_CREATE_PRIVATE_NAME:
            o->opcode = MAL_OP_CREATE_PRIVATE_NAME;
            o->as.create_private_name.dst = rd_i32(r);
            return;
        case WIRE_CREATE_PRIVATE_NAMES: {
            o->opcode = MAL_OP_CREATE_PRIVATE_NAMES;
            o->as.create_private_names.owner_function_index = rd_i32(r);
            i32 count = rd_i32(r);
            if (count < 1) {
                r->ok = false;
                return;
            }
            o->as.create_private_names.data_offset = rd_side_single(r, side_data, count);
            return;
        }
        case WIRE_INIT_PRIVATE_FIELDS: {
            o->opcode = MAL_OP_INIT_PRIVATE_FIELDS;
            o->as.init_private_fields.object = rd_i32(r);
            i32 count = rd_i32(r);
            if (count < 1) {
                r->ok = false;
                return;
            }
            o->as.init_private_fields.data_offset = rd_side_single(r, side_data, count);
            return;
        }
        case WIRE_SET_PROTOTYPE:
            o->opcode = MAL_OP_SET_PROTOTYPE;
            o->as.set_prototype.object = rd_i32(r);
            o->as.set_prototype.prototype = rd_i32(r);
            o->as.set_prototype.literal = rd_u8(r) != 0;
            return;
        case WIRE_LOAD_UNDECLARED:
            o->opcode = MAL_OP_LOAD_UNDECLARED;
            o->as.load_undeclared.dst = rd_i32(r);
            o->as.load_undeclared.name_string_index = rd_i32(r);
            return;
        case WIRE_LOAD_GLOBAL_PROPERTY:
            o->opcode = MAL_OP_LOAD_GLOBAL_PROPERTY;
            o->as.load_global_property.dst = rd_i32(r);
            o->as.load_global_property.name_string_index = rd_i32(r);
            return;
        case WIRE_WITH_GET:
            o->opcode = MAL_OP_WITH_GET;
            o->as.with_get.dst = rd_i32(r);
            o->as.with_get.name_string_index = rd_i32(r);
            return;
        case WIRE_WITH_RESOLVE_BASE:
            o->opcode = MAL_OP_WITH_RESOLVE_BASE;
            o->as.with_resolve_base.dst = rd_i32(r);
            o->as.with_resolve_base.name_string_index = rd_i32(r);
            return;
        case WIRE_STORE_GLOBAL_PROPERTY:
            o->opcode = MAL_OP_STORE_GLOBAL_PROPERTY;
            o->as.store_global_property.src = rd_i32(r);
            o->as.store_global_property.name_string_index = rd_i32(r);
            o->as.store_global_property.declaration = rd_u8(r) != 0;
            o->as.store_global_property.declaration_configurable = rd_u8(r) != 0;
            return;
        case WIRE_DECLARE_GLOBAL_LEXICAL:
            o->opcode = MAL_OP_DECLARE_GLOBAL_LEXICAL;
            o->as.declare_global_lexical.name_string_index = rd_i32(r);
            o->as.declare_global_lexical.index = rd_i32(r);
            o->as.declare_global_lexical.immutable = rd_u8(r) != 0;
            o->as.declare_global_lexical.check_only = rd_u8(r) != 0;
            return;
        case WIRE_GLOBAL_BINDING_QUERY:
            o->opcode = MAL_OP_GLOBAL_BINDING_QUERY;
            o->as.global_binding_query.dst = rd_i32(r);
            o->as.global_binding_query.name_string_index = rd_i32(r);
            o->as.global_binding_query.query = rd_u8(r);
            if (o->as.global_binding_query.query > 2) r->ok = false;
            return;
        case WIRE_INIT_GLOBAL_VARS: {
            o->opcode = MAL_OP_INIT_GLOBAL_VARS;
            i32 count = rd_i32(r);
            if (count < 1) {
                r->ok = false;
                return;
            }
            o->as.init_global_vars.data_offset = rd_side_single(r, side_data, count);
            o->as.init_global_vars.declaration_configurable = rd_u8(r) != 0;
            return;
        }
        case WIRE_THROW_IF_TDZ:
            o->opcode = MAL_OP_THROW_IF_TDZ;
            o->as.throw_if_tdz.src = rd_i32(r);
            o->as.throw_if_tdz.name_string_index = rd_i32(r);
            return;
        case WIRE_WITH_ENTER:
            o->opcode = MAL_OP_WITH_ENTER;
            o->as.with_enter.object = rd_i32(r);
            return;
        case WIRE_WITH_EXIT:
            o->opcode = MAL_OP_WITH_EXIT;
            return;
        case WIRE_WITH_SET:
            o->opcode = MAL_OP_WITH_SET;
            o->as.with_set.found = rd_i32(r);
            o->as.with_set.value = rd_i32(r);
            o->as.with_set.name_string_index = rd_i32(r);
            return;
        case WIRE_IS_EMPTY:
            o->opcode = MAL_OP_IS_EMPTY;
            o->as.is_empty.dst = rd_i32(r);
            o->as.is_empty.src = rd_i32(r);
            return;
        case WIRE_REQUIRE_COERCIBLE:
            o->opcode = MAL_OP_REQUIRE_COERCIBLE;
            o->as.require_coercible.src = rd_i32(r);
            return;
        case WIRE_CHECK_SUPER_CLASS:
            o->opcode = MAL_OP_CHECK_SUPER_CLASS;
            o->as.check_super_class.parent = rd_i32(r);
            return;
        case WIRE_CREATE_REST_ARGUMENTS:
            o->opcode = MAL_OP_CREATE_REST_ARGUMENTS;
            o->as.create_rest_arguments.dst = rd_i32(r);
            o->as.create_rest_arguments.start_index = rd_i32(r);
            return;
        case WIRE_ARRAY_REST:
            o->opcode = MAL_OP_ARRAY_REST;
            o->as.array_rest.dst = rd_i32(r);
            o->as.array_rest.src = rd_i32(r);
            o->as.array_rest.start_index = rd_i32(r);
            return;
        case WIRE_COPY_DATA_PROPERTIES: {
            o->opcode = MAL_OP_COPY_DATA_PROPERTIES;
            o->as.copy_data_properties.dst = rd_i32(r);
            o->as.copy_data_properties.src = rd_i32(r);
            i32 count = rd_i32(r);
            o->as.copy_data_properties.data_offset =
                rd_side_single(r, side_data, count);
            return;
        }
        case WIRE_BINARY: {
            o->opcode = MAL_OP_BINARY;
            o->as.binary.dst = rd_i32(r);
            o->as.binary.left = rd_i32(r);
            o->as.binary.right = rd_i32(r);
            u8 idx = rd_u8(r);
            if (r->ok && idx < countof(wire_binops)) {
                o->as.binary.op = wire_binops[idx];
            } else {
                r->ok = false;
            }
            return;
        }
        case WIRE_UNARY: {
            o->opcode = MAL_OP_UNARY;
            o->as.unary.dst = rd_i32(r);
            o->as.unary.src = rd_i32(r);
            u8 idx = rd_u8(r);
            if (r->ok && idx < countof(wire_unops)) {
                o->as.unary.op = wire_unops[idx];
            } else {
                r->ok = false;
            }
            return;
        }
        case WIRE_MATH_UNARY_NUMBER: {
            o->opcode = MAL_OP_MATH_UNARY_NUMBER;
            o->as.math_unary_number.dst = rd_i32(r);
            o->as.math_unary_number.src = rd_i32(r);
            u8 idx = rd_u8(r);
            if (r->ok && idx < countof(wire_math_unary_number_ops)) {
                o->as.math_unary_number.operation = wire_math_unary_number_ops[idx];
            } else {
                r->ok = false;
            }
            return;
        }
        case WIRE_MATH_BINARY_NUMBER: {
            o->opcode = MAL_OP_MATH_BINARY_NUMBER;
            o->as.math_binary_number.dst = rd_i32(r);
            o->as.math_binary_number.left = rd_i32(r);
            o->as.math_binary_number.right = rd_i32(r);
            u8 idx = rd_u8(r);
            if (r->ok && idx < countof(wire_math_binary_number_ops)) {
                o->as.math_binary_number.operation = wire_math_binary_number_ops[idx];
            } else {
                r->ok = false;
            }
            return;
        }
        case WIRE_TYPEOF_COMPARE: {
            o->opcode = MAL_OP_TYPEOF_COMPARE;
            o->as.typeof_compare.dst = rd_i32(r);
            o->as.typeof_compare.src = rd_i32(r);
            u8 idx = rd_u8(r);
            if (r->ok && idx < countof(wire_typeof_results)) {
                o->as.typeof_compare.expected = wire_typeof_results[idx];
            } else {
                r->ok = false;
            }
            o->as.typeof_compare.negated = rd_u8(r) != 0;
            return;
        }
        case WIRE_OP_COUNT:
        default:
            r->ok = false;
            return;
    }
}

static bool mal_loaded_static_query_valid(const MalRuntimeImage *image, const MalFunction *fn, const MalInstruction *instruction) {
    i32 side_offset = instruction->as.query_static_data.data_offset;
    if (side_offset < 0 || side_offset >= fn->instruction_data_count - 1) return false;
    i32 offset = fn->instruction_data[side_offset];
    i32 kind = fn->instruction_data[side_offset + 1];
    i32 registers[] = { instruction->as.query_static_data.dst, instruction->as.query_static_data.needle, instruction->as.query_static_data.from_index };
    for (usize index = 0; index < sizeof(registers) / sizeof(registers[0]); index++)
        if (registers[index] < 0 || registers[index] >= fn->register_count) return false;
    if ((kind != 0 && kind != 1) || offset < 0 || offset >= image->literal_template_data_count - 1) return false;
    const u32 *data = image->literal_template_data;
    u32 position = (u32) offset, end = (u32) image->literal_template_data_count;
    if (data[position++] != MAL_LITERAL_ARRAY) return false;
    u32 length = data[position++];
    if (length > end - position) return false;
    for (u32 index = 0; index < length; index++) {
        if (position >= end) return false;
        u32 tag = data[position++];
        if (kind == 1 && tag != MAL_LITERAL_STRING) return false;
        u32 words = 0;
        switch (tag) {
            case MAL_LITERAL_NULL: case MAL_LITERAL_FALSE: case MAL_LITERAL_TRUE:
            case MAL_LITERAL_HOLE: case MAL_LITERAL_UNDEFINED: break;
            case MAL_LITERAL_I32: words = 1; break;
            case MAL_LITERAL_F64: words = 2; break;
            case MAL_LITERAL_STRING:
                if (position >= end || data[position] >= (u32) image->string_constant_count) return false;
                words = 1; break;
            case MAL_LITERAL_BIGINT:
                if (position >= end || data[position] >= (u32) image->bigint_constant_count) return false;
                words = 1; break;
            default: return false;
        }
        if (words > end - position) return false;
        position += words;
    }
    return true;
}

static bool mal_loaded_instruction_writes_register(
    const MalInstruction *instruction, i32 target_register
) {
#define MAL_WRITES_DST(opcode, member) \
    case opcode: return instruction->as.member.dst == target_register
    switch (instruction->opcode) {
        MAL_WRITES_DST(MAL_OP_MOVE, move);
        MAL_WRITES_DST(MAL_OP_CREATE_NUMBER, create_number);
        MAL_WRITES_DST(MAL_OP_CREATE_F64, create_f64);
        MAL_WRITES_DST(MAL_OP_CREATE_BOOLEAN, create_boolean);
        MAL_WRITES_DST(MAL_OP_CREATE_STRING, create_string);
        MAL_WRITES_DST(MAL_OP_CREATE_BIGINT, create_bigint);
        MAL_WRITES_DST(MAL_OP_CREATE_OBJECT, create_object);
        MAL_WRITES_DST(MAL_OP_CREATE_OBJECT_SHAPED, create_object_shaped);
        MAL_WRITES_DST(MAL_OP_CREATE_ARRAY, create_array);
        MAL_WRITES_DST(MAL_OP_INSTANTIATE_LITERAL_TEMPLATE, instantiate_literal_template);
        MAL_WRITES_DST(MAL_OP_QUERY_STATIC_DATA, query_static_data);
        MAL_WRITES_DST(MAL_OP_CREATE_MODULE_NAMESPACE, create_module_namespace);
        MAL_WRITES_DST(MAL_OP_CREATE_TEMPLATE_OBJECT, create_template_object);
        MAL_WRITES_DST(MAL_OP_CREATE_UNDEFINED, create_undefined);
        MAL_WRITES_DST(MAL_OP_CREATE_EMPTY, create_empty);
        MAL_WRITES_DST(MAL_OP_CREATE_NULL, create_null);
        MAL_WRITES_DST(MAL_OP_CREATE_FUNCTION, create_function);
        MAL_WRITES_DST(MAL_OP_CREATE_ARGUMENTS_OBJECT, create_arguments_object);
        MAL_WRITES_DST(MAL_OP_LOAD_ARGUMENT_COUNT, load_argument_count);
        MAL_WRITES_DST(MAL_OP_LOAD_ARGUMENT, load_argument);
        MAL_WRITES_DST(MAL_OP_LOAD_STATIC_ARGUMENT, load_static_argument);
        MAL_WRITES_DST(MAL_OP_LOAD_THIS, load_this);
        MAL_WRITES_DST(MAL_OP_LOAD_NEW_TARGET, load_new_target);
        MAL_WRITES_DST(MAL_OP_LOAD_CALLEE, load_callee);
        MAL_WRITES_DST(MAL_OP_CALL, call);
        MAL_WRITES_DST(MAL_OP_CALL_KNOWN, call_known);
        MAL_WRITES_DST(MAL_OP_BUILTIN_ERROR, builtin_error);
        MAL_WRITES_DST(MAL_OP_PREPARED_STRING_COMPARE, prepared_string_compare);
        MAL_WRITES_DST(MAL_OP_CONSTRUCT, construct);
        MAL_WRITES_DST(MAL_OP_CATCH, caught);
        MAL_WRITES_DST(MAL_OP_LOAD_INTRINSIC, load_intrinsic);
        MAL_WRITES_DST(MAL_OP_LOAD_PRIMORDIAL, load_intrinsic);
        MAL_WRITES_DST(MAL_OP_LOAD_CAPTURED, load_captured);
        MAL_WRITES_DST(MAL_OP_GUARD_FUNCTION_INDEX, guard_function_index);
        MAL_WRITES_DST(MAL_OP_LOAD_GLOBAL_INDEX, load_global_index);
        MAL_WRITES_DST(MAL_OP_LOAD_GLOBAL, load_global);
        MAL_WRITES_DST(MAL_OP_LOAD_PROPERTY, load_property);
        MAL_WRITES_DST(MAL_OP_LOAD_PROPERTY_STATIC, load_property_static);
        MAL_WRITES_DST(MAL_OP_LOAD_PROPERTY_STATIC_ARRAY_LENGTH, load_property_static);
        MAL_WRITES_DST(
            MAL_OP_LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT,
            load_property_static_known_own_slot);
        MAL_WRITES_DST(MAL_OP_SELECT_SHAPE_CASE, select_shape_case);
        MAL_WRITES_DST(
            MAL_OP_LOAD_PROPERTY_STATIC_SHAPE_CASE,
            load_property_static_shape_case);
        MAL_WRITES_DST(MAL_OP_DELETE_PROPERTY, delete_property);
        MAL_WRITES_DST(MAL_OP_TO_PROPERTY_KEY, to_property_key);
        MAL_WRITES_DST(MAL_OP_LOAD_PRIVATE, load_private);
        MAL_WRITES_DST(MAL_OP_HAS_PRIVATE, has_private);
        MAL_WRITES_DST(MAL_OP_LOAD_SUPER_PROPERTY, load_super_property);
        MAL_WRITES_DST(MAL_OP_LOAD_PROTOTYPE, load_prototype);
        MAL_WRITES_DST(MAL_OP_FOR_IN_KEYS, for_in_keys);
        MAL_WRITES_DST(MAL_OP_CALL_SPREAD, call_spread);
        MAL_WRITES_DST(MAL_OP_CALL_SPREAD_ITERABLE, call_spread_iterable);
        MAL_WRITES_DST(MAL_OP_CALL_REST_ARGUMENTS, call_rest_arguments);
        MAL_WRITES_DST(MAL_OP_CONSTRUCT_SPREAD, construct_spread);
        MAL_WRITES_DST(MAL_OP_CONSTRUCT_SUPER, construct_super);
        MAL_WRITES_DST(MAL_OP_CONSTRUCT_SUPER_EXPLICIT, construct_super_explicit);
        MAL_WRITES_DST(MAL_OP_CREATE_PRIVATE_NAME, create_private_name);
        MAL_WRITES_DST(MAL_OP_LOAD_UNDECLARED, load_undeclared);
        MAL_WRITES_DST(MAL_OP_LOAD_GLOBAL_PROPERTY, load_global_property);
        MAL_WRITES_DST(MAL_OP_GLOBAL_BINDING_QUERY, global_binding_query);
        MAL_WRITES_DST(MAL_OP_WITH_GET, with_get);
        MAL_WRITES_DST(MAL_OP_WITH_RESOLVE_BASE, with_resolve_base);
        MAL_WRITES_DST(MAL_OP_IS_EMPTY, is_empty);
        MAL_WRITES_DST(MAL_OP_CREATE_REST_ARGUMENTS, create_rest_arguments);
        MAL_WRITES_DST(MAL_OP_ARRAY_REST, array_rest);
        MAL_WRITES_DST(MAL_OP_COPY_DATA_PROPERTIES, copy_data_properties);
        MAL_WRITES_DST(MAL_OP_BINARY, binary);
        MAL_WRITES_DST(MAL_OP_UNARY, unary);
        MAL_WRITES_DST(MAL_OP_MATH_UNARY_NUMBER, math_unary_number);
        MAL_WRITES_DST(MAL_OP_MATH_BINARY_NUMBER, math_binary_number);
        MAL_WRITES_DST(MAL_OP_TYPEOF_COMPARE, typeof_compare);
        case MAL_OP_YIELD:
            return instruction->as.yield.value_dst == target_register ||
                instruction->as.yield.mode_dst == target_register;
        case MAL_OP_AWAIT:
            return instruction->as.await.value_dst == target_register ||
                instruction->as.await.mode_dst == target_register;
        case MAL_OP_GET_ITERATOR:
            return instruction->as.get_iterator.iterator_dst == target_register ||
                instruction->as.get_iterator.next_dst == target_register;
        case MAL_OP_GET_ASYNC_ITERATOR:
            return instruction->as.get_async_iterator.iterator_dst == target_register ||
                instruction->as.get_async_iterator.next_dst == target_register;
        case MAL_OP_ITERATOR_NEXT:
            return instruction->as.iterator_next.result_dst == target_register;
        case MAL_OP_ITERATOR_STEP:
            return instruction->as.iterator_step.value_dst == target_register ||
                instruction->as.iterator_step.done_dst == target_register;
        case MAL_OP_WITH_SET:
            return instruction->as.with_set.found == target_register;
        default:
            return false;
    }
#undef MAL_WRITES_DST
}

static const MalInstruction *mal_loaded_latest_definition(
    const MalFunction *fn, i32 target_register, i32 before_ip
) {
    for (i32 ip = before_ip - 1; ip >= 0; ip--) {
        const MalInstruction *instruction = &fn->instructions[ip];
        if (mal_loaded_instruction_writes_register(instruction, target_register)) {
            return instruction;
        }
    }
    return nullptr;
}

static bool mal_loaded_static_property_matches(
    const MalFunction *fn,
    const MalString *strings,
    u32 string_count,
    i32 ip,
    i32 object,
    const char *name
) {
    if (ip < 0 || ip >= fn->instruction_count) return false;
    const MalInstruction *property = &fn->instructions[ip];
    if (property->opcode != MAL_OP_LOAD_PROPERTY_STATIC ||
        property->as.load_property_static.object != object) return false;
    i32 string_index = property->as.load_property_static.string_index;
    if (string_index < 0 || string_index >= (i32) string_count) return false;
    const MalString *string = &strings[string_index];
    usize length = strlen(name);
    if (string->length != length) return false;
    for (usize index = 0; index < length; index++) {
        if (string->code_units[index] != (u8) name[index]) return false;
    }
    return true;
}

/*
 * Re-check a region's Core property placement. Placement is Core metadata: only a
 * compiled backend acts on it by skipping the load on the fast path, so the
 * interpreter needs no behavior here. What the image must still prove is what
 * corruption or a stale writer could break — a deferred load produces the call's
 * callee and shares its handler coverage, so its throw is caught where it was.
 */
static bool mal_loaded_property_placement_holds(
    const MalFunction *fn, u8 placement, i32 property_ip, i32 call_ip
) {
    if (placement == 0) return true;
    if (placement != 1) return false;
    if (property_ip < 0 || property_ip >= fn->instruction_count) return false;
    if (call_ip < 0 || call_ip >= fn->instruction_count) return false;
    const MalInstruction *property = &fn->instructions[property_ip];
    const MalInstruction *call = &fn->instructions[call_ip];
    if (property->opcode != MAL_OP_LOAD_PROPERTY_STATIC || call->opcode != MAL_OP_CALL) {
        return false;
    }
    if (call->as.call.callee != property->as.load_property_static.dst) return false;
    for (i32 handler = 0; handler < fn->handler_count; handler++) {
        const MalExceptionHandler *entry = &fn->handlers[handler];
        bool covers_property = property_ip >= entry->start_ip && property_ip < entry->end_ip;
        bool covers_call = call_ip >= entry->start_ip && call_ip < entry->end_ip;
        if (covers_property != covers_call) return false;
    }
    return true;
}

static i32 argument_retention_limit(const MalFunction *fn) {
    i32 limit = -1;
    for (i32 i = fn->argument_snapshot_count; i < fn->instruction_count; i++) {
        const MalInstruction *instruction = &fn->instructions[i];
        if (instruction->opcode == MAL_OP_CREATE_ARGUMENTS_OBJECT ||
            instruction->opcode == MAL_OP_CREATE_REST_ARGUMENTS ||
            instruction->opcode == MAL_OP_CALL_REST_ARGUMENTS ||
            instruction->opcode == MAL_OP_LOAD_ARGUMENT) {
            return INT32_MAX;
        }
        if (instruction->opcode == MAL_OP_LOAD_STATIC_ARGUMENT &&
            instruction->as.load_static_argument.index > limit) {
            limit = instruction->as.load_static_argument.index;
        }
    }
    return limit;
}

static void rd_function(MalLoadedRuntimeImage *L, Rd *r, MalFunction *fn, bool debug) {
    fn->name_string_index = rd_i32(r);
    u8 kind = rd_u8(r);
    switch (kind) {
        case 1:
            fn->kind = MAL_FUNCTION_KIND_GENERATOR;
            break;
        case 2:
            fn->kind = MAL_FUNCTION_KIND_ASYNC;
            break;
        case 3:
            fn->kind = MAL_FUNCTION_KIND_ASYNC_GENERATOR;
            break;
        default:
            fn->kind = MAL_FUNCTION_KIND_NORMAL;
            break;
    }
    fn->strict = rd_u8(r) != 0;
    fn->gc_safepoints_trusted = false;
    fn->needs_arguments = rd_u8(r) != 0;
    fn->is_derived_constructor = rd_u8(r) != 0;
    fn->is_class_constructor = rd_u8(r) != 0;
    fn->has_prototype = rd_u8(r) != 0;
    fn->mapped_arguments = rd_u8(r) != 0;
    fn->argument_snapshot_count = (i32) rd_count(r, 1);
    u32 argument_snapshot_plan_count = rd_count(r, 2);
    fn->argument_snapshot_plan_count = (i32) argument_snapshot_plan_count;
    MalArgumentSnapshotMove *argument_snapshot_plan = arena_array(
        L, r, argument_snapshot_plan_count, sizeof(MalArgumentSnapshotMove),
        alignof(MalArgumentSnapshotMove));
    for (u32 i = 0; r->ok && i < argument_snapshot_plan_count; i++) {
        argument_snapshot_plan[i].destination = rd_i32(r);
        argument_snapshot_plan[i].source = rd_i32(r);
    }
    fn->argument_snapshot_plan = argument_snapshot_plan;
    u32 mapped_argument_count = rd_count(r, 1);
    fn->mapped_argument_count = (i32) mapped_argument_count;
    i32 *mapped_argument_slots = arena_array(
        L, r, mapped_argument_count, sizeof(i32), alignof(i32));
    for (u32 i = 0; r->ok && i < mapped_argument_count; i++) {
        mapped_argument_slots[i] = rd_i32(r);
    }
    fn->mapped_argument_slots = mapped_argument_slots;
    fn->parameter_count = rd_i32(r);
    fn->length = rd_i32(r);
    fn->register_count = rd_i32(r);
    fn->captured_count = rd_i32(r);
    fn->file_index = rd_i32(r);
    fn->literal_shape_count = (i32) rd_count(r, 1);
    if (fn->parameter_count < 0 || fn->register_count < fn->parameter_count ||
        fn->argument_snapshot_count > fn->register_count - fn->parameter_count ||
        fn->captured_count < 0 || fn->mapped_argument_count > fn->parameter_count ||
        (!fn->mapped_arguments && fn->mapped_argument_count != 0) ||
        (fn->mapped_arguments && fn->strict)) {
        r->ok = false;
        return;
    }
    for (i32 i = 0; i < fn->mapped_argument_count; i++) {
        if (fn->mapped_argument_slots[i] < -1 ||
            fn->mapped_argument_slots[i] >= fn->captured_count) {
            r->ok = false;
            return;
        }
    }
    fn->compiled = nullptr; // loaded code is always interpreted

    u32 instruction_count = rd_count(r, 1);
    fn->instruction_count = (i32) instruction_count;
    MalInstruction *instructions = arena_array(
        L, r, instruction_count, sizeof(MalInstruction), alignof(MalInstruction));
    I32Builder side_data = {0};
    for (u32 i = 0; r->ok && i < instruction_count; i++) {
        rd_instruction(r, &instructions[i], &side_data);
    }
    fn->property_ic_count = 0;
    i32 physical_literal_shape_count = 0;
    for (u32 i = 0; r->ok && i < instruction_count; i++) {
        switch (instructions[i].opcode) {
            case MAL_OP_LOAD_PROPERTY:
                instructions[i].as.load_property.ic_index = fn->property_ic_count++;
                break;
            case MAL_OP_LOAD_PROPERTY_STATIC:
            case MAL_OP_LOAD_PROPERTY_STATIC_ARRAY_LENGTH:
                instructions[i].as.load_property_static.ic_index = fn->property_ic_count++;
                break;
            case MAL_OP_LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT:
                instructions[i].as.load_property_static_known_own_slot.ic_index =
                    fn->property_ic_count++;
                break;
            case MAL_OP_LOAD_PROPERTY_STATIC_SHAPE_CASE: {
                i32 offset = instructions[i].as.load_property_static_shape_case.data_offset;
                if (offset < 0 || offset > (i32) side_data.count - 3) {
                    r->ok = false;
                    break;
                }
                side_data.data[offset + 1] = fn->property_ic_count++;
                break;
            }
            case MAL_OP_STORE_PROPERTY:
                instructions[i].as.store_property.ic_index = fn->property_ic_count++;
                break;
            case MAL_OP_STORE_PROPERTY_STATIC:
                instructions[i].as.store_property_static.ic_index = fn->property_ic_count++;
                break;
            case MAL_OP_STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT:
                instructions[i].as.store_property_static_known_own_slot.ic_index =
                    fn->property_ic_count++;
                break;
            case MAL_OP_CREATE_OBJECT_SHAPED:
                instructions[i].as.create_object_shaped.shape_cache_index =
                    physical_literal_shape_count++;
                break;
            default:
                break;
        }
    }
    if (physical_literal_shape_count > fn->literal_shape_count) {
        r->ok = false;
    }
    fn->instructions = instructions;
    fn->argument_retention_limit = -1;
    if (r->ok) {
        fn->argument_retention_limit = argument_retention_limit(fn);
        if ((fn->argument_retention_limit >= 0) != fn->needs_arguments) {
            r->ok = false;
        }
    }
    if ((u32) fn->argument_snapshot_count > instruction_count) {
        r->ok = false;
    }
    for (i32 i = 0; r->ok && i < fn->argument_snapshot_count; i++) {
        MalOpcode opcode = instructions[i].opcode;
        if (opcode != MAL_OP_LOAD_ARGUMENT_COUNT && opcode != MAL_OP_LOAD_ARGUMENT) {
            r->ok = false;
            continue;
        }
        i32 destination = opcode == MAL_OP_LOAD_ARGUMENT_COUNT
            ? instructions[i].as.load_argument_count.dst
            : instructions[i].as.load_argument.dst;
        if (destination != fn->parameter_count + i) {
            r->ok = false;
        }
    }
    if (r->ok && (u32) fn->argument_snapshot_count < instruction_count) {
        MalOpcode opcode = instructions[fn->argument_snapshot_count].opcode;
        if (opcode == MAL_OP_LOAD_ARGUMENT_COUNT || opcode == MAL_OP_LOAD_ARGUMENT) {
            r->ok = false;
        }
    }
    if (r->ok && (
        (u32) fn->argument_snapshot_count > UINT32_MAX / 2 ||
        argument_snapshot_plan_count < (u32) fn->argument_snapshot_count ||
        argument_snapshot_plan_count > (u32) fn->argument_snapshot_count * 2
    )) {
        r->ok = false;
    }
    bool *snapshot_destinations = fn->argument_snapshot_count > 0
        ? calloc((usize) fn->argument_snapshot_count, sizeof(bool))
        : nullptr;
    if (r->ok && fn->argument_snapshot_count > 0 && snapshot_destinations == nullptr) {
        r->ok = false;
    }
    bool scratch_live = false;
    i32 scratch_destination = -1;
    i32 scratch_source = -1;
    i32 destination_writes = 0;
    for (u32 i = 0; r->ok && i < argument_snapshot_plan_count; i++) {
        i32 destination = argument_snapshot_plan[i].destination;
        i32 source = argument_snapshot_plan[i].source;
        if (destination < 0) {
            i32 saved_destination = ~destination;
            if (scratch_live || source < 0 || saved_destination < fn->parameter_count ||
                saved_destination >= fn->parameter_count + fn->argument_snapshot_count) {
                r->ok = false;
                break;
            }
            i32 dense_index = saved_destination - fn->parameter_count;
            const MalInstruction *snapshot = &instructions[dense_index];
            if (snapshot->opcode != MAL_OP_LOAD_ARGUMENT ||
                snapshot->as.load_argument.index != source ||
                (source >= fn->parameter_count &&
                 source < fn->parameter_count + fn->argument_snapshot_count &&
                 snapshot_destinations[source - fn->parameter_count])) {
                r->ok = false;
                break;
            }
            scratch_live = true;
            scratch_destination = saved_destination;
            scratch_source = source;
            continue;
        }
        if (destination < fn->parameter_count ||
            destination >= fn->parameter_count + fn->argument_snapshot_count ||
            (source < 0 && source != MAL_ARGUMENT_SNAPSHOT_SOURCE_COUNT &&
             source != MAL_ARGUMENT_SNAPSHOT_SOURCE_SCRATCH)) {
            r->ok = false;
            break;
        }
        if (source == MAL_ARGUMENT_SNAPSHOT_SOURCE_SCRATCH) {
            if (!scratch_live || destination != scratch_destination) {
                r->ok = false;
                break;
            }
            scratch_live = false;
            scratch_destination = -1;
        } else if (source >= fn->parameter_count &&
                   source < fn->parameter_count + fn->argument_snapshot_count &&
                   snapshot_destinations[source - fn->parameter_count]) {
            // This aliased argument slot has already been overwritten by an
            // earlier destination write, so the plan is not a parallel move.
            r->ok = false;
            break;
        }
        i32 dense_index = destination - fn->parameter_count;
        const MalInstruction *snapshot = &instructions[dense_index];
        i32 expected_source = snapshot->opcode == MAL_OP_LOAD_ARGUMENT_COUNT
            ? MAL_ARGUMENT_SNAPSHOT_SOURCE_COUNT
            : snapshot->as.load_argument.index;
        i32 actual_source = source == MAL_ARGUMENT_SNAPSHOT_SOURCE_SCRATCH
            ? scratch_source
            : source;
        if (actual_source != expected_source) {
            r->ok = false;
            break;
        }
        if (snapshot_destinations[dense_index]) {
            r->ok = false;
            break;
        }
        snapshot_destinations[dense_index] = true;
        destination_writes++;
        if (source == MAL_ARGUMENT_SNAPSHOT_SOURCE_SCRATCH) {
            scratch_source = -1;
        }
    }
    if (r->ok && (scratch_live || destination_writes != fn->argument_snapshot_count)) {
        r->ok = false;
    }
    free(snapshot_destinations);
    i32 *instruction_data = arena_array(
        L, r, side_data.count, sizeof(i32), alignof(i32));
    if (r->ok && side_data.count > 0) {
        memcpy(instruction_data, side_data.data, side_data.count * sizeof(i32));
    }
    free(side_data.data);
    fn->instruction_data_count = (i32) side_data.count;
    fn->instruction_data = instruction_data;

    u32 gc_safepoint_count = rd_count(r, 2);
    I32Builder gc_safepoints = {0};
    i32 previous_ip = -1;
    for (u32 i = 0; r->ok && i < gc_safepoint_count; i++) {
        i32 instruction_ip = rd_i32(r);
        u32 root_count = rd_count(r, 1);
        if (instruction_ip <= previous_ip || instruction_ip < 0 ||
            instruction_ip >= fn->instruction_count ||
            root_count > (u32) fn->register_count ||
            !i32_builder_reserve(&gc_safepoints, r, (usize) root_count + 2)) {
            r->ok = false;
            break;
        }
        previous_ip = instruction_ip;
        gc_safepoints.data[gc_safepoints.count++] = instruction_ip;
        gc_safepoints.data[gc_safepoints.count++] = (i32) root_count;
        usize root_base = gc_safepoints.count;
        i32 previous_register = -1;
        for (u32 root = 0; r->ok && root < root_count; root++) {
            i32 reg = rd_i32(r);
            if (reg <= previous_register || reg < 0 || reg >= fn->register_count) {
                r->ok = false;
                break;
            }
            previous_register = reg;
            gc_safepoints.data[gc_safepoints.count++] = reg;
        }
        u32 clear_count = rd_count(r, 1);
        if (clear_count > root_count ||
            !i32_builder_reserve(&gc_safepoints, r, (usize) clear_count + 1)) {
            r->ok = false;
            break;
        }
        gc_safepoints.data[gc_safepoints.count++] = (i32) clear_count;
        previous_register = -1;
        u32 root_cursor = 0;
        for (u32 clear = 0; r->ok && clear < clear_count; clear++) {
            i32 reg = rd_i32(r);
            while (root_cursor < root_count &&
                   gc_safepoints.data[root_base + root_cursor] < reg) {
                root_cursor++;
            }
            if (root_cursor == root_count ||
                gc_safepoints.data[root_base + root_cursor] != reg ||
                reg <= previous_register) {
                r->ok = false;
                break;
            }
            previous_register = reg;
            gc_safepoints.data[gc_safepoints.count++] = reg;
        }
    }
    i32 *gc_safepoint_data = arena_array(
        L, r, gc_safepoints.count, sizeof(i32), alignof(i32));
    if (r->ok && gc_safepoints.count > 0) {
        memcpy(
            gc_safepoint_data,
            gc_safepoints.data,
            gc_safepoints.count * sizeof(i32));
    }
    free(gc_safepoints.data);
    fn->gc_safepoint_count = (i32) gc_safepoint_count;
    fn->gc_safepoints = gc_safepoint_data;

    u32 handler_count = rd_count(r, 3);
    fn->handler_count = (i32) handler_count;
    MalExceptionHandler *handlers = arena_array(
        L, r, handler_count, sizeof(MalExceptionHandler), alignof(MalExceptionHandler));
    for (u32 i = 0; r->ok && i < handler_count; i++) {
        handlers[i].start_ip = rd_i32(r);
        handlers[i].end_ip = rd_i32(r);
        handlers[i].handler_ip = rd_i32(r);
    }
    fn->handlers = handlers;

    u32 run_count = rd_count(r, 2);
    fn->position_count = (i32) run_count;
    MalLineEntry *positions = arena_array(
        L, r, run_count, sizeof(MalLineEntry), alignof(MalLineEntry));
    for (u32 i = 0; r->ok && i < run_count; i++) {
        positions[i].start_ip = rd_i32(r);
        positions[i].pos_id = rd_i32(r);
    }
    fn->positions = positions;

    if (!debug) {
        fn->file_index = 0;
        fn->position_count = 0;
        fn->positions = nullptr;
    }
}

static i32 mal_loaded_known_own_slot_offset(const MalInstruction *instruction) {
    if (instruction->opcode == MAL_OP_LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT) {
        return instruction->as.load_property_static_known_own_slot.data_offset;
    }
    if (instruction->opcode == MAL_OP_STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT) {
        return instruction->as.store_property_static_known_own_slot.data_offset;
    }
    return -1;
}

static const MalPrecompiledLiteralShape *mal_loaded_literal_shape(
    const MalRuntimeImage *program, i32 function_index, i32 shape_cache_index
) {
    const MalPrecompiledLiteralShape *result = nullptr;
    for (i32 index = 0; index < program->precompiled_literal_shape_count; index++) {
        const MalPrecompiledLiteralShape *candidate =
            &program->precompiled_literal_shapes[index];
        if (candidate->function_index != function_index ||
            candidate->shape_cache_index != shape_cache_index) {
            continue;
        }
        if (result != nullptr) return nullptr;
        result = candidate;
    }
    return result;
}

static bool mal_loaded_shape_key_is_named(const MalString *string) {
    static const char proto[] = "__proto__";
    if (string->length == sizeof(proto) - 1) {
        bool equal = true;
        for (usize index = 0; index < sizeof(proto) - 1; index++) {
            if (string->code_units[index] != (u8) proto[index]) {
                equal = false;
                break;
            }
        }
        if (equal) return false;
    }
    if (string->length == 0 ||
        (string->length > 1 && string->code_units[0] == (c16) '0')) {
        return true;
    }
    u64 value = 0;
    for (usize index = 0; index < string->length; index++) {
        c16 unit = string->code_units[index];
        if (unit < (c16) '0' || unit > (c16) '9') return true;
        value = value * 10 + (u64) (unit - (c16) '0');
        if (value > UINT32_MAX) return true;
    }
    return value == UINT32_MAX;
}

static bool mal_loaded_strings_equal(const MalString *left, const MalString *right) {
    if (left->length != right->length) return false;
    for (usize index = 0; index < left->length; index++) {
        if (left->code_units[index] != right->code_units[index]) return false;
    }
    return true;
}

static bool mal_loaded_value_operand_valid(
    const MalFunction *owner, u32 string_count, i32 operand
) {
    if (operand >= 0) return operand < owner->register_count;
    if (operand >= MAL_VALUE_OPERAND_TRUE) return true;
    if (operand <= MAL_VALUE_OPERAND_STRING_BASE &&
        operand >= MAL_VALUE_OPERAND_STRING_MIN) {
        return MAL_VALUE_OPERAND_STRING_BASE - operand < (i32) string_count;
    }
    return operand <= MAL_VALUE_OPERAND_I28_BASE &&
        operand >= MAL_VALUE_OPERAND_I28_MIN;
}

static bool mal_loaded_exact_array_length_valid(
    const MalString *strings,
    u32 string_count,
    const MalFunction *owner,
    const MalInstruction *instruction
) {
    i32 dst = instruction->as.load_property_static.dst;
    i32 object = instruction->as.load_property_static.object;
    i32 string_index = instruction->as.load_property_static.string_index;
    if (dst < 0 || dst >= owner->register_count ||
        object < 0 || object >= owner->register_count ||
        string_index < 0 || string_index >= (i32) string_count) {
        return false;
    }
    static const c16 length_key[] = {'l', 'e', 'n', 'g', 't', 'h'};
    const MalString *key = &strings[string_index];
    if (key->length != countof(length_key)) return false;
    for (usize index = 0; index < countof(length_key); index++) {
        if (key->code_units[index] != length_key[index]) return false;
    }
    return true;
}

static bool mal_loaded_known_own_slot_valid(
    const MalRuntimeImage *program,
    u32 string_count,
    const MalFunction *owner,
    const MalInstruction *instruction
) {
    i32 offset = mal_loaded_known_own_slot_offset(instruction);
    if (offset < 0 || offset > owner->instruction_data_count - 2) return false;
    const i32 *data = &owner->instruction_data[offset];
    i32 string_index = data[0];
    i32 candidate_count = data[1];
    if (string_index < 0 || string_index >= (i32) string_count ||
        candidate_count < 1 || candidate_count > 4 ||
        offset > owner->instruction_data_count - 2 - candidate_count * 3) {
        return false;
    }
    for (i32 index = 0; index < candidate_count; index++) {
        i32 shape_function_index = data[2 + index * 3];
        i32 shape_cache_index = data[3 + index * 3];
        i32 slot = data[4 + index * 3];
        if (shape_function_index < 0 ||
            shape_function_index >= program->function_count ||
            shape_cache_index < 0 || slot < 0) {
            return false;
        }
        for (i32 previous = 0; previous < index; previous++) {
            if (data[2 + previous * 3] == shape_function_index &&
                data[3 + previous * 3] == shape_cache_index) {
                return false;
            }
        }
        const MalPrecompiledLiteralShape *shape = mal_loaded_literal_shape(
            program, shape_function_index, shape_cache_index);
        if (shape == nullptr || slot >= shape->key_count ||
            shape->key_string_indices[slot] != string_index) {
            return false;
        }
    }
    return true;
}

static bool mal_loaded_shape_case_transparent(const MalInstruction *instruction) {
    switch (instruction->opcode) {
        case MAL_OP_MOVE:
        case MAL_OP_CREATE_NUMBER:
        case MAL_OP_CREATE_F64:
        case MAL_OP_CREATE_BOOLEAN:
        case MAL_OP_CREATE_UNDEFINED:
        case MAL_OP_CREATE_EMPTY:
        case MAL_OP_CREATE_NULL:
        case MAL_OP_GUARD_FUNCTION_INDEX:
        case MAL_OP_LOAD_CAPTURED:
        case MAL_OP_STORE_CAPTURED:
        case MAL_OP_LOAD_GLOBAL:
        case MAL_OP_STORE_GLOBAL:
        case MAL_OP_LOAD_INTRINSIC:
        case MAL_OP_LOAD_NEW_TARGET:
        case MAL_OP_LOAD_THIS:
        case MAL_OP_SET_THIS:
        case MAL_OP_IS_EMPTY:
        case MAL_OP_TYPEOF_COMPARE:
        case MAL_OP_MATH_UNARY_NUMBER:
        case MAL_OP_MATH_BINARY_NUMBER:
        case MAL_OP_WITH_EXIT:
        case MAL_OP_SELECT_SHAPE_CASE:
            return true;
        default:
            return false;
    }
}

static bool mal_loaded_shape_case_load_valid(
    const MalRuntimeImage *program,
    u32 string_count,
    const MalFunction *fn,
    i32 ip,
    const MalInstruction *selector,
    const MalInstruction *load
) {
    if (selector == nullptr || selector->opcode != MAL_OP_SELECT_SHAPE_CASE ||
        load->opcode != MAL_OP_LOAD_PROPERTY_STATIC_SHAPE_CASE ||
        load->as.load_property_static_shape_case.dst < 0 ||
        load->as.load_property_static_shape_case.dst >= fn->register_count ||
        load->as.load_property_static_shape_case.object < 0 ||
        load->as.load_property_static_shape_case.object >= fn->register_count ||
        load->as.load_property_static_shape_case.shape_case < 0 ||
        load->as.load_property_static_shape_case.shape_case >= fn->register_count ||
        load->as.load_property_static_shape_case.object !=
            selector->as.select_shape_case.object) {
        return false;
    }
    i32 offset = load->as.load_property_static_shape_case.data_offset;
    if (offset < 0 || offset > fn->instruction_data_count - 3) return false;
    const i32 *load_data = &fn->instruction_data[offset];
    i32 string_index = load_data[0];
    i32 slot_count = load_data[2];
    i32 candidate_count = selector->as.select_shape_case.candidate_count;
    if (string_index < 0 || string_index >= (i32) string_count ||
        slot_count != candidate_count || slot_count < 1 || slot_count > 4 ||
        offset > fn->instruction_data_count - 3 - slot_count) {
        return false;
    }
    i32 selector_offset = selector->as.select_shape_case.data_offset;
    if (selector_offset < 0 || candidate_count < 1 || candidate_count > 4 ||
        selector_offset > fn->instruction_data_count - candidate_count * 2) {
        return false;
    }
    const i32 *candidates = &fn->instruction_data[selector_offset];
    for (i32 index = 0; index < candidate_count; index++) {
        i32 function_index = candidates[index * 2];
        i32 shape_cache_index = candidates[index * 2 + 1];
        i32 slot = load_data[3 + index];
        const MalPrecompiledLiteralShape *shape = mal_loaded_literal_shape(
            program, function_index, shape_cache_index);
        if (shape == nullptr || slot < 0 || slot >= shape->key_count ||
            shape->key_string_indices[slot] != string_index) {
            return false;
        }
    }
    const MalInstruction *latest = mal_loaded_latest_definition(
        fn, load->as.load_property_static_shape_case.shape_case, ip);
    return latest == selector;
}

static bool mal_loaded_shape_case_selector_valid(
    const MalRuntimeImage *program,
    u32 string_count,
    const MalFunction *fn,
    i32 selector_ip
) {
    const MalInstruction *selector = &fn->instructions[selector_ip];
    i32 dst = selector->as.select_shape_case.dst;
    i32 object = selector->as.select_shape_case.object;
    i32 count = selector->as.select_shape_case.candidate_count;
    i32 offset = selector->as.select_shape_case.data_offset;
    if (dst < 0 || dst >= fn->register_count || object < 0 ||
        object >= fn->register_count || count < 1 || count > 4 || offset < 0 ||
        offset > fn->instruction_data_count - count * 2) {
        return false;
    }
    const i32 *candidates = &fn->instruction_data[offset];
    for (i32 index = 0; index < count; index++) {
        i32 function_index = candidates[index * 2];
        i32 shape_cache_index = candidates[index * 2 + 1];
        if (mal_loaded_literal_shape(program, function_index, shape_cache_index) == nullptr) {
            return false;
        }
        for (i32 previous = 0; previous < index; previous++) {
            if (candidates[previous * 2] == function_index &&
                candidates[previous * 2 + 1] == shape_cache_index) {
                return false;
            }
        }
    }
    i32 uses = 0;
    i32 last_ip = selector_ip;
    bool crossed_barrier = false;
    bool receiver_redefined = false;
    for (i32 ip = selector_ip + 1; ip < fn->instruction_count; ip++) {
        const MalInstruction *instruction = &fn->instructions[ip];
        if (mal_loaded_instruction_writes_register(instruction, dst)) break;
        if (instruction->opcode == MAL_OP_LOAD_PROPERTY_STATIC_SHAPE_CASE &&
            instruction->as.load_property_static_shape_case.shape_case == dst) {
            if (crossed_barrier || receiver_redefined ||
                !mal_loaded_shape_case_load_valid(
                    program, string_count, fn, ip, selector, instruction)) {
                return false;
            }
            uses++;
            last_ip = ip;
            receiver_redefined = mal_loaded_instruction_writes_register(
                instruction, object);
            continue;
        }
        if (!mal_loaded_shape_case_transparent(instruction)) crossed_barrier = true;
        if (mal_loaded_instruction_writes_register(instruction, object)) {
            receiver_redefined = true;
        }
    }
    return uses >= 2 && uses <= 16 && last_ip - selector_ip <= 64;
}

MalLoadedRuntimeImage *mal_runtime_image_load_with_host_resolver(
    const u8 *buf,
    usize len,
    const char **out_err,
    MalHostInstallerResolver resolver) {
    const char *err = "ok";
    MalLoadedRuntimeImage *L = calloc(1, sizeof(MalLoadedRuntimeImage));
    if (L == nullptr) {
        if (out_err != nullptr) {
            *out_err = "out of memory";
        }
        return nullptr;
    }

    Rd r = {.buf = buf, .len = len, .pos = 0, .ok = true};

    u32 magic = rd_fixed_u32(&r);
    if (!r.ok || magic != WIRE_MAGIC) {
        err = "bad magic";
        goto fail;
    }
    u32 version = rd_fixed_u32(&r);
    if (!r.ok || version != WIRE_VERSION) {
        err = "version mismatch";
        goto fail;
    }
    u32 flags = rd_u32(&r);
    bool debug = (flags & WIRE_FLAG_HAS_DEBUG) != 0;
    MalRuntimeImage *def = &L->runtime_image;
    u32 global_count = rd_u32(&r);
    if (global_count > (u32) INT32_MAX) {
        r.ok = false;
    }
    def->global_count = (i32) global_count;
    u32 entry_path_length = rd_count(&r, 1);
    char *entry_path = arena(
        L, &r, (usize) entry_path_length + 1, alignof(char));
    for (u32 index = 0; r.ok && index < entry_path_length; index++) {
        entry_path[index] = (char) rd_u8(&r);
    }
    def->entry_path = entry_path;

    // Strings: immortal, external code units copied into the arena.
    u32 string_count = rd_count(&r, 1);
    def->string_constant_count = (i32) string_count;
    MalString *strings = arena_array(
        L, &r, string_count, sizeof(MalString), alignof(MalString));
    def->string_constants = strings;
    for (u32 s = 0; r.ok && s < string_count; s++) {
        u32 length = rd_count(&r, sizeof(c16));
        if (!r.ok) {
            break;
        }
        if ((usize) length > MAL_STRING_MAX_CODE_UNITS) {
            err = "string constant exceeds engine limit";
            goto fail;
        }
        c16 *units = arena_array(L, &r, length, sizeof(c16), alignof(c16));
        for (u32 u = 0; r.ok && u < length; u++) {
            units[u] = rd_u16(&r);
        }
        if (!r.ok) {
            break;
        }
        strings[s].header.type = MAL_HEAP_STRING;
        strings[s].header.storage = MAL_HEAP_STORAGE_IMMORTAL;
        strings[s].storage = MAL_STRING_STORAGE_EXTERNAL;
        strings[s].hash_valid = false;
        strings[s].array_index_impossible = false;
        strings[s].property_atom = false;
        strings[s].length = length;
        strings[s].code_units = units;
    }

    // BigInts: immortal, 128-bit value (low u64 then high u64).
    u32 bigint_count = rd_count(&r, 16);
    def->bigint_constant_count = (i32) bigint_count;
    MalBigInt *bigints = arena_array(
        L, &r, bigint_count, sizeof(MalBigInt), alignof(MalBigInt));
    def->bigint_constants = bigints;
    for (u32 b = 0; r.ok && b < bigint_count; b++) {
        u64 lo = rd_u64(&r);
        u64 hi = rd_u64(&r);
        bigints[b].header.type = MAL_HEAP_BIGINT;
        bigints[b].header.storage = MAL_HEAP_STORAGE_IMMORTAL;
        bigints[b].value = mal_bigint128_from_bits(((u128) hi << 64) | (u128) lo);
    }

    // Packed literal-template u32 stream.
    u32 literal_template_count = rd_count(&r, sizeof(u32));
    u32 *literal_templates = arena_array(
        L, &r, literal_template_count, sizeof(u32), alignof(u32));
    for (u32 i = 0; r.ok && i < literal_template_count; i++) {
        literal_templates[i] = rd_fixed_u32(&r);
    }
    def->literal_template_data_count = (i32) literal_template_count;
    def->literal_template_data = literal_templates;

    // CommonJS module table.
    i32 cjs_count;
    const i32 *cjs = rd_i32_array(L, &r, &cjs_count);
    def->cjs_module_count = cjs_count;
    def->cjs_module_function_indices = cjs;

    // Functions.
    u32 function_count = rd_count(&r, 1);
    def->function_count = (i32) function_count;
    MalFunction *functions = arena_array(
        L, &r, function_count, sizeof(MalFunction), alignof(MalFunction));
    def->functions = functions;
    for (u32 f = 0; r.ok && f < function_count; f++) {
        rd_function(L, &r, &functions[f], debug);
    }

    u32 precompiled_literal_shape_count = rd_count(&r, 3);
    MalPrecompiledLiteralShape *precompiled_literal_shapes = arena_array(
        L, &r, precompiled_literal_shape_count,
        sizeof(MalPrecompiledLiteralShape), alignof(MalPrecompiledLiteralShape));
    def->precompiled_literal_shape_count = (i32) precompiled_literal_shape_count;
    def->precompiled_literal_shapes = precompiled_literal_shapes;
    for (u32 shape = 0; r.ok && shape < precompiled_literal_shape_count; shape++) {
        MalPrecompiledLiteralShape *descriptor = &precompiled_literal_shapes[shape];
        descriptor->function_index = rd_i32(&r);
        descriptor->shape_cache_index = rd_i32(&r);
        descriptor->key_string_indices = rd_i32_array(L, &r, &descriptor->key_count);
        if (descriptor->function_index < 0 ||
            descriptor->function_index >= (i32) function_count ||
            descriptor->shape_cache_index < 0 ||
            descriptor->shape_cache_index >=
                functions[descriptor->function_index].literal_shape_count ||
            descriptor->key_count < 1 ||
            descriptor->key_count > MAL_SHAPE_MAX_INLINE_SLOTS) {
            r.ok = false;
            continue;
        }
        for (i32 key = 0; r.ok && key < descriptor->key_count; key++) {
            i32 string_index = descriptor->key_string_indices[key];
            if (string_index < 0 || string_index >= (i32) string_count ||
                !mal_loaded_shape_key_is_named(&strings[string_index])) {
                r.ok = false;
            }
            for (i32 previous = 0; r.ok && previous < key; previous++) {
                i32 previous_string_index = descriptor->key_string_indices[previous];
                if (mal_loaded_strings_equal(
                        &strings[previous_string_index], &strings[string_index])) {
                    r.ok = false;
                }
            }
        }
        for (u32 previous = 0; r.ok && previous < shape; previous++) {
            if (precompiled_literal_shapes[previous].function_index ==
                    descriptor->function_index &&
                precompiled_literal_shapes[previous].shape_cache_index ==
                    descriptor->shape_cache_index) {
                r.ok = false;
            }
        }
    }
    for (u32 f = 0; r.ok && f < function_count; f++) {
        const MalFunction *fn = &functions[f];
        for (i32 ip = 0; r.ok && ip < fn->instruction_count; ip++) {
            const MalInstruction *instruction = &fn->instructions[ip];
            if (instruction->opcode == MAL_OP_QUERY_STATIC_DATA) {
                if (!mal_loaded_static_query_valid(def, fn, instruction)) r.ok = false;
            } else if (instruction->opcode == MAL_OP_CALL) {
                const i32 *data =
                    &fn->instruction_data[instruction->as.call.data_offset];
                i32 argument_count = data[0];
                i32 exact = data[1];
                i32 target_count = data[2];
                if (!mal_loaded_value_operand_valid(
                        fn, string_count, instruction->as.call.callee) ||
                    !mal_loaded_value_operand_valid(
                        fn, string_count, instruction->as.call.this_value) ||
                    exact >= (i32) function_count || target_count < 0 || target_count > 4 ||
                    (exact >= 0 && target_count != 0)) {
                    r.ok = false;
                }
                i32 guarded_tag = data[3 + target_count + argument_count];
                if ((guarded_tag > 0 &&
                     ((guarded_tag <= MAL_MATH_UNARY_ROUND && argument_count != 1) ||
                      guarded_tag > MAL_MATH_UNARY_ROUND + 1 +
                          MAL_GUARDED_BUILTIN_ARRAY_PUSH ||
                      (guarded_tag == MAL_MATH_UNARY_ROUND + 1 +
                          MAL_GUARDED_BUILTIN_ARRAY_PUSH && argument_count > 4))) ||
                    (guarded_tag < 0 &&
                     (-guarded_tag > MAL_MATH_BINARY_MAX || argument_count != 2))) {
                    r.ok = false;
                }
                for (i32 target = 0; r.ok && target < target_count; target++) {
                    i32 function_index = data[target + 3];
                    if (function_index < 0 || function_index >= (i32) function_count ||
                        (target > 0 && function_index <= data[target + 2])) {
                        r.ok = false;
                    }
                }
                for (i32 argument = 0; r.ok && argument < argument_count; argument++) {
                    if (!mal_loaded_value_operand_valid(
                            fn, string_count, data[3 + target_count + argument])) {
                        r.ok = false;
                    }
                }
            } else if (instruction->opcode == MAL_OP_BUILTIN_ERROR) {
                if (instruction->as.builtin_error.dst < 0 || instruction->as.builtin_error.dst >= fn->register_count) r.ok = false;
            } else if (instruction->opcode == MAL_OP_PREPARED_STRING_COMPARE) {
                i32 registers[] = {instruction->as.prepared_string_compare.dst, instruction->as.prepared_string_compare.left, instruction->as.prepared_string_compare.right};
                for (usize i = 0; i < countof(registers); i++)
                    if (registers[i] < 0 || registers[i] >= fn->register_count) r.ok = false;
                u32 locale_index = instruction->as.prepared_string_compare.locale_options >> 6;
                if (locale_index >= string_count) r.ok = false;
                else {
                    MalString *locale = &strings[locale_index];
                    usize length = mal_string_length(locale);
                    if (length > 128) r.ok = false;
                    const c16 *units = mal_string_code_units(locale);
                    for (usize i = 0; r.ok && i < length; i++) if (units[i] > 127) r.ok = false;
                }
            } else if ((instruction->opcode == MAL_OP_CALL_KNOWN)) {
                const i32 *data =
                    &fn->instruction_data[instruction->as.call_known.data_offset];
                if (!mal_loaded_value_operand_valid(
                        fn, string_count, instruction->as.call_known.this_value)) {
                    r.ok = false;
                }
                for (i32 argument = 0; r.ok && argument < data[0]; argument++) {
                    if (!mal_loaded_value_operand_valid(
                            fn, string_count, data[argument + 1])) {
                        r.ok = false;
                    }
                }
            } else if (instruction->opcode == MAL_OP_CONSTRUCT) {
                const i32 *data =
                    &fn->instruction_data[instruction->as.construct.data_offset];
                if (!mal_loaded_value_operand_valid(
                        fn, string_count, instruction->as.construct.callee) ||
                    data[1] >= (i32) function_count || data[2] != 0) {
                    r.ok = false;
                }
                for (i32 argument = 0; r.ok && argument < data[0]; argument++) {
                    if (!mal_loaded_value_operand_valid(
                            fn, string_count, data[argument + 3])) {
                        r.ok = false;
                    }
                }
            }
            if ((instruction->opcode == MAL_OP_LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT ||
                 instruction->opcode == MAL_OP_STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT) &&
                !mal_loaded_known_own_slot_valid(
                    def, string_count, fn, instruction)) {
                r.ok = false;
            }
            if (instruction->opcode == MAL_OP_LOAD_PROPERTY_STATIC_ARRAY_LENGTH &&
                !mal_loaded_exact_array_length_valid(
                    strings, string_count, fn, instruction)) {
                r.ok = false;
            }
            if (instruction->opcode == MAL_OP_SELECT_SHAPE_CASE &&
                !mal_loaded_shape_case_selector_valid(
                    def, string_count, fn, ip)) {
                r.ok = false;
            }
            if (instruction->opcode == MAL_OP_LOAD_PROPERTY_STATIC_SHAPE_CASE) {
                const MalInstruction *selector = mal_loaded_latest_definition(
                    fn,
                    instruction->as.load_property_static_shape_case.shape_case,
                    ip);
                if (!mal_loaded_shape_case_load_valid(
                        def, string_count, fn, ip, selector, instruction)) {
                    r.ok = false;
                }
            }
        }
    }

    // Debug-info: files + source positions.
    u32 file_count = rd_count(&r, 1);
    const char **files = arena_array(
        L, &r, file_count, sizeof(char *), alignof(char *));
    for (u32 f = 0; r.ok && f < file_count; f++) {
        u32 length = rd_count(&r, 1);
        char *str = arena(L, &r, (usize) length + 1, alignof(char));
        for (u32 i = 0; r.ok && i < length; i++) {
            str[i] = (char) rd_u8(&r);
        }
        if (r.ok) {
            files[f] = str;
        }
    }
    u32 source_pos_count = rd_count(&r, 4);
    MalSourcePos *source_positions = arena_array(
        L, &r, source_pos_count, sizeof(MalSourcePos), alignof(MalSourcePos));
    for (u32 p = 0; r.ok && p < source_pos_count; p++) {
        source_positions[p].line = rd_i32(&r);
        source_positions[p].column = rd_i32(&r);
        source_positions[p].inlined_function_index = rd_i32(&r);
        source_positions[p].caller_pos_id = rd_i32(&r);
    }
    if (debug) {
        def->file_count = (i32) file_count;
        def->files = files;
        def->source_position_count = (i32) source_pos_count;
        def->source_positions = source_positions;
    }

    u32 host_install_count = rd_u32(&r);
    MalHostInstall *host_installs = arena_array(
        L, &r, host_install_count, sizeof(MalHostInstall), alignof(MalHostInstall));
    def->host_install_count = (i32) host_install_count;
    def->host_installs = host_installs;
    for (u32 i = 0; r.ok && i < host_install_count; i++) {
        u32 installer_length = rd_count(&r, 1);
        char *installer_name = arena(
            L, &r, (usize) installer_length + 1, alignof(char));
        for (u32 byte = 0; r.ok && byte < installer_length; byte++) {
            installer_name[byte] = (char) rd_u8(&r);
        }
        host_installs[i].installer = resolver == nullptr
            ? nullptr
            : resolver(installer_name, installer_length);
        if (r.ok && host_installs[i].installer == nullptr) {
            err = "unsupported host installer";
            goto fail;
        }
        // Names, destinations and optional data each occupy at least one wire byte.
        u32 slot_count = rd_count(&r, 3);
        MalHostInstallSlot *slots = arena_array(
            L, &r, slot_count, sizeof(MalHostInstallSlot), alignof(MalHostInstallSlot));
        host_installs[i].slots = slots;
        host_installs[i].slot_count = (i32) slot_count;
        for (u32 slot = 0; r.ok && slot < slot_count; slot++) {
            u32 name_length = rd_count(&r, 1);
            char *name = arena(L, &r, (usize) name_length + 1, alignof(char));
            for (u32 byte = 0; r.ok && byte < name_length; byte++) {
                name[byte] = (char) rd_u8(&r);
            }
            slots[slot].name = name;
            slots[slot].slot = rd_i32(&r);
            u32 data_length = rd_count(&r, 1);
            if (data_length > 0) {
                char *data = arena(L, &r, (usize) data_length + 1, alignof(char));
                for (u32 byte = 0; r.ok && byte < data_length; byte++) {
                    data[byte] = (char) rd_u8(&r);
                }
                slots[slot].data = data;
            }
        }
    }

    if (!r.ok || r.pos != r.len) {
		if (err[0] == 'o' && err[1] == 'k' && err[2] == '\0') {
			err = "truncated or corrupt buffer";
		}
        goto fail;
    }

    return L;

fail:
    if (out_err != nullptr) {
        *out_err = err;
    }
    mal_loaded_runtime_image_free(L);
    return nullptr;
}

MalLoadedRuntimeImage *mal_runtime_image_load(const u8 *buf, usize len, const char **out_err) {
    return mal_runtime_image_load_with_host_resolver(buf, len, out_err, nullptr);
}

const MalRuntimeImage *mal_loaded_runtime_image_get(const MalLoadedRuntimeImage *loaded) {
    return &loaded->runtime_image;
}

void mal_loaded_runtime_image_free(MalLoadedRuntimeImage *loaded) {
    if (loaded == nullptr) {
        return;
    }
    MalLoadArenaBlock *block = loaded->arena;
    while (block != nullptr) {
        MalLoadArenaBlock *next = block->next;
        free(block);
        block = next;
    }
    free(loaded);
}
