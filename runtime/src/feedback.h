#pragma once

typedef struct MalVm MalVm;

/**
 * Development feedback capture. When `MAL_FEEDBACK_CAPTURE` names a file, the
 * first isolate started in the process dumps what its property inline caches
 * hold once it stops: at teardown, at `exit()`, or after SIGINT/SIGTERM. The
 * caches are read as they are, so a run without the variable executes exactly
 * the same IC code; only isolate start and teardown pay one check.
 *
 * The dump is a little-endian binary file, translated by the CLI's
 * `src/feedback/` module:
 *   "MALFDB01", u32 version (1), u32 vm function count, u32 record count,
 *   per record: i32 function index, u32 property IC count, u32 site count,
 *   per site: u32 IC index, u8 kind, then by kind:
 *     shapes:      u8 shape count, per shape u32 key count, per key u32 byte
 *                  length and its UTF-8 bytes, in slot order;
 *     megamorphic: nothing;
 *     mode:        u8 name length and the mode's ASCII name.
 */
void mal_feedback_init(MalVm *vm);

/** Write the dump for `vm` once, while its heap is still alive. */
void mal_feedback_finish(MalVm *vm);
