#include "node_readline.h"
#include "node_module.h"

#if MAL_NODE

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "array_object.h"
#include "builtin_data_view.h"
#include "builtin_iterator.h"
#include "builtin_promise.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "microtask.h"
#include "node_events.h"
#include "object.h"
#include "promise_object.h"
#include "typed_array_object.h"
#include "utf8.h"
#include "value_ops.h"
#include "vm_ops.h"

#define RL_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)
#define RL_STATE_KEY "maligator.readline.state"
#define RL_MIN_CRLF_DELAY 100.0
#define RL_ITERATOR_HIGH_WATER 1024

/* Slots of the native function that carries an interface's private state. */
enum {
    RL_SELF,
    RL_INPUT,
    RL_OUTPUT,
    RL_LINE_BUFFER,
    RL_SAW_RETURN_AT,
    RL_CARRY,
    RL_QUESTION,
    RL_OLD_PROMPT,
    RL_PROMPT,
    RL_CRLF_DELAY,
    RL_QUEUE,
    RL_WAITING,
    RL_ITERATING,
    RL_DATA_LISTENER,
    RL_END_LISTENER,
    RL_SLOTS,
};

static f64 rl_now_ms(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (f64) now.tv_sec * 1000.0 + (f64) now.tv_nsec / 1e6;
}

static MalValue rl_ascii(MalVm *vm, const char *text) {
    return mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) text));
}

static MalValue rl_get(MalVm *vm, MalValue object, const char *name) {
    MalValue value = mal_value_new_undefined();
    if (mal_value_is_object(object)) {
        mal_vm_get_property(vm, object, mal_intrinsic_string_key(vm, (const byte *) name), &value);
    }
    return value;
}

static void rl_set(MalVm *vm, MalValue object, const char *name, MalValue value) {
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    mal_intrinsic_define_data(vm, mal_value_to_object(object), (const byte *) name, value, RL_VISIBLE);
    mal_gc_unroot(&root);
}

static MalValue rl_call_method(MalVm *vm, MalValue target, const char *name, const MalValue *args, i32 argc) {
    MalValue method = rl_get(vm, target, name);
    if (vm->completion.kind == MAL_COMPLETION_THROW || !mal_value_is_callable(method)) {
        return mal_value_new_undefined();
    }
    MalCompletion completion = mal_vm_call_value(vm, method, target, args, argc);
    if (completion.kind == MAL_COMPLETION_THROW) {
        vm->completion = completion;
        return mal_value_new_undefined();
    }
    return completion.value;
}

static void rl_emit(MalVm *vm, MalValue self, const char *event, const MalValue *args, i32 argc) {
    MalValue roots[3] = {rl_ascii(vm, event)};
    for (i32 i = 0; i < argc && i < 2; i++) roots[1 + i] = args[i];
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    rl_call_method(vm, self, "emit", roots, 1 + argc);
    mal_gc_unroot(&root);
}

static MalNativeFunctionObject *rl_state_of(MalVm *vm, MalValue self) {
    if (!mal_value_is_object(self)) return nullptr;
    MalPropertyLookup found = mal_object_get_own(mal_value_to_object(self),
        mal_key_from_value(mal_node_registered_symbol(vm, RL_STATE_KEY)));
    if (!found.present || !mal_value_is_native_function_object(found.desc.value)) return nullptr;
    return mal_value_to_native_function_object(found.desc.value);
}

static MalNativeFunctionObject *rl_receiver_state(MalVm *vm, MalValue self) {
    MalNativeFunctionObject *state = rl_state_of(vm, self);
    if (state == nullptr) {
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Value of \"this\" must be of type Interface", "ERR_INVALID_THIS");
    }
    return state;
}

static MalValue rl_slot(MalNativeFunctionObject *state, i32 index) {
    return mal_native_function_object_get_slot(state, index);
}

static void rl_store(MalNativeFunctionObject *state, i32 index, MalValue value) {
    mal_native_function_object_set_slot(state, index, value);
}

static bool rl_flag(MalVm *vm, MalValue self, const char *name) {
    return mal_value_is_truthy(rl_get(vm, self, name));
}

static void rl_write_output(MalVm *vm, MalNativeFunctionObject *state, MalValue text) {
    MalValue output = rl_slot(state, RL_OUTPUT);
    if (mal_value_is_nil(output)) return;
    MalValue roots[] = {output, text};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    rl_call_method(vm, roots[0], "write", &roots[1], 1);
    mal_gc_unroot(&root);
}

static MalValue rl_pause(MalVm *vm, MalValue self, MalNativeFunctionObject *state) {
    if (rl_flag(vm, self, "paused")) return self;
    rl_call_method(vm, rl_slot(state, RL_INPUT), "pause", nullptr, 0);
    rl_set(vm, self, "paused", mal_value_new_boolean(true));
    rl_emit(vm, self, "pause", nullptr, 0);
    return self;
}

static MalValue rl_resume(MalVm *vm, MalValue self, MalNativeFunctionObject *state) {
    if (!rl_flag(vm, self, "paused")) return self;
    rl_call_method(vm, rl_slot(state, RL_INPUT), "resume", nullptr, 0);
    rl_set(vm, self, "paused", mal_value_new_boolean(false));
    rl_emit(vm, self, "resume", nullptr, 0);
    return self;
}

