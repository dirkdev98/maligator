#include "vm_load.h"

#include <stdlib.h>
#include <string.h>
#include "heap_bigint.h"
#include "heap_string.h"

/*
 * Inverse of src/emit-vm.ts + src/serialize-vm.ts: decode the flat wire buffer
 * into the runtime structs. The per-opcode operand layout, the opcode tag
 * ordering (WireOp below), and the operator/intrinsic tables mirror
 * serialize-vm.ts exactly; WIRE_VERSION is the staleness guard.
 */

#define WIRE_MAGIC 0x574c414du // "MALW" little-endian
#define WIRE_VERSION 1u
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
    /* Appended last; mirrors the trailing WITH_RESOLVE_BASE / SET_FUNCTION_NAME in
     * WIRE_OPCODES (serialize-vm.ts). APPEND-ONLY. */
    WIRE_WITH_RESOLVE_BASE,
    WIRE_SET_FUNCTION_NAME,
    WIRE_CHECK_SUPER_CLASS,
    WIRE_LOAD_CALLEE,
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
    MalLoadArenaBlock *block = L->arena;
    usize offset = block != nullptr ? align_up(block->used, align) : 0;
    if (block == nullptr || offset + bytes > block->size) {
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
    u16 v = (u16) (r->buf[r->pos] | (r->buf[r->pos + 1] << 8));
    r->pos += 2;
    return v;
}

static u32 rd_u32(Rd *r) {
    if (!r->ok || r->pos + 4 > r->len) {
        r->ok = false;
        return 0;
    }
    u32 v = (u32) r->buf[r->pos] | ((u32) r->buf[r->pos + 1] << 8) |
        ((u32) r->buf[r->pos + 2] << 16) | ((u32) r->buf[r->pos + 3] << 24);
    r->pos += 4;
    return v;
}

static i32 rd_i32(Rd *r) {
    return (i32) rd_u32(r);
}

static u64 rd_u64(Rd *r) {
    if (!r->ok || r->pos + 8 > r->len) {
        r->ok = false;
        return 0;
    }
    u64 v = 0;
    for (int i = 0; i < 8; i++) {
        v |= (u64) r->buf[r->pos + (usize) i] << (8 * i);
    }
    r->pos += 8;
    return v;
}

