#include "profile.h"

#if MAL_PROFILE

#include <errno.h>
#include <math.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>

#include "gc.h"
#include "heap.h"
#include "monotonic_clock.h"
#include "vm.h"

#define MAL_PROFILE_MAX_RECORDS 65536u
#define MAL_PROFILE_MAX_FRAMES 1048576u
#define MAL_PROFILE_MAX_STACK 128u
#define MAL_PROFILE_DEFAULT_INTERVAL_US 10000u
#define MAL_PROFILE_ALLOCATION_INTERVAL 524288u
#define MAL_PROFILE_MAX_COUNTER_SITES 65536u
#define MAL_PROFILE_INITIAL_RECORDS 1024u
#define MAL_PROFILE_INITIAL_FRAMES 8192u
#define MAL_PROFILE_MAX_ALLOCATION_COUNTERS 16384u
#define MAL_PROFILE_FRAME_COUNT_MASK 0x3fffffffu
#define MAL_PROFILE_FRAME_DEPTH_TRUNCATED 0x80000000u
#define MAL_PROFILE_FRAME_CAPACITY_TRUNCATED 0x40000000u

typedef struct MalProfileFrame {
    i32 function_index;
    i32 position_id;
    i32 site_id;
} MalProfileFrame;

typedef struct MalProfileRecord {
    u64 timestamp_ns;
    u64 value;
    u64 auxiliary;
    u32 frame_offset;
    u32 frame_count;
    u32 frame_omission;
    u8 kind;
    u8 allocation_storage;
    u8 allocation_family;
    u8 allocation_object_type;
} MalProfileRecord;

typedef struct MalProfileAllocationCounter {
    i32 site_id;
    u64 count;
    u64 requested_bytes;
    u64 charged_bytes;
    u8 storage;
    u8 family;
    u8 object_type;
    bool occupied;
} MalProfileAllocationCounter;

typedef struct MalProfileState {
    MalVm *vm;
    char *output_path;
    MalProfileRecord *records;
    MalProfileFrame *frames;
    u32 record_capacity;
    u32 frame_capacity;
    u32 record_count;
    u32 frame_count;
    u32 dropped_records;
    u32 dropped_frames;
    u32 interval_us;
    u64 start_ns;
    u64 expected_sample_cpu_ns;
    u64 allocation_rng;
    bool finished;
    bool compiler_enabled;
    u32 counter_site_count;
    u32 total_site_count;
    u64 *site_counters;
    u64 unattributed_site_counters[MAL_PROFILE_SITE_EVENT_COUNT];
    MalProfileAllocationCounter *allocation_counters;
    u32 allocation_counter_capacity;
    u32 allocation_counter_count;
    MalProfileAllocationCounter allocation_overflow;
    struct sigaction previous_action;
    struct sigaction previous_interrupt_action;
    struct sigaction previous_terminate_action;
    struct itimerval previous_timer;
} MalProfileState;

static MalProfileState *g_profile = nullptr;
static volatile sig_atomic_t g_profile_pending_ticks = 0;
static volatile sig_atomic_t g_profile_termination_signal = 0;
volatile sig_atomic_t mal_profile_poll_requested = 0;

static void mal_profile_signal(int signal_number) {
    (void) signal_number;
    if (g_profile_pending_ticks < 0x7fff) g_profile_pending_ticks++;
    mal_profile_poll_requested = 1;
    mal_gc_poll = true;
}

static void mal_profile_terminate_signal(int signal_number) {
    g_profile_termination_signal = signal_number;
    mal_profile_poll_requested = 1;
    mal_gc_poll = true;
}

static i32 mal_profile_position_for(const MalFunction *function, i32 ip) {
    i32 found = -1;
    for (i32 index = 0; index < function->position_count; index++) {
        if (function->positions[index].start_ip > ip) break;
        found = function->positions[index].pos_id;
    }
    return found;
}

static i32 mal_profile_site_for(const MalFunction *function, i32 ip) {
    if (function->profile_site_ids == nullptr || ip < 0 || ip >= function->instruction_count) {
        return -1;
    }
    return function->profile_site_ids[ip];
}

