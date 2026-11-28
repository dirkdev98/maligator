#pragma once

#include <stdatomic.h>

#include "./defaults.h"
#include "value.h"

typedef struct MalVm MalVm;
struct MalInlineCache;
struct MalObject;

/**
 * Development feedback capture. When `MAL_FEEDBACK_CAPTURE` names a file, the
 * first isolate started in the process dumps what its property sites observed
 * once it stops: at teardown, at `exit()`, or after SIGINT/SIGTERM.
 *
 * Runtimes compiled with the development API, which run development images,
 * also keep an observation history per site: every receiver an inline cache
 * miss, slot-key hit or shared inherited row serves, and every state a row held
 * before a miss or an invalidation replaced it. Other runtimes compile none of
 * it, and read only the rows as they are at the end.
 *
 * The dump is a little-endian binary file, translated by the CLI's
 * `src/feedback/` module:
 *   "MALFDB02", u32 version (2), u32 vm function count, u32 record count,
 *   per record: i32 function index, u32 property IC count, u32 site count,
 *   per site: u32 IC index, u8 flags (1 megamorphic, 2 dictionary, 4 mixed or
 *   unnamed receiver kinds), u8 kind name length and its ASCII name (empty for
 *   ordinary objects), u8 mode count and per mode u8 name length and its ASCII
 *   name ("own" for own data slots), u8 shape count and per shape u32 key count,
 *   per key u8 attributes (1 writable, 2 enumerable, 4 configurable, 8 accessor),
 *   u32 byte length and its UTF-8 bytes, in slot order.
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
 * A miss at `ic` loading or storing `key` on `object`, null for a primitive
 * receiver: records the receiver, whether `key` is its own data property, and
 * the state the row holds now, which the miss may replace. Some receivers, such
 * as functions, are never cached in the row, so their own accesses are told here.
 */
void mal_feedback_observe_miss(
    MalFeedbackHistory *history, const struct MalInlineCache *ic,
    const struct MalObject *object, MalValue key, bool store);

/** A hit for `object` that `ic` serves without holding its shape. */
void mal_feedback_observe_receiver(
    MalFeedbackHistory *history, const struct MalInlineCache *ic, const struct MalObject *object);

/** `ic` answered `object`, null for a primitive, from VM-wide state in `mode`. */
void mal_feedback_observe_shared(
    MalFeedbackHistory *history, const struct MalInlineCache *ic,
    const struct MalObject *object, u8 mode);

/** The state `ic` holds before it is cleared. */
void mal_feedback_observe_row(MalFeedbackHistory *history, const struct MalInlineCache *ic);

/** `ic` was just seeded by the compiler's candidates, which no access observed yet. */
void mal_feedback_observe_seed(MalFeedbackHistory *history, const struct MalInlineCache *ic);

static inline MalFeedbackHistory *mal_feedback_recording(void) {
    MalFeedbackHistory *history =
        atomic_load_explicit(&mal_feedback_history, memory_order_relaxed);
    return __builtin_expect(history != nullptr, 0) && mal_feedback_recording_thread()
        ? history : nullptr;
}

static inline const struct MalObject *mal_feedback_object(MalValue value) {
    return mal_value_is_object(value) ? (const struct MalObject *) mal_value_to_heap(value) : nullptr;
}

#define MAL_FEEDBACK_OBSERVE_MISS(ic, object, key, store) do { \
    MalFeedbackHistory *mal_feedback_ = mal_feedback_recording(); \
    if (mal_feedback_ != nullptr) \
        mal_feedback_observe_miss(mal_feedback_, (ic), (object), (key), (store)); \
} while (0)
#define MAL_FEEDBACK_OBSERVE_RECEIVER(ic, object) do { \
    MalFeedbackHistory *mal_feedback_ = mal_feedback_recording(); \
    if (mal_feedback_ != nullptr) mal_feedback_observe_receiver(mal_feedback_, (ic), (object)); \
} while (0)
#define MAL_FEEDBACK_OBSERVE_SHARED(ic, object, mode) do { \
    MalFeedbackHistory *mal_feedback_ = mal_feedback_recording(); \
    if (mal_feedback_ != nullptr) \
        mal_feedback_observe_shared(mal_feedback_, (ic), (object), (mode)); \
} while (0)
#define MAL_FEEDBACK_OBSERVE_ROW(ic) do { \
    MalFeedbackHistory *mal_feedback_ = mal_feedback_recording(); \
    if (mal_feedback_ != nullptr) mal_feedback_observe_row(mal_feedback_, (ic)); \
} while (0)
#define MAL_FEEDBACK_OBSERVE_SEED(ic) do { \
    MalFeedbackHistory *mal_feedback_ = mal_feedback_recording(); \
    if (mal_feedback_ != nullptr) mal_feedback_observe_seed(mal_feedback_, (ic)); \
} while (0)
#else
#define MAL_FEEDBACK_OBSERVE_MISS(ic, object, key, store) ((void) 0)
#define MAL_FEEDBACK_OBSERVE_RECEIVER(ic, object) ((void) 0)
#define MAL_FEEDBACK_OBSERVE_SHARED(ic, object, mode) ((void) 0)
#define MAL_FEEDBACK_OBSERVE_ROW(ic) ((void) 0)
#define MAL_FEEDBACK_OBSERVE_SEED(ic) ((void) 0)
#endif
