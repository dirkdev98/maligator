#include "feedback.h"

#if !defined(__wasi__)
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
    MAL_FEEDBACK_SITE_SHAPES = 0,
    MAL_FEEDBACK_SITE_MEGAMORPHIC = 1,
    MAL_FEEDBACK_SITE_MODE = 2,
};

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

/** Only plain string keys with default data attributes on a tree shape have a name. */
static bool mal_feedback_shape_nameable(const MalShape *shape) {
    if (shape == nullptr || shape->tree_root == nullptr) return false;
    for (u16 index = 0; index < shape->inline_count; index++) {
        const MalShapeProp *prop = &shape->props[index];
        if (!mal_value_is_string(prop->key) || !mal_shape_attrs_are_default(prop->attrs))
            return false;
    }
    return true;
}

static void mal_feedback_write_shape(MalFeedbackBuffer *buffer, const MalShape *shape) {
    mal_feedback_u32(buffer, shape->inline_count);
    for (u16 index = 0; index < shape->inline_count; index++) {
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

static void mal_feedback_write_site(
    MalFeedbackBuffer *buffer, const MalInlineCache *ic, i32 ic_index
) {
    mal_feedback_u32(buffer, (u32) ic_index);
    if (ic->mode == MAL_IC_MODE_SHAPE) {
        const MalShape *shapes[1 + MAL_IC_POLY_EXTRA] = {ic->shape};
        u8 count = 1;
        for (u8 index = 0; index < ic->poly_count && count < countof(shapes); index++) {
            shapes[count++] = ic->poly_shape[index];
        }
        bool nameable = !ic->megamorphic;
        for (u8 index = 0; nameable && index < count; index++) {
            nameable = mal_feedback_shape_nameable(shapes[index]);
        }
        if (!nameable) {
            mal_feedback_u8(buffer, MAL_FEEDBACK_SITE_MEGAMORPHIC);
            return;
        }
        mal_feedback_u8(buffer, MAL_FEEDBACK_SITE_SHAPES);
        mal_feedback_u8(buffer, count);
        for (u8 index = 0; index < count; index++) mal_feedback_write_shape(buffer, shapes[index]);
        return;
    }
    const char *name = mal_feedback_mode_name(ic->mode);
    // An own property kept in a dictionary table has no shape to name.
    if (name == nullptr) {
        mal_feedback_u8(buffer, MAL_FEEDBACK_SITE_MEGAMORPHIC);
        return;
    }
    usize length = strlen(name);
    mal_feedback_u8(buffer, MAL_FEEDBACK_SITE_MODE);
    mal_feedback_u8(buffer, (u8) length);
    mal_feedback_write(buffer, name, length);
}

static void mal_feedback_serialize(MalVm *vm, MalFeedbackBuffer *buffer) {
    const MalRuntimeImage *image = vm->runtime_image;
    mal_feedback_write(buffer, "MALFDB01", 8);
    mal_feedback_u32(buffer, 1);
    mal_feedback_u32(buffer, (u32) image->function_count);
    usize record_count_offset = buffer->length;
    mal_feedback_u32(buffer, 0);
    u32 record_count = 0;
    if (vm->property_cache == nullptr) return;
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
            if (mal_feedback_row_empty(ic)) continue;
            if (seeded != nullptr && mal_feedback_rows_equal(ic, &seeded[ic_index])) continue;
            mal_feedback_write_site(buffer, ic, ic_index);
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
