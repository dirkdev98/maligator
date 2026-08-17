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
#define WIRE_VERSION 48u        // String.split cursors join the tagged compiler region table
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

        u32 stack_site_count = rd_count(&r, 2);
        for (u32 site = 0; r.ok && site < stack_site_count; site++) {
            (void) rd_i32(&r);
            (void) rd_i32(&r);
        }

        u32 stack_access_count = rd_count(&r, 3);
        for (u32 access = 0; r.ok && access < stack_access_count; access++) {
            (void) rd_i32(&r);
            (void) rd_i32(&r);
            (void) rd_i32(&r);
        }

        u32 inherited_stack_access_count = rd_count(&r, 4);
        for (u32 access = 0; r.ok && access < inherited_stack_access_count; access++) {
            (void) rd_i32(&r);
            (void) rd_i32(&r);
            u8 dependency_mask = rd_u8(&r);
            u8 obligation_mask = rd_u8(&r);
            if ((dependency_mask != 1 && dependency_mask != 2) ||
                obligation_mask != 3) {
                r.ok = false;
            }
        }

        u32 materialization_count = rd_count(&r, 2);
        for (u32 materialization = 0; r.ok && materialization < materialization_count;
             materialization++) {
            (void) rd_i32(&r);
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
                if (flags > 127 || collection_tag > 48 || guarded_builtin_count > 1 ||
                    ((flags & 48) != 0 && (flags & 4) == 0) ||
                    (flags & 48) == 48 ||
                    ((flags & 64) != 0 && guarded_builtin_count != 1)) {
                    r.ok = false;
                }
                if (flags & 8) {
                    (void) rd_i32(&r); // virtual array allocation instruction
                    (void) rd_i32(&r); // pushed stack-object allocation instruction
                }
            } else if (tag == 2) { // CONSTRUCT
                (void) rd_i32(&r);
            } else if (tag == 3) { // BINARY numeric fusion
                u8 role = rd_u8(&r);
                (void) rd_i32(&r);
                if (role == 2) {
                    (void) rd_i32(&r);
                    (void) rd_i32(&r);
                    (void) rd_i32(&r);
                    (void) rd_u8(&r);
                } else if (role != 1) {
                    r.ok = false;
                }
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
            } else if (tag == 8) { // CREATE_ARRAY cardinality region
                i32 maximum_length = rd_i32(&r);
                u8 dependency_mask = rd_u8(&r);
                u8 obligation_mask = rd_u8(&r);
                if (maximum_length <= 0 || maximum_length > 32 ||
                    (dependency_mask != 1 && dependency_mask != 14) ||
                    obligation_mask != 3) {
                    r.ok = false;
                }
            } else if (tag == 9) { // LOAD_PROPERTY cardinality access
                u8 role = rd_u8(&r);
                (void) rd_i32(&r); // virtual array allocation instruction
                if (role < 1 || role > 4) {
                    r.ok = false;
                }
                if (role == 4) {
                    i32 field_slot = rd_i32(&r);
                    if (field_slot < 0 || field_slot >= 8) {
                        r.ok = false;
                    }
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
            } else if (tag == 13) { // LOAD_PROPERTY exact fresh-Array element
                i32 allocation_ip = rd_i32(&r);
                const MalFunction *fn = &functions[i];
                if (instruction_index >= (u32) fn->instruction_count ||
                    fn->instructions[instruction_index].opcode != MAL_OP_LOAD_PROPERTY ||
                    allocation_ip < 0 || allocation_ip >= (i32) instruction_index ||
                    fn->instructions[allocation_ip].opcode != MAL_OP_CREATE_ARRAY ||
                    fn->instructions[allocation_ip].as.create_array.dst !=
                        fn->instructions[instruction_index].as.load_property.object) {
                    r.ok = false;
                }
            } else {
                r.ok = false;
            }
        }

        u32 numeric_hof_count = rd_count(&r, 13);
        for (u32 region = 0; r.ok && region < numeric_hof_count; region++) {
            u8 dispatch_tag = rd_u8(&r);
            i32 dispatch_primary_ip = rd_i32(&r);
            i32 dispatch_secondary_ip = rd_i32(&r);
            i32 entry_ip = rd_i32(&r);
            (void) rd_u64(&r); // exact numeric initial accumulator
            i32 initial_ip = rd_i32(&r);
            i32 completion_ip = rd_i32(&r);
            i32 callback_function = rd_i32(&r);
            i32 receiver = rd_i32(&r);
            i32 initial = rd_i32(&r);
            i32 accumulator = rd_i32(&r);
            i32 result = rd_i32(&r);
            u8 dependency_mask = rd_u8(&r);
            u8 obligation_mask = rd_u8(&r);
            u8 poll_policy = rd_u8(&r);
            i32 result_operand = rd_i32(&r);
            u32 operation_count = rd_count(&r, 2);
            const MalFunction *fn = &functions[i];
#define MAL_HOF_IP_OPCODE(ip, op) \
            ((ip) >= 0 && (ip) < fn->instruction_count && \
             fn->instructions[(ip)].opcode == (op))
            bool dispatch_ok =
                (dispatch_tag == 1 &&
                 entry_ip == dispatch_primary_ip &&
                 MAL_HOF_IP_OPCODE(dispatch_primary_ip, MAL_OP_CALL) &&
                 MAL_HOF_IP_OPCODE(dispatch_secondary_ip, MAL_OP_CALL)) ||
                (dispatch_tag == 2 && dispatch_secondary_ip == -1 &&
                 dependency_mask == 1 &&
                 MAL_HOF_IP_OPCODE(dispatch_primary_ip, MAL_OP_CREATE_ARRAY) &&
                 fn->instructions[dispatch_primary_ip].as.create_array.dst == receiver &&
                 dispatch_primary_ip < entry_ip && entry_ip == initial_ip &&
                 MAL_HOF_IP_OPCODE(entry_ip, MAL_OP_MOVE));
            bool completion_ok = completion_ip >= 0 && completion_ip < fn->instruction_count;
            if (completion_ok && fn->instructions[completion_ip].opcode == MAL_OP_MOVE &&
                fn->instructions[completion_ip].as.move.src == accumulator) {
                completion_ok = fn->instructions[completion_ip].as.move.dst == result;
            } else {
                completion_ok = result == accumulator;
            }
            if (!dispatch_ok ||
                !MAL_HOF_IP_OPCODE(initial_ip, MAL_OP_MOVE) ||
                !completion_ok ||
                callback_function < 0 || callback_function >= function_count ||
                receiver < 0 || receiver >= fn->register_count ||
                initial < 0 || initial >= fn->register_count ||
                accumulator < 0 || accumulator >= fn->register_count ||
                result < 0 || result >= fn->register_count ||
                (dependency_mask != 1 && dependency_mask != 14) ||
                obligation_mask != 1 || poll_policy != 1 ||
                operation_count == 0 || operation_count > 32 ||
                fn->instructions[initial_ip].as.move.src != initial ||
                fn->instructions[initial_ip].as.move.dst != accumulator) {
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
        }

        u32 compiler_region_count = rd_count(&r, 17);
        if (compiler_region_count > 8) r.ok = false;
        i32 claimed_region_ips[768];
        u32 claimed_region_count = 0;
        for (u32 region = 0; r.ok && region < compiler_region_count; region++) {
            const MalFunction *fn = &functions[i];
            u8 kind = rd_u8(&r);
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
                for (u32 previous = 0; r.ok && previous < claimed_region_count; previous++) {
                    if (claimed_region_ips[previous] == claims[claim]) r.ok = false;
                }
                if (r.ok && claimed_region_count < countof(claimed_region_ips)) {
                    claimed_region_ips[claimed_region_count++] = claims[claim];
                } else if (r.ok) {
                    r.ok = false;
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
            if (exceptional_handler_count != 0) r.ok = false;
            for (u32 handler = 0; r.ok && handler < exceptional_handler_count; handler++) {
                (void) rd_i32(&r);
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
            if (generic_twin != 1 || score == 0 || metadata_operations == 0 ||
                metadata_operations > 96 || (!closed_record_contract && !split_cursor_contract)) {
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
                i32 length_ip = anchor_count > 1 ? anchors[1] : -1;
                i32 backedge_ip = anchor_count > 2 ? anchors[2] : -1;
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
                if (anchor_count != 3 || !call_ip_ok ||
                    (!call_is_generic && !call_is_builtin) ||
                    (call_is_generic && !property_ok) ||
                    (call_is_builtin && (property_ip != -1 || callee != -1)) ||
                    result < 0 || result >= fn->register_count ||
                    index < 0 || index >= fn->register_count || !fixed_ips_ok) {
                    r.ok = false;
                }
                if (r.ok) {
                    const MalInstruction *call = &fn->instructions[call_ip];
                    const MalInstruction *length = &fn->instructions[length_ip];
                    const MalInstruction *compare = &fn->instructions[length_ip + 1];
                    const MalInstruction *body_branch = &fn->instructions[length_ip + 2];
                    const MalInstruction *exit_jump = &fn->instructions[length_ip + 3];
                    const MalInstruction *element = &fn->instructions[element_ip];
                    const MalInstruction *trim_property = &fn->instructions[trim_property_ip];
                    const MalInstruction *trim_call = &fn->instructions[trim_call_ip];
                    const MalInstruction *increment = &fn->instructions[backedge_ip - 1];
                    const MalInstruction *backedge = &fn->instructions[backedge_ip];
                    bool structure_ok = length->opcode == MAL_OP_LOAD_PROPERTY_STATIC &&
                        compare->opcode == MAL_OP_BINARY && compare->as.binary.op == MAL_BIN_LT &&
                        compare->as.binary.left == index &&
                        compare->as.binary.right == length->as.load_property_static.dst &&
                        body_branch->opcode == MAL_OP_JUMP_IF &&
                        body_branch->as.jump_if.cond == compare->as.binary.dst &&
                        body_branch->as.jump_if.target_ip == element_ip &&
                        exit_jump->opcode == MAL_OP_JUMP &&
                        exit_jump->as.jump.target_ip == exit_ip &&
                        element->opcode == MAL_OP_LOAD_PROPERTY &&
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
            }
            if (payload_count != claim_count) r.ok = false;
#undef MAL_REGION_PAYLOAD_CLAIM
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
