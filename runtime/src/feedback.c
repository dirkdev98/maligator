#include "feedback.h"

#if !defined(__wasi__)
#include <pthread.h>
#include <signal.h>
#endif
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "gc.h"
#include "shape.h"
#include "utf8.h"
#include "vm.h"
#include "vm_ops.h"

enum {
    MAL_FEEDBACK_MEGAMORPHIC = 1,
    MAL_FEEDBACK_DICTIONARY = 2,
    MAL_FEEDBACK_MIXED_KINDS = 4,
};

#define MAL_FEEDBACK_SHAPE_LIMIT 4
#define MAL_FEEDBACK_NO_KIND UINT8_MAX

static_assert(MAL_HEAP_TYPE_COUNT < MAL_FEEDBACK_NO_KIND, "heap types outgrew the kind byte");

/**
 * What one property site observed. Shapes are immortal for their heap's lifetime
 * and the transition tree roots their keys, so the raw pointers stay valid and
 * nameable until the dump, which runs before the heap is freed.
 */
typedef struct MalFeedbackSite {
    const MalInlineCache *ic;
    const MalShape *shapes[MAL_FEEDBACK_SHAPE_LIMIT];
    // Inline cache modes the row held, one bit per mode.
    u64 modes;
    u8 shape_count;
    // Heap type of the object receivers, or MAL_FEEDBACK_NO_KIND before the first.
    u8 kind;
    u8 flags;
    bool observed;
#if MAL_FEEDBACK_HISTORY
    // The row still holds the compiler's seed, captured here, which no access observed.
    bool seeded;
    u8 seed_mode;
    u8 seed_poly_count;
    const MalShape *seed_shape;
    MalValue seed_key;
#endif
} MalFeedbackSite;

static_assert(MAL_IC_MODE_FUNCTION_METADATA < 64, "inline cache modes outgrew the mode mask");

typedef struct MalFeedbackBuffer {
    byte *bytes;
    usize length;
    usize capacity;
    bool failed;
} MalFeedbackBuffer;

// One isolate per process records: the CLI attributes IC indices to the main
// program's functions, and a worker isolate's function table differs.
static atomic_bool g_feedback_claimed = false;
static MalVm *g_feedback_vm = nullptr;
static char *g_feedback_path = nullptr;
#if !defined(__wasi__)
static volatile sig_atomic_t g_feedback_signal = 0;
static MalGcTerminationTarget *g_feedback_termination = nullptr;
static MalGcPollTarget *g_feedback_poll = nullptr;
static struct sigaction g_feedback_previous_interrupt;
static struct sigaction g_feedback_previous_terminate;
#endif

static void mal_feedback_reserve(MalFeedbackBuffer *buffer, usize extra) {
    if (buffer->failed) return;
    if (extra <= buffer->capacity - buffer->length) return;
    usize capacity = buffer->capacity == 0 ? 4096 : buffer->capacity;
    while (extra > capacity - buffer->length) {
        if (capacity > SIZE_MAX / 2) {
            buffer->failed = true;
            return;
        }
        capacity *= 2;
    }
    byte *bytes = realloc(buffer->bytes, capacity);
    if (bytes == nullptr) {
        buffer->failed = true;
        return;
    }
    buffer->bytes = bytes;
    buffer->capacity = capacity;
}

static void mal_feedback_write(MalFeedbackBuffer *buffer, const void *bytes, usize length) {
    mal_feedback_reserve(buffer, length);
    if (buffer->failed) return;
    memcpy(buffer->bytes + buffer->length, bytes, length);
    buffer->length += length;
}

static void mal_feedback_u8(MalFeedbackBuffer *buffer, u8 value) {
    mal_feedback_write(buffer, &value, 1);
}

static void mal_feedback_u32(MalFeedbackBuffer *buffer, u32 value) {
    byte bytes[4] = {
        (byte) value, (byte) (value >> 8), (byte) (value >> 16), (byte) (value >> 24),
    };
    mal_feedback_write(buffer, bytes, sizeof(bytes));
}

