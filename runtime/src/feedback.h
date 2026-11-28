#pragma once

#include <stdatomic.h>

#include "./defaults.h"
#include "value.h"

typedef struct MalVm MalVm;
struct MalInlineCache;
struct MalInstruction;
struct MalObject;

/**
 * Development feedback capture. When `MAL_FEEDBACK_CAPTURE` names a file, the
 * first isolate started in the process dumps what its property sites observed
 * once it stops: at teardown, at `exit()`, or after SIGINT/SIGTERM.
 *
 * Runtimes compiled with the development API, which run development images,
 * also keep an observation history per site: every receiver an inline cache
 * miss, slot-key hit or shared inherited row serves, every state a row held
 * before a miss or an invalidation replaced it, the functions those loads
 * produced, and the callees of the interpreter's plain calls. Other runtimes
 * compile none of it, and read only the rows as they are at the end.
 *
 * The dump is a little-endian binary file, translated by the CLI's
 * `src/feedback/` module:
 *   "MALFDB03", u32 version (3), u32 vm function count, u32 known primordial
 *   count, u32 record count,
 *   per record: i32 function index, u32 property IC count, u32 site count,
 *   per site: u32 IC index, u8 flags (1 megamorphic, 2 dictionary, 4 mixed or
 *   unnamed receiver kinds), u8 kind name length and its ASCII name (empty for
 *   ordinary objects), u8 primitive kind name length and its ASCII name (empty
 *   for none), u8 mode count and per mode u8 name length and its ASCII name
 *   ("own" for own data slots), u8 shape count and per shape u32 key count, per
 *   key u8 attributes (1 writable, 2 enumerable, 4 configurable, 8 accessor),
 *   u32 byte length and its UTF-8 bytes, in slot order, then the site's targets;
 *   then u32 call site count, per call site: u32 function index, u32 source
 *   position id of the call instruction, then its targets.
 *   Targets: u8 flags (1 megamorphic: a function without a portable name, or
 *   more than four), u8 count, per target u8 tag and u32 index: tag 1 is a
 *   source function's VM function index, tag 2 a known primordial node.
 */
void mal_feedback_init(MalVm *vm);

/** Write the dump for `vm` once, while its heap is still alive. */
void mal_feedback_finish(MalVm *vm);

#ifndef MAL_DEVELOPMENT_API
#define MAL_DEVELOPMENT_API 0
#endif

// A profiled build measures the code that ships, so it records no history.
#define MAL_FEEDBACK_HISTORY (MAL_DEVELOPMENT_API && !MAL_PROFILE)

#if MAL_FEEDBACK_HISTORY
typedef struct MalFeedbackHistory MalFeedbackHistory;

/**
 * The recording isolate's history, or null when nothing records. Other isolates'
 * threads read it too, so only its owner thread may follow it.
 */
extern _Atomic(MalFeedbackHistory *) mal_feedback_history;

/** Whether the calling thread runs the recording isolate. */
bool mal_feedback_recording_thread(void);

/**
 * A miss at `ic` loading or storing `key` on `receiver`: records the receiver,
 * whether `key` is its own data property, the function a load finds, and the
 * state the row holds now, which the miss may replace. Some receivers, such as
 * functions, are never cached in the row, so their own accesses are told here.
 */
void mal_feedback_observe_miss(
    MalFeedbackHistory *history, const struct MalInlineCache *ic,
    MalValue receiver, MalValue key, bool store);

/** A hit for `object` that `ic` serves without holding its shape, loading `value`. */
void mal_feedback_observe_receiver(
    MalFeedbackHistory *history, const struct MalInlineCache *ic,
    const struct MalObject *object, MalValue value);

/** `ic` answered `receiver` with `value` from VM-wide state in `mode`. */
void mal_feedback_observe_shared(
    MalFeedbackHistory *history, const struct MalInlineCache *ic,
    MalValue receiver, u8 mode, MalValue value);