static i32 mal_profile_current_site(MalVm *vm) {
    return vm->profile_current_site_id;
}

#if MAL_PERF_STATS
void mal_profile_site_event(MalVm *vm, i32 site_id, u8 event, u64 value) {
    (void) vm;
    MalProfileState *state = g_profile;
    if (state == nullptr || state->finished || !state->compiler_enabled ||
        event >= MAL_PROFILE_SITE_EVENT_COUNT) {
        return;
    }
    if (site_id < 0 || (u32) site_id >= state->counter_site_count) {
        state->unattributed_site_counters[event] += value;
        return;
    }
    state->site_counters[(usize) event * state->counter_site_count + (u32) site_id] += value;
}

void mal_profile_safepoint_compiler(MalVm *vm) {
    MalProfileState *state = g_profile;
    if (state != nullptr && state->compiler_enabled) {
        mal_profile_site_event(
            vm, mal_profile_current_site(vm), MAL_PROFILE_SITE_SAFEPOINT, 1);
    }
}
#endif

static bool mal_profile_grow(
    void **items, u32 *capacity, u32 needed, u32 maximum, usize item_size
) {
    if (needed <= *capacity) return true;
    if (needed > maximum) return false;
    u32 next = *capacity == 0 ? 1 : *capacity;
    while (next < needed) {
        u32 grown = next > maximum / 2 ? maximum : next * 2;
        if (grown == next) break;
        next = grown;
    }
    void *resized = realloc(*items, (usize) next * item_size);
    if (resized == nullptr) return false;
    *items = resized;
    *capacity = next;
    return true;
}

typedef struct MalProfileStackCopy {
    u32 count;
    u32 omission;
} MalProfileStackCopy;

static MalProfileStackCopy mal_profile_copy_stack(MalProfileState *state, MalVm *vm) {
    u32 visible_native = 0;
    for (i32 index = 0; index < vm->native_frame_count; index++) {
        if (!vm->native_frames[index].hidden) visible_native++;
    }
    u32 total = (u32) vm->frame_count + visible_native;
    u32 target = total > MAL_PROFILE_MAX_STACK ? MAL_PROFILE_MAX_STACK : total;
    u32 omission_flags = total > target ? MAL_PROFILE_FRAME_DEPTH_TRUNCATED : 0;
    u32 available = MAL_PROFILE_MAX_FRAMES - state->frame_count;
    if (target > available) {
        target = available;
        omission_flags |= MAL_PROFILE_FRAME_CAPACITY_TRUNCATED;
    }
    if (!mal_profile_grow(
            (void **) &state->frames, &state->frame_capacity,
            state->frame_count + target, MAL_PROFILE_MAX_FRAMES,
            sizeof(MalProfileFrame))) {
        target = 0;
        omission_flags |= MAL_PROFILE_FRAME_CAPACITY_TRUNCATED;
    }

    u32 start = state->frame_count;
    u32 skip = total - target;
    u32 seen = 0;
    i32 interpreted = 0;
    i32 native = 0;
    while ((interpreted < vm->frame_count || native < vm->native_frame_count) &&
           state->frame_count - start < target) {
        while (native < vm->native_frame_count && vm->native_frames[native].hidden) native++;
        bool take_interpreted = interpreted < vm->frame_count;
        if (take_interpreted && native < vm->native_frame_count) {
            take_interpreted = vm->frames[interpreted].enter_seq <=
                               vm->native_frames[native].enter_seq;
        }
        i32 function_index;
        i32 position_id;
        i32 site_id;
        if (take_interpreted) {
            MalVmFrame *frame = &vm->frames[interpreted++];
            function_index = frame->function_index;
            i32 ip = frame->instruction_pointer - 1;
            position_id = mal_profile_position_for(frame->function, ip);
            site_id = mal_profile_site_for(frame->function, ip);
        } else {
            MalNativeFrame *frame = &vm->native_frames[native++];
            function_index = frame->function_index;
            position_id = frame->pos_id;
            site_id = frame->site_id;
        }
        if (seen++ < skip) continue;
        MalProfileFrame *output = &state->frames[state->frame_count++];
        output->function_index = function_index;
        output->position_id = position_id;
        output->site_id = site_id;
    }
    u32 count = state->frame_count - start;
    u32 omitted = total - count;
    state->dropped_frames += omitted;
    return (MalProfileStackCopy) {
        .count = count,
        .omission = omission_flags | (omitted & MAL_PROFILE_FRAME_COUNT_MASK),
    };
}