static void mal_feedback_patch_u32(MalFeedbackBuffer *buffer, usize offset, u32 value) {
    if (buffer->failed) return;
    buffer->bytes[offset] = (byte) value;
    buffer->bytes[offset + 1] = (byte) (value >> 8);
    buffer->bytes[offset + 2] = (byte) (value >> 16);
    buffer->bytes[offset + 3] = (byte) (value >> 24);
}

static const char *mal_feedback_mode_name(u8 mode) {
    switch (mode) {
        case MAL_IC_MODE_INHERITED_VALUE:
        case MAL_IC_MODE_INHERITED_SLOT:
        case MAL_IC_MODE_INHERITED_TABLE:
            return "inherited";
        case MAL_IC_MODE_PRIMITIVE_VALUE: return "primitive";
        case MAL_IC_MODE_STRING_LENGTH: return "string-length";
        case MAL_IC_MODE_ARRAY_LENGTH: return "array-length";
        case MAL_IC_MODE_MISSING: return "missing";
        case MAL_IC_MODE_TRANSITION: return "transition";
        case MAL_IC_MODE_TYPED_ARRAY_LENGTH: return "typed-array-length";
        case MAL_IC_MODE_CONSTRUCTOR_LAYOUT: return "constructor-layout";
        case MAL_IC_MODE_COLLECTION_SIZE: return "collection-size";
        case MAL_IC_MODE_INHERITED_GETTER: return "inherited-getter";
        case MAL_IC_MODE_INHERITED_SETTER: return "inherited-setter";
        case MAL_IC_MODE_WATCHED_VALUE: return "watched";
        case MAL_IC_MODE_ACCESSOR_DECLINED: return "accessor-declined";
        case MAL_IC_MODE_OWN_GETTER: return "own-getter";
        case MAL_IC_MODE_DATA_VIEW_BYTE_LENGTH: return "data-view-byte-length";
        case MAL_IC_MODE_TYPED_ARRAY_BYTE_LENGTH: return "typed-array-byte-length";
        case MAL_IC_MODE_ARRAY_BUFFER_BYTE_LENGTH: return "array-buffer-byte-length";
        case MAL_IC_MODE_FUNCTION_METADATA: return "function-metadata";
        default: return nullptr;
    }
}

/** A tree shape whose keys are all strings has a name; symbol and private keys do not. */
static bool mal_feedback_shape_nameable(const MalShape *shape) {
    if (shape == nullptr || shape->tree_root == nullptr) return false;
    for (u16 index = 0; index < shape->inline_count; index++) {
        if (!mal_value_is_string(shape->props[index].key)) return false;
    }
    return true;
}

static void mal_feedback_write_shape(MalFeedbackBuffer *buffer, const MalShape *shape) {
    mal_feedback_u32(buffer, shape->inline_count);
    for (u16 index = 0; index < shape->inline_count; index++) {
        mal_feedback_u8(
            buffer,
            shape->props[index].attrs &
                (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE |
                 MAL_PROPERTY_ACCESSOR));
        usize length = 0;
        byte *utf8 = mal_string_to_utf8(mal_value_to_string(shape->props[index].key), &length);
        if (utf8 == nullptr || length > UINT32_MAX) {
            free(utf8);
            buffer->failed = true;
            return;
        }
        mal_feedback_u32(buffer, (u32) length);
        mal_feedback_write(buffer, utf8, length);
        free(utf8);
    }
}

static bool mal_feedback_row_empty(const MalInlineCache *ic) {
    return ic->mode == MAL_IC_MODE_SHAPE && ic->shape == nullptr && ic->key == 0;
}

static bool mal_feedback_rows_equal(const MalInlineCache *left, const MalInlineCache *right) {
    if (left->mode != right->mode || left->shape != right->shape || left->key != right->key ||
        left->poly_count != right->poly_count || left->megamorphic != right->megamorphic)
        return false;
    for (u8 index = 0; index < left->poly_count; index++) {
        if (left->poly_shape[index] != right->poly_shape[index]) return false;
    }
    return true;
}

/**
 * Replay the compiler-certified seeding of an interpreted function into scratch
 * rows. A live row still equal to its seed carries no runtime evidence: pools are
 * created, and seeded, with a function's first closure, before it runs.
 */