/** The state `ic` holds before it is cleared. */
void mal_feedback_observe_row(MalFeedbackHistory *history, const struct MalInlineCache *ic);

/** `ic` was just seeded by the compiler's candidates, which no access observed yet. */
void mal_feedback_observe_seed(MalFeedbackHistory *history, const struct MalInlineCache *ic);

/**
 * The interpreter's `instruction` calls `callee` with `this_value`. Only plain
 * calls, which pass undefined or the global object, are recorded: a method
 * call's callee is the function its property site loaded, recorded there.
 */
void mal_feedback_observe_call(
    MalFeedbackHistory *history, const struct MalInstruction *instruction,
    MalValue callee, MalValue this_value);

static inline MalFeedbackHistory *mal_feedback_recording(void) {
    MalFeedbackHistory *history =
        atomic_load_explicit(&mal_feedback_history, memory_order_relaxed);
    return __builtin_expect(history != nullptr, 0) && mal_feedback_recording_thread()
        ? history : nullptr;
}

static inline MalValue mal_feedback_receiver(const struct MalObject *object) {
    return object == nullptr
        ? MAL_VALUE_UNDEFINED : mal_value_from_heap((MalHeapHeader *) object);
}

#define MAL_FEEDBACK_OBSERVE_MISS(ic, receiver, key, store) do { \
    MalFeedbackHistory *mal_feedback_ = mal_feedback_recording(); \
    if (mal_feedback_ != nullptr) \
        mal_feedback_observe_miss(mal_feedback_, (ic), (receiver), (key), (store)); \
} while (0)
#define MAL_FEEDBACK_OBSERVE_RECEIVER(ic, object, value) do { \
    MalFeedbackHistory *mal_feedback_ = mal_feedback_recording(); \
    if (mal_feedback_ != nullptr) \
        mal_feedback_observe_receiver(mal_feedback_, (ic), (object), (value)); \
} while (0)
#define MAL_FEEDBACK_OBSERVE_SHARED(ic, receiver, mode, value) do { \
    MalFeedbackHistory *mal_feedback_ = mal_feedback_recording(); \
    if (mal_feedback_ != nullptr) \
        mal_feedback_observe_shared(mal_feedback_, (ic), (receiver), (mode), (value)); \
} while (0)
#define MAL_FEEDBACK_OBSERVE_ROW(ic) do { \
    MalFeedbackHistory *mal_feedback_ = mal_feedback_recording(); \
    if (mal_feedback_ != nullptr) mal_feedback_observe_row(mal_feedback_, (ic)); \
} while (0)
#define MAL_FEEDBACK_OBSERVE_SEED(ic) do { \
    MalFeedbackHistory *mal_feedback_ = mal_feedback_recording(); \
    if (mal_feedback_ != nullptr) mal_feedback_observe_seed(mal_feedback_, (ic)); \
} while (0)
#define MAL_FEEDBACK_OBSERVE_CALL(instruction, callee, this_value) do { \
    MalFeedbackHistory *mal_feedback_ = mal_feedback_recording(); \
    if (mal_feedback_ != nullptr) \
        mal_feedback_observe_call(mal_feedback_, (instruction), (callee), (this_value)); \
} while (0)
#else
#define MAL_FEEDBACK_OBSERVE_MISS(ic, receiver, key, store) ((void) 0)
#define MAL_FEEDBACK_OBSERVE_RECEIVER(ic, object, value) ((void) 0)
#define MAL_FEEDBACK_OBSERVE_SHARED(ic, receiver, mode, value) ((void) 0)
#define MAL_FEEDBACK_OBSERVE_ROW(ic) ((void) 0)
#define MAL_FEEDBACK_OBSERVE_SEED(ic) ((void) 0)
#define MAL_FEEDBACK_OBSERVE_CALL(instruction, callee, this_value) ((void) 0)
#endif