static void mal_profile_record(
    MalProfileState *state, MalVm *vm, u8 kind, u64 value, u64 auxiliary,
    bool stack, u8 allocation_storage, u8 allocation_family,
    u8 allocation_object_type
) {
    if (state == nullptr || state->finished) return;
    if (!mal_profile_grow(
            (void **) &state->records, &state->record_capacity,
            state->record_count + 1, MAL_PROFILE_MAX_RECORDS,
            sizeof(MalProfileRecord))) {
        state->dropped_records++;
        return;
    }
    u32 frame_offset = state->frame_count;
    MalProfileStackCopy copied = stack
        ? mal_profile_copy_stack(state, vm)
        : (MalProfileStackCopy) {0};
    state->records[state->record_count++] = (MalProfileRecord) {
        .timestamp_ns = mal_monotonic_now_ns() - state->start_ns,
        .value = value,
        .auxiliary = auxiliary,
        .frame_offset = frame_offset,
        .frame_count = copied.count,
        .frame_omission = copied.omission,
        .kind = kind,
        .allocation_storage = allocation_storage,
        .allocation_family = allocation_family,
        .allocation_object_type = allocation_object_type,
    };
}

static void mal_profile_record_cpu_ticks(
    MalProfileState *state, MalVm *vm, u32 ticks, u64 now_cpu
) {
    u32 available = MAL_PROFILE_MAX_RECORDS - state->record_count;
    u32 recorded = ticks > available ? available : ticks;
    if (recorded > 0 && !mal_profile_grow(
            (void **) &state->records, &state->record_capacity,
            state->record_count + recorded, MAL_PROFILE_MAX_RECORDS,
            sizeof(MalProfileRecord))) {
        recorded = 0;
    }
    state->dropped_records += ticks - recorded;

    u32 frame_offset = state->frame_count;
    MalProfileStackCopy copied = recorded > 0
        ? mal_profile_copy_stack(state, vm)
        : (MalProfileStackCopy) {0};
    u32 omitted = copied.omission & MAL_PROFILE_FRAME_COUNT_MASK;
    if (recorded > 1 && omitted > 0) {
        state->dropped_frames += omitted * (recorded - 1);
    }
    u64 timestamp_ns = mal_monotonic_now_ns() - state->start_ns;
    u64 interval_ns = (u64) state->interval_us * 1000u;
    u64 expected = state->expected_sample_cpu_ns;
    for (u32 index = 0; index < recorded; index++) {
        u64 tick_expected = expected + interval_ns * index;
        u64 delay = now_cpu > tick_expected ? now_cpu - tick_expected : 0;
        state->records[state->record_count++] = (MalProfileRecord) {
            .timestamp_ns = timestamp_ns,
            .auxiliary = delay,
            .frame_offset = frame_offset,
            .frame_count = copied.count,
            .frame_omission = copied.omission,
            .kind = MAL_PROFILE_RECORD_CPU,
            .allocation_storage = MAL_PROFILE_ALLOCATION_NONE,
            .allocation_family = MAL_PROFILE_ALLOCATION_FAMILY_UNKNOWN,
            .allocation_object_type = MAL_PROFILE_OBJECT_TYPE_NONE,
        };
    }

    u64 projected = expected + interval_ns * ticks;
    state->expected_sample_cpu_ns = now_cpu > projected + interval_ns * 4
        ? now_cpu + interval_ns
        : projected;
}