static void rl_iterator_settle(MalVm *vm, MalValue promise, MalValue value, bool done) {
    MalValue roots[] = {promise, mal_vm_create_iter_result(vm, value, done)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    mal_promise_settle_direct(vm, roots[0], vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR], false, roots[1]);
    mal_gc_unroot(&root);
}

/* lib/internal/readline/interface.js [kOnLine]: a pending question takes the line. */
static void rl_on_line(MalVm *vm, MalNativeFunctionObject *state, MalValue line) {
    MalValue roots[] = {rl_slot(state, RL_SELF), line, rl_slot(state, RL_QUESTION)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!mal_value_is_undefined(roots[2])) {
        rl_store(state, RL_QUESTION, mal_value_new_undefined());
        rl_store(state, RL_PROMPT, rl_slot(state, RL_OLD_PROMPT));
        if (mal_value_is_promise_object(roots[2])) {
            mal_promise_settle_direct(vm, roots[2], vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR], false, roots[1]);
        } else {
            MalCompletion completion = mal_vm_call_value(vm, roots[2], mal_value_new_undefined(), &roots[1], 1);
            if (completion.kind == MAL_COMPLETION_THROW) vm->completion = completion;
        }
    } else {
        rl_emit(vm, roots[0], "line", &roots[1], 1);
    }
    mal_gc_unroot(&root);
}

/* The async iterator sees every line the 'line' event would. */
static void rl_deliver(MalVm *vm, MalNativeFunctionObject *state, MalValue line) {
    bool question = !mal_value_is_undefined(rl_slot(state, RL_QUESTION));
    rl_on_line(vm, state, line);
    if (question || vm->completion.kind == MAL_COMPLETION_THROW
        || !mal_value_is_truthy(rl_slot(state, RL_ITERATING))) {
        return;
    }
    MalValue waiting = rl_slot(state, RL_WAITING);
    if (mal_value_is_promise_object(waiting)) {
        rl_store(state, RL_WAITING, mal_value_new_undefined());
        rl_iterator_settle(vm, waiting, line, false);
        return;
    }
    MalArrayObject *queue = mal_value_to_array_object(rl_slot(state, RL_QUEUE));
    u32 length = mal_array_object_length(queue);
    mal_array_object_store(queue, mal_key_index(length), line);
    if (length + 1 >= RL_ITERATOR_HIGH_WATER) rl_pause(vm, rl_slot(state, RL_SELF), state);
}

static bool rl_line_ending(const MalStringSegment *segment, usize index, usize *width) {
    c16 unit = segment->latin1 ? segment->latin1_units[index] : segment->utf16_units[index];
    if (unit == '\n') {
        *width = 1;
        return true;
    }
    if (unit != '\r') return false;
    *width = index + 1 < segment->length
        && (segment->latin1 ? segment->latin1_units[index + 1] : segment->utf16_units[index + 1]) == '\n'
        ? 2 : 1;
    return true;
}

/* Cons strings need two non-empty sides. */
static bool rl_concat(MalVm *vm, MalString *left, MalString *right, MalString **out) {
    if (mal_string_length(left) == 0) {
        *out = right;
        return true;
    }
    if (mal_string_length(right) == 0) {
        *out = left;
        return true;
    }
    if (mal_string_append_checked(&vm->heap, left, right, out)) return true;
    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid string length");
    return false;
}

/* [kNormalWrite]: split on \r\n, \n and a lone \r, keeping the unterminated tail. */
static void rl_normal_write(MalVm *vm, MalNativeFunctionObject *state, MalString *chunk) {
    MalValue roots[] = {mal_value_from_string(chunk), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    f64 saw_return = mal_ops_number_as_f64(rl_slot(state, RL_SAW_RETURN_AT));
    MalString *string = chunk;
    if (saw_return != 0) {
        f64 delay = mal_ops_number_as_f64(rl_slot(state, RL_CRLF_DELAY));
        if (rl_now_ms() - saw_return <= delay && mal_string_length(string) > 0
            && mal_string_code_unit_at(string, 0) == '\n') {
            string = mal_string_new_slice(&vm->heap, string, 1, mal_string_length(string) - 1);
            roots[0] = mal_value_from_string(string);
        }
        rl_store(state, RL_SAW_RETURN_AT, mal_value_from_i32(0));
    }
    MalStringSegment segment = mal_string_flat_segment(string);
    bool has_ending = false;
    for (usize i = 0; i < segment.length && !has_ending; i++) {
        c16 unit = segment.latin1 ? segment.latin1_units[i] : segment.utf16_units[i];
        has_ending = unit == '\n' || unit == '\r';
    }
    MalValue buffer = rl_slot(state, RL_LINE_BUFFER);
    if (!has_ending) {
        if (mal_string_length(string) > 0) {
            MalString *combined = string;
            if (mal_value_is_string(buffer) && !rl_concat(vm, mal_value_to_string(buffer), string, &combined)) {
                mal_gc_unroot(&root);
                return;
            }
            rl_store(state, RL_LINE_BUFFER, mal_value_from_string(combined));
        }
        mal_gc_unroot(&root);
        return;
    }
    if (mal_value_is_string(buffer)) {
        MalString *combined;
        if (!rl_concat(vm, mal_value_to_string(buffer), string, &combined)) {
            mal_gc_unroot(&root);
            return;
        }
        string = combined;
        roots[0] = mal_value_from_string(string);
        rl_store(state, RL_LINE_BUFFER, mal_value_new_undefined());
    }
    usize length = mal_string_length(string);
    if (length > 0 && mal_string_code_unit_at(string, length - 1) == '\r') {
        rl_store(state, RL_SAW_RETURN_AT, mal_value_from_f64(rl_now_ms()));
    }
    usize start = 0;
    for (usize i = 0; i < length && vm->completion.kind != MAL_COMPLETION_THROW;) {
        segment = mal_string_flat_segment(string);
        usize width;
        if (!rl_line_ending(&segment, i, &width)) {
            i++;
            continue;
        }
        roots[1] = mal_value_from_string(mal_string_new_slice(&vm->heap, string, start, i - start));
        i += width;
        start = i;
        rl_deliver(vm, state, roots[1]);
    }
    rl_store(state, RL_LINE_BUFFER, start < length
        ? mal_value_from_string(mal_string_new_slice(&vm->heap, string, start, length - start))
        : mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "")));
    mal_gc_unroot(&root);
}