static MalInlineCache *mal_feedback_seeded_rows(MalVm *vm, const MalFunction *function) {
    if (function->instructions == nullptr) return nullptr;
    MalInlineCache *rows = nullptr;
    for (i32 ip = 0; ip < function->instruction_count; ip++) {
        const MalInstruction *instruction = &function->instructions[ip];
        i32 data_offset;
        i32 ic_index;
        if (instruction->opcode == MAL_OP_LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT) {
            data_offset = instruction->as.load_property_static_known_own_slot.data_offset;
            ic_index = instruction->as.load_property_static_known_own_slot.ic_index;
        } else if (instruction->opcode == MAL_OP_STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT) {
            data_offset = instruction->as.store_property_static_known_own_slot.data_offset;
            ic_index = instruction->as.store_property_static_known_own_slot.ic_index;
        } else {
            continue;
        }
        if (data_offset < 0 || data_offset > function->instruction_data_count - 2 ||
            ic_index < 0 || ic_index >= function->property_ic_count) {
            continue;
        }
        const i32 *data = &function->instruction_data[data_offset];
        i32 candidate_count = data[1];
        if (data[0] < 0 || data[0] >= vm->runtime_image->string_constant_count ||
            candidate_count <= 0 ||
            candidate_count > (function->instruction_data_count - data_offset - 2) / 3) {
            continue;
        }
        if (rows == nullptr) {
            rows = calloc((usize) function->property_ic_count, sizeof(MalInlineCache));
            if (rows == nullptr) return nullptr;
        }
        MalValue key = mal_value_from_string(vm->string_constant_atoms[data[0]]);
        mal_vm_seed_known_own_slot_ic(vm, &rows[ic_index], key, candidate_count, &data[2]);
    }
    return rows;
}

static MalFeedbackSite mal_feedback_site_init(const MalInlineCache *ic) {
    return (MalFeedbackSite) {.ic = ic, .kind = MAL_FEEDBACK_NO_KIND};
}

static void mal_feedback_note_shape(MalFeedbackSite *site, const MalShape *shape) {
    if (shape == nullptr || (site->flags & MAL_FEEDBACK_MEGAMORPHIC) != 0) return;
    for (u8 index = 0; index < site->shape_count; index++) {
        if (site->shapes[index] == shape) return;
    }
    if (!mal_feedback_shape_nameable(shape) || site->shape_count == MAL_FEEDBACK_SHAPE_LIMIT) {
        site->flags |= MAL_FEEDBACK_MEGAMORPHIC;
        return;
    }
    site->shapes[site->shape_count++] = shape;
}

/** Add a row's mode and, for own data slots, the receiver shapes it holds. */
static void mal_feedback_note_state(MalFeedbackSite *site, const MalInlineCache *ic) {
    if (mal_feedback_row_empty(ic)) return;
    site->observed = true;
    site->modes |= (u64) 1 << ic->mode;
    if (ic->megamorphic) site->flags |= MAL_FEEDBACK_MEGAMORPHIC;
    if (ic->mode != MAL_IC_MODE_SHAPE || ic->prim_kind != 0) return;
    mal_feedback_note_shape(site, ic->shape);
    for (u8 index = 0; index < ic->poly_count && index < MAL_IC_POLY_EXTRA; index++) {
        mal_feedback_note_shape(site, ic->poly_shape[index]);
    }
}

static void mal_feedback_write_text(MalFeedbackBuffer *buffer, const char *text) {
    usize length = strlen(text);
    mal_feedback_u8(buffer, (u8) length);
    mal_feedback_write(buffer, text, length);
}

/** Own-table rows, plain or holding an own accessor, read a dictionary receiver. */
static bool mal_feedback_dictionary_mode(u8 mode) {
    return mode == MAL_IC_MODE_OWN_TABLE || mode == MAL_IC_MODE_OWN_GETTER;
}