void mal_profile_safepoint_slow(MalVm *vm) {
    MalProfileState *state = g_profile;
    sigset_t blocked;
    sigset_t previous;
    sigemptyset(&blocked);
    sigaddset(&blocked, SIGPROF);
    sigaddset(&blocked, SIGINT);
    sigaddset(&blocked, SIGTERM);
    sigprocmask(SIG_BLOCK, &blocked, &previous);
    sig_atomic_t ticks = g_profile_pending_ticks;
    int termination_signal = g_profile_termination_signal;
    g_profile_pending_ticks = 0;
    g_profile_termination_signal = 0;
    mal_profile_poll_requested = 0;
    sigprocmask(SIG_SETMASK, &previous, nullptr);
    if (state == nullptr) return;
    if (ticks > 0) {
        u64 now_cpu = mal_process_cpu_now_ns();
        mal_profile_record_cpu_ticks(state, vm, (u32) ticks, now_cpu);
    }
    if (termination_signal != 0) {
        mal_profile_finish(vm);
        raise(termination_signal);
    }
}

static u64 mal_profile_random(MalProfileState *state) {
    u64 value = state->allocation_rng;
    value ^= value >> 12;
    value ^= value << 25;
    value ^= value >> 27;
    state->allocation_rng = value;
    return value * 2685821657736338717ull;
}

static usize mal_profile_next_allocation_budget(MalProfileState *state) {
    double unit = ((double) (mal_profile_random(state) >> 11) + 1.0)
        / 9007199254740993.0;
    double interval = -log(unit) * (double) MAL_PROFILE_ALLOCATION_INTERVAL;
    if (interval < 1.0) return 1;
    if (interval > (double) SIZE_MAX) return SIZE_MAX;
    return (usize) interval;
}

#if MAL_PERF_STATS
static u32 mal_profile_allocation_hash(
    i32 site_id, u8 storage, u8 family, u8 object_type
) {
    u32 value = (u32) site_id * 0x9e3779b1u;
    value ^= (u32) storage * 0x85ebca6bu;
    value ^= (u32) family * 0xc2b2ae35u;
    value ^= (u32) object_type * 0x27d4eb2fu;
    value ^= value >> 16;
    return value;
}

static void mal_profile_count_allocation(
    MalProfileState *state, i32 site_id, usize requested_size, usize charged_size,
    u8 storage, u8 family, u8 object_type
) {
    if (state->allocation_counter_capacity == 0) return;
    u32 mask = state->allocation_counter_capacity - 1;
    u32 slot = mal_profile_allocation_hash(site_id, storage, family, object_type) & mask;
    for (u32 probe = 0; probe < state->allocation_counter_capacity; probe++) {
        MalProfileAllocationCounter *counter = &state->allocation_counters[slot];
        if (!counter->occupied) {
            if (state->allocation_counter_count >=
                state->allocation_counter_capacity * 3 / 4) {
                break;
            }
            *counter = (MalProfileAllocationCounter) {
                .site_id = site_id,
                .storage = storage,
                .family = family,
                .object_type = object_type,
                .occupied = true,
            };
            state->allocation_counter_count++;
        }
        if (counter->site_id == site_id && counter->storage == storage &&
            counter->family == family && counter->object_type == object_type) {
            counter->count++;
            counter->requested_bytes += requested_size;
            counter->charged_bytes += charged_size;
            return;
        }
        slot = (slot + 1) & mask;
    }
    state->allocation_overflow.occupied = true;
    state->allocation_overflow.site_id = -2;
    state->allocation_overflow.count++;
    state->allocation_overflow.requested_bytes += requested_size;
    state->allocation_overflow.charged_bytes += charged_size;
}
#endif

void mal_profile_allocation(
    MalHeap *heap, usize requested_size, usize charged_size,
    MalProfileAllocationStorage storage, MalProfileAllocationFamily family,
    u8 object_type
) {
    MalProfileState *state = (MalProfileState *) heap->profile_state;
    if (state == nullptr || state->finished) return;
#if MAL_PERF_STATS
    if (state->compiler_enabled) {
        i32 site_id = mal_profile_current_site(state->vm);
        mal_profile_site_event(
            state->vm, site_id, MAL_PROFILE_SITE_ALLOCATION_COUNT, 1);
        mal_profile_site_event(
            state->vm, site_id, MAL_PROFILE_SITE_ALLOCATION_REQUESTED_BYTES,
            (u64) requested_size);
        mal_profile_site_event(
            state->vm, site_id, MAL_PROFILE_SITE_ALLOCATION_CHARGED_BYTES,
            (u64) charged_size);
        mal_profile_count_allocation(
            state, site_id, requested_size, charged_size,
            (u8) storage, (u8) family, object_type);
    }
#endif
    if (charged_size < heap->profile_allocation_budget) {
        heap->profile_allocation_budget -= charged_size;
        return;
    }
    heap->profile_allocation_budget = mal_profile_next_allocation_budget(state);
    mal_profile_record(
        state, state->vm, MAL_PROFILE_RECORD_ALLOCATION,
        (u64) requested_size, (u64) charged_size, true,
        (u8) storage, (u8) family, object_type);
}