static usize rl_utf8_sequence_length(u8 lead) {
    return lead < 0x80 ? 1 : (lead & 0xe0) == 0xc0 ? 2 : (lead & 0xf0) == 0xe0 ? 3 : (lead & 0xf8) == 0xf0 ? 4 : 1;
}

/* StringDecoder-style UTF-8: an incomplete trailing sequence waits for the next chunk. */
static MalString *rl_decode(MalVm *vm, MalNativeFunctionObject *state, const byte *bytes, usize length) {
    u32 carry = (u32) mal_value_to_i32(rl_slot(state, RL_CARRY));
    usize carried = carry >> 24;
    byte joined_storage[256];
    byte *joined = nullptr;
    if (carried > 0) {
        usize total = carried + length;
        joined = total <= sizeof joined_storage ? joined_storage : malloc(total);
        if (joined == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return nullptr;
        }
        for (usize i = 0; i < carried; i++) joined[i] = (byte) (carry >> (8 * (2 - i)));
        memcpy(joined + carried, bytes, length);
        bytes = joined;
        length = total;
    }
    usize keep = 0;
    for (usize back = 1; back <= 3 && back <= length; back++) {
        u8 unit = (u8) bytes[length - back];
        if ((unit & 0xc0) == 0x80) continue;
        if (rl_utf8_sequence_length(unit) > back) keep = back;
        break;
    }
    u32 next_carry = (u32) keep << 24;
    for (usize i = 0; i < keep; i++) next_carry |= (u32) (u8) bytes[length - keep + i] << (8 * (2 - i));
    rl_store(state, RL_CARRY, mal_value_from_i32((i32) next_carry));
    MalString *string = mal_string_from_utf8(&vm->heap, bytes, length - keep);
    if (joined != nullptr && joined != joined_storage) free(joined);
    if (string == nullptr) mal_vm_throw_allocation_error(vm);
    return string;
}

static MalValue rl_on_data(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target;
    MalNativeFunctionObject *state = mal_value_to_native_function_object(
        mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0));
    MalValue chunk = argc > 0 ? args[0] : mal_value_new_undefined();
    if (mal_value_is_string(chunk)) {
        rl_normal_write(vm, state, mal_value_to_string(chunk));
        return mal_value_new_undefined();
    }
    MalBufferSourceSpan span;
    if (mal_buffer_source_span(chunk, &span) != MAL_BUFFER_SOURCE_SPAN_OK) return mal_value_new_undefined();
    byte *copy = nullptr;
    const byte *bytes = span.data;
    if (span.shared && span.length > 0) {
        copy = malloc(span.length);
        if (copy == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return mal_value_new_undefined();
        }
        mal_buffer_source_span_read(&span, 0, copy, span.length);
        bytes = copy;
    }
    MalRootSpan root;
    mal_gc_root(&root, &chunk, 1);
    MalString *string = rl_decode(vm, state, bytes, span.length);
    free(copy);
    if (string != nullptr) rl_normal_write(vm, state, string);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static void rl_close(MalVm *vm, MalValue self, MalNativeFunctionObject *state) {
    if (rl_flag(vm, self, "closed")) return;
    rl_pause(vm, self, state);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return;
    MalValue roots[] = {self, rl_slot(state, RL_INPUT), rl_slot(state, RL_DATA_LISTENER),
        rl_slot(state, RL_END_LISTENER), rl_slot(state, RL_WAITING), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    rl_set(vm, self, "closed", mal_value_new_boolean(true));
    rl_emit(vm, self, "close", nullptr, 0);
    if (!mal_value_is_nil(roots[1])) {
        roots[5] = rl_ascii(vm, "data");
        MalValue data_args[] = {roots[5], roots[2]};
        rl_call_method(vm, roots[1], "removeListener", data_args, 2);
        roots[5] = rl_ascii(vm, "end");
        MalValue end_args[] = {roots[5], roots[3]};
        rl_call_method(vm, roots[1], "removeListener", end_args, 2);
    }
    if (mal_value_is_promise_object(roots[4])
        && mal_array_object_length(mal_value_to_array_object(rl_slot(state, RL_QUEUE))) == 0) {
        rl_store(state, RL_WAITING, mal_value_new_undefined());
        rl_iterator_settle(vm, roots[4], mal_value_new_undefined(), true);
    }
    mal_gc_unroot(&root);
}

static MalValue rl_on_end(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) args, (void) argc, (void) new_target;
    MalNativeFunctionObject *state = mal_value_to_native_function_object(
        mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0));
    MalValue roots[] = {rl_slot(state, RL_SELF), rl_slot(state, RL_LINE_BUFFER)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    u32 carry = (u32) mal_value_to_i32(rl_slot(state, RL_CARRY));
    if ((carry >> 24) > 0) {
        // A truncated final sequence decodes to U+FFFD, as StringDecoder.end() does.
        rl_store(state, RL_CARRY, mal_value_from_i32(0));
        MalString *tail;
        MalString *replacement = mal_string_from_utf8(&vm->heap, (const byte *) "\xef\xbf\xbd", 3);
        if (replacement != nullptr) {
            if (!mal_value_is_string(roots[1]) || !rl_concat(vm, mal_value_to_string(roots[1]), replacement, &tail)) {
                tail = replacement;
            }
            roots[1] = mal_value_from_string(tail);
        }
    }
    if (mal_value_is_string(roots[1]) && mal_string_length(mal_value_to_string(roots[1])) > 0) {
        rl_store(state, RL_LINE_BUFFER, mal_value_new_undefined());
        rl_emit(vm, roots[0], "line", &roots[1], 1);
        if (mal_value_is_truthy(rl_slot(state, RL_ITERATING)) && vm->completion.kind != MAL_COMPLETION_THROW) {
            MalValue waiting = rl_slot(state, RL_WAITING);
            if (mal_value_is_promise_object(waiting)) {
                rl_store(state, RL_WAITING, mal_value_new_undefined());
                rl_iterator_settle(vm, waiting, roots[1], false);
            } else {
                MalArrayObject *queue = mal_value_to_array_object(rl_slot(state, RL_QUEUE));
                mal_array_object_store(queue, mal_key_index(mal_array_object_length(queue)), roots[1]);
            }
        }
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW) rl_close(vm, roots[0], state);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue rl_new_listener(MalVm *vm, MalValue state, MalNativeFunctionCallback callback) {
    return mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) ""), 1, callback, &state, 1));
}

