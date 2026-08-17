#include "vm_load.h"

#include <stdlib.h>
#include <string.h>
#include "bigint128.h"
#include "builtin_math.h"
#include "endian.h"
#include "heap_bigint.h"
#include "heap_string.h"

/*
 * Inverse of src/emit-vm.ts + src/serialize-vm.ts: decode the flat wire buffer
 * into the runtime structs. The per-opcode operand layout, the opcode tag
 * ordering (WireOp below), and the operator/intrinsic tables mirror
 * serialize-vm.ts exactly. Existing tags/layouts are immutable and new opcodes
 * append where possible; WIRE_VERSION guards incompatible changes.
 */

#define WIRE_MAGIC 0x574c414du // "MALW" little-endian
#define WIRE_VERSION 61u        // numeric-fusion overlay regions
#define WIRE_FLAG_HAS_DEBUG 1u

/* Wire opcode tags. MUST match WIRE_OPCODES in src/serialize-vm.ts (index order). */
typedef enum WireOp {
    WIRE_MOVE,
    WIRE_RETURN,
    WIRE_JUMP_IF,
    WIRE_JUMP,
    WIRE_CREATE_NUMBER,
    WIRE_CREATE_F64,
    WIRE_CREATE_BOOLEAN,
    WIRE_CREATE_STRING,
    WIRE_CREATE_BIGINT,
    WIRE_CREATE_OBJECT,
    WIRE_CREATE_OBJECT_SHAPED,
    WIRE_CREATE_ARRAY,
    WIRE_CREATE_MODULE_NAMESPACE,
    WIRE_CREATE_TEMPLATE_OBJECT,
    WIRE_CREATE_UNDEFINED,
    WIRE_CREATE_EMPTY,
    WIRE_CREATE_NULL,
    WIRE_CREATE_FUNCTION,
    WIRE_CREATE_ARGUMENTS_OBJECT,
    WIRE_LOAD_THIS,
    WIRE_LOAD_NEW_TARGET,
    WIRE_CALL,
    WIRE_CONSTRUCT,
    WIRE_THROW,
    WIRE_CATCH,
    WIRE_TRY_BEGIN,
    WIRE_TRY_END,
    WIRE_GENERATOR_START,
    WIRE_ASYNC_START,
    WIRE_YIELD,
    WIRE_AWAIT,
    WIRE_LOAD_INTRINSIC,
    WIRE_LOAD_CAPTURED,
    WIRE_LOAD_GLOBAL,
    WIRE_STORE_CAPTURED,
    WIRE_ENV_PUSH,
    WIRE_ENV_COPY,
    WIRE_ENV_POP,
    WIRE_STORE_GLOBAL,
    WIRE_LOAD_PROPERTY,
    WIRE_STORE_PROPERTY,
    WIRE_TO_PROPERTY_KEY,
    WIRE_STORE_SUPER_PROPERTY,
    WIRE_LOAD_PROTOTYPE,
    WIRE_GET_ITERATOR,
    WIRE_GET_ASYNC_ITERATOR,
    WIRE_ITERATOR_NEXT,
    WIRE_ITERATOR_STEP,
    WIRE_ITERATOR_CLOSE,
    WIRE_FOR_IN_KEYS,
    WIRE_CALL_SPREAD,
    WIRE_CONSTRUCT_SPREAD,
    WIRE_CONSTRUCT_SUPER,
    WIRE_MERGE_DATA_PROPERTIES,
    WIRE_DELETE_PROPERTY,
    WIRE_DEFINE_ACCESSOR,
    WIRE_DEFINE_PROPERTY,
    WIRE_CREATE_PRIVATE_NAME,
    WIRE_DEFINE_PRIVATE,
    WIRE_LOAD_PRIVATE,
    WIRE_STORE_PRIVATE,
    WIRE_HAS_PRIVATE,
    WIRE_SET_PROTOTYPE,
    WIRE_LOAD_UNDECLARED,
    WIRE_LOAD_GLOBAL_PROPERTY,
    WIRE_STORE_GLOBAL_PROPERTY,
    WIRE_THROW_IF_TDZ,
    WIRE_WITH_ENTER,
    WIRE_WITH_EXIT,
    WIRE_WITH_GET,
    WIRE_WITH_SET,
    WIRE_IS_EMPTY,
    WIRE_REQUIRE_COERCIBLE,
    WIRE_CREATE_REST_ARGUMENTS,
    WIRE_ARRAY_REST,
    WIRE_COPY_DATA_PROPERTIES,
    WIRE_BINARY,
    WIRE_UNARY,
    /* Appended last; mirrors the trailing opcodes in WIRE_OPCODES
     * (serialize-vm.ts). APPEND-ONLY. */
    WIRE_WITH_RESOLVE_BASE,
    WIRE_SET_FUNCTION_NAME,
    WIRE_CHECK_SUPER_CLASS,
    WIRE_LOAD_CALLEE,
    WIRE_GUARD_FUNCTION_INDEX,
    WIRE_LOAD_SUPER_PROPERTY,
    WIRE_INSTANTIATE_LITERAL_TEMPLATE,
    WIRE_LOAD_ARGUMENT_COUNT,
    WIRE_LOAD_ARGUMENT,
    WIRE_LOAD_PROPERTY_STATIC,
    WIRE_STORE_PROPERTY_STATIC,
    WIRE_INIT_GLOBAL_VARS,
    WIRE_CREATE_PRIVATE_NAMES,
    WIRE_INIT_PRIVATE_FIELDS,
    WIRE_TYPEOF_COMPARE,
    WIRE_TERMINAL_YIELD,
    WIRE_CONSTRUCT_SUPER_EXPLICIT,
    WIRE_SET_THIS,
    WIRE_LOAD_STATIC_ARGUMENT,
    WIRE_CALL_SPREAD_ITERABLE,
    WIRE_MATH_UNARY_NUMBER,
    WIRE_MATH_BINARY_NUMBER,
    WIRE_CALL_BUILTIN,
    WIRE_OP_COUNT,
} WireOp;

/* Wire tag -> MalBinaryOp. MUST match WIRE_BINOPS in serialize-vm.ts. */
static const MalBinaryOp wire_binops[] = {
    MAL_BIN_ADD, MAL_BIN_SUB, MAL_BIN_MUL, MAL_BIN_DIV, MAL_BIN_REM, MAL_BIN_POW,
    MAL_BIN_BIT_AND, MAL_BIN_BIT_OR, MAL_BIN_BIT_XOR, MAL_BIN_SHL, MAL_BIN_SHR,
    MAL_BIN_USHR, MAL_BIN_LT, MAL_BIN_LTE, MAL_BIN_GT, MAL_BIN_GTE, MAL_BIN_EQ,
    MAL_BIN_NEQ, MAL_BIN_STRICT_EQ, MAL_BIN_STRICT_NEQ, MAL_BIN_IN, MAL_BIN_INSTANCEOF,
};

/* Wire tag -> MalUnaryOp. MUST match WIRE_UNOPS in serialize-vm.ts. */
static const MalUnaryOp wire_unops[] = {
    MAL_UNARY_NOT, MAL_UNARY_NEGATE, MAL_UNARY_PLUS, MAL_UNARY_BIT_NOT, MAL_UNARY_TYPEOF,
    MAL_UNARY_TO_NUMERIC, MAL_UNARY_INCREMENT, MAL_UNARY_DECREMENT,
};

/* Wire tags mirror VM_MATH_*_NUMBER_OPERATIONS in lower-vm.ts. */
static const MalMathUnaryOp wire_math_unary_number_ops[] = {
    MAL_MATH_UNARY_ABS,
    MAL_MATH_UNARY_FLOOR,
    MAL_MATH_UNARY_CEIL,
    MAL_MATH_UNARY_ROUND,
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
};

static const MalMathBinaryOp wire_math_binary_number_ops[] = {
    MAL_MATH_BINARY_MIN,
    MAL_MATH_BINARY_MAX,
};

static const MalDirectBuiltinOp wire_direct_builtin_ops[] = {
#define MAL_DIRECT_BUILTIN_OP(operation) operation,
#include "generated/primordial_registry.inc"
};

/* Wire tag -> MalTypeofResult. MUST match WIRE_TYPEOF_RESULTS in serialize-vm.ts. */
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

/* Wire tag -> MAL_INTRINSIC_*. MUST match WIRE_INTRINSICS in serialize-vm.ts. */
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
};

// ---- owned arena (chained calloc'd blocks; pointers stay stable, one free) ----

#define MAL_LOAD_ARENA_BLOCK ((usize) 64 * 1024)

typedef struct MalLoadArenaBlock {
    struct MalLoadArenaBlock *next;
    usize size;
    usize used;
    _Alignas(16) u8 data[];
} MalLoadArenaBlock;

struct MalLoadedDefinition {
    MalLoadArenaBlock *arena;
    MalVmDefinition definition;
};

static usize align_up(usize value, usize align) {
    return (value + (align - 1)) & ~(align - 1);
}

