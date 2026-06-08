#pragma once

#include "./defaults.h"
#include "object.h"
#include "value.h"
#include "vm.h"

/**
 * Generator lifecycle (subset of the spec [[GeneratorState]] values).
 */
typedef enum MalGeneratorState {
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

/**
 * A generator instance owning its suspended activation. The frame's
 * registers/arguments buffers live with the generator while suspended
 * (transferred off the VM frame stack on suspend, pushed back on resume) and
 * are freed when the generator completes.
 */
typedef struct MalGeneratorObject {
    MalObject object;
    MalGeneratorState state;
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
} MalGeneratorObject;

/**
 * Allocate a generator instance in the suspended-start state. The caller fills
 * in `frame` (typically by suspending the current activation into it).
 */
MalGeneratorObject *mal_generator_object_new(MalHeap *heap, MalObject *prototype);