/* InterfaceConstructor(input, output, completer, terminal) or ({ input, ... }). */
static MalValue rl_construct(MalVm *vm, MalValue prototype, const MalValue *args, i32 argc) {
    enum { SELF, INPUT, OUTPUT, OPTIONS, STATE, TEMP, PROMPT, ROOT_COUNT };
    MalValue roots[ROOT_COUNT];
    for (usize i = 0; i < countof(roots); i++) roots[i] = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[INPUT] = argc > 0 ? args[0] : mal_value_new_undefined();
    roots[OUTPUT] = argc > 1 ? args[1] : mal_value_new_undefined();
    MalValue completer = argc > 2 ? args[2] : mal_value_new_undefined();
    MalValue terminal = argc > 3 ? args[3] : mal_value_new_undefined();
    f64 crlf_delay = RL_MIN_CRLF_DELAY;
    roots[PROMPT] = rl_ascii(vm, "> ");
    MalValue nested_input = rl_get(vm, roots[INPUT], "input");
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto failed;
    if (!mal_value_is_nil(nested_input)) {
        roots[OPTIONS] = roots[INPUT];
        roots[INPUT] = nested_input;
        roots[OUTPUT] = rl_get(vm, roots[OPTIONS], "output");
        completer = rl_get(vm, roots[OPTIONS], "completer");
        terminal = rl_get(vm, roots[OPTIONS], "terminal");
        roots[TEMP] = rl_get(vm, roots[OPTIONS], "prompt");
        if (!mal_value_is_undefined(roots[TEMP])) roots[PROMPT] = roots[TEMP];
        roots[TEMP] = rl_get(vm, roots[OPTIONS], "crlfDelay");
        if (mal_ops_is_number(roots[TEMP]) && mal_ops_number_as_f64(roots[TEMP]) > RL_MIN_CRLF_DELAY) {
            crlf_delay = mal_ops_number_as_f64(roots[TEMP]);
        }
        if (vm->completion.kind == MAL_COMPLETION_THROW) goto failed;
    }
    if (!mal_value_is_undefined(completer) && !mal_value_is_callable(completer)) {
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The argument 'completer' is invalid. Received a non-function value", "ERR_INVALID_ARG_VALUE");
        goto failed;
    }
    if (mal_value_is_undefined(terminal) && !mal_value_is_nil(roots[OUTPUT])) {
        terminal = mal_value_new_boolean(rl_flag(vm, roots[OUTPUT], "isTTY"));
    }
    roots[SELF] = mal_value_from_object(mal_object_new(&vm->heap, mal_value_to_object(prototype)));
    MalCompletion init = mal_vm_call_value(vm, vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_CONSTRUCTOR],
        roots[SELF], nullptr, 0);
    if (init.kind == MAL_COMPLETION_THROW) {
        vm->completion = init;
        goto failed;
    }
    MalValue slots[RL_SLOTS];
    for (usize i = 0; i < countof(slots); i++) slots[i] = mal_value_new_undefined();
    slots[RL_SELF] = roots[SELF];
    slots[RL_INPUT] = roots[INPUT];
    slots[RL_OUTPUT] = roots[OUTPUT];
    slots[RL_SAW_RETURN_AT] = mal_value_from_i32(0);
    slots[RL_CARRY] = mal_value_from_i32(0);
    slots[RL_PROMPT] = roots[PROMPT];
    slots[RL_CRLF_DELAY] = mal_value_from_f64(crlf_delay);
    slots[RL_ITERATING] = mal_value_new_boolean(false);
    roots[STATE] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) ""), 0, rl_on_data, slots, RL_SLOTS));
    MalNativeFunctionObject *state = mal_value_to_native_function_object(roots[STATE]);
    rl_store(state, RL_QUEUE, mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0)));
    MalPropertyDesc state_desc = mal_intrinsic_data_desc(roots[STATE], MAL_PROPERTY_NONE);
    mal_object_define_own(mal_value_to_object(roots[SELF]),
        mal_key_from_value(mal_node_registered_symbol(vm, RL_STATE_KEY)), &state_desc);
    rl_set(vm, roots[SELF], "terminal", mal_value_new_boolean(mal_value_is_truthy(terminal)));
    rl_set(vm, roots[SELF], "line", rl_ascii(vm, ""));
    rl_set(vm, roots[SELF], "cursor", mal_value_from_i32(0));
    rl_set(vm, roots[SELF], "history", mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0)));
    rl_set(vm, roots[SELF], "historySize", mal_value_from_i32(30));
    rl_set(vm, roots[SELF], "crlfDelay", mal_value_from_f64(crlf_delay));
    rl_set(vm, roots[SELF], "completer", completer);
    rl_set(vm, roots[SELF], "input", roots[INPUT]);
    rl_set(vm, roots[SELF], "output", roots[OUTPUT]);
    rl_set(vm, roots[SELF], "paused", mal_value_new_boolean(false));
    rl_set(vm, roots[SELF], "closed", mal_value_new_boolean(false));
    if (!mal_value_is_nil(roots[INPUT])) {
        roots[TEMP] = rl_new_listener(vm, roots[STATE], rl_on_data);
        rl_store(state, RL_DATA_LISTENER, roots[TEMP]);
        MalValue data_args[] = {rl_ascii(vm, "data"), roots[TEMP]};
        rl_call_method(vm, roots[INPUT], "on", data_args, 2);
        roots[TEMP] = rl_new_listener(vm, roots[STATE], rl_on_end);
        rl_store(state, RL_END_LISTENER, roots[TEMP]);
        MalValue end_args[] = {rl_ascii(vm, "end"), roots[TEMP]};
        rl_call_method(vm, roots[INPUT], "on", end_args, 2);
        rl_call_method(vm, roots[INPUT], "resume", nullptr, 0);
        if (vm->completion.kind == MAL_COMPLETION_THROW) goto failed;
    }
    MalValue result = roots[SELF];
    mal_gc_unroot(&root);
    return result;
