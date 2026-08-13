#include "profile.h"

#if MAL_PROFILE

#include <errno.h>
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
#define MAL_PROFILE_ALLOCATION_INTERVAL 65536u

typedef struct MalProfileFrame {
    i32 function_index;
    i32 position_id;
} MalProfileFrame;

typedef struct MalProfileRecord {
    u64 timestamp_ns;
    u64 value;
    u64 delay_ns;
    u32 frame_offset;
    u32 frame_count;
    u8 kind;
} MalProfileRecord;

typedef struct MalProfileState {
    MalVm *vm;
    char *output_path;
    MalProfileRecord *records;
    MalProfileFrame *frames;
    u32 record_count;
    u32 frame_count;
    u32 dropped_records;
    u32 dropped_frames;
    u32 interval_us;
    u64 start_ns;
    u64 expected_sample_ns;
    usize allocation_budget;
    bool finished;
	struct sigaction previous_action;
	struct sigaction previous_interrupt_action;
	struct sigaction previous_terminate_action;
    struct itimerval previous_timer;
} MalProfileState;

static MalProfileState *g_profile = nullptr;
static volatile sig_atomic_t g_profile_pending_ticks = 0;
static volatile sig_atomic_t g_profile_termination_signal = 0;

static void mal_profile_signal(int signal_number) {
    (void) signal_number;
    if (g_profile_pending_ticks < 0x7fff) g_profile_pending_ticks++;
    mal_gc_poll = true;
}

static void mal_profile_terminate_signal(int signal_number) {
	g_profile_termination_signal = signal_number;
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

static u32 mal_profile_copy_stack(MalProfileState *state, MalVm *vm) {
    u32 start = state->frame_count;
    i32 interpreted = 0;
    i32 native = 0;
    while ((interpreted < vm->frame_count || native < vm->native_frame_count) &&
           state->frame_count - start < MAL_PROFILE_MAX_STACK) {
        while (native < vm->native_frame_count && vm->native_frames[native].hidden) native++;
        bool take_interpreted = interpreted < vm->frame_count;
        if (take_interpreted && native < vm->native_frame_count) {
            take_interpreted = vm->frames[interpreted].enter_seq <=
                               vm->native_frames[native].enter_seq;
        }
        if (state->frame_count >= MAL_PROFILE_MAX_FRAMES) {
            state->dropped_frames++;
            break;
        }
        MalProfileFrame *output = &state->frames[state->frame_count++];
        if (take_interpreted) {
            MalVmFrame *frame = &vm->frames[interpreted++];
            output->function_index = frame->function_index;
            output->position_id = mal_profile_position_for(
                frame->function, frame->instruction_pointer - 1);
        } else {
            MalNativeFrame *frame = &vm->native_frames[native++];
            output->function_index = frame->function_index;
            output->position_id = frame->pos_id;
        }
    }
    return state->frame_count - start;
}

static void mal_profile_record(
    MalProfileState *state, MalVm *vm, u8 kind, u64 value, u64 delay_ns,
    bool stack
) {
    if (state == nullptr || state->finished) return;
    if (state->record_count >= MAL_PROFILE_MAX_RECORDS) {
        state->dropped_records++;
        return;
    }
    u32 frame_offset = state->frame_count;
    u32 frame_count = stack ? mal_profile_copy_stack(state, vm) : 0;
    state->records[state->record_count++] = (MalProfileRecord) {
        .timestamp_ns = mal_monotonic_now_ns() - state->start_ns,
        .value = value,
        .delay_ns = delay_ns,
        .frame_offset = frame_offset,
        .frame_count = frame_count,
        .kind = kind,
    };
}

void mal_profile_safepoint(MalVm *vm) {
    MalProfileState *state = g_profile;
    sig_atomic_t ticks = g_profile_pending_ticks;
	if (state == nullptr || (ticks == 0 && g_profile_termination_signal == 0)) return;
	g_profile_pending_ticks = 0;
    if (ticks > 1) state->dropped_records += (u32) ticks - 1;
	if (ticks > 0) {
		u64 now = mal_monotonic_now_ns();
		u64 delay = now > state->expected_sample_ns ? now - state->expected_sample_ns : 0;
		mal_profile_record(state, vm, MAL_PROFILE_RECORD_CPU, 0, delay, true);
		u64 interval_ns = (u64) state->interval_us * 1000u;
		state->expected_sample_ns = delay > interval_ns * 4
			? now + interval_ns
			: state->expected_sample_ns + interval_ns * (u64) ticks;
	}
	if (g_profile_termination_signal != 0) {
		int termination_signal = g_profile_termination_signal;
		g_profile_termination_signal = 0;
		mal_profile_finish(vm);
		raise(termination_signal);
	}
}

void mal_profile_allocation(MalHeap *heap, usize size, u8 heap_type) {
    (void) heap_type;
    MalProfileState *state = (MalProfileState *) heap->profile_state;
    if (state == nullptr || state->finished) return;
    if (size < state->allocation_budget) {
        state->allocation_budget -= size;
        return;
    }
    state->allocation_budget = MAL_PROFILE_ALLOCATION_INTERVAL;
    mal_profile_record(state, state->vm, MAL_PROFILE_RECORD_ALLOCATION, (u64) size, 0, true);
}

void mal_profile_event(MalVm *vm, u8 kind, u64 value) {
    mal_profile_record(g_profile, vm, kind, value, 0, false);
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
    fwrite("MALPROF1", 1, 8, file);
    mal_profile_write_u32(file, 1);
    mal_profile_write_u32(file, state->record_count);
    mal_profile_write_u32(file, state->frame_count);
    mal_profile_write_u32(file, state->dropped_records);
    mal_profile_write_u32(file, state->dropped_frames);
    mal_profile_write_u32(file, state->interval_us);
    mal_profile_write_u64(file, state->start_ns);
    for (u32 index = 0; index < state->record_count; index++) {
        MalProfileRecord *record = &state->records[index];
        fputc(record->kind, file);
        for (u32 padding = 0; padding < 7; padding++) fputc(0, file);
        mal_profile_write_u64(file, record->timestamp_ns);
        mal_profile_write_u64(file, record->value);
        mal_profile_write_u64(file, record->delay_ns);
        mal_profile_write_u32(file, record->frame_offset);
        mal_profile_write_u32(file, record->frame_count);
    }
    for (u32 index = 0; index < state->frame_count; index++) {
        mal_profile_write_i32(file, state->frames[index].function_index);
        mal_profile_write_i32(file, state->frames[index].position_id);
    }
    if (fclose(file) != 0) {
        fprintf(stderr, "warning: could not finalize profile capture %s\n", state->output_path);
    }
}

void mal_profile_init(MalVm *vm) {
    const char *output_path = getenv("MAL_PROFILE_CAPTURE");
    if (output_path == nullptr || output_path[0] == '\0' || g_profile != nullptr) return;
    MalProfileState *state = calloc(1, sizeof(MalProfileState));
    if (state == nullptr) return;
    state->records = calloc(MAL_PROFILE_MAX_RECORDS, sizeof(MalProfileRecord));
    state->frames = calloc(MAL_PROFILE_MAX_FRAMES, sizeof(MalProfileFrame));
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
    state->expected_sample_ns = state->start_ns + (u64) state->interval_us * 1000u;
    state->allocation_budget = MAL_PROFILE_ALLOCATION_INTERVAL;
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
    vm->heap.profile_state = nullptr;
    g_profile = nullptr;
    mal_profile_publish(state);
    free(state->records);
    free(state->frames);
    free(state->output_path);
    free(state);
}

#endif