static const char *mal_feedback_kind_name(u8 type) {
    switch (type) {
        case MAL_FEEDBACK_NO_KIND:
        case MAL_HEAP_OBJECT: return "";
        case MAL_HEAP_FUNCTION_OBJECT: return "function";
        case MAL_HEAP_NATIVE_FUNCTION_OBJECT: return "native-function";
        case MAL_HEAP_BOUND_FUNCTION_OBJECT: return "bound-function";
        case MAL_HEAP_ARRAY_OBJECT: return "array";
        case MAL_HEAP_ARGUMENTS_OBJECT: return "arguments";
        case MAL_HEAP_PRIMITIVE_WRAPPER_OBJECT: return "primitive-wrapper";
        case MAL_HEAP_MAP_OBJECT: return "map";
        case MAL_HEAP_SET_OBJECT: return "set";
        case MAL_HEAP_PROMISE_OBJECT: return "promise";
        case MAL_HEAP_REGEXP_OBJECT: return "regexp";
        case MAL_HEAP_DATE_OBJECT: return "date";
        case MAL_HEAP_ARRAY_BUFFER_OBJECT: return "array-buffer";
        case MAL_HEAP_TYPED_ARRAY_OBJECT: return "typed-array";
        case MAL_HEAP_DATA_VIEW_OBJECT: return "data-view";
        case MAL_HEAP_PROXY_OBJECT: return "proxy";
        case MAL_HEAP_GENERATOR_OBJECT: return "generator";
        case MAL_HEAP_ITERATOR_OBJECT: return "iterator";
        case MAL_HEAP_MODULE_NAMESPACE_OBJECT: return "module-namespace";
        default: return nullptr;
    }
}

static void mal_feedback_write_site(
    MalFeedbackBuffer *buffer, const MalFeedbackSite *site, i32 ic_index
) {
    u8 flags = site->flags;
    const char *kind = mal_feedback_kind_name(site->kind);
    if (kind == nullptr) {
        flags |= MAL_FEEDBACK_MIXED_KINDS;
        kind = "";
    }
    const char *modes[64];
    u8 mode_count = 0;
    for (u8 mode = 0; mode < 64; mode++) {
        if ((site->modes & ((u64) 1 << mode)) == 0) continue;
        if (mal_feedback_dictionary_mode(mode)) {
            flags |= MAL_FEEDBACK_DICTIONARY;
            continue;
        }
        const char *name = mode == MAL_IC_MODE_SHAPE ? "own" : mal_feedback_mode_name(mode);
        if (name == nullptr) {
            flags |= MAL_FEEDBACK_MEGAMORPHIC;
            continue;
        }
        bool duplicate = false;
        for (u8 index = 0; !duplicate && index < mode_count; index++) {
            duplicate = strcmp(modes[index], name) == 0;
        }
        if (!duplicate) modes[mode_count++] = name;
    }
    mal_feedback_u32(buffer, (u32) ic_index);
    mal_feedback_u8(buffer, flags);
    mal_feedback_write_text(buffer, kind);
    mal_feedback_u8(buffer, mode_count);
    for (u8 index = 0; index < mode_count; index++) mal_feedback_write_text(buffer, modes[index]);
    mal_feedback_u8(buffer, site->shape_count);
    for (u8 index = 0; index < site->shape_count; index++) {
        mal_feedback_write_shape(buffer, site->shapes[index]);
    }
}

#if MAL_FEEDBACK_HISTORY
struct MalFeedbackHistory {
    MalFeedbackSite *sites;
    // A power of two, at most half full.
    usize capacity;
    usize count;
};

_Atomic(MalFeedbackHistory *) mal_feedback_history = nullptr;
#if !defined(__wasi__)
// Set before the history is published and never changed after.
static pthread_t g_feedback_thread;
#endif

/** The receiver's layout: a shape, or a dictionary whose own table has no shape to guard. */
static void mal_feedback_note_object(MalFeedbackSite *site, const MalObject *object) {
    site->observed = true;
    u8 type = (u8) object->header.type;
    if (site->kind == MAL_FEEDBACK_NO_KIND) site->kind = type;
    else if (site->kind != type) site->flags |= MAL_FEEDBACK_MIXED_KINDS;
    if (mal_object_has_public_overflow(object) || object->shape == nullptr ||
        object->shape->tree_root == nullptr) {
        site->flags |= MAL_FEEDBACK_DICTIONARY;
        return;
    }
    mal_feedback_note_shape(site, object->shape);
}