failed:
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue rl_interface_prototype(MalVm *vm, bool promises);

static MalValue rl_interface_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver;
    MalValue target = mal_value_is_undefined(new_target) ? callee : new_target;
    MalValue prototype = mal_vm_function_prototype(vm, target);
    if (!mal_value_is_object(prototype)) {
        prototype = rl_interface_prototype(vm, mal_value_is_truthy(
            mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0)));
    }
    return rl_construct(vm, prototype, args, argc);
}

static MalValue rl_create_interface(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target;
    bool promises = mal_value_is_truthy(mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 0));
    return rl_construct(vm, rl_interface_prototype(vm, promises), args, argc);
}

static MalValue rl_method_pause(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args, (void) argc, (void) nt, (void) callee;
    MalNativeFunctionObject *state = rl_receiver_state(vm, self);
    return state == nullptr ? mal_value_new_undefined() : rl_pause(vm, self, state);
}

static MalValue rl_method_resume(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args, (void) argc, (void) nt, (void) callee;
    MalNativeFunctionObject *state = rl_receiver_state(vm, self);
    return state == nullptr ? mal_value_new_undefined() : rl_resume(vm, self, state);
}

static MalValue rl_method_close(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args, (void) argc, (void) nt, (void) callee;
    MalNativeFunctionObject *state = rl_receiver_state(vm, self);
    if (state != nullptr) rl_close(vm, self, state);
    return mal_value_new_undefined();
}

static MalValue rl_method_set_prompt(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt, (void) callee;
    MalNativeFunctionObject *state = rl_receiver_state(vm, self);
    if (state != nullptr) rl_store(state, RL_PROMPT, argc > 0 ? args[0] : mal_value_new_undefined());
    return mal_value_new_undefined();
}

static MalValue rl_method_get_prompt(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args, (void) argc, (void) nt, (void) callee;
    MalNativeFunctionObject *state = rl_receiver_state(vm, self);
    return state == nullptr ? mal_value_new_undefined() : rl_slot(state, RL_PROMPT);
}

static MalValue rl_method_prompt(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args, (void) argc, (void) nt, (void) callee;
    MalNativeFunctionObject *state = rl_receiver_state(vm, self);
    if (state == nullptr) return mal_value_new_undefined();
    if (rl_flag(vm, self, "closed")) {
        mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "readline was closed", "ERR_USE_AFTER_CLOSE");
        return mal_value_new_undefined();
    }
    rl_resume(vm, self, state);
    if (vm->completion.kind != MAL_COMPLETION_THROW) rl_write_output(vm, state, rl_slot(state, RL_PROMPT));
    return mal_value_new_undefined();
}