void mal_profile_native_allocation(
    MalHeap *heap, usize size, MalProfileAllocationFamily family
) {
    mal_profile_allocation(
        heap, size, size, MAL_PROFILE_ALLOCATION_NATIVE_BACKING,
        family, MAL_PROFILE_OBJECT_TYPE_NONE);
}

void mal_profile_event(MalVm *vm, u8 kind, u64 value) {
#if MAL_PERF_STATS
    MalProfileState *state = g_profile;
    if (state != nullptr && state->compiler_enabled && kind == MAL_PROFILE_RECORD_GC_BEGIN) {
        mal_profile_site_event(
            vm, mal_profile_current_site(vm), MAL_PROFILE_SITE_GC, 1);
    }
#endif
    mal_profile_record(
        g_profile, vm, kind, value, 0, false,
        MAL_PROFILE_ALLOCATION_NONE, MAL_PROFILE_ALLOCATION_FAMILY_UNKNOWN,
        MAL_PROFILE_OBJECT_TYPE_NONE);
}

static void mal_profile_write_u32(FILE *file, u32 value) {
    u8 bytes[4];
    for (u32 index = 0; index < 4; index++) bytes[index] = (u8) (value >> (index * 8));
    fwrite(bytes, 1, sizeof(bytes), file);
}

static void mal_profile_write_i32(FILE *file, i32 value) {
    mal_profile_write_u32(file, (u32) value);
}

static void mal_profile_write_u64(FILE *file, u64 value) {
    u8 bytes[8];
    for (u32 index = 0; index < 8; index++) bytes[index] = (u8) (value >> (index * 8));
    fwrite(bytes, 1, sizeof(bytes), file);
}

static void mal_profile_publish(MalProfileState *state) {
    FILE *file = fopen(state->output_path, "wb");
    if (file == nullptr) {
        fprintf(stderr, "warning: could not write profile capture %s: %s\n",
                state->output_path, strerror(errno));
        return;
    }
    fwrite("MALPROF3", 1, 8, file);
    mal_profile_write_u32(file, 3);
    mal_profile_write_u32(file, state->record_count);
    mal_profile_write_u32(file, state->frame_count);
    mal_profile_write_u32(file, state->dropped_records);
    mal_profile_write_u32(file, state->dropped_frames);
    mal_profile_write_u32(file, state->interval_us);
    mal_profile_write_u64(file, state->start_ns);
    mal_profile_write_u64(file, MAL_PROFILE_ALLOCATION_INTERVAL);
    for (u32 index = 0; index < state->record_count; index++) {
        MalProfileRecord *record = &state->records[index];
        fputc(record->kind, file);
        fputc(record->allocation_storage, file);
        fputc(record->allocation_family, file);
        fputc(record->allocation_object_type, file);
        mal_profile_write_u32(file, record->frame_omission);
        mal_profile_write_u64(file, record->timestamp_ns);
        mal_profile_write_u64(file, record->value);
        mal_profile_write_u64(file, record->auxiliary);
        mal_profile_write_u32(file, record->frame_offset);
        mal_profile_write_u32(file, record->frame_count);
    }
    for (u32 index = 0; index < state->frame_count; index++) {
        mal_profile_write_i32(file, state->frames[index].function_index);
        mal_profile_write_i32(file, state->frames[index].position_id);
        mal_profile_write_i32(file, state->frames[index].site_id);
    }
    if (fclose(file) != 0) {
        fprintf(stderr, "warning: could not finalize profile capture %s\n", state->output_path);
    }
}