static f64 rd_f64(Rd *r) {
    u64 bits = rd_u64(r);
    f64 v;
    memcpy(&v, &bits, sizeof(f64));
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
    if ((usize) n > remaining / min_each) {
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

static const i32 *rd_i32_array(MalLoadedDefinition *L, Rd *r, i32 *count_out) {
    u32 n = rd_count(r, sizeof(i32));
    *count_out = (i32) n;
    if (!r->ok || n == 0) {
        return nullptr;
    }
    i32 *arr = arena(L, r, (usize) n * sizeof(i32), alignof(i32));
    if (!r->ok) {
        return nullptr;
    }
    for (u32 i = 0; i < n; i++) {
        arr[i] = rd_i32(r);
    }
    return arr;
}

// ---- instruction decode (mirrors writeInstruction in serialize-vm.ts) ----

static void rd_instruction(MalLoadedDefinition *L, Rd *r, MalInstruction *o) {
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
            o->as.create_f64.value = rd_f64(r);
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
            o->as.create_object_shaped.count = rd_i32(r);
            i32 keys, values;
            o->as.create_object_shaped.key_indices = rd_i32_array(L, r, &keys);
            o->as.create_object_shaped.value_registers = rd_i32_array(L, r, &values);
            return;
        }
        case WIRE_CREATE_ARRAY:
            o->opcode = MAL_OP_CREATE_ARRAY;
            o->as.create_array.dst = rd_i32(r);
            o->as.create_array.length = rd_i32(r);
            return;
        case WIRE_CREATE_MODULE_NAMESPACE: {
            o->opcode = MAL_OP_CREATE_MODULE_NAMESPACE;
            o->as.create_module_namespace.dst = rd_i32(r);
            i32 names, slots;
            o->as.create_module_namespace.name_indices = rd_i32_array(L, r, &names);
            o->as.create_module_namespace.slots = rd_i32_array(L, r, &slots);
            o->as.create_module_namespace.count = names;
            return;
        }
        case WIRE_CREATE_TEMPLATE_OBJECT: {
            o->opcode = MAL_OP_CREATE_TEMPLATE_OBJECT;
            o->as.create_template_object.dst = rd_i32(r);
            o->as.create_template_object.cache_slot = rd_i32(r);
            i32 cooked, raw;
            o->as.create_template_object.cooked_indices = rd_i32_array(L, r, &cooked);
            o->as.create_template_object.raw_indices = rd_i32_array(L, r, &raw);
            o->as.create_template_object.count = cooked;
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
        case WIRE_CALL:
            o->opcode = MAL_OP_CALL;
            o->as.call.dst = rd_i32(r);
            o->as.call.callee = rd_i32(r);
            o->as.call.this_value = rd_i32(r);
            o->as.call.argument_count = rd_i32(r);
            {
                i32 args;
                o->as.call.arguments = rd_i32_array(L, r, &args);
            }
            return;
        case WIRE_CONSTRUCT:
            o->opcode = MAL_OP_CONSTRUCT;
            o->as.construct.dst = rd_i32(r);
            o->as.construct.callee = rd_i32(r);
            o->as.construct.argument_count = rd_i32(r);
            {
                i32 args;
                o->as.construct.arguments = rd_i32_array(L, r, &args);
            }
            return;
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
            return;
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
        case WIRE_COPY_DATA_PROPERTIES:
            o->opcode = MAL_OP_COPY_DATA_PROPERTIES;
            o->as.copy_data_properties.dst = rd_i32(r);
            o->as.copy_data_properties.src = rd_i32(r);
            o->as.copy_data_properties.excluded_count = rd_i32(r);
            {
                i32 excluded;
                o->as.copy_data_properties.excluded = rd_i32_array(L, r, &excluded);
            }
            return;
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
        case WIRE_OP_COUNT:
        default:
            r->ok = false;
            return;
    }
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
    fn->parameter_count = rd_i32(r);
    fn->length = rd_i32(r);
    fn->register_count = rd_i32(r);
    fn->captured_count = rd_i32(r);
    fn->file_index = rd_i32(r);
    fn->compiled = nullptr; // loaded code is always interpreted

    u32 instruction_count = rd_count(r, 1);
    fn->instruction_count = (i32) instruction_count;
    MalInstruction *instructions =
        arena(L, r, (usize) instruction_count * sizeof(MalInstruction), alignof(MalInstruction));
    for (u32 i = 0; r->ok && i < instruction_count; i++) {
        rd_instruction(L, r, &instructions[i]);
    }
    fn->instructions = instructions;

    u32 handler_count = rd_count(r, 12);
    fn->handler_count = (i32) handler_count;
    MalExceptionHandler *handlers =
        arena(L, r, (usize) handler_count * sizeof(MalExceptionHandler), alignof(MalExceptionHandler));
    for (u32 i = 0; r->ok && i < handler_count; i++) {
        handlers[i].start_ip = rd_i32(r);
        handlers[i].end_ip = rd_i32(r);
        handlers[i].handler_ip = rd_i32(r);
    }
    fn->handlers = handlers;

    u32 run_count = rd_count(r, 8);
    fn->position_count = (i32) run_count;
    MalLineEntry *positions =
        arena(L, r, (usize) run_count * sizeof(MalLineEntry), alignof(MalLineEntry));
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

MalLoadedDefinition *mal_vm_load_definition(const u8 *buf, usize len, const char **out_err) {
    const char *err = "ok";
    MalLoadedDefinition *L = calloc(1, sizeof(MalLoadedDefinition));
    if (L == nullptr) {
        if (out_err != nullptr) {
            *out_err = "out of memory";
        }
        return nullptr;
    }

    Rd r = {.buf = buf, .len = len, .pos = 0, .ok = true};

    u32 magic = rd_u32(&r);
    if (!r.ok || magic != WIRE_MAGIC) {
        err = "bad magic";
        goto fail;
    }
    u32 version = rd_u32(&r);
    if (!r.ok || version != WIRE_VERSION) {
        err = "version mismatch";
        goto fail;
    }
    u32 flags = rd_u32(&r);
    bool debug = (flags & WIRE_FLAG_HAS_DEBUG) != 0;
    MalVmDefinition *def = &L->definition;
    def->global_count = rd_i32(&r);

    // Strings: immortal, external code units copied into the arena.
    u32 string_count = rd_count(&r, 4);
    def->string_constant_count = (i32) string_count;
    MalString *strings = arena(L, &r, (usize) string_count * sizeof(MalString), alignof(MalString));
    def->string_constants = strings;
    for (u32 s = 0; r.ok && s < string_count; s++) {
        u32 length = rd_count(&r, sizeof(c16));
        c16 *units = arena(L, &r, (usize) length * sizeof(c16), alignof(c16));
        for (u32 u = 0; r.ok && u < length; u++) {
            units[u] = rd_u16(&r);
        }
        if (!r.ok) {
            break;
        }
        strings[s].header.type = MAL_HEAP_STRING;
        strings[s].header.storage = MAL_HEAP_STORAGE_IMMORTAL;
        strings[s].storage = MAL_STRING_STORAGE_EXTERNAL;
        strings[s].length = length;
        strings[s].code_units = units;
        strings[s].hash = mal_string_hash_code_units(units, length);
    }

    // BigInts: immortal, 128-bit value (low u64 then high u64).
    u32 bigint_count = rd_count(&r, 16);
    def->bigint_constant_count = (i32) bigint_count;
    MalBigInt *bigints = arena(L, &r, (usize) bigint_count * sizeof(MalBigInt), alignof(MalBigInt));
    def->bigint_constants = bigints;
    for (u32 b = 0; r.ok && b < bigint_count; b++) {
        u64 lo = rd_u64(&r);
        u64 hi = rd_u64(&r);
        bigints[b].header.type = MAL_HEAP_BIGINT;
        bigints[b].header.storage = MAL_HEAP_STORAGE_IMMORTAL;
        bigints[b].value = (i128) (((u128) hi << 64) | (u128) lo);
    }

    // CommonJS module table.
    i32 cjs_count;
    const i32 *cjs = rd_i32_array(L, &r, &cjs_count);
    def->cjs_module_count = cjs_count;
    def->cjs_module_function_indices = cjs;

    // Functions.
    u32 function_count = rd_count(&r, 1);
    def->function_count = (i32) function_count;
    MalFunction *functions = arena(L, &r, (usize) function_count * sizeof(MalFunction), alignof(MalFunction));
    def->functions = functions;
    for (u32 f = 0; r.ok && f < function_count; f++) {
        rd_function(L, &r, &functions[f], debug);
    }

    // Debug-info: files + source positions.
    u32 file_count = rd_count(&r, 1);
    const char **files = arena(L, &r, (usize) file_count * sizeof(char *), alignof(char *));
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
    u32 source_pos_count = rd_count(&r, 16);
    MalSourcePos *source_positions =
        arena(L, &r, (usize) source_pos_count * sizeof(MalSourcePos), alignof(MalSourcePos));
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

    if (!r.ok) {
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