static MalValue rl_method_write(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt, (void) callee;
    MalNativeFunctionObject *state = rl_receiver_state(vm, self);
    if (state == nullptr) return mal_value_new_undefined();
    if (rl_flag(vm, self, "closed")) {
        mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "readline was closed", "ERR_USE_AFTER_CLOSE");
        return mal_value_new_undefined();
    }
    rl_resume(vm, self, state);
    MalValue data = argc > 0 ? args[0] : mal_value_new_undefined();
    if (vm->completion.kind == MAL_COMPLETION_THROW || mal_value_is_undefined(data)) return mal_value_new_undefined();
    MalValue callee_args[] = {data};
    MalValue listener = rl_slot(state, RL_DATA_LISTENER);
    if (mal_value_is_callable(listener)) mal_vm_call_value(vm, listener, mal_value_new_undefined(), callee_args, 1);
    return mal_value_new_undefined();
}

/* readline's question(query[, options], cb) and readline/promises' question(query[, options]). */
static MalValue rl_method_question(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    bool promises = mal_value_is_truthy(mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 0));
    MalNativeFunctionObject *state = rl_receiver_state(vm, self);
    if (state == nullptr) return mal_value_new_undefined();
    MalValue roots[] = {argc > 0 ? args[0] : mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    if (promises) {
        MalValue resolve, reject;
        mal_promise_new_direct_capability(vm, &roots[1], &resolve, &reject);
        result = roots[1];
    } else {
        roots[1] = argc > 2 ? args[2] : argc > 1 ? args[1] : mal_value_new_undefined();
    }
    if (rl_flag(vm, self, "closed")) {
        mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "readline was closed", "ERR_USE_AFTER_CLOSE");
        if (promises) {
            roots[2] = vm->completion.value;
            vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
            mal_promise_settle_direct(vm, roots[1], vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR], true, roots[2]);
        }
        mal_gc_unroot(&root);
        return result;
    }
    if (!promises && !mal_value_is_callable(roots[1])) {
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    if (mal_value_is_undefined(rl_slot(state, RL_QUESTION))) {
        rl_store(state, RL_OLD_PROMPT, rl_slot(state, RL_PROMPT));
        rl_store(state, RL_PROMPT, roots[0]);
        rl_store(state, RL_QUESTION, roots[1]);
    }
    rl_resume(vm, self, state);
    if (vm->completion.kind != MAL_COMPLETION_THROW) rl_write_output(vm, state, rl_slot(state, RL_PROMPT));
    mal_gc_unroot(&root);
    return result;
}

static MalNativeFunctionObject *rl_iterator_state(MalVm *vm, MalValue callee) {
    return rl_state_of(vm, mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0));
}

static MalValue rl_iterator_next(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self, (void) args, (void) argc, (void) nt;
    MalNativeFunctionObject *state = rl_iterator_state(vm, callee);
    MalValue roots[] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue resolve, reject;
    mal_promise_new_direct_capability(vm, &roots[0], &resolve, &reject);
    MalArrayObject *queue = mal_value_to_array_object(rl_slot(state, RL_QUEUE));
    u32 length = mal_array_object_length(queue);
    MalValue interface = rl_slot(state, RL_SELF);
    if (length > 0) {
        mal_array_object_dense_get(queue, 0, &roots[1]);
        for (u32 i = 1; i < length; i++) {
            MalValue moved;
            mal_array_object_dense_get(queue, i, &moved);
            mal_array_object_store(queue, mal_key_index(i - 1), moved);
        }
        mal_array_object_set_length(queue, length - 1);
        if (length - 1 == 0 && !rl_flag(vm, interface, "closed")) rl_resume(vm, interface, state);
        rl_iterator_settle(vm, roots[0], roots[1], false);
    } else if (rl_flag(vm, interface, "closed")) {
        rl_iterator_settle(vm, roots[0], mal_value_new_undefined(), true);
    } else {
        rl_store(state, RL_WAITING, roots[0]);
    }
    mal_gc_unroot(&root);
    return roots[0];
}

static MalValue rl_iterator_return(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self, (void) nt;
    MalNativeFunctionObject *state = rl_iterator_state(vm, callee);
    MalValue roots[] = {rl_slot(state, RL_SELF), mal_value_new_undefined(), rl_slot(state, RL_WAITING)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    rl_close(vm, roots[0], state);
    MalValue resolve, reject;
    mal_promise_new_direct_capability(vm, &roots[1], &resolve, &reject);
    rl_iterator_settle(vm, roots[1], argc > 0 ? args[0] : mal_value_new_undefined(), true);
    mal_gc_unroot(&root);
    return roots[1];
}

static MalValue rl_iterator_self(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) vm, (void) args, (void) argc, (void) nt, (void) callee;
    return self;
}

static MalValue rl_method_async_iterator(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args, (void) argc, (void) nt, (void) callee;
    MalNativeFunctionObject *state = rl_receiver_state(vm, self);
    if (state == nullptr) return mal_value_new_undefined();
    rl_store(state, RL_ITERATING, mal_value_new_boolean(true));
    MalValue roots[] = {self, mal_value_from_object(mal_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ASYNC_ITERATOR_PROTOTYPE]))), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    static const struct {
        const char *name;
        MalNativeFunctionCallback callback;
    } methods[] = {{"next", rl_iterator_next}, {"return", rl_iterator_return}};
    for (usize i = 0; i < countof(methods); i++) {
        roots[2] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) methods[i].name), 0, methods[i].callback, &roots[0], 1));
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]), (const byte *) methods[i].name, roots[2],
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    }
    mal_gc_unroot(&root);
    return roots[1];
}