static void mal_profile_publish_site_counters(MalProfileState *state) {
    if (!state->compiler_enabled ||
        (state->counter_site_count > 0 && state->site_counters == nullptr)) return;
    usize output_length = strlen(state->output_path);
    char *path = malloc(output_length + sizeof(".compiler"));
    if (path == nullptr) return;
    memcpy(path, state->output_path, output_length);
    memcpy(path + output_length, ".compiler", sizeof(".compiler"));
    FILE *file = fopen(path, "wb");
    if (file == nullptr) {
        fprintf(stderr, "warning: could not write compiler profile %s: %s\n",
                path, strerror(errno));
        free(path);
        return;
    }
    u32 allocation_entry_count = state->allocation_counter_count
        + (state->allocation_overflow.occupied ? 1 : 0);
    fwrite("MALSITE2", 1, 8, file);
    mal_profile_write_u32(file, 2);
    mal_profile_write_u32(file, state->counter_site_count);
    mal_profile_write_u32(file, state->total_site_count);
    mal_profile_write_u32(file, MAL_PROFILE_SITE_EVENT_COUNT);
    mal_profile_write_u32(file, allocation_entry_count);
    mal_profile_write_u32(file, 0);
    for (u32 event = 0; event < MAL_PROFILE_SITE_EVENT_COUNT; event++) {
        mal_profile_write_u64(file, state->unattributed_site_counters[event]);
    }
    for (u32 event = 0; event < MAL_PROFILE_SITE_EVENT_COUNT; event++) {
        for (u32 site_id = 0; site_id < state->counter_site_count; site_id++) {
            mal_profile_write_u64(
                file, state->site_counters[(usize) event * state->counter_site_count + site_id]);
        }
    }
    for (u32 index = 0; index < state->allocation_counter_capacity; index++) {
        MalProfileAllocationCounter *counter = &state->allocation_counters[index];
        if (!counter->occupied) continue;
        mal_profile_write_i32(file, counter->site_id);
        fputc(counter->storage, file);
        fputc(counter->family, file);
        fputc(counter->object_type, file);
        fputc(0, file);
        mal_profile_write_u64(file, counter->count);
        mal_profile_write_u64(file, counter->requested_bytes);
        mal_profile_write_u64(file, counter->charged_bytes);
    }
    if (state->allocation_overflow.occupied) {
        MalProfileAllocationCounter *counter = &state->allocation_overflow;
        mal_profile_write_i32(file, counter->site_id);
        fputc(0, file);
        fputc(0, file);
        fputc(MAL_PROFILE_OBJECT_TYPE_NONE, file);
        fputc(0, file);
        mal_profile_write_u64(file, counter->count);
        mal_profile_write_u64(file, counter->requested_bytes);
        mal_profile_write_u64(file, counter->charged_bytes);
    }
    if (fclose(file) != 0) {
        fprintf(stderr, "warning: could not finalize compiler profile %s\n", path);
    }
    free(path);
}