bool mal_feedback_recording_thread(void) {
#if defined(__wasi__)
    return true;
#else
    return pthread_equal(g_feedback_thread, pthread_self()) != 0;
#endif
}

static usize mal_feedback_slot(const MalFeedbackHistory *history, const MalInlineCache *ic) {
    usize mask = history->capacity - 1;
    usize index = (usize) (((u64) (uptr) ic * 0x9E3779B97F4A7C15ull) >> 32) & mask;
    while (history->sites[index].ic != nullptr && history->sites[index].ic != ic) {
        index = (index + 1) & mask;
    }
    return index;
}

static const MalFeedbackSite *mal_feedback_find(
    const MalFeedbackHistory *history, const MalInlineCache *ic
) {
    const MalFeedbackSite *site = &history->sites[mal_feedback_slot(history, ic)];
    return site->ic == ic ? site : nullptr;
}

/** The history entry of `ic`, created on first use; null only when memory runs out. */
static MalFeedbackSite *mal_feedback_site(MalFeedbackHistory *history, const MalInlineCache *ic) {
    if ((history->count + 1) * 2 > history->capacity) {
        usize capacity = history->capacity * 2;
        MalFeedbackSite *sites = calloc(capacity, sizeof(MalFeedbackSite));
        if (sites == nullptr) return nullptr;
        MalFeedbackSite *previous = history->sites;
        usize previous_capacity = history->capacity;
        history->sites = sites;
        history->capacity = capacity;
        for (usize index = 0; index < previous_capacity; index++) {
            if (previous[index].ic == nullptr) continue;
            history->sites[mal_feedback_slot(history, previous[index].ic)] = previous[index];
        }
        free(previous);
    }
    MalFeedbackSite *site = &history->sites[mal_feedback_slot(history, ic)];
    if (site->ic == nullptr) {
        *site = mal_feedback_site_init(ic);
        history->count++;
    }
    return site;
}

/** Record the row's state unless it is still the compiler's seed. */
static void mal_feedback_note_row(MalFeedbackSite *site, const MalInlineCache *ic) {
    if (site->seeded) {
        if (ic->mode == site->seed_mode && ic->shape == site->seed_shape &&
            ic->key == site->seed_key && ic->poly_count == site->seed_poly_count) {
            return;
        }
        site->seeded = false;
    }
    mal_feedback_note_state(site, ic);
}

void mal_feedback_observe_miss(
    MalFeedbackHistory *history, const MalInlineCache *ic, const MalObject *object,
    MalValue key, bool store
) {
    MalFeedbackSite *site = mal_feedback_site(history, ic);
    if (site == nullptr) return;
    mal_feedback_note_row(site, ic);
    site->observed = true;
    // A primitive receiver's mode names it fully.
    if (object == nullptr) return;
    mal_feedback_note_object(site, object);
    const MalShape *shape = object->shape;
    if (!mal_value_is_string(key) || mal_object_has_public_overflow(object) || shape == nullptr ||
        shape->tree_root == nullptr) {
        return;
    }
    i32 found = mal_shape_find(
        shape, (MalKey) {.kind = MAL_KEY_STRING, .value = key},
        store ? MAL_SHAPE_FIND_STORE_IC : MAL_SHAPE_FIND_LOAD_IC);
    if (found < 0) return;
    u8 attrs = shape->props[found].attrs;
    if ((attrs & MAL_PROPERTY_ACCESSOR) == 0 && (!store || (attrs & MAL_PROPERTY_WRITABLE) != 0))
        site->modes |= (u64) 1 << MAL_IC_MODE_SHAPE;
}

void mal_feedback_observe_receiver(
    MalFeedbackHistory *history, const MalInlineCache *ic, const MalObject *object
) {
    MalFeedbackSite *site = mal_feedback_site(history, ic);
    if (site != nullptr) mal_feedback_note_object(site, object);
}

