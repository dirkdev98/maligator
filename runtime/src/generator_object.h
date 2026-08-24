#pragma once

#include "./defaults.h"
#include "object.h"
#include "value.h"
#include "vm.h"

/**
 * Generator lifecycle (subset of the spec [[GeneratorState]] values).
 */
typedef enum MalGeneratorState : u8 {
    MAL_GENERATOR_SUSPENDED_START,
    MAL_GENERATOR_SUSPENDED_YIELD,
    MAL_GENERATOR_EXECUTING,
    MAL_GENERATOR_COMPLETED,
} MalGeneratorState;

/**
 * How a generator is resumed. The integer values are a fixed contract with the
 * compiler-emitted post-yield dispatch (see compileYieldExpression): the mode
 * is written into the yield's mode register and compared against these codes.
 */
typedef enum MalGeneratorResumeMode {
    MAL_GENERATOR_RESUME_NEXT = 0,
    MAL_GENERATOR_RESUME_THROW = 1,
    MAL_GENERATOR_RESUME_RETURN = 2,
} MalGeneratorResumeMode;

typedef struct MalGeneratorObject MalGeneratorObject;
typedef struct MalAsyncGeneratorRequest MalAsyncGeneratorRequest;

/**
 * State used only by async functions and async generators. Async generator
 * objects coallocate this immediately after the common generator object, while
 * synchronous generators omit it entirely.
 */
typedef struct MalGeneratorAsyncData {
    /** Direct intrinsic result promise for async functions. */
    MalValue promise;
    /** Async stack stitching to the function awaiting this result. */
    MalGeneratorObject *awaited_by;
    /** FIFO next/throw/return requests owned by an async generator. */
    MalAsyncGeneratorRequest *queue_head;
    MalAsyncGeneratorRequest *queue_tail;
} MalGeneratorAsyncData;

/**
 * A generator instance owning its suspended activation. The frame's
 * registers/arguments buffers live with the generator while suspended
 * (transferred off the VM frame stack on suspend, pushed back on resume) and
 * are returned to the VM's bounded buffer pool when the generator completes.
 */
struct MalGeneratorObject {
    MalObject object;
    MalVmFrame frame;

    /**
     * Registers in `frame` where a resume writes the sent value and the resume
     * mode code; recorded by the most recent YIELD.
     */
    i32 resume_value_register;
    i32 resume_mode_register;

    /**
     * The value handed out by the current suspension (gen -> caller).
     */
    MalValue yielded_value;

    /** Coallocated trailing state for async functions/generators; null for sync. */
    MalGeneratorAsyncData *async_data;

    /* State + flags clustered so the enum/bools share one trailing word. */
    MalGeneratorState state;
    /** This object is an async function's hidden state. */
    bool is_async : 1;
    /** `async function*`: sets is_async too, so await works. */
    bool is_async_generator : 1;
    /** Guards against re-entrant driving while the body is mid-step (awaiting). */
    bool agen_running : 1;
    /** The current call must still package a terminal yield as done:false. */
    bool terminal_yield_pending : 1;
};

static_assert(sizeof(MalGeneratorObject) <= (MAL_REALMS ? 208 : 192),
              "synchronous generator state outgrew its compact size class");
static_assert(sizeof(MalGeneratorObject) + sizeof(MalGeneratorAsyncData) <=
                  (MAL_REALMS ? 240 : 224),
              "coallocated async generator state outgrew its size class");

/**
 * A queued next/throw/return on an async generator: the intrinsic Promise the
 * engine settles directly, its request realm's %Promise% constructor anchor,
 * and the resume mode/value to deliver to the body. This remains the same three
 * MalValue fields as the former resolve/reject/value capability representation.
 */
struct MalAsyncGeneratorRequest {
    struct MalAsyncGeneratorRequest *next;
    MalValue promise;
    MalValue promise_constructor;
    i32 mode;
    MalValue value;
};

/**
 * Allocate a generator instance in the suspended-start state. The caller fills
 * in `frame` (typically by suspending the current activation into it).
 */
MalGeneratorObject *mal_generator_object_new(MalHeap *heap, MalObject *prototype);

/** Allocate a generator object with coallocated async-only state. */
MalGeneratorObject *mal_generator_object_new_async(
    MalHeap *heap, MalObject *prototype, bool is_async_generator);

/** Shade, release, and null all malloc-owned storage in a coroutine frame. */
void mal_generator_release_frame(MalVm *vm, MalGeneratorObject *generator);