static MalValue rl_method_get_cursor_pos(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args, (void) argc, (void) nt, (void) callee;
    if (rl_receiver_state(vm, self) == nullptr) return mal_value_new_undefined();
    MalValue result = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalRootSpan root;
    mal_gc_root(&root, &result, 1);
    rl_set(vm, result, "rows", mal_value_from_i32(0));
    rl_set(vm, result, "cols", rl_get(vm, self, "cursor"));
    mal_gc_unroot(&root);
    return result;
}

static void rl_define(MalVm *vm, MalObject *target, const char *name, i32 length,
    MalNativeFunctionCallback callback, bool flag) {
    MalValue slot = mal_value_new_boolean(flag);
    MalValue function = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), length, callback, &slot, 1));
    MalRootSpan root;
    mal_gc_root(&root, &function, 1);
    mal_intrinsic_define_data(vm, target, (const byte *) name, function,
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_gc_unroot(&root);
}

/* Builds Interface for readline (false) or readline/promises (true), cached per module. */
static MalValue rl_build_interface(MalVm *vm, bool promises) {
    mal_host_install_node_events(vm, nullptr, 0, nullptr);
    MalValue roots[] = {mal_value_from_object(mal_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_PROTOTYPE]))),
        mal_value_new_undefined(), mal_value_new_boolean(promises)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalObject *prototype = mal_value_to_object(roots[0]);
    rl_define(vm, prototype, "question", promises ? 2 : 3, rl_method_question, promises);
    rl_define(vm, prototype, "setPrompt", 1, rl_method_set_prompt, promises);
    rl_define(vm, prototype, "getPrompt", 0, rl_method_get_prompt, promises);
    rl_define(vm, prototype, "prompt", 1, rl_method_prompt, promises);
    rl_define(vm, prototype, "close", 0, rl_method_close, promises);
    rl_define(vm, prototype, "pause", 0, rl_method_pause, promises);
    rl_define(vm, prototype, "resume", 0, rl_method_resume, promises);
    rl_define(vm, prototype, "write", 2, rl_method_write, promises);
    rl_define(vm, prototype, "getCursorPos", 0, rl_method_get_cursor_pos, promises);
    MalValue iterator = mal_value_from_native_function_object(mal_native_function_object_new_arity(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) "[Symbol.asyncIterator]"), 0, rl_method_async_iterator));
    MalPropertyDesc iterator_desc = mal_intrinsic_data_desc(iterator, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ASYNC_ITERATOR), &iterator_desc);
    MalNativeFunctionObject *constructor = mal_native_function_object_new_with_slots_arity(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) "Interface"), 4, rl_interface_constructor, &roots[2], 1);
    mal_native_function_object_set_constructor(constructor);
    mal_native_function_object_set_handles_new_target_prototype(constructor);
    roots[1] = mal_value_from_native_function_object(constructor);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, (const byte *) "prototype", roots[0], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, (const byte *) "constructor", roots[1],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_gc_unroot(&root);
    return roots[1];
}

static MalValue rl_interface_prototype(MalVm *vm, bool promises) {
    MalValue module = mal_node_module_get_cached(vm, promises ? "node:readline/promises" : "node:readline");
    MalValue interface = rl_get(vm, module, "Interface");
    return rl_get(vm, interface, "prototype");
}

/* Writes an ANSI control sequence, or only calls back when there is no stream. */
static MalValue rl_write_sequence(MalVm *vm, MalValue stream, const char *sequence, MalValue callback) {
    if (!mal_value_is_undefined(callback) && !mal_value_is_callable(callback)) {
        mal_node_throw_invalid_arg_type(vm, "callback", "of type function", callback);
        return mal_value_new_undefined();
    }
    if (mal_value_is_nil(stream) || sequence == nullptr) {
        if (mal_value_is_callable(callback)) {
            mal_vm_enqueue_reaction_job(vm, callback, false, mal_value_new_undefined(),
                mal_value_new_undefined(), mal_value_new_null());
        }
        return mal_value_new_boolean(true);
    }
    MalValue args[] = {rl_ascii(vm, sequence), callback};
    MalRootSpan root;
    mal_gc_root(&root, args, countof(args));
    MalValue result = rl_call_method(vm, stream, "write", args, mal_value_is_undefined(callback) ? 1 : 2);
    mal_gc_unroot(&root);
    return result;
}

static MalValue rl_clear_line(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self, (void) nt, (void) callee;
    f64 dir = argc > 1 && mal_ops_is_number(args[1]) ? mal_ops_number_as_f64(args[1]) : 0;
    return rl_write_sequence(vm, argc > 0 ? args[0] : mal_value_new_undefined(),
        dir < 0 ? "\x1b[1K" : dir > 0 ? "\x1b[0K" : "\x1b[2K", argc > 2 ? args[2] : mal_value_new_undefined());
}

static MalValue rl_clear_screen_down(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self, (void) nt, (void) callee;
    return rl_write_sequence(vm, argc > 0 ? args[0] : mal_value_new_undefined(), "\x1b[0J",
        argc > 1 ? args[1] : mal_value_new_undefined());
}

static bool rl_number_is_nan(MalValue value) {
    return mal_ops_is_number(value) && isnan(mal_ops_number_as_f64(value));
}