void mal_feedback_observe_shared(
    MalFeedbackHistory *history, const MalInlineCache *ic, const MalObject *object, u8 mode
) {
    MalFeedbackSite *site = mal_feedback_site(history, ic);
    if (site == nullptr) return;
    site->observed = true;
    site->modes |= (u64) 1 << mode;
    if (object != nullptr) mal_feedback_note_object(site, object);
}

void mal_feedback_observe_row(MalFeedbackHistory *history, const MalInlineCache *ic) {
    if (mal_feedback_row_empty(ic)) return;
    MalFeedbackSite *site = mal_feedback_site(history, ic);
    if (site != nullptr) mal_feedback_note_row(site, ic);
}

void mal_feedback_observe_seed(MalFeedbackHistory *history, const MalInlineCache *ic) {
    MalFeedbackSite *site = mal_feedback_site(history, ic);
    if (site == nullptr || site->observed) return;
    site->seeded = true;
    site->seed_mode = ic->mode;
    site->seed_shape = ic->shape;
    site->seed_key = ic->key;
    site->seed_poly_count = ic->poly_count;
}
#endif

static void mal_feedback_serialize(MalVm *vm, MalFeedbackBuffer *buffer) {
    const MalRuntimeImage *image = vm->runtime_image;
    mal_feedback_write(buffer, "MALFDB02", 8);
    mal_feedback_u32(buffer, 2);
    mal_feedback_u32(buffer, (u32) image->function_count);
    usize record_count_offset = buffer->length;
    mal_feedback_u32(buffer, 0);
    u32 record_count = 0;
    if (vm->property_cache == nullptr) return;
#if MAL_FEEDBACK_HISTORY
    const MalFeedbackHistory *history =
        atomic_load_explicit(&mal_feedback_history, memory_order_relaxed);
#endif
    for (i32 function_index = 0; function_index < image->function_count; function_index++) {
        const MalPropertyCachePool *pool = &vm->property_cache[function_index];
        if (pool->sites == nullptr) continue;
        const MalFunction *function = &image->functions[function_index];
        MalInlineCache *seeded = mal_feedback_seeded_rows(vm, function);
        usize record_offset = buffer->length;
        mal_feedback_u32(buffer, (u32) function_index);
        mal_feedback_u32(buffer, (u32) function->property_ic_count);
        usize site_count_offset = buffer->length;
        mal_feedback_u32(buffer, 0);
        u32 site_count = 0;
        for (i32 ic_index = 0; ic_index < function->property_ic_count; ic_index++) {
            const MalInlineCache *ic = &pool->sites[ic_index];
            MalFeedbackSite site = mal_feedback_site_init(ic);
#if MAL_FEEDBACK_HISTORY
            const MalFeedbackSite *recorded = history == nullptr
                ? nullptr : mal_feedback_find(history, ic);
            if (recorded != nullptr && recorded->observed) site = *recorded;
#endif
            // The history and the final row together: a row still equal to its seed
            // carries no runtime evidence.
            if (seeded == nullptr || !mal_feedback_rows_equal(ic, &seeded[ic_index]))
                mal_feedback_note_state(&site, ic);
            if (!site.observed) continue;
            mal_feedback_write_site(buffer, &site, ic_index);
            site_count++;
        }
        free(seeded);
        if (site_count == 0) {
            if (!buffer->failed) buffer->length = record_offset;
            continue;
        }
        mal_feedback_patch_u32(buffer, site_count_offset, site_count);
        record_count++;
    }
    mal_feedback_patch_u32(buffer, record_count_offset, record_count);
}

static void mal_feedback_publish(MalVm *vm, const char *path) {
    MalFeedbackBuffer buffer = {0};
    mal_feedback_serialize(vm, &buffer);
    usize path_length = strlen(path);
    char *temporary = malloc(path_length + sizeof(".partial"));
    FILE *file = nullptr;
    if (!buffer.failed && temporary != nullptr) {
        memcpy(temporary, path, path_length);
        memcpy(temporary + path_length, ".partial", sizeof(".partial"));
        file = fopen(temporary, "wb");
    }
    bool written = file != nullptr && fwrite(buffer.bytes, 1, buffer.length, file) == buffer.length;
    if (file != nullptr && fclose(file) != 0) written = false;
    // A reader sees the previous dump or this complete one, never a torn file.
    if (!written || rename(temporary, path) != 0) {
        fprintf(stderr, "warning: could not write feedback capture %s\n", path);
        if (temporary != nullptr) remove(temporary);
    }
    free(temporary);
    free(buffer.bytes);
}