void mal_profile_init(MalVm *vm) {
    const char *output_path = getenv("MAL_PROFILE_CAPTURE");
    if (output_path == nullptr || output_path[0] == '\0' || g_profile != nullptr) return;
    MalProfileState *state = calloc(1, sizeof(MalProfileState));
    if (state == nullptr) return;
    state->record_capacity = MAL_PROFILE_INITIAL_RECORDS;
    state->frame_capacity = MAL_PROFILE_INITIAL_FRAMES;
    state->records = calloc(state->record_capacity, sizeof(MalProfileRecord));
    state->frames = calloc(state->frame_capacity, sizeof(MalProfileFrame));
    usize output_length = strlen(output_path);
    state->output_path = malloc(output_length + 1);
    if (state->output_path != nullptr) memcpy(state->output_path, output_path, output_length + 1);
    if (state->records == nullptr || state->frames == nullptr || state->output_path == nullptr) {
        free(state->records);
        free(state->frames);
        free(state->output_path);
        free(state);
        return;
    }
    state->vm = vm;
    state->interval_us = MAL_PROFILE_DEFAULT_INTERVAL_US;
    const char *interval = getenv("MAL_PROFILE_INTERVAL_US");
    if (interval != nullptr) {
        unsigned long parsed = strtoul(interval, nullptr, 10);
        if (parsed >= 1000 && parsed <= 1000000) state->interval_us = (u32) parsed;
    }
    state->start_ns = mal_monotonic_now_ns();
    state->expected_sample_cpu_ns =
        mal_process_cpu_now_ns() + (u64) state->interval_us * 1000u;
    state->allocation_rng = state->start_ns ^ (u64) (uptr) state ^ 0x9e3779b97f4a7c15ull;
    if (state->allocation_rng == 0) state->allocation_rng = 1;
    vm->heap.profile_allocation_budget = mal_profile_next_allocation_budget(state);
    state->compiler_enabled = getenv("MAL_PROFILE_COMPILER") != nullptr;
#if MAL_PERF_STATS
    if (state->compiler_enabled) {
        state->total_site_count = vm->definition->profile_site_count > 0
            ? (u32) vm->definition->profile_site_count
            : 0;
        state->counter_site_count = state->total_site_count > MAL_PROFILE_MAX_COUNTER_SITES
            ? MAL_PROFILE_MAX_COUNTER_SITES
            : state->total_site_count;
        state->site_counters = calloc(
            (usize) state->counter_site_count * MAL_PROFILE_SITE_EVENT_COUNT,
            sizeof(u64));
        if (state->counter_site_count > 0 && state->site_counters == nullptr) {
            state->compiler_enabled = false;
        } else {
            u32 desired = state->counter_site_count > 512
                ? state->counter_site_count * 2 : 1024;
            state->allocation_counter_capacity = 1024;
            while (state->allocation_counter_capacity < desired &&
                   state->allocation_counter_capacity < MAL_PROFILE_MAX_ALLOCATION_COUNTERS) {
                state->allocation_counter_capacity *= 2;
            }
            state->allocation_counters = calloc(
                state->allocation_counter_capacity,
                sizeof(MalProfileAllocationCounter));
            if (state->allocation_counters == nullptr) {
                state->allocation_counter_capacity = 0;
            }
        }
    }
#else
    state->compiler_enabled = false;
#endif
    vm->heap.profile_state = state;
    g_profile = state;

    struct sigaction action = {0};
    action.sa_handler = mal_profile_signal;
    sigemptyset(&action.sa_mask);
    action.sa_flags = SA_RESTART;
    sigaction(SIGPROF, &action, &state->previous_action);
    struct sigaction termination_action = {0};
    termination_action.sa_handler = mal_profile_terminate_signal;
    sigemptyset(&termination_action.sa_mask);
    termination_action.sa_flags = SA_RESTART;
    sigaction(SIGINT, &termination_action, &state->previous_interrupt_action);
    sigaction(SIGTERM, &termination_action, &state->previous_terminate_action);
    struct itimerval timer = {0};
    timer.it_interval.tv_sec = state->interval_us / 1000000u;
    timer.it_interval.tv_usec = state->interval_us % 1000000u;
    timer.it_value = timer.it_interval;
    getitimer(ITIMER_PROF, &state->previous_timer);
    setitimer(ITIMER_PROF, &timer, nullptr);
}

void mal_profile_finish(MalVm *vm) {
    MalProfileState *state = g_profile;
    if (state == nullptr || state->vm != vm || state->finished) return;
    state->finished = true;
    setitimer(ITIMER_PROF, &state->previous_timer, nullptr);
    sigaction(SIGPROF, &state->previous_action, nullptr);
    sigaction(SIGINT, &state->previous_interrupt_action, nullptr);
    sigaction(SIGTERM, &state->previous_terminate_action, nullptr);
    g_profile_pending_ticks = 0;
    g_profile_termination_signal = 0;
    mal_profile_poll_requested = 0;
    vm->heap.profile_state = nullptr;
    vm->heap.profile_allocation_budget = 0;
    g_profile = nullptr;
    mal_profile_publish(state);
    mal_profile_publish_site_counters(state);
    free(state->records);
    free(state->frames);
    free(state->site_counters);
    free(state->allocation_counters);
    free(state->output_path);
    free(state);
}

#endif