static MalValue rl_cursor_to(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self, (void) nt, (void) callee;
    MalValue stream = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue x = argc > 1 ? args[1] : mal_value_new_undefined();
    MalValue y = argc > 2 ? args[2] : mal_value_new_undefined();
    MalValue callback = argc > 3 ? args[3] : mal_value_new_undefined();
    if (mal_value_is_callable(y)) {
        callback = y;
        y = mal_value_new_undefined();
    }
    if (rl_number_is_nan(x) || rl_number_is_nan(y)) {
        char message[96];
        snprintf(message, sizeof message, "The argument '%s' is invalid. Received NaN", rl_number_is_nan(x) ? "x" : "y");
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_INVALID_ARG_VALUE");
        return mal_value_new_undefined();
    }
    if (mal_value_is_nil(stream) || (!mal_ops_is_number(x) && !mal_ops_is_number(y))) {
        return rl_write_sequence(vm, mal_value_new_undefined(), nullptr, callback);
    }
    if (!mal_ops_is_number(x)) {
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot set cursor row without setting its column",
            "ERR_INVALID_CURSOR_POS");
        return mal_value_new_undefined();
    }
    char sequence[64];
    if (mal_ops_is_number(y)) {
        snprintf(sequence, sizeof sequence, "\x1b[%.0f;%.0fH", mal_ops_number_as_f64(y) + 1, mal_ops_number_as_f64(x) + 1);
    } else {
        snprintf(sequence, sizeof sequence, "\x1b[%.0fG", mal_ops_number_as_f64(x) + 1);
    }
    return rl_write_sequence(vm, stream, sequence, callback);
}

static MalValue rl_move_cursor(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self, (void) nt, (void) callee;
    MalValue stream = argc > 0 ? args[0] : mal_value_new_undefined();
    f64 dx = argc > 1 && mal_ops_is_number(args[1]) ? mal_ops_number_as_f64(args[1]) : 0;
    f64 dy = argc > 2 && mal_ops_is_number(args[2]) ? mal_ops_number_as_f64(args[2]) : 0;
    MalValue callback = argc > 3 ? args[3] : mal_value_new_undefined();
    if (mal_value_is_nil(stream) || (dx == 0 && dy == 0) || isnan(dx) || isnan(dy)) {
        return rl_write_sequence(vm, mal_value_new_undefined(), nullptr, callback);
    }
    char sequence[64] = "";
    usize used = 0;
    if (dx != 0) used += (usize) snprintf(sequence + used, sizeof sequence - used, "\x1b[%.0f%c", dx < 0 ? -dx : dx, dx < 0 ? 'D' : 'C');
    if (dy != 0) snprintf(sequence + used, sizeof sequence - used, "\x1b[%.0f%c", dy < 0 ? -dy : dy, dy < 0 ? 'A' : 'B');
    return rl_write_sequence(vm, stream, sequence, callback);
}

/* Keypress parsing for raw-mode TTYs is not implemented; marking the stream keeps callers working. */
static MalValue rl_emit_keypress_events(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) vm, (void) self, (void) args, (void) argc, (void) nt, (void) callee;
    return mal_value_new_undefined();
}

static MalValue rl_build_module(MalVm *vm, bool promises) {
    MalValue roots[] = {mal_value_from_object(mal_intrinsic_new_object(vm)), rl_build_interface(vm, promises)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalObject *module = mal_value_to_object(roots[0]);
    mal_intrinsic_define_data(vm, module, (const byte *) "Interface", roots[1], RL_VISIBLE);
    rl_define(vm, module, "createInterface", 4, rl_create_interface, promises);
    if (!promises) {
        mal_intrinsic_define_method_n(vm, module, (const byte *) "clearLine", 3, rl_clear_line);
        mal_intrinsic_define_method_n(vm, module, (const byte *) "clearScreenDown", 2, rl_clear_screen_down);
        mal_intrinsic_define_method_n(vm, module, (const byte *) "cursorTo", 4, rl_cursor_to);
        mal_intrinsic_define_method_n(vm, module, (const byte *) "moveCursor", 4, rl_move_cursor);
        mal_intrinsic_define_method_n(vm, module, (const byte *) "emitKeypressEvents", 2, rl_emit_keypress_events);
    }
    mal_gc_unroot(&root);
    return roots[0];
}

static MalValue rl_promises_module(MalVm *vm) {
    MalValue cached = mal_node_module_get_cached(vm, "node:readline/promises");
    if (!mal_value_is_undefined(cached)) return cached;
    MalValue module = rl_build_module(vm, true);
    MalRootSpan root;
    mal_gc_root(&root, &module, 1);
    mal_node_module_publish(vm, "node:readline/promises", nullptr, 0, module);
    mal_gc_unroot(&root);
    return module;
}

void mal_host_install_node_readline(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    if (mal_node_module_install_cached(vm, "node:readline", slots, count)) return;
    MalValue roots[] = {rl_build_module(vm, false), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = rl_promises_module(vm);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "promises", roots[1], RL_VISIBLE);
    mal_node_module_publish(vm, "node:readline", slots, count, roots[0]);
    mal_gc_unroot(&root);
}

void mal_host_install_node_readline_promises(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    if (mal_node_module_install_cached(vm, "node:readline/promises", slots, count)) return;
    MalValue module = rl_promises_module(vm);
    MalRootSpan root;
    mal_gc_root(&root, &module, 1);
    mal_node_module_publish(vm, "node:readline/promises", slots, count, module);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