static void *arena_raw(MalLoadedDefinition *L, usize bytes, usize align) {
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

static void *arena(MalLoadedDefinition *L, Rd *r, usize bytes, usize align) {
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
    MalLoadedDefinition *L, Rd *r, usize count, usize item_size, usize align
) {
    if (item_size != 0 && count > SIZE_MAX / item_size) {
        r->ok = false;
        return nullptr;
    }
    return arena(L, r, count * item_size, align);
}

static const i32 *rd_i32_array(MalLoadedDefinition *L, Rd *r, i32 *count_out) {
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

// ---- instruction decode (mirrors writeInstruction in serialize-vm.ts) ----

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
            return;
        case WIRE_CREATE_MODULE_NAMESPACE: {
            o->opcode = MAL_OP_CREATE_MODULE_NAMESPACE;
            o->as.create_module_namespace.dst = rd_i32(r);
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
            i32 count = rd_i32(r);
            o->as.call.data_offset = rd_side_single(r, side_data, count);
            return;
        }
        case WIRE_CALL_BUILTIN: {
            o->opcode = MAL_OP_CALL_BUILTIN;
            o->as.call_builtin.dst = rd_i32(r);
            o->as.call_builtin.this_value = rd_i32(r);
            i32 count = rd_i32(r);
            o->as.call_builtin.data_offset = rd_side_single(r, side_data, count);
            u8 idx = rd_u8(r);
            if (r->ok && idx < countof(wire_direct_builtin_ops)) {
                o->as.call_builtin.operation = wire_direct_builtin_ops[idx];
            } else {
                r->ok = false;
            }
            return;
        }
        case WIRE_CONSTRUCT: {
            o->opcode = MAL_OP_CONSTRUCT;
            o->as.construct.dst = rd_i32(r);
            o->as.construct.callee = rd_i32(r);
            i32 count = rd_i32(r);
            o->as.construct.data_offset = rd_side_single(r, side_data, count);
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
        MAL_WRITES_DST(MAL_OP_CALL_BUILTIN, call_builtin);
        MAL_WRITES_DST(MAL_OP_CONSTRUCT, construct);
        MAL_WRITES_DST(MAL_OP_CATCH, caught);
        MAL_WRITES_DST(MAL_OP_LOAD_INTRINSIC, load_intrinsic);
        MAL_WRITES_DST(MAL_OP_LOAD_CAPTURED, load_captured);
        MAL_WRITES_DST(MAL_OP_GUARD_FUNCTION_INDEX, guard_function_index);
        MAL_WRITES_DST(MAL_OP_LOAD_GLOBAL, load_global);
        MAL_WRITES_DST(MAL_OP_LOAD_PROPERTY, load_property);
        MAL_WRITES_DST(MAL_OP_LOAD_PROPERTY_STATIC, load_property_static);
        MAL_WRITES_DST(MAL_OP_DELETE_PROPERTY, delete_property);
        MAL_WRITES_DST(MAL_OP_TO_PROPERTY_KEY, to_property_key);
        MAL_WRITES_DST(MAL_OP_LOAD_PRIVATE, load_private);
        MAL_WRITES_DST(MAL_OP_HAS_PRIVATE, has_private);
        MAL_WRITES_DST(MAL_OP_LOAD_SUPER_PROPERTY, load_super_property);
        MAL_WRITES_DST(MAL_OP_LOAD_PROTOTYPE, load_prototype);
        MAL_WRITES_DST(MAL_OP_FOR_IN_KEYS, for_in_keys);
        MAL_WRITES_DST(MAL_OP_CALL_SPREAD, call_spread);
        MAL_WRITES_DST(MAL_OP_CALL_SPREAD_ITERABLE, call_spread_iterable);
        MAL_WRITES_DST(MAL_OP_CONSTRUCT_SPREAD, construct_spread);
        MAL_WRITES_DST(MAL_OP_CONSTRUCT_SUPER, construct_super);
        MAL_WRITES_DST(MAL_OP_CONSTRUCT_SUPER_EXPLICIT, construct_super_explicit);
        MAL_WRITES_DST(MAL_OP_CREATE_PRIVATE_NAME, create_private_name);
        MAL_WRITES_DST(MAL_OP_LOAD_UNDECLARED, load_undeclared);
        MAL_WRITES_DST(MAL_OP_LOAD_GLOBAL_PROPERTY, load_global_property);
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

static i32 argument_retention_limit(const MalFunction *fn) {
    i32 limit = -1;
    for (i32 i = fn->argument_snapshot_count; i < fn->instruction_count; i++) {
        const MalInstruction *instruction = &fn->instructions[i];
        if (instruction->opcode == MAL_OP_CREATE_ARGUMENTS_OBJECT ||
            instruction->opcode == MAL_OP_CREATE_REST_ARGUMENTS ||
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

static void rd_function(MalLoadedDefinition *L, Rd *r, MalFunction *fn, bool debug) {
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
    fn->literal_shape_count = 0;
    for (u32 i = 0; r->ok && i < instruction_count; i++) {
        switch (instructions[i].opcode) {
            case MAL_OP_LOAD_PROPERTY:
                instructions[i].as.load_property.ic_index = fn->property_ic_count++;
                break;
            case MAL_OP_LOAD_PROPERTY_STATIC:
                instructions[i].as.load_property_static.ic_index = fn->property_ic_count++;
                break;
            case MAL_OP_STORE_PROPERTY:
                instructions[i].as.store_property.ic_index = fn->property_ic_count++;
                break;
            case MAL_OP_STORE_PROPERTY_STATIC:
                instructions[i].as.store_property_static.ic_index = fn->property_ic_count++;
                break;
            case MAL_OP_CREATE_OBJECT_SHAPED:
                instructions[i].as.create_object_shaped.shape_cache_index =
                    fn->literal_shape_count++;
                break;
            default:
                break;
        }
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

MalLoadedDefinition *mal_vm_load_definition_with_host_resolver(
    const u8 *buf,
    usize len,
    const char **out_err,
    MalHostInstallerResolver resolver) {
    const char *err = "ok";
    MalLoadedDefinition *L = calloc(1, sizeof(MalLoadedDefinition));
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
    MalVmDefinition *def = &L->definition;
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
        // The wire stores each slot as a length-prefixed UTF-8 name plus a
        // varint destination. Runtime structs are pointer-sized and therefore
        // much larger than their serialized form.
        u32 slot_count = rd_count(&r, 2);
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
        }
    }

    /* Program-level compiler facts consumed only by post-wire native analyses. */
    u32 semantic_protector_count = rd_count(&r, 3);
    u8 semantic_protector_tags = 0;
    if (semantic_protector_count > 3) {
        r.ok = false;
    }
    for (u32 i = 0; r.ok && i < semantic_protector_count; i++) {
        u8 tag = rd_u8(&r);
        u8 dependency_mask = rd_u8(&r);
        u8 obligation_mask = rd_u8(&r);
        if (tag < 1 || tag > 3 ||
            (dependency_mask != 1 && dependency_mask != (u8) (1u << tag)) ||
            obligation_mask != 1 ||
            (semantic_protector_tags & (u8) (1u << tag)) != 0) {
            r.ok = false;
            continue;
        }
        semantic_protector_tags |= (u8) (1u << tag);
    }

    /*
     * Compiler-only metadata is retained in the portable wire so Node-hosted
     * tooling can deserialize an AOT-equivalent VmDefinition from its frontend
     * cache. The interpreter does not use these tables, but validates and skips
     * them to keep one canonical wire contract.
     */
    u32 compiler_function_count = rd_count(&r, 1);
    if (compiler_function_count != function_count) {
        r.ok = false;
    }
    for (u32 i = 0; r.ok && i < compiler_function_count; i++) {
        u8 has_gc_roots = rd_u8(&r);
        u32 gc_root_count = rd_count(&r, 1);
        if (has_gc_roots > 1 || (has_gc_roots == 0 && gc_root_count != 0)) {
            r.ok = false;
        }
        for (u32 root = 0; r.ok && root < gc_root_count; root++) {
            (void) rd_i32(&r);
        }

        u32 instruction_metadata_count = rd_count(&r, 2);
        for (u32 metadata = 0; r.ok && metadata < instruction_metadata_count; metadata++) {
            u32 instruction_index = rd_u32(&r);
            u8 tag = rd_u8(&r);
            if (tag == 1) { // CALL
                (void) rd_i32(&r);
                (void) rd_i32(&r);
                u8 flags = rd_u8(&r);
                u8 collection_tag = rd_u8(&r);
                u8 guarded_builtin_count = ((flags & 2) != 0 ? 1 : 0) +
                    ((flags & 4) != 0 ? 1 : 0) + (collection_tag != 0 ? 1 : 0);
                if (flags > 127 || (flags & 8) != 0 || collection_tag > 48 ||
					guarded_builtin_count > 1 ||
                    ((flags & 48) != 0 && (flags & 4) == 0) ||
                    (flags & 48) == 48 ||
                    ((flags & 64) != 0 && guarded_builtin_count != 1)) {
                    r.ok = false;
                }
            } else if (tag == 2) { // CONSTRUCT
                (void) rd_i32(&r);
            } else if (tag == 4) { // BINARY finite-string table
                (void) rd_i32(&r); // minimum
                u32 string_index_count = rd_count(&r, sizeof(i32));
                if (string_index_count == 0 || string_index_count > 32) {
                    r.ok = false;
                }
                for (u32 index = 0; r.ok && index < string_index_count; index++) {
                    (void) rd_i32(&r);
                }
            } else if (tag == 6) { // LOAD_PROPERTY finite selector domain
                (void) rd_i32(&r); // minimum
                (void) rd_i32(&r); // ordinal register
                u32 string_index_count = rd_count(&r, sizeof(i32));
                if (string_index_count == 0 || string_index_count > 8) {
                    r.ok = false;
                }
                for (u32 index = 0; r.ok && index < string_index_count; index++) {
                    (void) rd_i32(&r);
                }
                u8 has_finite_record_access = rd_u8(&r);
                if (has_finite_record_access > 1) {
                    r.ok = false;
                } else if (has_finite_record_access != 0) {
                    (void) rd_i32(&r); // virtual record allocation instruction
                }
            } else if (tag == 7) { // CREATE_OBJECT finite construction region
                (void) rd_i32(&r); // shared property IC index
                u32 guard_count = rd_count(&r, sizeof(i32));
                if (guard_count > 4) {
                    r.ok = false;
                }
                for (u32 guard = 0; r.ok && guard < guard_count; guard++) {
                    (void) rd_i32(&r);
                }
                u32 string_index_count = rd_count(&r, sizeof(i32));
                if (string_index_count == 0 || string_index_count > 8) {
                    r.ok = false;
                }
                for (u32 index = 0; r.ok && index < string_index_count; index++) {
                    (void) rd_i32(&r);
                }
                if (rd_u8(&r) > 1) { // virtual-record flag
                    r.ok = false;
                }
			} else if (tag == 10) { // closed-global finite table
                i32 base = rd_i32(&r);
                i32 state = rd_i32(&r);
                i32 mask = rd_i32(&r);
                u8 direct = rd_u8(&r);
                u8 dependency_mask = rd_u8(&r);
                u8 obligation_mask = rd_u8(&r);
                if (base < 0 || state != base + mask + 1 ||
                    state >= def->global_count || mask < 0 || mask > 1023 ||
                    (mask & (mask + 1)) != 0 || direct > 1 ||
                    (dependency_mask != 1 && dependency_mask != 8) ||
                    obligation_mask != 3) {
                    r.ok = false;
                }
            } else if (tag == 11) { // guarded primitive-String length load
                // No payload: generated native code alone consumes this hint.
            } else if (tag == 12) { // CREATE_ARRAY exact indexed-fill reserve
                i32 reserve_length = rd_i32(&r);
                if (instruction_index >= (u32) functions[i].instruction_count ||
                    functions[i].instructions[instruction_index].opcode != MAL_OP_CREATE_ARRAY ||
                    reserve_length < 1 || reserve_length > 65536) {
                    r.ok = false;
                }
            } else {
                r.ok = false;
            }
        }

        u32 compiler_region_count = rd_count(&r, 17);
        if (compiler_region_count > 8) r.ok = false;
        i32 claimed_region_ips[768];
        u32 claimed_region_count = 0;
        for (u32 region = 0; r.ok && region < compiler_region_count; region++) {
            const MalFunction *fn = &functions[i];
            u8 kind = rd_u8(&r);
			u8 composition = rd_u8(&r);
			if (composition > 1) r.ok = false;
            u32 anchor_count = rd_count(&r, 1);
            if (anchor_count == 0 || anchor_count > 8) r.ok = false;
            i32 anchors[8];
            for (u32 anchor = 0; r.ok && anchor < anchor_count; anchor++) {
                anchors[anchor] = rd_i32(&r);
                if (anchors[anchor] < 0 || anchors[anchor] >= fn->instruction_count) r.ok = false;
                for (u32 previous = 0; r.ok && previous < anchor; previous++) {
                    if (anchors[previous] == anchors[anchor]) r.ok = false;
                }
            }
            u32 claim_count = rd_count(&r, 1);
            if (claim_count == 0 || claim_count > 96) r.ok = false;
            i32 claims[96];
            for (u32 claim = 0; r.ok && claim < claim_count; claim++) {
                claims[claim] = rd_i32(&r);
                if (claims[claim] < 0 || claims[claim] >= fn->instruction_count) r.ok = false;
                for (u32 previous = 0; r.ok && previous < claim; previous++) {
                    if (claims[previous] == claims[claim]) r.ok = false;
                }
				if (composition == 0) {
					for (u32 previous = 0; r.ok && previous < claimed_region_count; previous++) {
						if (claimed_region_ips[previous] == claims[claim]) r.ok = false;
					}
					if (r.ok && claimed_region_count < countof(claimed_region_ips)) {
						claimed_region_ips[claimed_region_count++] = claims[claim];
					} else if (r.ok) {
						r.ok = false;
					}
				}
            }
            for (u32 anchor = 0; r.ok && anchor < anchor_count; anchor++) {
                bool found = false;
                for (u32 claim = 0; claim < claim_count; claim++) {
                    if (anchors[anchor] == claims[claim]) found = true;
                }
                if (!found) r.ok = false;
            }
            u32 ordinary_block_count = rd_count(&r, 1);
            if (ordinary_block_count == 0 || ordinary_block_count > 64) r.ok = false;
            i32 ordinary_block_ips[64];
            for (u32 block = 0; r.ok && block < ordinary_block_count; block++) {
                ordinary_block_ips[block] = rd_i32(&r);
                if (ordinary_block_ips[block] < 0 ||
                    ordinary_block_ips[block] >= fn->instruction_count) {
                    r.ok = false;
                }
                for (u32 previous = 0; r.ok && previous < block; previous++) {
                    if (ordinary_block_ips[previous] == ordinary_block_ips[block]) r.ok = false;
                }
            }
            u32 exceptional_handler_count = rd_count(&r, 1);
			if (exceptional_handler_count > 64 ||
				(kind != 6 && kind != 7 && exceptional_handler_count != 0)) r.ok = false;
            i32 exceptional_handler_ips[64];
            for (u32 handler = 0; r.ok && handler < exceptional_handler_count; handler++) {
                exceptional_handler_ips[handler] = rd_i32(&r);
                bool known_handler = false;
                if (exceptional_handler_ips[handler] < 0 ||
                    exceptional_handler_ips[handler] >= fn->instruction_count) r.ok = false;
                for (u32 previous = 0; r.ok && previous < handler; previous++) {
                    if (exceptional_handler_ips[previous] == exceptional_handler_ips[handler]) {
                        r.ok = false;
                    }
                }
                for (i32 candidate = 0; r.ok && candidate < fn->handler_count; candidate++) {
                    if (fn->handlers[candidate].handler_ip == exceptional_handler_ips[handler]) {
                        known_handler = true;
                    }
                }
                if (!known_handler) r.ok = false;
            }
            u32 score = rd_u32(&r);
            u32 metadata_operations = rd_u32(&r);
            u8 representation = rd_u8(&r);
            u8 generic_twin = rd_u8(&r);
            u8 materialization = rd_u8(&r);
            u8 dependency_mask = rd_u8(&r);
            u8 obligation_mask = rd_u8(&r);
            bool closed_record_contract = kind == 1 && representation == 1 &&
                materialization == 0 && dependency_mask == 1 && obligation_mask == 1;
            bool split_cursor_contract = kind == 2 && representation == 2 &&
                materialization == 1 && (dependency_mask == 1 || dependency_mask == 4) &&
                obligation_mask == 3;
            bool numeric_hof_contract = kind == 3 && representation == 3 &&
                materialization == 0 && (dependency_mask == 1 || dependency_mask == 14) &&
                obligation_mask == 1;
            bool split_projection_contract = kind == 4 && representation == 4 &&
                materialization == 2 && (dependency_mask == 1 || dependency_mask == 4) &&
                obligation_mask == 3;
            bool regexp_exec_projection_contract = kind == 5 && representation == 5 &&
                materialization == 2 && (dependency_mask == 1 || dependency_mask == 4) &&
                obligation_mask == 3;
			bool regexp_iterator_projection_contract = kind == 6 && representation == 6 &&
				materialization == 1 && (dependency_mask == 1 || dependency_mask == 4) &&
				obligation_mask == 3;
			bool string_slice_number_contract = kind == 7 && representation == 7 &&
				materialization == 0 && (dependency_mask == 1 || dependency_mask == 4) &&
				obligation_mask == 1;
			bool string_scan_contract = kind == 8 && representation == 8 &&
				materialization == 0 && (dependency_mask == 1 || dependency_mask == 14) &&
				obligation_mask == 1;
			bool private_aggregate_memo_contract = kind == 9 && representation == 9 &&
				materialization == 0 && (dependency_mask == 1 || dependency_mask == 14) &&
				obligation_mask == 1;
			bool invariant_json_map_template_contract = kind == 10 && representation == 10 &&
				materialization == 2 && (dependency_mask == 1 || dependency_mask == 14) &&
				obligation_mask == 3;
			bool stack_object_plan_contract = kind == 11 && representation == 11 &&
				materialization == 1 &&
				(dependency_mask == 0 || dependency_mask == 1 || dependency_mask == 2) &&
				obligation_mask == 3;
			bool cardinality_array_contract = kind == 12 && representation == 12 &&
				materialization == 2 && (dependency_mask == 1 || dependency_mask == 14) &&
				obligation_mask == 3;
			bool exact_fresh_array_contract = kind == 13 && representation == 13 &&
				materialization == 0 && dependency_mask == 0 && obligation_mask == 1;
			bool numeric_fusion_contract = kind == 14 && representation == 14 &&
				materialization == 0 && dependency_mask == 0 && obligation_mask == 1;
            if (generic_twin != 1 || score == 0 || metadata_operations == 0 ||
                metadata_operations > 96 ||
				(composition == 1) !=
					(exact_fresh_array_contract || numeric_fusion_contract) ||
                (!closed_record_contract && !split_cursor_contract && !numeric_hof_contract &&
				 !split_projection_contract && !regexp_exec_projection_contract &&
				 !regexp_iterator_projection_contract && !string_slice_number_contract &&
				 !string_scan_contract && !private_aggregate_memo_contract &&
				 !invariant_json_map_template_contract && !stack_object_plan_contract &&
				 !cardinality_array_contract && !exact_fresh_array_contract &&
				 !numeric_fusion_contract)) {
                r.ok = false;
            }

            i32 payload_ips[96];
            u32 payload_count = 0;
#define MAL_REGION_PAYLOAD_CLAIM(ip) do { \
                i32 payload_ip = (ip); \
                bool found = false; \
                if (payload_ip < 0 || payload_ip >= fn->instruction_count) r.ok = false; \
                for (u32 claim = 0; r.ok && claim < claim_count; claim++) { \
                    if (claims[claim] == payload_ip) found = true; \
                } \
                if (!found) r.ok = false; \
                for (u32 previous = 0; r.ok && previous < payload_count; previous++) { \
                    if (payload_ips[previous] == payload_ip) r.ok = false; \
                } \
                if (r.ok && payload_count < countof(payload_ips)) { \
                    payload_ips[payload_count++] = payload_ip; \
                } else if (r.ok) { \
                    r.ok = false; \
                } \
            } while (0)
#define MAL_REGION_PAYLOAD_REFERENCE(ip) do { \
                i32 payload_ip = (ip); \
                bool found = false; \
                bool already_recorded = false; \
                if (payload_ip < 0 || payload_ip >= fn->instruction_count) r.ok = false; \
                for (u32 claim = 0; r.ok && claim < claim_count; claim++) { \
                    if (claims[claim] == payload_ip) found = true; \
                } \
                if (!found) r.ok = false; \
                for (u32 previous = 0; r.ok && previous < payload_count; previous++) { \
                    if (payload_ips[previous] == payload_ip) already_recorded = true; \
                } \
                if (r.ok && !already_recorded && payload_count < countof(payload_ips)) { \
                    payload_ips[payload_count++] = payload_ip; \
                } else if (r.ok && !already_recorded) { \
                    r.ok = false; \
                } \
            } while (0)
            if (r.ok && kind == 1) {
                i32 length = rd_i32(&r);
                u32 element_count = rd_count(&r, 1);
                if (element_count == 0 || element_count > 64) r.ok = false;
                i32 element_ips[64];
                for (u32 element = 0; r.ok && element < element_count; element++) {
                    element_ips[element] = rd_i32(&r);
                }
                u32 access_count = rd_count(&r, 3);
                if (access_count < 2 || access_count > 64 ||
                    element_count + access_count > 64) {
                    r.ok = false;
                }
                i32 access_ips[64];
                u8 access_kinds[64];
                i32 access_slots[64];
                for (u32 access = 0; r.ok && access < access_count; access++) {
                    access_ips[access] = rd_i32(&r);
                    access_kinds[access] = rd_u8(&r);
                    access_slots[access] = rd_i32(&r);
                }
                i32 allocation_ip = anchor_count > 0 ? anchors[0] : -1;
                i32 producer_object_ip = anchor_count > 1 ? anchors[1] : -1;
                bool header_ok = r.ok && anchor_count == 2 &&
                    fn->instructions[allocation_ip].opcode == MAL_OP_CREATE_ARRAY &&
                    fn->instructions[allocation_ip].as.create_array.length == 0 &&
                    fn->instructions[producer_object_ip].opcode == MAL_OP_CREATE_OBJECT_SHAPED &&
                    length > 0 && length <= 65536 &&
                    metadata_operations == element_count + access_count;
                if (!header_ok) r.ok = false;
                if (claim_count != 2 + element_count + access_count) r.ok = false;
                MAL_REGION_PAYLOAD_CLAIM(allocation_ip);
                MAL_REGION_PAYLOAD_CLAIM(producer_object_ip);
                for (u32 element = 0; r.ok && element < element_count; element++) {
                    i32 ip = element_ips[element];
                    if (ip < 0 || ip >= fn->instruction_count ||
                        fn->instructions[ip].opcode != MAL_OP_LOAD_PROPERTY) {
                        r.ok = false;
                        break;
                    }
                    MAL_REGION_PAYLOAD_CLAIM(ip);
                }
                for (u32 access = 0; r.ok && access < access_count; access++) {
                    i32 ip = access_ips[access];
                    u8 access_kind = access_kinds[access];
                    bool opcode_ok = ip >= 0 && ip < fn->instruction_count &&
                        ((access_kind == 1 &&
                          fn->instructions[ip].opcode == MAL_OP_LOAD_PROPERTY_STATIC) ||
                         (access_kind == 2 &&
                          fn->instructions[ip].opcode == MAL_OP_STORE_PROPERTY_STATIC));
                    if (!opcode_ok || access_slots[access] < 0 || access_slots[access] >= 64) {
                        r.ok = false;
                        break;
                    }
                    MAL_REGION_PAYLOAD_CLAIM(ip);
                }
            } else if (r.ok && kind == 2) {
                i32 property_ip = rd_i32(&r);
                i32 callee = rd_i32(&r);
                i32 receiver = rd_i32(&r);
                i32 separator = rd_i32(&r);
                i32 result = rd_i32(&r);
                i32 index = rd_i32(&r);
                i32 element_ip = rd_i32(&r);
                i32 trim_property_ip = rd_i32(&r);
                i32 trim_ic_index = rd_i32(&r);
                i32 trim_call_ip = rd_i32(&r);
                u32 primitive_length_count = rd_count(&r, 1);
                if (primitive_length_count > 64) r.ok = false;
                i32 primitive_length_ips[64];
                for (u32 load = 0; r.ok && load < primitive_length_count; load++) {
                    primitive_length_ips[load] = rd_i32(&r);
                }
                i32 exit_ip = rd_i32(&r);
                i32 call_ip = anchor_count > 0 ? anchors[0] : -1;
                i32 result_alias_ip = anchor_count > 1 ? anchors[1] : -1;
                i32 length_ip = anchor_count > 2 ? anchors[2] : -1;
                i32 backedge_ip = anchor_count > 3 ? anchors[3] : -1;
                bool call_ip_ok = call_ip >= 0 && call_ip < fn->instruction_count;
                bool call_is_generic = call_ip_ok &&
                    fn->instructions[call_ip].opcode == MAL_OP_CALL;
                bool call_is_builtin = call_ip_ok &&
                    fn->instructions[call_ip].opcode == MAL_OP_CALL_BUILTIN;
                bool property_ok = property_ip >= 0 && property_ip < fn->instruction_count &&
                    fn->instructions[property_ip].opcode == MAL_OP_LOAD_PROPERTY_STATIC;
                bool fixed_ips_ok = length_ip >= 0 && length_ip + 4 == element_ip &&
                    trim_property_ip == element_ip + 1 &&
                    trim_call_ip == trim_property_ip + 1 && trim_call_ip < backedge_ip &&
                    exit_ip == backedge_ip + 1 && exit_ip <= fn->instruction_count &&
                    backedge_ip < fn->instruction_count;
                if (anchor_count != 4 || !call_ip_ok ||
                    (!call_is_generic && !call_is_builtin) ||
                    (call_is_generic && !property_ok) ||
                    (call_is_builtin && (property_ip != -1 || callee != -1)) ||
                    result < 0 || result >= fn->register_count ||
                    index < 0 || index >= fn->register_count || !fixed_ips_ok) {
                    r.ok = false;
                }
                if (r.ok) {
                    const MalInstruction *call = &fn->instructions[call_ip];
                    const MalInstruction *result_alias = &fn->instructions[result_alias_ip];
                    const MalInstruction *length = &fn->instructions[length_ip];
                    const MalInstruction *compare = &fn->instructions[length_ip + 1];
                    const MalInstruction *body_branch = &fn->instructions[length_ip + 2];
                    const MalInstruction *exit_jump = &fn->instructions[length_ip + 3];
                    const MalInstruction *element = &fn->instructions[element_ip];
                    const MalInstruction *trim_property = &fn->instructions[trim_property_ip];
                    const MalInstruction *trim_call = &fn->instructions[trim_call_ip];
                    const MalInstruction *increment = &fn->instructions[backedge_ip - 1];
                    const MalInstruction *backedge = &fn->instructions[backedge_ip];
                    bool structure_ok = result_alias->opcode == MAL_OP_MOVE &&
                        result_alias->as.move.src == result &&
                        length->opcode == MAL_OP_LOAD_PROPERTY_STATIC &&
                        length->as.load_property_static.object == result_alias->as.move.dst &&
                        compare->opcode == MAL_OP_BINARY && compare->as.binary.op == MAL_BIN_LT &&
                        compare->as.binary.left == index &&
                        compare->as.binary.right == length->as.load_property_static.dst &&
                        body_branch->opcode == MAL_OP_JUMP_IF &&
                        body_branch->as.jump_if.cond == compare->as.binary.dst &&
                        body_branch->as.jump_if.target_ip == element_ip &&
                        exit_jump->opcode == MAL_OP_JUMP &&
                        exit_jump->as.jump.target_ip == exit_ip &&
                        element->opcode == MAL_OP_LOAD_PROPERTY &&
                        element->as.load_property.object == result_alias->as.move.dst &&
                        element->as.load_property.key == index &&
                        trim_property->opcode == MAL_OP_LOAD_PROPERTY_STATIC &&
                        trim_property->as.load_property_static.object ==
                            element->as.load_property.dst &&
                        trim_property->as.load_property_static.ic_index == trim_ic_index &&
                        trim_call->opcode == MAL_OP_CALL &&
                        trim_call->as.call.callee ==
                            trim_property->as.load_property_static.dst &&
                        trim_call->as.call.this_value == element->as.load_property.dst &&
                        increment->opcode == MAL_OP_UNARY &&
                        increment->as.unary.op == MAL_UNARY_INCREMENT &&
                        increment->as.unary.src == index && increment->as.unary.dst == index &&
                        backedge->opcode == MAL_OP_JUMP &&
                        backedge->as.jump.target_ip == length_ip;
                    if (call_is_generic) {
                        structure_ok = structure_ok && call->as.call.dst == result &&
                            call->as.call.callee == callee &&
                            call->as.call.this_value == receiver &&
                            fn->instructions[property_ip].as.load_property_static.dst == callee &&
                            fn->instructions[property_ip].as.load_property_static.object == receiver;
                    } else {
                        structure_ok = structure_ok && call->as.call_builtin.dst == result &&
                            call->as.call_builtin.this_value == receiver;
                    }
                    (void) separator;
                    if (!structure_ok) r.ok = false;
                }
                if (property_ip >= 0) MAL_REGION_PAYLOAD_CLAIM(property_ip);
                MAL_REGION_PAYLOAD_CLAIM(call_ip);
                MAL_REGION_PAYLOAD_CLAIM(result_alias_ip);
                for (i32 ip = length_ip; r.ok && ip <= trim_call_ip; ip++) {
                    MAL_REGION_PAYLOAD_CLAIM(ip);
                }
                for (u32 load = 0; r.ok && load < primitive_length_count; load++) {
                    i32 ip = primitive_length_ips[load];
                    if (ip < 0 || ip >= fn->instruction_count ||
                        fn->instructions[ip].opcode != MAL_OP_LOAD_PROPERTY_STATIC) {
                        r.ok = false;
                        break;
                    }
                    MAL_REGION_PAYLOAD_CLAIM(ip);
                }
                MAL_REGION_PAYLOAD_CLAIM(backedge_ip - 1);
                MAL_REGION_PAYLOAD_CLAIM(backedge_ip);
                if (metadata_operations != payload_count) r.ok = false;
            } else if (r.ok && kind == 3) {
                u8 dispatch_tag = rd_u8(&r);
                i32 dispatch_primary_ip = rd_i32(&r);
                i32 dispatch_secondary_ip = rd_i32(&r);
                i32 callback_function = rd_i32(&r);
                i32 receiver = rd_i32(&r);
                (void) rd_u64(&r); // exact numeric initial accumulator
                u8 poll_policy = rd_u8(&r);
                i32 result_operand = rd_i32(&r);
                u32 operation_count = rd_count(&r, 2);
                i32 initial_ip = anchor_count > 0 ? anchors[0] : -1;
                i32 element_ip = anchor_count > 1 ? anchors[1] : -1;
                i32 backedge_ip = anchor_count > 2 ? anchors[2] : -1;
                i32 loop_exit_ip = anchor_count > 3 ? anchors[3] : -1;
#define MAL_HOF_IP_OPCODE(ip, op) \
                ((ip) >= 0 && (ip) < fn->instruction_count && \
                 fn->instructions[(ip)].opcode == (op))
                bool anchors_ok = anchor_count == 4 &&
                    MAL_HOF_IP_OPCODE(initial_ip, MAL_OP_MOVE) &&
                    MAL_HOF_IP_OPCODE(element_ip, MAL_OP_LOAD_PROPERTY) &&
                    MAL_HOF_IP_OPCODE(backedge_ip, MAL_OP_JUMP) &&
                    MAL_HOF_IP_OPCODE(loop_exit_ip, MAL_OP_JUMP);
                i32 completion_ip = anchors_ok
                    ? fn->instructions[loop_exit_ip].as.jump.target_ip
                    : -1;
                bool completion_ok = completion_ip >= 0 &&
                    completion_ip < fn->instruction_count;
                bool dispatch_ok =
                    (dispatch_tag == 1 &&
                     MAL_HOF_IP_OPCODE(dispatch_primary_ip, MAL_OP_CALL) &&
                     MAL_HOF_IP_OPCODE(dispatch_secondary_ip, MAL_OP_CALL)) ||
                    (dispatch_tag == 2 && dispatch_secondary_ip == -1 &&
                     dependency_mask == 1 &&
                     MAL_HOF_IP_OPCODE(dispatch_primary_ip, MAL_OP_CREATE_ARRAY) &&
                     fn->instructions[dispatch_primary_ip].as.create_array.dst == receiver &&
                     dispatch_primary_ip < initial_ip);
                if (!anchors_ok || !completion_ok || !dispatch_ok ||
                    callback_function < 0 || callback_function >= function_count ||
                    receiver < 0 || receiver >= fn->register_count ||
                    fn->instructions[element_ip].as.load_property.object != receiver ||
                    poll_policy != 1 || operation_count == 0 || operation_count > 32 ||
                    metadata_operations != claim_count) {
                    r.ok = false;
                }
#undef MAL_HOF_IP_OPCODE
                if (!(result_operand == -1 || result_operand == -2 ||
                      (result_operand >= 0 && (u32) result_operand < operation_count))) {
                    r.ok = false;
                }
                for (u32 operation = 0; r.ok && operation < operation_count; operation++) {
                    u8 tag = rd_u8(&r);
                    if (tag == 1) {
                        (void) rd_u64(&r);
                    } else if (tag == 2) {
                        u8 binary = rd_u8(&r);
                        i32 left = rd_i32(&r);
                        i32 right = rd_i32(&r);
                        bool left_ok = left == -1 || left == -2 ||
                            (left >= 0 && (u32) left < operation);
                        bool right_ok = right == -1 || right == -2 ||
                            (right >= 0 && (u32) right < operation);
                        if (binary >= 5 || !left_ok || !right_ok) r.ok = false;
                    } else if (tag == 3) {
                        u8 math = rd_u8(&r);
                        i32 value = rd_i32(&r);
                        bool value_ok = value == -1 || value == -2 ||
                            (value >= 0 && (u32) value < operation);
                        if (math >= 27 || !value_ok) r.ok = false;
                    } else {
                        r.ok = false;
                    }
                }
                if (r.ok) {
                    MAL_REGION_PAYLOAD_CLAIM(initial_ip);
                    MAL_REGION_PAYLOAD_CLAIM(element_ip);
                    MAL_REGION_PAYLOAD_CLAIM(backedge_ip);
                    MAL_REGION_PAYLOAD_CLAIM(loop_exit_ip);
                    MAL_REGION_PAYLOAD_CLAIM(dispatch_primary_ip);
                    if (dispatch_tag == 1) MAL_REGION_PAYLOAD_CLAIM(dispatch_secondary_ip);
                    // Numeric regions claim the complete canonical loop corridor, not
                    // only payload-bearing anchors. Bounds/uniqueness were checked by
                    // the common envelope above; known payload anchors were checked here.
                    payload_count = claim_count;
                }
            } else if (r.ok && kind == 4) {
                i32 property_ip = rd_i32(&r);
                i32 call_ip = rd_i32(&r);
                i32 callee = rd_i32(&r);
                i32 receiver = rd_i32(&r);
                i32 separator_string_index = rd_i32(&r);
                i32 result = rd_i32(&r);
                u32 alias_count = rd_count(&r, 1);
                if (alias_count > 94) r.ok = false;
                i32 alias_ips[94];
                for (u32 alias = 0; r.ok && alias < alias_count; alias++) {
                    alias_ips[alias] = rd_i32(&r);
                }
                u32 load_count = rd_count(&r, 4);
                if (load_count == 0 || load_count > 9) r.ok = false;
                i32 load_ips[9];
                u8 load_kinds[9];
                i32 load_indices[9];
                i32 load_dsts[9];
                for (u32 load = 0; r.ok && load < load_count; load++) {
                    load_ips[load] = rd_i32(&r);
                    load_kinds[load] = rd_u8(&r);
                    load_indices[load] = rd_i32(&r);
                    load_dsts[load] = rd_i32(&r);
                }
                bool call_ip_ok = call_ip >= 0 && call_ip < fn->instruction_count;
                bool generic = call_ip_ok && fn->instructions[call_ip].opcode == MAL_OP_CALL;
                bool direct = call_ip_ok &&
                    fn->instructions[call_ip].opcode == MAL_OP_CALL_BUILTIN;
                bool property_ok = property_ip >= 0 && property_ip < fn->instruction_count &&
                    fn->instructions[property_ip].opcode == MAL_OP_LOAD_PROPERTY_STATIC;
                bool header_ok = anchor_count == 2 && anchors[0] == call_ip &&
                    load_count > 0 && anchors[1] == load_ips[0] &&
                    (generic || direct) &&
                    separator_string_index >= 0 &&
                    separator_string_index < (i32) string_count &&
                    strings[separator_string_index].length > 0 &&
                    receiver >= 0 && receiver < fn->register_count &&
                    result >= 0 && result < fn->register_count;
                if (header_ok && generic) {
                    const MalInstruction *call = &fn->instructions[call_ip];
                    const MalInstruction *property = property_ok
                        ? &fn->instructions[property_ip]
                        : nullptr;
                    header_ok = property != nullptr && property_ip < call_ip &&
                        property->as.load_property_static.dst == callee &&
                        property->as.load_property_static.object == receiver &&
                        property->as.load_property_static.string_index >= 0 &&
                        property->as.load_property_static.string_index < (i32) string_count &&
                        strings[property->as.load_property_static.string_index].length == 5 &&
                        strings[property->as.load_property_static.string_index].code_units[0] == 's' &&
                        strings[property->as.load_property_static.string_index].code_units[1] == 'p' &&
                        strings[property->as.load_property_static.string_index].code_units[2] == 'l' &&
                        strings[property->as.load_property_static.string_index].code_units[3] == 'i' &&
                        strings[property->as.load_property_static.string_index].code_units[4] == 't' &&
                        call->as.call.dst == result && call->as.call.callee == callee &&
                        call->as.call.this_value == receiver;
                } else if (header_ok && direct) {
                    const MalInstruction *call = &fn->instructions[call_ip];
                    header_ok = dependency_mask == 1 && property_ip == -1 && callee == -1 &&
                        call->as.call_builtin.dst == result &&
                        call->as.call_builtin.this_value == receiver &&
                        call->as.call_builtin.operation == MAL_DIRECT_BUILTIN_STRING_SPLIT;
                }
                if (header_ok) {
                    const MalInstruction *call = &fn->instructions[call_ip];
                    i32 data_offset = generic
                        ? call->as.call.data_offset
                        : call->as.call_builtin.data_offset;
                    i32 separator_operand = data_offset >= 0 &&
                        data_offset + 1 < fn->instruction_data_count
                        ? fn->instruction_data[data_offset + 1]
                        : -1;
                    const MalInstruction *separator_definition = separator_operand >= 0 &&
                        separator_operand < fn->register_count
                        ? mal_loaded_latest_definition(fn, separator_operand, call_ip)
                        : nullptr;
                    bool separator_matches =
                        separator_operand ==
                            MAL_VALUE_OPERAND_STRING_BASE - separator_string_index ||
                        (separator_definition != nullptr &&
                         separator_definition->opcode == MAL_OP_CREATE_STRING &&
                         separator_definition->as.create_string.string_index ==
                            separator_string_index);
                    header_ok = data_offset >= 0 &&
                        data_offset + 1 < fn->instruction_data_count &&
                        fn->instruction_data[data_offset] == 1 && separator_matches;
                }
                if (!header_ok) r.ok = false;

                i32 aliases[95];
                u32 aliases_seen = 1;
                aliases[0] = result;
                for (u32 alias = 0; r.ok && alias < alias_count; alias++) {
                    i32 ip = alias_ips[alias];
                    if (ip <= call_ip || ip >= fn->instruction_count ||
                        (alias > 0 && alias_ips[alias - 1] >= ip) ||
                        fn->instructions[ip].opcode != MAL_OP_MOVE) {
                        r.ok = false;
                        break;
                    }
                    const MalInstruction *move = &fn->instructions[ip];
                    bool source_found = false;
                    for (u32 previous = 0; previous < aliases_seen; previous++) {
                        i32 definition_ip = previous == 0
                            ? call_ip
                            : alias_ips[previous - 1];
                        if (aliases[previous] == move->as.move.src &&
                            mal_loaded_latest_definition(fn, move->as.move.src, ip) ==
                                &fn->instructions[definition_ip]) {
                            source_found = true;
                        }
                    }
                    if (!source_found) {
                        r.ok = false;
                        break;
                    }
                    aliases[aliases_seen++] = move->as.move.dst;
                }
                u32 element_count = 0;
                u32 length_count = 0;
                for (u32 load = 0; r.ok && load < load_count; load++) {
                    i32 ip = load_ips[load];
                    bool object_found = false;
                    if (ip <= call_ip || ip >= fn->instruction_count ||
                        (load > 0 && load_ips[load - 1] >= ip) ||
                        load_dsts[load] < 0 || load_dsts[load] >= fn->register_count) {
                        r.ok = false;
                        break;
                    }
                    const MalInstruction *instruction = &fn->instructions[ip];
                    i32 object = instruction->opcode == MAL_OP_LOAD_PROPERTY
                        ? instruction->as.load_property.object
                        : instruction->opcode == MAL_OP_LOAD_PROPERTY_STATIC
                            ? instruction->as.load_property_static.object
                            : -1;
                    for (u32 alias = 0; alias < aliases_seen; alias++) {
                        i32 definition_ip = alias == 0 ? call_ip : alias_ips[alias - 1];
                        const MalInstruction *latest = object >= 0
                            ? mal_loaded_latest_definition(fn, object, ip)
                            : nullptr;
                        if (aliases[alias] == object && definition_ip < ip &&
                            latest == &fn->instructions[definition_ip]) {
                            object_found = true;
                        }
                    }
                    if (load_kinds[load] == 1) {
                        element_count++;
                        const MalInstruction *key_definition =
                            instruction->opcode == MAL_OP_LOAD_PROPERTY
                            ? mal_loaded_latest_definition(
                                fn, instruction->as.load_property.key, ip)
                            : nullptr;
                        bool duplicate_index = false;
                        for (u32 previous = 0; previous < load; previous++) {
                            if (load_kinds[previous] == 1 &&
                                load_indices[previous] == load_indices[load]) {
                                duplicate_index = true;
                            }
                        }
                        if (instruction->opcode != MAL_OP_LOAD_PROPERTY || !object_found ||
                            instruction->as.load_property.dst != load_dsts[load] ||
                            load_indices[load] < 0 || load_indices[load] > 65535 ||
                            duplicate_index || key_definition == nullptr ||
                            key_definition->opcode != MAL_OP_CREATE_NUMBER ||
                            key_definition->as.create_number.value != load_indices[load]) {
                            r.ok = false;
                        }
                    } else if (load_kinds[load] == 2) {
                        length_count++;
                        i32 string_index = instruction->opcode == MAL_OP_LOAD_PROPERTY_STATIC
                            ? instruction->as.load_property_static.string_index
                            : -1;
                        if (instruction->opcode != MAL_OP_LOAD_PROPERTY_STATIC || !object_found ||
                            instruction->as.load_property_static.dst != load_dsts[load] ||
                            load_indices[load] != -1 || string_index < 0 ||
                            string_index >= (i32) string_count || strings[string_index].length != 6 ||
                            strings[string_index].code_units[0] != 'l' ||
                            strings[string_index].code_units[1] != 'e' ||
                            strings[string_index].code_units[2] != 'n' ||
                            strings[string_index].code_units[3] != 'g' ||
                            strings[string_index].code_units[4] != 't' ||
                            strings[string_index].code_units[5] != 'h') {
                            r.ok = false;
                        }
                    } else {
                        r.ok = false;
                    }
                }
                if (element_count == 0 || element_count > 8 || length_count > 1 ||
                    metadata_operations != 1 + (property_ip >= 0 ? 1 : 0) +
                        alias_count + load_count) {
                    r.ok = false;
                }
                if (property_ip >= 0) MAL_REGION_PAYLOAD_CLAIM(property_ip);
                MAL_REGION_PAYLOAD_CLAIM(call_ip);
                for (u32 alias = 0; r.ok && alias < alias_count; alias++) {
                    MAL_REGION_PAYLOAD_CLAIM(alias_ips[alias]);
                }
                for (u32 load = 0; r.ok && load < load_count; load++) {
                    MAL_REGION_PAYLOAD_CLAIM(load_ips[load]);
                }
            } else if (r.ok && kind == 5) {
                i32 property_ip = rd_i32(&r);
                i32 call_ip = rd_i32(&r);
                u8 locked = rd_u8(&r);
                i32 constructor_intrinsic_ip = rd_i32(&r);
                i32 construct_ip = rd_i32(&r);
                i32 callee = rd_i32(&r);
                i32 receiver = rd_i32(&r);
                i32 input = rd_i32(&r);
                i32 result = rd_i32(&r);
                u32 alias_count = rd_count(&r, 1);
                if (alias_count == 0 || alias_count > 94) r.ok = false;
                i32 alias_ips[94];
                for (u32 alias = 0; r.ok && alias < alias_count; alias++) {
                    alias_ips[alias] = rd_i32(&r);
                }
                u32 null_count = rd_count(&r, 5);
                if (null_count > 47) r.ok = false;
                i32 comparison_ips[47];
                i32 null_ips[47];
                for (u32 check = 0; r.ok && check < null_count; check++) {
                    comparison_ips[check] = rd_i32(&r);
                    null_ips[check] = rd_i32(&r);
                }
                u8 last_index_effect = rd_u8(&r);
                u32 load_count = rd_count(&r, 4);
                if (load_count == 0 || load_count > 8) r.ok = false;
                i32 load_ips[8];
                i32 key_ips[8];
                i32 capture_indices[8];
                i32 load_dsts[8];
                u8 consumer_tags[8];
                i32 consumer_ips[8][7];
                i32 consumer_move_ips[8][64];
                u32 consumer_move_counts[8];
                memset(consumer_ips, 0xff, sizeof(consumer_ips));
                memset(consumer_move_counts, 0, sizeof(consumer_move_counts));
                for (u32 load = 0; r.ok && load < load_count; load++) {
                    load_ips[load] = rd_i32(&r);
                    key_ips[load] = rd_i32(&r);
                    capture_indices[load] = rd_i32(&r);
                    load_dsts[load] = rd_i32(&r);
                    consumer_tags[load] = rd_u8(&r);
                    if (consumer_tags[load] == 1) {
                        consumer_ips[load][0] = rd_i32(&r);
                    } else if (consumer_tags[load] == 2) {
                        consumer_ips[load][0] = rd_i32(&r);
                        consumer_ips[load][1] = rd_i32(&r);
                        consumer_ips[load][2] = rd_i32(&r);
                    } else if (consumer_tags[load] == 3) {
                        consumer_ips[load][0] = rd_i32(&r);
                        consumer_ips[load][1] = rd_i32(&r);
                    } else if (consumer_tags[load] == 4) {
                        consumer_ips[load][0] = rd_i32(&r);
                        consumer_ips[load][1] = rd_i32(&r);
                        consumer_ips[load][2] = rd_i32(&r);
                        consumer_ips[load][3] = rd_i32(&r);
                        consumer_ips[load][4] = rd_i32(&r);
                        consumer_move_counts[load] = rd_count(&r, 1);
                        if (consumer_move_counts[load] > 64) r.ok = false;
                        for (u32 move = 0; r.ok && move < consumer_move_counts[load]; move++) {
                            consumer_move_ips[load][move] = rd_i32(&r);
                        }
                        consumer_ips[load][5] = rd_i32(&r);
                    } else if (consumer_tags[load] != 0) {
                        r.ok = false;
                    }
                }

                bool property_ok = property_ip >= 0 && property_ip < fn->instruction_count &&
                    fn->instructions[property_ip].opcode == MAL_OP_LOAD_PROPERTY_STATIC;
                bool call_ok = call_ip >= 0 && call_ip < fn->instruction_count &&
                    fn->instructions[call_ip].opcode == MAL_OP_CALL;
                bool header_ok = anchor_count == 3 && anchors[0] == call_ip &&
                    anchors[1] == (alias_count > 0 ? alias_ips[0] : -1) &&
                    anchors[2] == (load_count > 0 ? load_ips[0] : -1) &&
                    property_ok && call_ok && property_ip + 1 == call_ip &&
                    locked <= 1 && last_index_effect == 1;
                if (header_ok) {
                    const MalInstruction *property = &fn->instructions[property_ip];
                    const MalInstruction *call = &fn->instructions[call_ip];
                    i32 data_offset = call->as.call.data_offset;
                    bool exec_name = property->as.load_property_static.string_index >= 0 &&
                        property->as.load_property_static.string_index < (i32) string_count;
                    if (exec_name) {
                        const MalString *name = &strings[property->as.load_property_static.string_index];
                        exec_name = name->length == 4 && name->code_units[0] == 'e' &&
                            name->code_units[1] == 'x' && name->code_units[2] == 'e' &&
                            name->code_units[3] == 'c';
                    }
                    header_ok = exec_name && call->as.call.dst == result &&
                        call->as.call.callee == callee && call->as.call.this_value == receiver &&
                        property->as.load_property_static.dst == callee &&
                        property->as.load_property_static.object == receiver &&
                        data_offset >= 0 && data_offset + 1 < fn->instruction_data_count &&
                        fn->instruction_data[data_offset] == 1 &&
                        fn->instruction_data[data_offset + 1] == input;
                }
                if (locked == 0) {
                    if (constructor_intrinsic_ip != -1 || construct_ip != -1) header_ok = false;
                } else {
                    if (dependency_mask != 1 || constructor_intrinsic_ip < 0 ||
                        constructor_intrinsic_ip >= fn->instruction_count || construct_ip < 0 ||
                        construct_ip >= fn->instruction_count ||
                        fn->instructions[constructor_intrinsic_ip].opcode != MAL_OP_LOAD_INTRINSIC ||
                        fn->instructions[construct_ip].opcode != MAL_OP_CONSTRUCT ||
                        fn->instructions[construct_ip].as.construct.dst != receiver) {
                        header_ok = false;
                    }
                }
                if (!header_ok) r.ok = false;

                i32 aliases[95];
                u32 aliases_seen = 1;
                aliases[0] = result;
                for (u32 alias = 0; r.ok && alias < alias_count; alias++) {
                    i32 ip = alias_ips[alias];
                    if (ip < 0 || ip >= fn->instruction_count ||
                        fn->instructions[ip].opcode != MAL_OP_MOVE) {
                        r.ok = false;
                        break;
                    }
                    bool source_found = false;
                    for (u32 previous = 0; previous < aliases_seen; previous++) {
                        if (aliases[previous] == fn->instructions[ip].as.move.src) {
                            source_found = true;
                        }
                    }
                    if (!source_found) {
                        r.ok = false;
                        break;
                    }
                    aliases[aliases_seen++] = fn->instructions[ip].as.move.dst;
                }
                for (u32 check = 0; r.ok && check < null_count; check++) {
                    i32 comparison_ip = comparison_ips[check];
                    i32 null_ip = null_ips[check];
                    if (comparison_ip < 0 || comparison_ip >= fn->instruction_count ||
                        null_ip < 0 || null_ip >= fn->instruction_count ||
                        fn->instructions[comparison_ip].opcode != MAL_OP_BINARY ||
                        (fn->instructions[comparison_ip].as.binary.op != MAL_BIN_STRICT_EQ &&
                         fn->instructions[comparison_ip].as.binary.op != MAL_BIN_STRICT_NEQ) ||
                        fn->instructions[null_ip].opcode != MAL_OP_CREATE_NULL) {
                        r.ok = false;
                    }
                }
                for (u32 load = 0; r.ok && load < load_count; load++) {
                    i32 ip = load_ips[load];
                    i32 key_ip = key_ips[load];
                    bool object_found = false;
                    if (ip < 0 || ip >= fn->instruction_count || key_ip < 0 ||
                        key_ip >= fn->instruction_count ||
                        fn->instructions[ip].opcode != MAL_OP_LOAD_PROPERTY ||
                        fn->instructions[key_ip].opcode != MAL_OP_CREATE_NUMBER) {
                        r.ok = false;
                        break;
                    }
                    const MalInstruction *capture = &fn->instructions[ip];
                    const MalInstruction *key = &fn->instructions[key_ip];
                    for (u32 alias = 0; alias < aliases_seen; alias++) {
                        if (aliases[alias] == capture->as.load_property.object) object_found = true;
                    }
                    bool duplicate = false;
                    for (u32 previous = 0; previous < load; previous++) {
                        if (capture_indices[previous] == capture_indices[load]) duplicate = true;
                    }
                    if (!object_found || capture->as.load_property.dst != load_dsts[load] ||
                        capture->as.load_property.key != key->as.create_number.dst ||
                        key->as.create_number.value != capture_indices[load] ||
                        capture_indices[load] <= 0 || capture_indices[load] > 65535 || duplicate) {
                        r.ok = false;
                    }
                    u8 tag = consumer_tags[load];
                    if (tag == 1) {
                        i32 consumer_ip = consumer_ips[load][0];
                        if (consumer_ip < 0 || consumer_ip >= fn->instruction_count ||
                            fn->instructions[consumer_ip].opcode != MAL_OP_LOAD_PROPERTY_STATIC ||
                            fn->instructions[consumer_ip].as.load_property_static.object !=
                                load_dsts[load]) r.ok = false;
                    } else if (tag == 2) {
                        i32 property = consumer_ips[load][0];
                        i32 call = consumer_ips[load][1];
                        i32 zero = consumer_ips[load][2];
                        if (property < 0 || property >= fn->instruction_count || call < 0 ||
                            call >= fn->instruction_count ||
                            fn->instructions[property].opcode != MAL_OP_LOAD_PROPERTY_STATIC ||
                            fn->instructions[call].opcode != MAL_OP_CALL ||
                            (zero >= 0 && (zero >= fn->instruction_count ||
                             fn->instructions[zero].opcode != MAL_OP_CREATE_NUMBER))) r.ok = false;
                    } else if (tag == 3) {
                        i32 intrinsic = consumer_ips[load][0];
                        i32 call = consumer_ips[load][1];
                        if (intrinsic < 0 || intrinsic >= fn->instruction_count || call < 0 ||
                            call >= fn->instruction_count ||
                            fn->instructions[intrinsic].opcode != MAL_OP_LOAD_INTRINSIC ||
                            fn->instructions[call].opcode != MAL_OP_CALL) r.ok = false;
                    } else if (tag == 4) {
                        for (u32 consumer = 0; r.ok && consumer < 6; consumer++) {
                            i32 consumer_ip = consumer_ips[load][consumer];
                            if (consumer_ip < 0 || consumer_ip >= fn->instruction_count) r.ok = false;
                        }
                        if (r.ok &&
                            (fn->instructions[consumer_ips[load][0]].opcode != MAL_OP_LOAD_PROPERTY_STATIC ||
                             fn->instructions[consumer_ips[load][1]].opcode != MAL_OP_CALL ||
                             fn->instructions[consumer_ips[load][2]].opcode != MAL_OP_LOAD_PROPERTY_STATIC ||
                             fn->instructions[consumer_ips[load][4]].opcode != MAL_OP_CALL ||
                             fn->instructions[consumer_ips[load][5]].opcode != MAL_OP_LOAD_PROPERTY_STATIC ||
                             consumer_ips[load][3] < 0 ||
                             consumer_ips[load][3] >= fn->property_ic_count)) r.ok = false;
                        for (u32 move = 0; r.ok && move < consumer_move_counts[load]; move++) {
                            i32 move_ip = consumer_move_ips[load][move];
                            if (move_ip < 0 || move_ip >= fn->instruction_count ||
                                fn->instructions[move_ip].opcode != MAL_OP_MOVE) r.ok = false;
                        }
                    }
                }

                MAL_REGION_PAYLOAD_REFERENCE(property_ip);
                MAL_REGION_PAYLOAD_REFERENCE(call_ip);
                for (u32 alias = 0; r.ok && alias < alias_count; alias++) {
                    MAL_REGION_PAYLOAD_REFERENCE(alias_ips[alias]);
                }
                for (u32 check = 0; r.ok && check < null_count; check++) {
                    MAL_REGION_PAYLOAD_REFERENCE(comparison_ips[check]);
                    MAL_REGION_PAYLOAD_REFERENCE(null_ips[check]);
                }
                if (locked == 1) {
                    MAL_REGION_PAYLOAD_REFERENCE(constructor_intrinsic_ip);
                    MAL_REGION_PAYLOAD_REFERENCE(construct_ip);
                }
                for (u32 load = 0; r.ok && load < load_count; load++) {
                    MAL_REGION_PAYLOAD_REFERENCE(load_ips[load]);
                    MAL_REGION_PAYLOAD_REFERENCE(key_ips[load]);
                    u8 tag = consumer_tags[load];
                    if (tag == 1) {
                        MAL_REGION_PAYLOAD_REFERENCE(consumer_ips[load][0]);
                    } else if (tag == 2) {
                        MAL_REGION_PAYLOAD_REFERENCE(consumer_ips[load][0]);
                        MAL_REGION_PAYLOAD_REFERENCE(consumer_ips[load][1]);
                        if (consumer_ips[load][2] >= 0) {
                            MAL_REGION_PAYLOAD_REFERENCE(consumer_ips[load][2]);
                        }
                    } else if (tag == 3) {
                        MAL_REGION_PAYLOAD_REFERENCE(consumer_ips[load][0]);
                        MAL_REGION_PAYLOAD_REFERENCE(consumer_ips[load][1]);
                    } else if (tag == 4) {
                        MAL_REGION_PAYLOAD_REFERENCE(consumer_ips[load][0]);
                        MAL_REGION_PAYLOAD_REFERENCE(consumer_ips[load][1]);
                        MAL_REGION_PAYLOAD_REFERENCE(consumer_ips[load][2]);
                        MAL_REGION_PAYLOAD_REFERENCE(consumer_ips[load][4]);
                        for (u32 move = 0; r.ok && move < consumer_move_counts[load]; move++) {
                            MAL_REGION_PAYLOAD_REFERENCE(consumer_move_ips[load][move]);
                        }
                        MAL_REGION_PAYLOAD_REFERENCE(consumer_ips[load][5]);
                    }
                }
                if (metadata_operations != payload_count) r.ok = false;
            } else if (r.ok && kind == 6) {
                i32 step_ip = rd_i32(&r);
                i32 done_branch_ip = rd_i32(&r);
                i32 exit_ip = rd_i32(&r);
                i32 iterator = rd_i32(&r);
                i32 next = rd_i32(&r);
                i32 value = rd_i32(&r);
                i32 done = rd_i32(&r);
                u32 alias_count = rd_count(&r, 1);
                if (alias_count > 94) r.ok = false;
                i32 alias_ips[94];
                for (u32 alias = 0; r.ok && alias < alias_count; alias++) {
                    alias_ips[alias] = rd_i32(&r);
                }
                u8 stateful_effect = rd_u8(&r);
                u8 runtime_guard = rd_u8(&r);
                u32 load_count = rd_count(&r, 4);
                if (load_count == 0 || load_count > 8) r.ok = false;
                i32 load_ips[8];
                i32 key_ips[8];
                i32 capture_indices[8];
                i32 load_dsts[8];
                i32 intrinsic_ips[8];
                i32 number_call_ips[8];
                for (u32 load = 0; r.ok && load < load_count; load++) {
                    load_ips[load] = rd_i32(&r);
                    key_ips[load] = rd_i32(&r);
                    capture_indices[load] = rd_i32(&r);
                    load_dsts[load] = rd_i32(&r);
                    intrinsic_ips[load] = rd_i32(&r);
                    number_call_ips[load] = rd_i32(&r);
                }
                bool header_ok = anchor_count == 3 && anchors[0] == step_ip &&
                    anchors[1] == done_branch_ip &&
                    anchors[2] == (load_count > 0 ? load_ips[0] : -1) &&
                    step_ip >= 0 && step_ip < fn->instruction_count &&
                    done_branch_ip == step_ip + 1 &&
                    done_branch_ip < fn->instruction_count && exit_ip >= 0 &&
                    exit_ip < fn->instruction_count &&
                    fn->instructions[step_ip].opcode == MAL_OP_ITERATOR_STEP &&
                    fn->instructions[done_branch_ip].opcode == MAL_OP_JUMP_IF &&
                    fn->instructions[step_ip].as.iterator_step.iterator == iterator &&
                    fn->instructions[step_ip].as.iterator_step.next == next &&
                    fn->instructions[step_ip].as.iterator_step.value_dst == value &&
                    fn->instructions[step_ip].as.iterator_step.done_dst == done &&
                    fn->instructions[done_branch_ip].as.jump_if.cond == done &&
                    fn->instructions[done_branch_ip].as.jump_if.target_ip == exit_ip &&
                    stateful_effect == 1 && runtime_guard == 1 &&
                    exceptional_handler_count > 0;
                if (!header_ok) r.ok = false;

                i32 aliases[95];
                u32 aliases_seen = 1;
                aliases[0] = value;
                for (u32 alias = 0; r.ok && alias < alias_count; alias++) {
                    i32 ip = alias_ips[alias];
                    if (ip < 0 || ip >= fn->instruction_count ||
                        fn->instructions[ip].opcode != MAL_OP_MOVE) {
                        r.ok = false;
                        break;
                    }
                    bool source_found = false;
                    for (u32 previous = 0; previous < aliases_seen; previous++) {
                        if (aliases[previous] == fn->instructions[ip].as.move.src) {
                            source_found = true;
                        }
                    }
                    if (!source_found) {
                        r.ok = false;
                        break;
                    }
                    aliases[aliases_seen++] = fn->instructions[ip].as.move.dst;
                }
                for (u32 load = 0; r.ok && load < load_count; load++) {
                    i32 ip = load_ips[load];
                    i32 key_ip = key_ips[load];
                    i32 intrinsic_ip = intrinsic_ips[load];
                    i32 number_call_ip = number_call_ips[load];
                    if (ip < 0 || ip >= fn->instruction_count || key_ip < 0 ||
                        key_ip >= fn->instruction_count || intrinsic_ip < 0 ||
                        intrinsic_ip >= fn->instruction_count || number_call_ip < 0 ||
                        number_call_ip >= fn->instruction_count ||
                        fn->instructions[ip].opcode != MAL_OP_LOAD_PROPERTY ||
                        fn->instructions[key_ip].opcode != MAL_OP_CREATE_NUMBER ||
                        fn->instructions[intrinsic_ip].opcode != MAL_OP_LOAD_INTRINSIC ||
                        fn->instructions[number_call_ip].opcode != MAL_OP_CALL) {
                        r.ok = false;
                        break;
                    }
                    const MalInstruction *capture = &fn->instructions[ip];
                    const MalInstruction *key = &fn->instructions[key_ip];
                    const MalInstruction *intrinsic = &fn->instructions[intrinsic_ip];
                    const MalInstruction *number_call = &fn->instructions[number_call_ip];
                    bool object_found = false;
                    for (u32 alias = 0; alias < aliases_seen; alias++) {
                        if (aliases[alias] == capture->as.load_property.object) object_found = true;
                    }
                    bool duplicate = false;
                    for (u32 previous = 0; previous < load; previous++) {
                        if (capture_indices[previous] == capture_indices[load]) duplicate = true;
                    }
                    i32 data_offset = number_call->as.call.data_offset;
                    if (!object_found || capture->as.load_property.dst != load_dsts[load] ||
                        capture->as.load_property.key != key->as.create_number.dst ||
                        key->as.create_number.value != capture_indices[load] ||
                        capture_indices[load] <= 0 || capture_indices[load] > 65535 || duplicate ||
                        number_call->as.call.callee != intrinsic->as.load_intrinsic.dst ||
                        data_offset < 0 || data_offset + 1 >= fn->instruction_data_count ||
                        fn->instruction_data[data_offset] != 1 ||
                        fn->instruction_data[data_offset + 1] != load_dsts[load]) {
                        r.ok = false;
                    }
                }
                for (u32 claim = 0; r.ok && claim < claim_count; claim++) {
                    for (i32 handler = 0; handler < fn->handler_count; handler++) {
                        const MalExceptionHandler *candidate = &fn->handlers[handler];
                        if (claims[claim] >= candidate->start_ip &&
                            claims[claim] < candidate->end_ip) {
                            bool declared = false;
                            for (u32 declared_handler = 0;
                                 declared_handler < exceptional_handler_count;
                                 declared_handler++) {
                                if (exceptional_handler_ips[declared_handler] ==
                                    candidate->handler_ip) declared = true;
                            }
                            if (!declared) r.ok = false;
                        }
                    }
                }
                for (u32 declared_handler = 0; r.ok &&
                     declared_handler < exceptional_handler_count; declared_handler++) {
                    bool covers_claim = false;
                    for (i32 handler = 0; handler < fn->handler_count; handler++) {
                        const MalExceptionHandler *candidate = &fn->handlers[handler];
                        if (candidate->handler_ip !=
                            exceptional_handler_ips[declared_handler]) continue;
                        for (u32 claim = 0; claim < claim_count; claim++) {
                            if (claims[claim] >= candidate->start_ip &&
                                claims[claim] < candidate->end_ip) covers_claim = true;
                        }
                    }
                    if (!covers_claim) r.ok = false;
                }

                MAL_REGION_PAYLOAD_REFERENCE(step_ip);
                MAL_REGION_PAYLOAD_REFERENCE(done_branch_ip);
                for (u32 alias = 0; r.ok && alias < alias_count; alias++) {
                    MAL_REGION_PAYLOAD_REFERENCE(alias_ips[alias]);
                }
                for (u32 load = 0; r.ok && load < load_count; load++) {
                    MAL_REGION_PAYLOAD_REFERENCE(load_ips[load]);
                    MAL_REGION_PAYLOAD_REFERENCE(key_ips[load]);
                    MAL_REGION_PAYLOAD_REFERENCE(intrinsic_ips[load]);
                    MAL_REGION_PAYLOAD_REFERENCE(number_call_ips[load]);
                }
                if (metadata_operations != payload_count) r.ok = false;
            } else if (r.ok && kind == 7) {
                i32 property_ip = rd_i32(&r);
                i32 slice_call_ip = rd_i32(&r);
                i32 number_intrinsic_ip = rd_i32(&r);
                i32 number_call_ip = rd_i32(&r);
                i32 number_callee = rd_i32(&r);
                i32 receiver = rd_i32(&r);
                (void) rd_u64(&r); // exact finite slice start, validated by the TS codec
                i32 result = rd_i32(&r);
                bool header_ok = anchor_count == 2 && anchors[0] == slice_call_ip &&
                    anchors[1] == number_call_ip && property_ip >= 0 &&
                    property_ip < fn->instruction_count && slice_call_ip == property_ip + 1 &&
                    number_call_ip == slice_call_ip + 1 &&
                    number_call_ip < fn->instruction_count && number_intrinsic_ip >= 0 &&
                    number_intrinsic_ip < fn->instruction_count &&
                    fn->instructions[property_ip].opcode == MAL_OP_LOAD_PROPERTY_STATIC &&
                    fn->instructions[slice_call_ip].opcode == MAL_OP_CALL &&
                    fn->instructions[number_intrinsic_ip].opcode == MAL_OP_LOAD_INTRINSIC &&
                    fn->instructions[number_intrinsic_ip].as.load_intrinsic.intrinsic ==
                        MAL_INTRINSIC_NUMBER_CONSTRUCTOR &&
                    fn->instructions[number_call_ip].opcode == MAL_OP_CALL;
                if (header_ok) {
                    const MalInstruction *property = &fn->instructions[property_ip];
                    const MalInstruction *slice_call = &fn->instructions[slice_call_ip];
                    const MalInstruction *number_intrinsic =
                        &fn->instructions[number_intrinsic_ip];
                    const MalInstruction *number_call = &fn->instructions[number_call_ip];
                    i32 slice_data = slice_call->as.call.data_offset;
                    i32 number_data = number_call->as.call.data_offset;
                    bool slice_name = property->as.load_property_static.string_index >= 0 &&
                        property->as.load_property_static.string_index < (i32) string_count;
                    if (slice_name) {
                        const MalString *name =
                            &strings[property->as.load_property_static.string_index];
                        slice_name = name->length == 5 && name->code_units[0] == 's' &&
                            name->code_units[1] == 'l' && name->code_units[2] == 'i' &&
                            name->code_units[3] == 'c' && name->code_units[4] == 'e';
                    }
                    header_ok = slice_name && property->as.load_property_static.dst ==
                            slice_call->as.call.callee &&
                        property->as.load_property_static.object == receiver &&
                        slice_call->as.call.this_value == receiver && slice_data >= 0 &&
                        slice_data + 1 < fn->instruction_data_count &&
                        fn->instruction_data[slice_data] == 1 &&
                        number_intrinsic->as.load_intrinsic.dst == number_callee &&
                        number_call->as.call.callee == number_callee && number_data >= 0 &&
                        number_data + 1 < fn->instruction_data_count &&
                        fn->instruction_data[number_data] == 1 &&
                        fn->instruction_data[number_data + 1] == slice_call->as.call.dst &&
                        number_call->as.call.dst == result;
                }
                if (!header_ok || metadata_operations != 4 || claim_count != 4) r.ok = false;

                for (u32 claim = 0; r.ok && claim < claim_count; claim++) {
                    for (i32 handler = 0; handler < fn->handler_count; handler++) {
                        const MalExceptionHandler *candidate = &fn->handlers[handler];
                        if (claims[claim] >= candidate->start_ip &&
                            claims[claim] < candidate->end_ip) {
                            bool declared = false;
                            for (u32 declared_handler = 0;
                                 declared_handler < exceptional_handler_count;
                                 declared_handler++) {
                                if (exceptional_handler_ips[declared_handler] ==
                                    candidate->handler_ip) declared = true;
                            }
                            if (!declared) r.ok = false;
                        }
                    }
                }
                for (u32 declared_handler = 0; r.ok &&
                     declared_handler < exceptional_handler_count; declared_handler++) {
                    bool covers_claim = false;
                    for (i32 handler = 0; handler < fn->handler_count; handler++) {
                        const MalExceptionHandler *candidate = &fn->handlers[handler];
                        if (candidate->handler_ip !=
                            exceptional_handler_ips[declared_handler]) continue;
                        for (u32 claim = 0; claim < claim_count; claim++) {
                            if (claims[claim] >= candidate->start_ip &&
                                claims[claim] < candidate->end_ip) covers_claim = true;
                        }
                    }
                    if (!covers_claim) r.ok = false;
                }

                MAL_REGION_PAYLOAD_REFERENCE(property_ip);
                MAL_REGION_PAYLOAD_REFERENCE(slice_call_ip);
                MAL_REGION_PAYLOAD_REFERENCE(number_intrinsic_ip);
                MAL_REGION_PAYLOAD_REFERENCE(number_call_ip);
            } else if (r.ok && kind == 8) {
                i32 entry_ip = rd_i32(&r);
                i32 exit_ip = rd_i32(&r);
                i32 input = rd_i32(&r);
                i32 length_load_ip = rd_i32(&r);
                i32 length_result = rd_i32(&r);
                i32 match_result = rd_i32(&r);
                i32 match_code_unit = rd_i32(&r);
                bool header_ok = anchor_count == 2 && anchors[0] == entry_ip &&
                    anchors[1] == length_load_ip && entry_ip >= 0 &&
                    exit_ip > entry_ip && exit_ip <= fn->instruction_count &&
                    length_load_ip >= exit_ip && length_load_ip < fn->instruction_count &&
                    input >= 0 && input < fn->register_count && length_result >= 0 &&
                    length_result < fn->register_count && match_result >= 0 &&
                    match_result < fn->register_count && match_code_unit >= 0 &&
                    match_code_unit <= 65535 &&
                    fn->instructions[entry_ip].opcode == MAL_OP_CREATE_ARRAY &&
                    fn->instructions[entry_ip].as.create_array.length == 0 &&
                    fn->instructions[length_load_ip].opcode == MAL_OP_LOAD_PROPERTY_STATIC &&
                    fn->instructions[length_load_ip].as.load_property_static.dst ==
                        length_result && exceptional_handler_count == 0;
                bool entry_is_block = false;
                for (u32 block = 0; block < ordinary_block_count; block++) {
                    if (ordinary_block_ips[block] == entry_ip) entry_is_block = true;
                }
                if (!entry_is_block) header_ok = false;
                if (header_ok) {
                    i32 name_index =
                        fn->instructions[length_load_ip].as.load_property_static.string_index;
                    bool length_name = name_index >= 0 && name_index < (i32) string_count;
                    if (length_name) {
                        const MalString *name = &strings[name_index];
                        length_name = name->length == 6 && name->code_units[0] == 'l' &&
                            name->code_units[1] == 'e' && name->code_units[2] == 'n' &&
                            name->code_units[3] == 'g' && name->code_units[4] == 't' &&
                            name->code_units[5] == 'h';
                    }
                    if (!length_name) header_ok = false;
                }
                bool exit_jump = false;
                for (i32 ip = entry_ip; header_ok && ip < exit_ip; ip++) {
                    MalOpcode opcode = fn->instructions[ip].opcode;
                    bool allowed = opcode == MAL_OP_CREATE_ARRAY || opcode == MAL_OP_MOVE ||
                        opcode == MAL_OP_CREATE_NUMBER || opcode == MAL_OP_JUMP ||
                        opcode == MAL_OP_LOAD_PROPERTY_STATIC || opcode == MAL_OP_BINARY ||
                        opcode == MAL_OP_JUMP_IF || opcode == MAL_OP_CALL ||
                        opcode == MAL_OP_CREATE_STRING ||
                        opcode == MAL_OP_CREATE_OBJECT_SHAPED || opcode == MAL_OP_UNARY;
                    if (!allowed) header_ok = false;
                    if (opcode == MAL_OP_JUMP &&
                        fn->instructions[ip].as.jump.target_ip == exit_ip) exit_jump = true;
                }
                i32 span_count = exit_ip - entry_ip;
                if (!header_ok || !exit_jump || span_count <= 0 ||
                    claim_count != (u32) span_count + 1 ||
                    metadata_operations != claim_count) r.ok = false;
                for (i32 ip = entry_ip; r.ok && ip < exit_ip; ip++) {
                    MAL_REGION_PAYLOAD_REFERENCE(ip);
                }
                MAL_REGION_PAYLOAD_REFERENCE(length_load_ip);
            } else if (r.ok && kind == 9) {
                i32 allocation_ip = rd_i32(&r);
                u32 push_count = rd_count(&r, 1);
                if (push_count == 0 || push_count > 94) r.ok = false;
                i32 push_ips[94];
                for (u32 push = 0; r.ok && push < push_count; push++) {
                    push_ips[push] = rd_i32(&r);
                }
                i32 call_ip = rd_i32(&r);
                i32 target_function_index = rd_i32(&r);
                i32 callee = rd_i32(&r);
                i32 input = rd_i32(&r);
                i32 result = rd_i32(&r);
                bool header_ok = anchor_count == 2 && anchors[0] == allocation_ip &&
                    anchors[1] == call_ip && allocation_ip >= 0 &&
                    allocation_ip < call_ip && call_ip < fn->instruction_count &&
                    target_function_index >= 0 &&
                    target_function_index < (i32) function_count && callee >= 0 &&
                    callee < fn->register_count && input >= 0 &&
                    input < fn->register_count && result >= 0 &&
                    result < fn->register_count &&
                    fn->instructions[allocation_ip].opcode == MAL_OP_CREATE_ARRAY &&
                    fn->instructions[allocation_ip].as.create_array.length == 0 &&
                    fn->instructions[call_ip].opcode == MAL_OP_CALL &&
                    fn->instructions[call_ip].as.call.dst == result &&
                    fn->instructions[call_ip].as.call.callee == callee &&
                    fn->instructions[call_ip].as.call.this_value ==
                        MAL_VALUE_OPERAND_UNDEFINED && exceptional_handler_count == 0;
                if (header_ok) {
                    i32 data = fn->instructions[call_ip].as.call.data_offset;
                    header_ok = data >= 0 && data + 1 < fn->instruction_data_count &&
                        fn->instruction_data[data] == 1 &&
                        fn->instruction_data[data + 1] == input;
                }
                bool allocation_block = false;
                bool call_block = false;
                for (u32 block = 0; block < ordinary_block_count; block++) {
                    if (ordinary_block_ips[block] == allocation_ip) allocation_block = true;
                    if (ordinary_block_ips[block] == call_ip) call_block = true;
                }
                if (!allocation_block || !call_block) header_ok = false;
                for (u32 push = 0; header_ok && push < push_count; push++) {
                    i32 ip = push_ips[push];
                    if (ip <= allocation_ip || ip >= call_ip ||
                        fn->instructions[ip].opcode != MAL_OP_CALL) header_ok = false;
                }
                if (!header_ok || metadata_operations != push_count + 2 ||
                    claim_count != push_count + 2) r.ok = false;
                MAL_REGION_PAYLOAD_REFERENCE(allocation_ip);
                for (u32 push = 0; r.ok && push < push_count; push++) {
                    MAL_REGION_PAYLOAD_REFERENCE(push_ips[push]);
                }
                MAL_REGION_PAYLOAD_REFERENCE(call_ip);
			} else if (r.ok && kind == 10) {
				i32 parse_call_ip = rd_i32(&r);
				i32 map_load_ip = rd_i32(&r);
				i32 map_call_ip = rd_i32(&r);
				i32 json_object = rd_i32(&r);
				i32 parse_callee = rd_i32(&r);
				i32 text = rd_i32(&r);
				i32 parse_result = rd_i32(&r);
				i32 map_callee = rd_i32(&r);
				i32 callback = rd_i32(&r);
				i32 map_result = rd_i32(&r);
				i32 target_function_index = rd_i32(&r);
				u32 capture_count = rd_count(&r, 2);
				if (capture_count == 0 || capture_count > 8) r.ok = false;
				i32 capture_owners[8];
				i32 capture_indices[8];
				for (u32 capture = 0; r.ok && capture < capture_count; capture++) {
					capture_owners[capture] = rd_i32(&r);
					capture_indices[capture] = rd_i32(&r);
					if (capture_owners[capture] < 0 ||
						capture_owners[capture] >= (i32) function_count ||
						capture_indices[capture] < 0) r.ok = false;
					for (u32 previous = 0; r.ok && previous < capture; previous++) {
						if (capture_owners[previous] == capture_owners[capture] &&
							capture_indices[previous] == capture_indices[capture]) r.ok = false;
					}
				}
				i32 row_property_loads = rd_i32(&r);
				u32 primitive_key_count = rd_count(&r, 1);
				if (primitive_key_count == 0 || primitive_key_count > 64) r.ok = false;
				for (u32 key = 0; r.ok && key < primitive_key_count; key++) {
					i32 string_index = rd_i32(&r);
					if (string_index < 0 || string_index >= (i32) string_count) r.ok = false;
				}
				i32 nested_base_string_index = rd_i32(&r);
				i32 nested_value_string_index = rd_i32(&r);
				u32 excluded_key_count = rd_count(&r, 1);
				if (excluded_key_count == 0 || excluded_key_count > 64) r.ok = false;
				for (u32 key = 0; r.ok && key < excluded_key_count; key++) {
					i32 string_index = rd_i32(&r);
					if (string_index < 0 || string_index >= (i32) string_count) r.ok = false;
				}

				bool header_ok = anchor_count == 2 && anchors[0] == parse_call_ip &&
					anchors[1] == map_call_ip && map_load_ip == parse_call_ip + 1 &&
					map_call_ip == parse_call_ip + 2 && parse_call_ip >= 0 &&
					map_call_ip < fn->instruction_count && json_object >= 0 &&
					json_object < fn->register_count && parse_callee >= 0 &&
					parse_callee < fn->register_count && text >= 0 &&
					text < fn->register_count && parse_result >= 0 &&
					parse_result < fn->register_count && map_callee >= 0 &&
					map_callee < fn->register_count && callback >= 0 &&
					callback < fn->register_count && map_result >= 0 &&
					map_result < fn->register_count && target_function_index >= 0 &&
					target_function_index < (i32) function_count && row_property_loads > 0 &&
					row_property_loads <= 65535 && nested_base_string_index >= 0 &&
					nested_base_string_index < (i32) string_count &&
					nested_value_string_index >= 0 &&
					nested_value_string_index < (i32) string_count &&
					fn->instructions[parse_call_ip].opcode == MAL_OP_CALL &&
					fn->instructions[map_load_ip].opcode == MAL_OP_LOAD_PROPERTY_STATIC &&
					fn->instructions[map_call_ip].opcode == MAL_OP_CALL &&
					exceptional_handler_count == 0;
				if (header_ok) {
					const MalInstruction *parse = &fn->instructions[parse_call_ip];
					const MalInstruction *map_load = &fn->instructions[map_load_ip];
					const MalInstruction *map_call = &fn->instructions[map_call_ip];
					i32 parse_data = parse->as.call.data_offset;
					i32 map_data = map_call->as.call.data_offset;
					i32 name_index = map_load->as.load_property_static.string_index;
					bool map_name = name_index >= 0 && name_index < (i32) string_count;
					if (map_name) {
						const MalString *name = &strings[name_index];
						map_name = name->length == 3 && name->code_units[0] == 'm' &&
							name->code_units[1] == 'a' && name->code_units[2] == 'p';
					}
					header_ok = map_name && parse->as.call.callee == parse_callee &&
						parse->as.call.this_value == json_object &&
						parse->as.call.dst == parse_result && parse_data >= 0 &&
						parse_data + 1 < fn->instruction_data_count &&
						fn->instruction_data[parse_data] == 1 &&
						fn->instruction_data[parse_data + 1] == text &&
						map_load->as.load_property_static.object == parse_result &&
						map_load->as.load_property_static.dst == map_callee &&
						map_call->as.call.callee == map_callee &&
						map_call->as.call.this_value == parse_result &&
						map_call->as.call.dst == map_result && map_data >= 0 &&
						map_data + 1 < fn->instruction_data_count &&
						fn->instruction_data[map_data] == 1 &&
						fn->instruction_data[map_data + 1] == callback;
				}
				bool parse_block = false;
				bool load_block = false;
				bool map_block = false;
				for (u32 block = 0; block < ordinary_block_count; block++) {
					if (ordinary_block_ips[block] == parse_call_ip) parse_block = true;
					if (ordinary_block_ips[block] == map_load_ip) load_block = true;
					if (ordinary_block_ips[block] == map_call_ip) map_block = true;
				}
				if (!parse_block || !load_block || !map_block) header_ok = false;
				if (!header_ok || metadata_operations != 3 || claim_count != 3) r.ok = false;
				MAL_REGION_PAYLOAD_REFERENCE(parse_call_ip);
				MAL_REGION_PAYLOAD_REFERENCE(map_load_ip);
				MAL_REGION_PAYLOAD_REFERENCE(map_call_ip);
			} else if (r.ok && kind == 11) {
				u32 site_count = rd_count(&r, 5);
				if (site_count == 0 || site_count > 8 || anchor_count != site_count ||
					exceptional_handler_count != 0) r.ok = false;
				u32 inherited_count = 0;
				u32 total_slots = 0;
				for (u32 site = 0; r.ok && site < site_count; site++) {
					i32 allocation_ip = rd_i32(&r);
					i32 slot_count = rd_i32(&r);
					bool allocation_ok = allocation_ip >= 0 &&
						allocation_ip < fn->instruction_count && anchors[site] == allocation_ip &&
						slot_count >= 0 && slot_count <= 256;
					if (allocation_ok) {
						const MalInstruction *allocation = &fn->instructions[allocation_ip];
						if (allocation->opcode == MAL_OP_CREATE_OBJECT) {
							allocation_ok = slot_count == 0;
						} else if (allocation->opcode == MAL_OP_CREATE_OBJECT_SHAPED) {
							i32 offset = allocation->as.create_object_shaped.data_offset;
							allocation_ok = offset >= 0 && offset < fn->instruction_data_count &&
								fn->instruction_data[offset] == slot_count;
						} else {
							allocation_ok = false;
						}
					}
					if (!allocation_ok) {
						r.ok = false;
					} else if (total_slots + (u32) slot_count > 256) {
						r.ok = false;
					} else {
						total_slots += (u32) slot_count;
					}
					MAL_REGION_PAYLOAD_REFERENCE(allocation_ip);

					u32 access_count = rd_count(&r, 2);
					for (u32 access = 0; r.ok && access < access_count; access++) {
						i32 ip = rd_i32(&r);
						i32 slot = rd_i32(&r);
						if (ip < 0 || ip >= fn->instruction_count || slot < 0 ||
							slot >= slot_count ||
							(fn->instructions[ip].opcode != MAL_OP_LOAD_PROPERTY_STATIC &&
							 fn->instructions[ip].opcode != MAL_OP_STORE_PROPERTY_STATIC)) {
							r.ok = false;
						}
						MAL_REGION_PAYLOAD_REFERENCE(ip);
					}

					i32 inherited_ip = rd_i32(&r);
					if (inherited_ip >= 0) {
						inherited_count++;
						if (inherited_ip >= fn->instruction_count ||
							fn->instructions[inherited_ip].opcode != MAL_OP_LOAD_PROPERTY_STATIC) {
							r.ok = false;
						}
						MAL_REGION_PAYLOAD_REFERENCE(inherited_ip);
					} else if (inherited_ip != -1) {
						r.ok = false;
					}

					u32 materialization_count = rd_count(&r, 2);
					for (u32 materialization = 0; r.ok &&
						 materialization < materialization_count; materialization++) {
						i32 ip = rd_i32(&r);
						u8 tag = rd_u8(&r);
							if (ip < 0 || ip >= fn->instruction_count || tag != 1 ||
								fn->instructions[ip].opcode != MAL_OP_RETURN) {
							r.ok = false;
						}
						MAL_REGION_PAYLOAD_REFERENCE(ip);
					}
				}
				if ((inherited_count == 0 && dependency_mask != 0) ||
					(inherited_count != 0 && dependency_mask == 0) ||
					metadata_operations != payload_count) r.ok = false;
			} else if (r.ok && kind == 12) {
				i32 allocation_ip = rd_i32(&r);
				i32 push_call_ip = rd_i32(&r);
				i32 item_allocation_ip = rd_i32(&r);
				i32 maximum_length = rd_i32(&r);
				bool header_ok = anchor_count == 3 && anchors[0] == allocation_ip &&
					anchors[1] == push_call_ip && anchors[2] == item_allocation_ip &&
					allocation_ip >= 0 && allocation_ip < fn->instruction_count &&
					push_call_ip >= 0 && push_call_ip < fn->instruction_count &&
					item_allocation_ip >= 0 && item_allocation_ip < fn->instruction_count &&
					maximum_length > 0 && maximum_length <= 32 &&
					exceptional_handler_count == 0 &&
					fn->instructions[allocation_ip].opcode == MAL_OP_CREATE_ARRAY &&
					fn->instructions[allocation_ip].as.create_array.length == 0 &&
					fn->instructions[push_call_ip].opcode == MAL_OP_CALL &&
					fn->instructions[item_allocation_ip].opcode == MAL_OP_CREATE_OBJECT_SHAPED;
				if (header_ok) {
					i32 data = fn->instructions[push_call_ip].as.call.data_offset;
					i32 shaped_data =
						fn->instructions[item_allocation_ip].as.create_object_shaped.data_offset;
					header_ok = data >= 0 && data + 1 < fn->instruction_data_count &&
						fn->instruction_data[data] == 1 &&
						fn->instruction_data[data + 1] ==
							fn->instructions[item_allocation_ip].as.create_object_shaped.dst &&
						shaped_data >= 0 &&
						shaped_data < fn->instruction_data_count &&
						fn->instruction_data[shaped_data] > 0 &&
						fn->instruction_data[shaped_data] <= 8;
				}
				if (!header_ok) r.ok = false;
				MAL_REGION_PAYLOAD_REFERENCE(allocation_ip);
				MAL_REGION_PAYLOAD_REFERENCE(push_call_ip);
				MAL_REGION_PAYLOAD_REFERENCE(item_allocation_ip);
				u32 access_count = rd_count(&r, 2);
				if (access_count == 0 || access_count > 32) r.ok = false;
				u32 push_access_count = 0;
				for (u32 access = 0; r.ok && access < access_count; access++) {
					i32 ip = rd_i32(&r);
					u8 role = rd_u8(&r);
					i32 field_slot = rd_i32(&r);
					if (ip < 0 || ip >= fn->instruction_count || role < 1 || role > 4 ||
						(fn->instructions[ip].opcode != MAL_OP_LOAD_PROPERTY &&
						 fn->instructions[ip].opcode != MAL_OP_LOAD_PROPERTY_STATIC) ||
						(role == 4 ? field_slot < 0 || field_slot >= 8 : field_slot != -1)) {
						r.ok = false;
					}
					if (role == 1) push_access_count++;
					MAL_REGION_PAYLOAD_REFERENCE(ip);
				}
				if (push_access_count != 1 || metadata_operations != payload_count) r.ok = false;
			} else if (r.ok && kind == 13) {
				i32 allocation_ip = rd_i32(&r);
				u8 runtime_guard = rd_u8(&r);
				u32 access_count = rd_count(&r, 1);
				bool header_ok = anchor_count == 2 && anchors[0] == allocation_ip &&
					access_count > 0 && access_count <= 64 && runtime_guard == 1 &&
					allocation_ip >= 0 && allocation_ip < fn->instruction_count &&
					fn->instructions[allocation_ip].opcode == MAL_OP_CREATE_ARRAY;
				if (!header_ok) r.ok = false;
				MAL_REGION_PAYLOAD_REFERENCE(allocation_ip);
				for (u32 access = 0; r.ok && access < access_count; access++) {
					i32 ip = rd_i32(&r);
					if (access == 0 && anchors[1] != ip) r.ok = false;
					if (ip < 0 || ip >= fn->instruction_count ||
						fn->instructions[ip].opcode != MAL_OP_LOAD_PROPERTY ||
						fn->instructions[ip].as.load_property.object !=
							fn->instructions[allocation_ip].as.create_array.dst) {
						r.ok = false;
					}
					MAL_REGION_PAYLOAD_REFERENCE(ip);
				}
				if (score != access_count || metadata_operations != payload_count) r.ok = false;
			} else if (r.ok && kind == 14) {
				u8 runtime_guard = rd_u8(&r);
				u32 pair_count = rd_count(&r, 2);
				if (runtime_guard != 1 || pair_count == 0 || pair_count > 32 ||
					anchor_count != 2) r.ok = false;
				for (u32 pair = 0; r.ok && pair < pair_count; pair++) {
					i32 first_ip = rd_i32(&r);
					i32 finish_ip = rd_i32(&r);
					u8 first_use_position = rd_u8(&r);
					bool ips_ok = first_ip >= 0 && first_ip < fn->instruction_count &&
						finish_ip > first_ip && finish_ip < fn->instruction_count;
					if (!ips_ok || (pair == 0 &&
						(anchors[0] != first_ip || anchors[1] != finish_ip)) ||
						(first_use_position != 1 && first_use_position != 2) ||
						fn->instructions[first_ip].opcode != MAL_OP_BINARY ||
						fn->instructions[finish_ip].opcode != MAL_OP_BINARY) {
						r.ok = false;
					} else {
						MalBinaryOp first_op = fn->instructions[first_ip].as.binary.op;
						MalBinaryOp finish_op = fn->instructions[finish_ip].as.binary.op;
						i32 first_dst = fn->instructions[first_ip].as.binary.dst;
						i32 consumed = first_use_position == 1
							? fn->instructions[finish_ip].as.binary.left
							: fn->instructions[finish_ip].as.binary.right;
						bool first_operator_ok = first_op <= MAL_BIN_REM ||
							(first_op >= MAL_BIN_BIT_AND && first_op <= MAL_BIN_USHR);
						bool finish_operator_ok = finish_op <= MAL_BIN_REM ||
							(finish_op >= MAL_BIN_BIT_AND && finish_op <= MAL_BIN_STRICT_NEQ);
						if (!first_operator_ok || !finish_operator_ok || consumed != first_dst) {
							r.ok = false;
						}
					}
					MAL_REGION_PAYLOAD_REFERENCE(first_ip);
					MAL_REGION_PAYLOAD_REFERENCE(finish_ip);
				}
				if (score != pair_count || metadata_operations != payload_count) r.ok = false;
            }
            if (payload_count != claim_count) r.ok = false;
#undef MAL_REGION_PAYLOAD_CLAIM
#undef MAL_REGION_PAYLOAD_REFERENCE
        }
    }

    if (!r.ok || r.pos != r.len) {
        err = "truncated or corrupt buffer";
        goto fail;
    }

    return L;

fail:
    if (out_err != nullptr) {
        *out_err = err;
    }
    mal_vm_loaded_definition_free(L);
    return nullptr;
}

MalLoadedDefinition *mal_vm_load_definition(const u8 *buf, usize len, const char **out_err) {
    return mal_vm_load_definition_with_host_resolver(buf, len, out_err, nullptr);
}

const MalVmDefinition *mal_loaded_definition_get(const MalLoadedDefinition *loaded) {
    return &loaded->definition;
}

void mal_vm_loaded_definition_free(MalLoadedDefinition *loaded) {
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