void mal_feedback_finish(MalVm *vm) {
    if (vm == nullptr || vm != g_feedback_vm) return;
    g_feedback_vm = nullptr;
#if !defined(__wasi__)
    sigaction(SIGINT, &g_feedback_previous_interrupt, nullptr);
    sigaction(SIGTERM, &g_feedback_previous_terminate, nullptr);
#endif
    mal_feedback_publish(vm, g_feedback_path);
    free(g_feedback_path);
    g_feedback_path = nullptr;
#if MAL_FEEDBACK_HISTORY
    // Other threads see the old pointer at most, and never follow it.
    MalFeedbackHistory *history = atomic_exchange(&mal_feedback_history, nullptr);
    if (history != nullptr) free(history->sites);
    free(history);
#endif
#if !defined(__wasi__)
    // The signal unwound the program instead of ending it, so end it now as the
    // signal would have, with the dump published.
    int signal_number = g_feedback_signal;
    if (signal_number != 0) raise(signal_number);
#endif
}

// process.exit() ends the process through exit(3) from inside the running
// program, so its isolate never reaches teardown.
static void mal_feedback_at_exit(void) {
    mal_feedback_finish(g_feedback_vm);
}

#if !defined(__wasi__)
// Like the profiler, defer the work to the mutator: terminating the isolate
// unwinds it to teardown, where the heap is consistent and the dump is written.
// A second signal ends the process at once, in case the program never polls.
static void mal_feedback_terminate_signal(int signal_number) {
    if (g_feedback_signal != 0) {
        signal(signal_number, SIG_DFL);
        raise(signal_number);
        return;
    }
    g_feedback_signal = signal_number;
    mal_gc_request_termination(g_feedback_termination, g_feedback_poll);
}
#endif

void mal_feedback_init(MalVm *vm) {
    const char *path = getenv("MAL_FEEDBACK_CAPTURE");
    if (path == nullptr || path[0] == '\0') return;
    bool unclaimed = false;
    if (!atomic_compare_exchange_strong(&g_feedback_claimed, &unclaimed, true)) return;
    g_feedback_path = strdup(path);
    if (g_feedback_path == nullptr) return;
    g_feedback_vm = vm;
#if MAL_FEEDBACK_HISTORY
    // Without memory for a history, the dump still reads the final rows.
    MalFeedbackHistory *history = calloc(1, sizeof(MalFeedbackHistory));
    if (history != nullptr) {
        history->capacity = 1024;
        history->sites = calloc(history->capacity, sizeof(MalFeedbackSite));
#if !defined(__wasi__)
        g_feedback_thread = pthread_self();
#endif
        if (history->sites != nullptr) atomic_store(&mal_feedback_history, history);
        else free(history);
    }
#endif
    atexit(mal_feedback_at_exit);
#if !defined(__wasi__)
    g_feedback_termination = mal_gc_current_termination_target();
    g_feedback_poll = mal_gc_current_poll_target();
    struct sigaction action = {0};
    action.sa_handler = mal_feedback_terminate_signal;
    sigemptyset(&action.sa_mask);
    action.sa_flags = SA_RESTART;
    // A signal the parent ignores, as a shell does for background jobs, stays ignored.
    sigaction(SIGINT, nullptr, &g_feedback_previous_interrupt);
    if (g_feedback_previous_interrupt.sa_handler != SIG_IGN) sigaction(SIGINT, &action, nullptr);
    sigaction(SIGTERM, nullptr, &g_feedback_previous_terminate);
    if (g_feedback_previous_terminate.sa_handler != SIG_IGN) sigaction(SIGTERM, &action, nullptr);
#endif
}
