// Portions derived from Node.js lib/internal/assert/assertion_error.js, lib/internal/assert/myers_diff.js (MIT); see THIRD_PARTY_NOTICES.md.
#include "node_assert_strict.h"

#if MAL_NODE

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "builtin_error.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "node_deep_equal.h"
#include "node_inspect.h"
#include "node_module.h"
#include "object.h"
#include "object_ops.h"
#include "promise_object.h"
#include "property_iter.h"
#include "text_buffer.h"
#include "value_ops.h"
#include "vm_ops.h"

#define ASSERT_VISIBLE (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)
#define ASSERT_HIDDEN (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE)

static bool assert_throwing(MalVm *vm) {
    return vm->completion.kind == MAL_COMPLETION_THROW;
}

static void assert_throw_value(MalVm *vm, MalValue value) {
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = value};
}

static MalValue assert_clear_throw(MalVm *vm) {
    MalValue value = vm->completion.value;
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = MAL_VALUE_UNDEFINED};
    return value;
}

static MalKey assert_key(MalVm *vm, const char *name) {
    return mal_intrinsic_string_key(vm, (const byte *) name);
}

static bool assert_get(MalVm *vm, MalValue object, const char *name, MalValue *out) {
    *out = mal_value_new_undefined();
    if (!mal_value_is_object(object)) return true;
    return mal_vm_get_property(vm, object, assert_key(vm, name), out) && !assert_throwing(vm);
}

static bool assert_is_error(MalVm *vm, MalValue value) {
    if (!mal_value_is_object(value)) return false;
    if (mal_builtin_value_has_error_data(vm, value)) return true;
    MalObject *prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ERROR_PROTOTYPE]);
    for (MalObject *current = mal_object_get_prototype(mal_value_to_object(value)); current != nullptr;
         current = mal_object_get_prototype(current)) {
        if (current == prototype) return true;
    }
    return false;
}

static bool assert_is_regexp(MalValue value) {
    return mal_value_is_regexp_object(value);
}

static bool assert_inspect_into(MalVm *vm, MalTextBuffer *out, MalValue value, bool value_mode) {
    MalNodeInspectOptions options = {.options = mal_value_new_undefined(), .assert_value = value_mode};
    return mal_node_util_inspect_into(vm, out, value, &options);
}

static MalString *assert_inspect(MalVm *vm, MalValue value, bool value_mode) {
    MalTextBuffer out = {0};
    if (!assert_inspect_into(vm, &out, value, value_mode)) {
        mal_text_buffer_dispose(&out);
        return nullptr;
    }
    return mal_text_buffer_finish(&vm->heap, &out);
}

typedef struct AssertLines {
    const c16 *units;
    usize *starts;
    usize *lengths;
    usize count;
} AssertLines;

static bool assert_lines(MalString *text, AssertLines *lines) {
    usize length = mal_string_length(text);
    lines->units = mal_string_code_units(text);
    usize count = 1;
    for (usize i = 0; i < length; i++) count += lines->units[i] == '\n';
    lines->starts = malloc(count * sizeof(usize));
    lines->lengths = malloc(count * sizeof(usize));
    if (lines->starts == nullptr || lines->lengths == nullptr) return false;
    usize start = 0, index = 0;
    for (usize i = 0; i <= length; i++) {
        if (i == length || lines->units[i] == '\n') {
            lines->starts[index] = start;
            lines->lengths[index++] = i - start;
            start = i + 1;
        }
    }
    lines->count = count;
    return true;
}

static void assert_lines_dispose(AssertLines *lines) {
    free(lines->starts);
    free(lines->lengths);
}

static void assert_append_line(MalTextBuffer *out, const AssertLines *lines, usize index) {
    mal_text_buffer_append_units(out, lines->units + lines->starts[index], lines->lengths[index]);
}

static bool assert_line_equal(const AssertLines *a, usize i, const AssertLines *b, usize j) {
    return a->lengths[i] == b->lengths[j]
        && memcmp(a->units + a->starts[i], b->units + b->starts[j], a->lengths[i] * sizeof(c16)) == 0;
}

static bool assert_ends_with_comma(const AssertLines *lines, usize index) {
    return lines->lengths[index] > 0 && lines->units[lines->starts[index] + lines->lengths[index] - 1] == ',';
}

typedef struct AssertDiffData {
    const AssertLines *actual;
    const AssertLines *expected;
    bool comma;
} AssertDiffData;

// Node's areLinesEqual: with comma disparity, "x," and "x" match so a trailing comma is not a change.
static bool assert_diff_equal(void *opaque, usize i, usize j) {
    const AssertDiffData *data = opaque;
    const AssertLines *a = data->actual, *b = data->expected;
    if (assert_line_equal(a, i, b, j)) return true;
    if (!data->comma) return false;
    usize la = a->lengths[i], lb = b->lengths[j];
    if (la + 1 == lb && assert_ends_with_comma(b, j)) {
        return memcmp(a->units + a->starts[i], b->units + b->starts[j], la * sizeof(c16)) == 0;
    }
    if (lb + 1 == la && assert_ends_with_comma(a, i)) {
        return memcmp(a->units + a->starts[i], b->units + b->starts[j], lb * sizeof(c16)) == 0;
    }
    return false;
}

static const char *assert_readable(const char *operator) {
    static const char *const table[][2] = {
        {"deepStrictEqual", "Expected values to be strictly deep-equal:"},
        {"partialDeepStrictEqual", "Expected values to be partially and strictly deep-equal:"},
        {"strictEqual", "Expected values to be strictly equal:"},
        {"strictEqualObject", "Expected \"actual\" to be reference-equal to \"expected\":"},
        {"deepEqual", "Expected values to be loosely deep-equal:"},
        {"notDeepStrictEqual", "Expected \"actual\" not to be strictly deep-equal to:"},
        {"notStrictEqual", "Expected \"actual\" to be strictly unequal to:"},
        {"notStrictEqualObject", "Expected \"actual\" not to be reference-equal to \"expected\":"},
        {"notDeepEqual", "Expected \"actual\" not to be loosely deep-equal to:"},
        {"notIdentical", "Values identical but not reference-equal:"},
        {"notDeepEqualUnequal", "Expected values not to be loosely deep-equal:"},
    };
    for (usize i = 0; i < countof(table); i++) {
        if (strcmp(table[i][0], operator) == 0) return table[i][1];
    }
    return nullptr;
}

// Node's printMyersDiff: runs of more than five unchanged lines collapse to "...".
static bool assert_print_diff(MalTextBuffer *out, const AssertLines *actual, const AssertLines *expected,
    const MalNodeDiffOp *ops, usize count, bool *skipped) {
    MalTextBuffer message = {0};
    usize nop_count = 0;
    const usize collapse = 5;
    for (usize step = count; step > 0; step--) {
        usize index = step - 1;
        const MalNodeDiffOp *op = &ops[index];
        bool previous_nop = index + 1 < count && ops[index + 1].op == 0;
        if (previous_nop && op->op != 0) {
            if (nop_count == collapse + 1) {
                mal_text_buffer_append_ascii(&message, (const byte *) "  ");
                assert_append_line(&message, actual, ops[index + 1].actual);
                mal_text_buffer_push(&message, '\n');
            } else if (nop_count == collapse + 2) {
                mal_text_buffer_append_ascii(&message, (const byte *) "  ");
                assert_append_line(&message, actual, ops[index + 2].actual);
                mal_text_buffer_append_ascii(&message, (const byte *) "\n  ");
                assert_append_line(&message, actual, ops[index + 1].actual);
                mal_text_buffer_push(&message, '\n');
            } else if (nop_count >= collapse + 3) {
                mal_text_buffer_append_ascii(&message, (const byte *) "...\n  ");
                assert_append_line(&message, actual, ops[index + 1].actual);
                mal_text_buffer_push(&message, '\n');
                *skipped = true;
            }
            nop_count = 0;
        }
        if (op->op == 1) {
            mal_text_buffer_append_ascii(&message, (const byte *) "+ ");
            assert_append_line(&message, actual, op->actual);
            mal_text_buffer_push(&message, '\n');
        } else if (op->op == -1) {
            mal_text_buffer_append_ascii(&message, (const byte *) "- ");
            assert_append_line(&message, expected, op->expected);
            mal_text_buffer_push(&message, '\n');
        } else {
            if (nop_count < collapse) {
                mal_text_buffer_append_ascii(&message, (const byte *) "  ");
                bool from_expected = !assert_ends_with_comma(actual, op->actual);
                if (from_expected) assert_append_line(&message, expected, op->expected);
                else assert_append_line(&message, actual, op->actual);
                mal_text_buffer_push(&message, '\n');
            }
            nop_count++;
        }
    }
    while (message.length > 0) {
        c16 last = mal_text_buffer_code_unit_at(&message, message.length - 1);
        if (last != '\n' && last != ' ') break;
        mal_text_buffer_truncate(&message, message.length - 1);
    }
    mal_text_buffer_push(out, '\n');
    mal_text_buffer_append_buffer(out, &message);
    mal_text_buffer_dispose(&message);
    return true;
}

static bool assert_is_object_like(MalValue value) {
    return mal_value_is_object(value);
}

// Node's createErrDiff for the strict-equality family.
static bool assert_err_diff(MalVm *vm, MalTextBuffer *out, MalValue actual, MalValue expected,
    const char *operator, MalValue custom) {
    if (strcmp(operator, "strictEqual") == 0
        && ((mal_value_is_object(actual) && !mal_value_is_callable(actual) && mal_value_is_object(expected)
                && !mal_value_is_callable(expected))
            || (mal_value_is_callable(actual) && mal_value_is_callable(expected)))) {
        operator = "strictEqualObject";
    }
    MalValue roots[2] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    MalString *inspected_actual = assert_inspect(vm, actual, true);
    if (inspected_actual == nullptr) goto fail;
    roots[0] = mal_value_from_string(inspected_actual);
    MalString *inspected_expected = assert_inspect(vm, expected, true);
    if (inspected_expected == nullptr) goto fail;
    roots[1] = mal_value_from_string(inspected_expected);
    if (strcmp(operator, "strictEqualObject") == 0 && mal_string_equals(inspected_actual, inspected_expected)
        && mal_value_is_undefined(custom)) {
        mal_text_buffer_append_ascii(out, (const byte *) "Values have same structure but are not reference-equal:\n\n");
        mal_text_buffer_append_string(out, inspected_actual);
        mal_text_buffer_push(out, '\n');
        mal_gc_unroot(&root);
        return true;
    }
    AssertLines lines_actual = {0}, lines_expected = {0};
    if (!assert_lines(inspected_actual, &lines_actual) || !assert_lines(inspected_expected, &lines_expected)) {
        assert_lines_dispose(&lines_actual);
        assert_lines_dispose(&lines_expected);
        goto fail;
    }
    MalTextBuffer message = {0};
    const char *header = "+ actual - expected";
    bool skipped = false;
    bool simple = lines_actual.count == 1 && lines_expected.count == 1
        && (!assert_is_object_like(actual) || !assert_is_object_like(expected));
    if (simple) {
        i64 strings_length = (i64) mal_string_length(inspected_actual) + (i64) mal_string_length(inspected_expected);
        if (mal_value_is_string(actual)) strings_length -= 2;
        if (mal_value_is_string(expected)) strings_length -= 2;
        bool both_zero = mal_ops_is_number(actual) && mal_ops_number_as_f64(actual) == 0
            && mal_ops_is_number(expected) && mal_ops_number_as_f64(expected) == 0;
        if (strings_length <= 12 && !both_zero) {
            mal_text_buffer_append_string(&message, inspected_actual);
            mal_text_buffer_append_ascii(&message, (const byte *) " !== ");
            mal_text_buffer_append_string(&message, inspected_expected);
            header = "";
        } else {
            mal_text_buffer_append_ascii(&message, (const byte *) "\n+ ");
            mal_text_buffer_append_string(&message, inspected_actual);
            mal_text_buffer_append_ascii(&message, (const byte *) "\n- ");
            mal_text_buffer_append_string(&message, inspected_expected);
            usize length_a = mal_string_length(inspected_actual);
            usize length_e = mal_string_length(inspected_expected);
            if (length_a + length_e <= 80) {
                const c16 *a = mal_string_code_units(inspected_actual);
                const c16 *e = mal_string_code_units(inspected_expected);
                for (usize i = 0; i < length_a; i++) {
                    if (i < length_e && a[i] == e[i]) continue;
                    if (i >= 1) {
                        mal_text_buffer_push(&message, '\n');
                        for (usize k = 0; k < i + 2; k++) mal_text_buffer_push(&message, ' ');
                        mal_text_buffer_push(&message, '^');
                    }
                    break;
                }
            }
        }
    } else {
        AssertDiffData data = {&lines_actual, &lines_expected, mal_value_is_object(actual)};
        MalNodeDiffOp *ops = nullptr;
        usize count = 0;
        if (!mal_node_myers_diff(lines_actual.count, lines_expected.count, assert_diff_equal, &data, &ops, &count)) {
            mal_text_buffer_dispose(&message);
            assert_lines_dispose(&lines_actual);
            assert_lines_dispose(&lines_expected);
            goto fail;
        }
        assert_print_diff(&message, &lines_actual, &lines_expected, ops, count, &skipped);
        free(ops);
    }
    if (mal_value_is_undefined(custom)) {
        mal_text_buffer_append_ascii(out, (const byte *) assert_readable(operator));
    } else {
        mal_text_buffer_append_string(out, mal_value_to_string(custom));
    }
    mal_text_buffer_push(out, '\n');
    mal_text_buffer_append_ascii(out, (const byte *) header);
    if (skipped) mal_text_buffer_append_ascii(out, (const byte *) "\n... Skipped lines");
    mal_text_buffer_push(out, '\n');
    mal_text_buffer_append_buffer(out, &message);
    mal_text_buffer_push(out, '\n');
    mal_text_buffer_dispose(&message);
    assert_lines_dispose(&lines_actual);
    assert_lines_dispose(&lines_expected);
    mal_gc_unroot(&root);
    return true;
fail:
    mal_gc_unroot(&root);
    return false;
}

static void assert_append_truncated(MalTextBuffer *out, MalString *text, usize limit) {
    usize length = mal_string_length(text);
    if (length <= limit) {
        mal_text_buffer_append_string(out, text);
    } else {
        mal_text_buffer_append_range(out, text, 0, limit - 3);
        mal_text_buffer_append_ascii(out, (const byte *) "...");
    }
}

// Node's AssertionError message for operators outside the strict-equality family.
static bool assert_generic_message(MalVm *vm, MalTextBuffer *out, MalValue actual, MalValue expected,
    const char *operator) {
    MalValue roots[2] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    bool ok = false;
    if (strcmp(operator, "notDeepStrictEqual") == 0 || strcmp(operator, "notStrictEqual") == 0) {
        const char *base = assert_readable(operator);
        if (strcmp(operator, "notStrictEqual") == 0 && mal_value_is_object(actual)) {
            base = assert_readable("notStrictEqualObject");
        }
        MalString *inspected = assert_inspect(vm, actual, true);
        if (inspected == nullptr) goto done;
        roots[0] = mal_value_from_string(inspected);
        AssertLines lines = {0};
        if (!assert_lines(inspected, &lines)) {
            assert_lines_dispose(&lines);
            goto done;
        }
        mal_text_buffer_append_ascii(out, (const byte *) base);
        if (lines.count == 1) {
            mal_text_buffer_append_ascii(out, (const byte *) (lines.lengths[0] > 5 ? "\n\n" : " "));
            mal_text_buffer_append_string(out, inspected);
        } else {
            mal_text_buffer_append_ascii(out, (const byte *) "\n\n");
            usize shown = lines.count > 50 ? 46 : lines.count;
            for (usize i = 0; i < shown; i++) {
                if (i > 0) mal_text_buffer_push(out, '\n');
                assert_append_line(out, &lines, i);
            }
            if (shown < lines.count) mal_text_buffer_append_ascii(out, (const byte *) "\n...");
            mal_text_buffer_push(out, '\n');
        }
        assert_lines_dispose(&lines);
        ok = true;
        goto done;
    }
    MalString *res = assert_inspect(vm, actual, true);
    if (res == nullptr) goto done;
    roots[0] = mal_value_from_string(res);
    MalString *other = assert_inspect(vm, expected, true);
    if (other == nullptr) goto done;
    roots[1] = mal_value_from_string(other);
    const char *known = assert_readable(operator);
    if (strcmp(operator, "notDeepEqual") == 0 && mal_string_equals(res, other)) {
        mal_text_buffer_append_ascii(out, (const byte *) known);
        mal_text_buffer_append_ascii(out, (const byte *) "\n\n");
        assert_append_truncated(out, res, 1024 - strlen(known) - 2);
        ok = true;
        goto done;
    }
    if (strcmp(operator, "deepEqual") == 0) {
        mal_text_buffer_append_ascii(out, (const byte *) known);
        mal_text_buffer_append_ascii(out, (const byte *) "\n\n");
        assert_append_truncated(out, res, 512);
        mal_text_buffer_append_ascii(out, (const byte *) "\n\nshould loosely deep-equal\n\n");
        assert_append_truncated(out, other, 512);
    } else if (strcmp(operator, "notDeepEqual") == 0) {
        mal_text_buffer_append_ascii(out, (const byte *) assert_readable("notDeepEqualUnequal"));
        mal_text_buffer_append_ascii(out, (const byte *) "\n\n");
        assert_append_truncated(out, res, 512);
        mal_text_buffer_append_ascii(out, (const byte *) "\n\nshould not loosely deep-equal\n\n");
        assert_append_truncated(out, other, 512);
    } else {
        assert_append_truncated(out, res, 512);
        mal_text_buffer_push(out, ' ');
        mal_text_buffer_append_ascii(out, (const byte *) operator);
        mal_text_buffer_push(out, ' ');
        assert_append_truncated(out, other, 512);
    }
    ok = true;
done:
    mal_gc_unroot(&root);
    return ok;
}

static MalValue assert_error_constructor_value(MalVm *vm) {
    MalValue module = vm->intrinsics[MAL_INTRINSIC_NODE_ASSERT_MODULE];
    MalValue constructor = mal_value_new_undefined();
    if (mal_value_is_object(module)) {
        MalPropertyLookup found = mal_object_get_own(mal_value_to_object(module), assert_key(vm, "AssertionError"));
        if (found.present) constructor = found.desc.value;
    }
    return constructor;
}

// Builds Node's AssertionError; `message` undefined means a generated message.
static MalValue assert_error_build(MalVm *vm, MalValue actual, MalValue expected, const char *operator,
    MalValue message, MalValue new_target) {
    MalValue roots[6] = {actual, expected, message, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, new_target};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    MalTextBuffer text = {0};
    bool generated = mal_value_is_nil(roots[2]);
    bool strict_family = strcmp(operator, "deepStrictEqual") == 0 || strcmp(operator, "strictEqual") == 0;
    if (!generated) {
        MalString *string;
        if (!mal_vm_to_string(vm, roots[2], &string)) goto done;
        roots[2] = mal_value_from_string(string);
        if (strict_family) {
            if (!assert_err_diff(vm, &text, roots[0], roots[1], operator, roots[2])) goto done;
        } else {
            mal_text_buffer_append_string(&text, string);
        }
    } else if (strict_family || strcmp(operator, "partialDeepStrictEqual") == 0) {
        if (!assert_err_diff(vm, &text, roots[0], roots[1], operator, mal_value_new_undefined())) goto done;
    } else if (!assert_generic_message(vm, &text, roots[0], roots[1], operator)) {
        goto done;
    }
    roots[3] = mal_value_from_string(mal_text_buffer_finish(&vm->heap, &text));
    if (mal_value_is_undefined(roots[5])) roots[5] = assert_error_constructor_value(vm);
    MalCompletion completion = mal_vm_construct_value_with_target(
        vm, vm->intrinsics[MAL_INTRINSIC_ERROR_CONSTRUCTOR], &roots[3], 1,
        mal_value_is_undefined(roots[5]) ? vm->intrinsics[MAL_INTRINSIC_ERROR_CONSTRUCTOR] : roots[5]);
    if (completion.kind == MAL_COMPLETION_THROW) goto done;
    roots[4] = completion.value;
    MalObject *error = mal_value_to_object(roots[4]);
    mal_intrinsic_define_data(vm, error, (const byte *) "generatedMessage", mal_value_new_boolean(generated), ASSERT_VISIBLE);
    mal_intrinsic_define_data(vm, error, (const byte *) "code",
        mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "ERR_ASSERTION")), ASSERT_VISIBLE);
    mal_intrinsic_define_data(vm, error, (const byte *) "actual", roots[0], ASSERT_VISIBLE);
    mal_intrinsic_define_data(vm, error, (const byte *) "expected", roots[1], ASSERT_VISIBLE);
    mal_intrinsic_define_data(vm, error, (const byte *) "operator",
        mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) operator)), ASSERT_VISIBLE);
    mal_intrinsic_define_data(vm, error, (const byte *) "diff",
        mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "simple")), ASSERT_VISIBLE);
    mal_intrinsic_define_data(vm, error, (const byte *) "name",
        mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "AssertionError")), ASSERT_HIDDEN);
    MalValue stack;
    if (assert_get(vm, roots[4], "stack", &stack) && mal_value_is_string(stack)) {
        MalString *string = mal_value_to_string(stack);
        const c16 *units = mal_string_code_units(string);
        usize length = mal_string_length(string);
        usize skip = 0;
        static const char *const heads[] = {"AssertionError", "Error"};
        for (usize h = 0; h < countof(heads) && skip == 0; h++) {
            usize head_length = strlen(heads[h]);
            if (length < head_length) continue;
            bool match = true;
            for (usize i = 0; i < head_length; i++) match = match && units[i] == (c16) heads[h][i];
            if (match) skip = head_length;
        }
        if (skip > 0) {
            MalTextBuffer rewritten = {0};
            mal_text_buffer_append_ascii(&rewritten, (const byte *) "AssertionError [ERR_ASSERTION]");
            mal_text_buffer_append_range(&rewritten, string, skip, length - skip);
            mal_intrinsic_define_data(vm, error, (const byte *) "stack",
                mal_value_from_string(mal_text_buffer_finish(&vm->heap, &rewritten)), ASSERT_HIDDEN);
        }
    }
    if (assert_throwing(vm)) assert_clear_throw(vm);
    result = roots[4];
done:
    if (mal_value_is_undefined(result)) mal_text_buffer_dispose(&text);
    mal_gc_unroot(&root);
    return result;
}

static void assert_set_generated(MalVm *vm, MalValue error, bool generated) {
    if (mal_value_is_object(error)) {
        mal_intrinsic_define_data(vm, mal_value_to_object(error), (const byte *) "generatedMessage",
            mal_value_new_boolean(generated), ASSERT_VISIBLE);
    }
}

// innerFail: an Error passed as the message is thrown as-is.
static MalValue assert_fail_with(MalVm *vm, MalValue actual, MalValue expected, const char *operator,
    MalValue message) {
    if (assert_is_error(vm, message)) {
        assert_throw_value(vm, message);
        return mal_value_new_undefined();
    }
    MalValue error = assert_error_build(vm, actual, expected, operator, message, mal_value_new_undefined());
    if (!assert_throwing(vm) && mal_value_is_object(error)) assert_throw_value(vm, error);
    return mal_value_new_undefined();
}

static MalValue assert_fail_message(MalVm *vm, MalValue actual, MalValue expected, const char *operator,
    const char *message, bool generated) {
    MalValue text = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) message));
    MalRootSpan root;
    mal_gc_root(&root, &text, 1);
    MalValue error = assert_error_build(vm, actual, expected, operator, text, mal_value_new_undefined());
    if (!assert_throwing(vm) && mal_value_is_object(error)) {
        assert_set_generated(vm, error, generated);
        assert_throw_value(vm, error);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue assert_fail_buffer(MalVm *vm, MalValue actual, MalValue expected, const char *operator,
    MalTextBuffer *text, bool generated) {
    MalValue message = mal_value_from_string(mal_text_buffer_finish(&vm->heap, text));
    MalRootSpan root;
    mal_gc_root(&root, &message, 1);
    MalValue error = assert_error_build(vm, actual, expected, operator, message, mal_value_new_undefined());
    if (!assert_throwing(vm) && mal_value_is_object(error)) {
        assert_set_generated(vm, error, generated);
        assert_throw_value(vm, error);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

#define ASSERT_ARG(i) (argc > (i) ? args[(i)] : mal_value_new_undefined())
#define ASSERT_FN(name) \
    static MalValue name(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, \
        MalValue new_target, MalValue callee)
#define ASSERT_UNUSED (void) receiver; (void) new_target; (void) callee

static bool assert_require_two(MalVm *vm, i32 argc) {
    if (argc >= 2) return true;
    mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "The \"actual\" and \"expected\" arguments must be specified", "ERR_MISSING_ARGS");
    return false;
}

ASSERT_FN(assert_ok) {
    ASSERT_UNUSED;
    if (argc == 0) {
        return assert_fail_message(vm, mal_value_new_undefined(), mal_value_new_boolean(true), "==",
            "No value argument passed to `assert.ok()`", true);
    }
    if (mal_value_is_truthy(args[0])) return mal_value_new_undefined();
    MalValue message = ASSERT_ARG(1);
    if (assert_is_error(vm, message)) {
        assert_throw_value(vm, message);
        return mal_value_new_undefined();
    }
    return assert_fail_with(vm, args[0], mal_value_new_boolean(true), "==", message);
}

ASSERT_FN(assert_equal) {
    ASSERT_UNUSED;
    if (!assert_require_two(vm, argc)) return mal_value_new_undefined();
    bool nan = mal_ops_is_number(args[0]) && mal_ops_is_number(args[1])
        && isnan(mal_ops_number_as_f64(args[0])) && isnan(mal_ops_number_as_f64(args[1]));
    if (nan || mal_value_is_truthy(mal_ops_equal(args[0], args[1]))) return mal_value_new_undefined();
    return assert_fail_with(vm, args[0], args[1], "==", ASSERT_ARG(2));
}

ASSERT_FN(assert_not_equal) {
    ASSERT_UNUSED;
    if (!assert_require_two(vm, argc)) return mal_value_new_undefined();
    bool nan = mal_ops_is_number(args[0]) && mal_ops_is_number(args[1])
        && isnan(mal_ops_number_as_f64(args[0])) && isnan(mal_ops_number_as_f64(args[1]));
    if (!nan && !mal_value_is_truthy(mal_ops_equal(args[0], args[1]))) return mal_value_new_undefined();
    return assert_fail_with(vm, args[0], args[1], "!=", ASSERT_ARG(2));
}

ASSERT_FN(assert_strict_equal) {
    ASSERT_UNUSED;
    if (!assert_require_two(vm, argc)) return mal_value_new_undefined();
    if (mal_ops_same_value(args[0], args[1])) return mal_value_new_undefined();
    return assert_fail_with(vm, args[0], args[1], "strictEqual", ASSERT_ARG(2));
}

ASSERT_FN(assert_not_strict_equal) {
    ASSERT_UNUSED;
    if (!assert_require_two(vm, argc)) return mal_value_new_undefined();
    if (!mal_ops_same_value(args[0], args[1])) return mal_value_new_undefined();
    return assert_fail_with(vm, args[0], args[1], "notStrictEqual", ASSERT_ARG(2));
}

static MalValue assert_deep(MalVm *vm, const MalValue *args, i32 argc, MalNodeDeepEqualMode mode,
    bool negate, const char *operator) {
    if (!assert_require_two(vm, argc)) return mal_value_new_undefined();
    bool equal;
    if (!mal_node_deep_equal(vm, args[0], args[1], mode, &equal)) return mal_value_new_undefined();
    if (equal != negate) return mal_value_new_undefined();
    return assert_fail_with(vm, args[0], args[1], operator, ASSERT_ARG(2));
}

ASSERT_FN(assert_deep_equal) {
    ASSERT_UNUSED;
    return assert_deep(vm, args, argc, MAL_NODE_DEEP_EQUAL_LOOSE, false, "deepEqual");
}

ASSERT_FN(assert_not_deep_equal) {
    ASSERT_UNUSED;
    return assert_deep(vm, args, argc, MAL_NODE_DEEP_EQUAL_LOOSE, true, "notDeepEqual");
}

ASSERT_FN(assert_deep_strict_equal) {
    ASSERT_UNUSED;
    return assert_deep(vm, args, argc, MAL_NODE_DEEP_EQUAL_STRICT, false, "deepStrictEqual");
}

ASSERT_FN(assert_not_deep_strict_equal) {
    ASSERT_UNUSED;
    return assert_deep(vm, args, argc, MAL_NODE_DEEP_EQUAL_STRICT, true, "notDeepStrictEqual");
}

ASSERT_FN(assert_partial_deep_strict_equal) {
    ASSERT_UNUSED;
    return assert_deep(vm, args, argc, MAL_NODE_DEEP_EQUAL_PARTIAL, false, "partialDeepStrictEqual");
}

static bool assert_regexp_matches(MalVm *vm, MalValue regexp, MalValue string, bool *matches) {
    MalValue exec;
    if (!assert_get(vm, regexp, "exec", &exec)) return false;
    MalCompletion result = mal_vm_call_value(vm, exec, regexp, &string, 1);
    if (result.kind == MAL_COMPLETION_THROW) return false;
    *matches = !mal_value_is_null(result.value);
    return true;
}

static MalValue assert_internal_match(MalVm *vm, const MalValue *args, i32 argc, bool match) {
    MalValue string = ASSERT_ARG(0), regexp = ASSERT_ARG(1), message = ASSERT_ARG(2);
    if (!assert_is_regexp(regexp)) {
        mal_node_throw_invalid_arg_type(vm, "regexp", "an instance of RegExp", regexp);
        return mal_value_new_undefined();
    }
    bool matches = false;
    if (mal_value_is_string(string) && !assert_regexp_matches(vm, regexp, string, &matches)) {
        return mal_value_new_undefined();
    }
    if (mal_value_is_string(string) && matches == match) return mal_value_new_undefined();
    if (assert_is_error(vm, message)) {
        assert_throw_value(vm, message);
        return mal_value_new_undefined();
    }
    const char *operator = match ? "match" : "doesNotMatch";
    if (!mal_value_is_nil(message) && !(mal_value_is_string(message) && mal_string_length(mal_value_to_string(message)) == 0)) {
        MalValue error = assert_error_build(vm, string, regexp, operator, message, mal_value_new_undefined());
        if (!assert_throwing(vm) && mal_value_is_object(error)) assert_throw_value(vm, error);
        return mal_value_new_undefined();
    }
    MalTextBuffer text = {0};
    if (!mal_value_is_string(string)) {
        mal_text_buffer_append_ascii(&text, (const byte *) "The \"string\" argument must be of type string. Received type ");
        mal_text_buffer_append_ascii(&text, (const byte *) (mal_value_is_undefined(string) ? "undefined"
            : mal_value_is_null(string) ? "object" : mal_ops_is_number(string) ? "number"
            : mal_value_is_boolean(string) ? "boolean" : mal_value_is_symbol(string) ? "symbol"
            : mal_value_is_bigint(string) ? "bigint" : mal_value_is_callable(string) ? "function" : "object"));
        mal_text_buffer_append_ascii(&text, (const byte *) " (");
        if (!assert_inspect_into(vm, &text, string, false)) goto failed;
        mal_text_buffer_push(&text, ')');
    } else {
        mal_text_buffer_append_ascii(&text, (const byte *) (match ? "The input did not match the regular expression "
            : "The input was expected to not match the regular expression "));
        if (!assert_inspect_into(vm, &text, regexp, false)) goto failed;
        mal_text_buffer_append_ascii(&text, (const byte *) ". Input:\n\n");
        if (!assert_inspect_into(vm, &text, string, false)) goto failed;
        mal_text_buffer_push(&text, '\n');
    }
    return assert_fail_buffer(vm, string, regexp, operator, &text, true);
failed:
    mal_text_buffer_dispose(&text);
    return mal_value_new_undefined();
}

ASSERT_FN(assert_match) {
    ASSERT_UNUSED;
    return assert_internal_match(vm, args, argc, true);
}

ASSERT_FN(assert_does_not_match) {
    ASSERT_UNUSED;
    return assert_internal_match(vm, args, argc, false);
}

ASSERT_FN(assert_fail) {
    ASSERT_UNUSED;
    if (argc == 0 || mal_value_is_undefined(args[0])) {
        return assert_fail_message(vm, mal_value_new_undefined(), mal_value_new_undefined(), "fail", "Failed", true);
    }
    return assert_fail_with(vm, mal_value_new_undefined(), mal_value_new_undefined(), "fail", args[0]);
}

ASSERT_FN(assert_if_error) {
    ASSERT_UNUSED;
    MalValue error = ASSERT_ARG(0);
    if (mal_value_is_nil(error)) return mal_value_new_undefined();
    MalTextBuffer text = {0};
    mal_text_buffer_append_ascii(&text, (const byte *) "ifError got unwanted exception: ");
    MalValue message;
    if (mal_value_is_object(error) && assert_get(vm, error, "message", &message) && mal_value_is_string(message)) {
        MalValue constructor;
        if (mal_string_length(mal_value_to_string(message)) == 0
            && assert_get(vm, error, "constructor", &constructor) && mal_value_is_callable(constructor)) {
            MalString *name = mal_vm_callable_name(vm, constructor);
            if (name != nullptr) mal_text_buffer_append_string(&text, name);
        } else {
            mal_text_buffer_append_string(&text, mal_value_to_string(message));
        }
    } else if (!assert_throwing(vm) && !assert_inspect_into(vm, &text, error, false)) {
        mal_text_buffer_dispose(&text);
        return mal_value_new_undefined();
    }
    if (assert_throwing(vm)) {
        mal_text_buffer_dispose(&text);
        return mal_value_new_undefined();
    }
    return assert_fail_buffer(vm, error, mal_value_new_null(), "ifError", &text, false);
}

static bool assert_is_error_class(MalVm *vm, MalValue expected) {
    MalObject *error = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ERROR_CONSTRUCTOR]);
    for (MalObject *current = mal_object_get_prototype(mal_value_to_object(expected)); current != nullptr;
         current = mal_object_get_prototype(current)) {
        if (current == error) return true;
    }
    return false;
}

static bool assert_instance_of(MalVm *vm, MalValue value, MalValue constructor, bool *result) {
    MalValue prototype;
    *result = false;
    if (!assert_get(vm, constructor, "prototype", &prototype)) return false;
    if (mal_value_is_undefined(prototype)) return true;
    *result = mal_vm_ordinary_has_instance(vm, constructor, value);
    return !assert_throwing(vm);
}

static MalValue assert_constructor(MalVm *vm, const char *name, i32 length, MalNativeFunctionCallback callback,
    MalValue prototype);
static MalValue assert_comparison_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee);

static MalValue assert_comparison(MalVm *vm, MalValue source, const MalValue *keys, usize count, MalValue actual) {
    MalValue roots[4] = {source, actual, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 4);
    // Node's placeholder class only exists so the diff names the objects "Comparison".
    roots[3] = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[2] = assert_constructor(vm, "Comparison", 0, assert_comparison_constructor, roots[3]);
    roots[2] = mal_value_from_object(mal_object_new(&vm->heap, mal_value_to_object(roots[3])));
    for (usize i = 0; i < count; i++) {
        MalKey key = mal_key_from_value(keys[i]);
        MalPropertyResolution present = mal_object_resolve_property(mal_value_to_object(roots[0]), key);
        if (!present.found) continue;
        if (!mal_vm_get_property(vm, roots[0], key, &roots[3]) || assert_throwing(vm)) break;
        if (mal_value_is_object(roots[1]) && assert_is_regexp(roots[3])) {
            MalValue actual_value;
            if (mal_vm_get_property(vm, roots[1], key, &actual_value) && mal_value_is_string(actual_value)) {
                bool matches = false;
                MalValue regexp = roots[3];
                MalRootSpan inner;
                mal_gc_root(&inner, &actual_value, 1);
                if (assert_regexp_matches(vm, regexp, actual_value, &matches) && matches) roots[3] = actual_value;
                mal_gc_unroot(&inner);
            }
        }
        mal_object_set(mal_value_to_object(roots[2]), key, roots[3]);
    }
    MalValue result = roots[2];
    mal_gc_unroot(&root);
    return result;
}

// Node's expectedException: RegExp, validation object, Error class or validation function.
static void assert_expected_exception(MalVm *vm, MalValue actual, MalValue expected, MalValue message,
    const char *operator) {
    MalValue roots[4] = {actual, expected, message, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 4);
    bool custom = !mal_value_is_nil(roots[2]) && !(mal_value_is_string(roots[2])
        && mal_string_length(mal_value_to_string(roots[2])) == 0);
    MalTextBuffer text = {0};
    if (!mal_value_is_callable(roots[1])) {
        if (assert_is_regexp(roots[1])) {
            MalString *string;
            if (!mal_vm_to_string(vm, roots[0], &string)) goto done;
            roots[3] = mal_value_from_string(string);
            bool matches = false;
            if (!assert_regexp_matches(vm, roots[1], roots[3], &matches) || matches) goto done;
            if (custom) {
                assert_fail_with(vm, roots[0], roots[1], operator, roots[2]);
                goto done;
            }
            mal_text_buffer_append_ascii(&text, (const byte *) "The input did not match the regular expression ");
            if (!assert_inspect_into(vm, &text, roots[1], false)) goto done;
            mal_text_buffer_append_ascii(&text, (const byte *) ". Input:\n\n");
            if (!assert_inspect_into(vm, &text, roots[3], false)) goto done;
            mal_text_buffer_push(&text, '\n');
            assert_fail_buffer(vm, roots[0], roots[1], operator, &text, true);
            goto done;
        }
        if (!mal_value_is_object(roots[0])) {
            MalValue error = assert_error_build(vm, roots[0], roots[1], "deepStrictEqual",
                custom ? roots[2] : mal_value_new_undefined(), mal_value_new_undefined());
            if (!assert_throwing(vm) && mal_value_is_object(error)) {
                mal_intrinsic_define_data(vm, mal_value_to_object(error), (const byte *) "operator",
                    mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) operator)), ASSERT_VISIBLE);
                assert_throw_value(vm, error);
            }
            goto done;
        }
        MalValue keys_array = mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0));
        roots[3] = keys_array;
        MalArrayObject *keys = mal_value_to_array_object(roots[3]);
        MalPropertyIter iter;
        MalKey key;
        MalPropertyDesc desc;
        mal_property_iter_init(&iter, mal_value_to_object(roots[1]), MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);
        while (mal_property_iter_next(&iter, &key, &desc)) {
            if (key.kind == MAL_KEY_SYMBOL) continue;
            MalValue name = key.kind == MAL_KEY_INDEX
                ? mal_value_from_string(mal_ops_to_string(&vm->heap, key.value)) : key.value;
            mal_array_object_store(keys, mal_key_index(mal_array_object_length(keys)), name);
        }
        if (assert_is_error(vm, roots[1])) {
            mal_array_object_store(keys, mal_key_index(mal_array_object_length(keys)),
                mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "name")));
            mal_array_object_store(keys, mal_key_index(mal_array_object_length(keys)),
                mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "message")));
        } else if (mal_array_object_length(keys) == 0) {
            mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "The argument 'error' may not be an empty object. Received {}", "ERR_INVALID_ARG_VALUE");
            goto done;
        }
        u32 count = mal_array_object_length(keys);
        MalValue *key_values = malloc(count * sizeof(MalValue));
        if (key_values == nullptr) goto done;
        for (u32 i = 0; i < count; i++) {
            mal_array_object_dense_get(keys, i, &key_values[i]);
        }
        for (u32 i = 0; i < count; i++) {
            MalValue pair[2] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
            MalRootSpan pair_root;
            mal_gc_root(&pair_root, pair, 2);
            MalKey property = mal_key_from_value(key_values[i]);
            bool present = mal_object_resolve_property(mal_value_to_object(roots[0]), property).found;
            bool equal = false;
            bool ok = mal_vm_get_property(vm, roots[0], property, &pair[0]) && !assert_throwing(vm)
                && mal_vm_get_property(vm, roots[1], property, &pair[1]) && !assert_throwing(vm);
            if (ok && mal_value_is_string(pair[0]) && assert_is_regexp(pair[1])) {
                bool matches = false;
                ok = assert_regexp_matches(vm, pair[1], pair[0], &matches);
                if (ok && matches) {
                    mal_gc_unroot(&pair_root);
                    continue;
                }
            }
            if (ok && present) ok = mal_node_deep_equal(vm, pair[0], pair[1], MAL_NODE_DEEP_EQUAL_STRICT, &equal);
            mal_gc_unroot(&pair_root);
            if (!ok) break;
            if (present && equal) continue;
            if (custom) {
                assert_fail_with(vm, roots[0], roots[1], operator, roots[2]);
                break;
            }
            MalValue compared[2] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
            MalRootSpan compared_root;
            mal_gc_root(&compared_root, compared, 2);
            compared[0] = assert_comparison(vm, roots[0], key_values, count, mal_value_new_undefined());
            compared[1] = assert_comparison(vm, roots[1], key_values, count, roots[0]);
            MalValue error = assert_throwing(vm) ? mal_value_new_undefined()
                : assert_error_build(vm, compared[0], compared[1], "deepStrictEqual",
                    mal_value_new_undefined(), mal_value_new_undefined());
            if (!assert_throwing(vm) && mal_value_is_object(error)) {
                MalObject *object = mal_value_to_object(error);
                mal_intrinsic_define_data(vm, object, (const byte *) "actual", roots[0], ASSERT_VISIBLE);
                mal_intrinsic_define_data(vm, object, (const byte *) "expected", roots[1], ASSERT_VISIBLE);
                mal_intrinsic_define_data(vm, object, (const byte *) "operator",
                    mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) operator)), ASSERT_VISIBLE);
                assert_throw_value(vm, error);
            }
            mal_gc_unroot(&compared_root);
            break;
        }
        free(key_values);
        goto done;
    }
    bool instance = false;
    if (!assert_instance_of(vm, roots[0], roots[1], &instance) || instance) goto done;
    if (assert_is_error_class(vm, roots[1])) {
        if (custom) {
            assert_fail_with(vm, roots[0], roots[1], operator, roots[2]);
            goto done;
        }
        MalValue name;
        if (!assert_get(vm, roots[1], "name", &name)) goto done;
        mal_text_buffer_append_ascii(&text, (const byte *) "The error is expected to be an instance of \"");
        if (mal_value_is_string(name)) mal_text_buffer_append_string(&text, mal_value_to_string(name));
        mal_text_buffer_append_ascii(&text, (const byte *) "\". Received ");
        if (assert_is_error(vm, roots[0])) {
            MalValue constructor, actual_name = mal_value_new_undefined();
            MalString *received = nullptr;
            if (assert_get(vm, roots[0], "constructor", &constructor) && mal_value_is_callable(constructor)) {
                received = mal_vm_callable_name(vm, constructor);
            }
            if (received == nullptr || mal_string_length(received) == 0) {
                assert_get(vm, roots[0], "name", &actual_name);
                received = mal_value_is_string(actual_name) ? mal_value_to_string(actual_name) : nullptr;
            }
            if (received != nullptr && mal_value_is_string(name) && mal_string_equals(received, mal_value_to_string(name))) {
                mal_text_buffer_append_ascii(&text, (const byte *) "an error with identical name but a different prototype.");
            } else {
                mal_text_buffer_push(&text, '"');
                if (received != nullptr) mal_text_buffer_append_string(&text, received);
                mal_text_buffer_push(&text, '"');
            }
            MalValue actual_message;
            if (assert_get(vm, roots[0], "message", &actual_message) && mal_value_is_truthy(actual_message)) {
                MalString *string;
                if (!mal_vm_to_string(vm, actual_message, &string)) goto done;
                mal_text_buffer_append_ascii(&text, (const byte *) "\n\nError message:\n\n");
                mal_text_buffer_append_string(&text, string);
            }
        } else {
            mal_text_buffer_push(&text, '"');
            if (!assert_inspect_into(vm, &text, roots[0], false)) goto done;
            mal_text_buffer_push(&text, '"');
        }
        MalValue error_text = mal_value_from_string(mal_text_buffer_finish(&vm->heap, &text));
        MalRootSpan text_root;
        mal_gc_root(&text_root, &error_text, 1);
        MalValue error = assert_error_build(vm, roots[0], roots[1], operator, error_text, mal_value_new_undefined());
        if (!assert_throwing(vm) && mal_value_is_object(error)) {
            mal_intrinsic_define_data(vm, mal_value_to_object(error), (const byte *) "expected",
                mal_value_new_undefined(), ASSERT_VISIBLE);
            assert_set_generated(vm, error, true);
            assert_throw_value(vm, error);
        }
        mal_gc_unroot(&text_root);
        goto done;
    }
    MalValue receiver = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[3] = receiver;
    MalCompletion result = mal_vm_call_value(vm, roots[1], roots[3], &roots[0], 1);
    if (result.kind == MAL_COMPLETION_THROW) goto done;
    if (mal_value_is_boolean(result.value) && mal_value_to_boolean(result.value)) goto done;
    if (custom) {
        assert_fail_with(vm, roots[0], roots[1], operator, roots[2]);
        goto done;
    }
    roots[3] = result.value;
    MalString *function_name = mal_vm_callable_name(vm, roots[1]);
    mal_text_buffer_append_ascii(&text, (const byte *) "The ");
    if (function_name != nullptr && mal_string_length(function_name) > 0) {
        mal_text_buffer_push(&text, '"');
        mal_text_buffer_append_string(&text, function_name);
        mal_text_buffer_append_ascii(&text, (const byte *) "\" ");
    }
    mal_text_buffer_append_ascii(&text, (const byte *) "validation function is expected to return \"true\". Received ");
    if (!assert_inspect_into(vm, &text, roots[3], false)) goto done;
    if (assert_is_error(vm, roots[0])) {
        MalString *string;
        if (!mal_vm_to_string(vm, roots[0], &string)) goto done;
        mal_text_buffer_append_ascii(&text, (const byte *) "\n\nCaught error:\n\n");
        mal_text_buffer_append_string(&text, string);
    }
    assert_fail_buffer(vm, roots[0], roots[1], operator, &text, true);
done:
    if (text.data != nullptr && text.length > 0 && vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_text_buffer_dispose(&text);
    }
    mal_gc_unroot(&root);
}

// expectsError: `threw` false means the function returned or the promise fulfilled.
static void assert_expects_error(MalVm *vm, const char *operator, bool threw, MalValue actual,
    MalValue error, MalValue message, i32 argc, bool rejection) {
    MalValue roots[3] = {actual, error, message};
    MalRootSpan root;
    mal_gc_root(&root, roots, 3);
    if (mal_value_is_string(roots[1])) {
        if (argc >= 3) {
            mal_node_throw_invalid_arg_type(vm, "error", "of type function or an instance of Error, RegExp, or Object", roots[1]);
            goto done;
        }
        roots[2] = roots[1];
        roots[1] = mal_value_new_undefined();
    } else if (!mal_value_is_nil(roots[1]) && !mal_value_is_object(roots[1])) {
        mal_node_throw_invalid_arg_type(vm, "error", "of type function or an instance of Error, RegExp, or Object", roots[1]);
        goto done;
    }
    if (!threw) {
        MalTextBuffer text = {0};
        mal_text_buffer_append_ascii(&text, (const byte *) (rejection ? "Missing expected rejection" : "Missing expected exception"));
        MalValue name;
        if (mal_value_is_object(roots[1]) && assert_get(vm, roots[1], "name", &name) && mal_value_is_truthy(name)) {
            MalString *string;
            if (mal_vm_to_string(vm, name, &string)) {
                mal_text_buffer_append_ascii(&text, (const byte *) " (");
                mal_text_buffer_append_string(&text, string);
                mal_text_buffer_push(&text, ')');
            }
        }
        if (mal_value_is_truthy(roots[2])) {
            MalString *string;
            if (!mal_vm_to_string(vm, roots[2], &string)) {
                mal_text_buffer_dispose(&text);
                goto done;
            }
            mal_text_buffer_append_ascii(&text, (const byte *) ": ");
            mal_text_buffer_append_string(&text, string);
        } else {
            mal_text_buffer_push(&text, '.');
        }
        assert_fail_buffer(vm, mal_value_new_undefined(), roots[1], operator, &text, false);
        goto done;
    }
    if (mal_value_is_nil(roots[1]) || (mal_value_is_boolean(roots[1]) && !mal_value_to_boolean(roots[1]))) goto done;
    assert_expected_exception(vm, roots[0], roots[1], roots[2], operator);
done:
    mal_gc_unroot(&root);
}

static bool assert_has_matching_error(MalVm *vm, MalValue actual, MalValue expected, bool *matches) {
    *matches = false;
    if (!mal_value_is_callable(expected)) {
        if (assert_is_regexp(expected)) {
            MalString *string;
            if (!mal_vm_to_string(vm, actual, &string)) return false;
            MalValue rooted = mal_value_from_string(string);
            MalRootSpan root;
            mal_gc_root(&root, &rooted, 1);
            bool ok = assert_regexp_matches(vm, expected, rooted, matches);
            mal_gc_unroot(&root);
            return ok;
        }
        mal_node_throw_invalid_arg_type(vm, "expected", "of type function or an instance of RegExp", expected);
        return false;
    }
    bool instance = false;
    if (!assert_instance_of(vm, actual, expected, &instance)) return false;
    if (instance) {
        *matches = true;
        return true;
    }
    if (assert_is_error_class(vm, expected)) return true;
    MalValue receiver = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalRootSpan root;
    mal_gc_root(&root, &receiver, 1);
    MalCompletion result = mal_vm_call_value(vm, expected, receiver, &actual, 1);
    mal_gc_unroot(&root);
    if (result.kind == MAL_COMPLETION_THROW) return false;
    *matches = mal_value_is_boolean(result.value) && mal_value_to_boolean(result.value);
    return true;
}

static void assert_expects_no_error(MalVm *vm, const char *operator, bool threw, MalValue actual,
    MalValue error, MalValue message, bool rejection) {
    if (!threw) return;
    MalValue roots[3] = {actual, error, message};
    MalRootSpan root;
    mal_gc_root(&root, roots, 3);
    if (mal_value_is_string(roots[1])) {
        roots[2] = roots[1];
        roots[1] = mal_value_new_undefined();
    }
    bool matches = true;
    if (mal_value_is_truthy(roots[1]) && !assert_has_matching_error(vm, roots[0], roots[1], &matches)) goto done;
    if (!matches) {
        assert_throw_value(vm, roots[0]);
        goto done;
    }
    MalTextBuffer text = {0};
    mal_text_buffer_append_ascii(&text, (const byte *) (rejection ? "Got unwanted rejection" : "Got unwanted exception"));
    if (mal_value_is_truthy(roots[2])) {
        MalString *string;
        if (!mal_vm_to_string(vm, roots[2], &string)) {
            mal_text_buffer_dispose(&text);
            goto done;
        }
        mal_text_buffer_append_ascii(&text, (const byte *) ": ");
        mal_text_buffer_append_string(&text, string);
    } else {
        mal_text_buffer_push(&text, '.');
    }
    mal_text_buffer_append_ascii(&text, (const byte *) "\nActual message: \"");
    MalValue actual_message = mal_value_new_undefined();
    if (mal_value_is_object(roots[0]) && !assert_get(vm, roots[0], "message", &actual_message)) {
        mal_text_buffer_dispose(&text);
        goto done;
    }
    MalString *string;
    if (!mal_vm_to_string(vm, actual_message, &string)) {
        mal_text_buffer_dispose(&text);
        goto done;
    }
    mal_text_buffer_append_string(&text, string);
    mal_text_buffer_push(&text, '"');
    assert_fail_buffer(vm, roots[0], roots[1], operator, &text, false);
done:
    mal_gc_unroot(&root);
}

static bool assert_call_block(MalVm *vm, MalValue fn, bool *threw, MalValue *actual) {
    if (!mal_value_is_callable(fn)) {
        mal_node_throw_invalid_arg_type(vm, "fn", "of type function", fn);
        return false;
    }
    MalCompletion result = mal_vm_call_value(vm, fn, mal_value_new_undefined(), nullptr, 0);
    *threw = result.kind == MAL_COMPLETION_THROW;
    *actual = *threw ? assert_clear_throw(vm) : mal_value_new_undefined();
    return true;
}

ASSERT_FN(assert_throws) {
    ASSERT_UNUSED;
    bool threw;
    MalValue actual = mal_value_new_undefined();
    if (!assert_call_block(vm, ASSERT_ARG(0), &threw, &actual)) return mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, &actual, 1);
    assert_expects_error(vm, "throws", threw, actual, ASSERT_ARG(1), ASSERT_ARG(2), argc, false);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

ASSERT_FN(assert_does_not_throw) {
    ASSERT_UNUSED;
    bool threw;
    MalValue actual = mal_value_new_undefined();
    if (!assert_call_block(vm, ASSERT_ARG(0), &threw, &actual)) return mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, &actual, 1);
    assert_expects_no_error(vm, "doesNotThrow", threw, actual, ASSERT_ARG(1), ASSERT_ARG(2), false);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

// Promise reaction for rejects/doesNotReject. Slots: result promise, error, message, flags.
static MalValue assert_async_settled(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue roots[5] = {
        mal_native_function_object_get_slot(function, 0), mal_native_function_object_get_slot(function, 1),
        mal_native_function_object_get_slot(function, 2), ASSERT_ARG(0), mal_native_function_object_get_slot(function, 3),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    i32 flags = mal_value_to_i32(roots[4]);
    bool rejected = (flags & 1) != 0, rejects = (flags & 2) != 0;
    i32 message_argc = (flags >> 2) & 7;
    if (rejects) {
        assert_expects_error(vm, "rejects", rejected, roots[3], roots[1], roots[2], message_argc, true);
    } else {
        assert_expects_no_error(vm, "doesNotReject", rejected, roots[3], roots[1], roots[2], true);
    }
    MalPromiseObject *promise = mal_value_to_promise_object(roots[0]);
    if (assert_throwing(vm)) {
        MalValue error = assert_clear_throw(vm);
        mal_promise_reject(vm, promise, error);
    } else {
        mal_promise_fulfill(vm, promise, mal_value_new_undefined());
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static bool assert_is_thenable(MalVm *vm, MalValue value) {
    if (mal_value_is_promise_object(value)) return true;
    if (!mal_value_is_object(value)) return false;
    MalValue then, catch_method;
    return assert_get(vm, value, "then", &then) && mal_value_is_callable(then)
        && assert_get(vm, value, "catch", &catch_method) && mal_value_is_callable(catch_method);
}

static MalValue assert_async(MalVm *vm, const MalValue *args, i32 argc, bool rejects) {
    MalValue roots[6] = {ASSERT_ARG(0), ASSERT_ARG(1), ASSERT_ARG(2), MAL_VALUE_UNDEFINED,
        MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[3] = mal_value_from_object((MalObject *) mal_promise_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE])));
    MalPromiseObject *result = mal_value_to_promise_object(roots[3]);
    if (mal_value_is_callable(roots[0])) {
        MalCompletion called = mal_vm_call_value(vm, roots[0], mal_value_new_undefined(), nullptr, 0);
        if (called.kind == MAL_COMPLETION_THROW) {
            mal_promise_reject(vm, result, assert_clear_throw(vm));
            goto done;
        }
        roots[4] = called.value;
        if (!assert_is_thenable(vm, roots[4])) {
            if (!assert_throwing(vm)) {
                mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                    "Expected instance of Promise to be returned from the \"promiseFn\" function but got a non-promise value.",
                    "ERR_INVALID_RETURN_VALUE");
            }
            mal_promise_reject(vm, result, assert_clear_throw(vm));
            goto done;
        }
    } else if (assert_is_thenable(vm, roots[0])) {
        roots[4] = roots[0];
    } else {
        if (!assert_throwing(vm)) {
            mal_node_throw_invalid_arg_type(vm, "promiseFn", "of type function or an instance of Promise", roots[0]);
        }
        mal_promise_reject(vm, result, assert_clear_throw(vm));
        goto done;
    }
    MalValue handlers[2];
    MalRootSpan handler_root;
    handlers[0] = mal_value_new_undefined();
    handlers[1] = mal_value_new_undefined();
    mal_gc_root(&handler_root, handlers, 2);
    for (i32 rejected = 0; rejected < 2; rejected++) {
        i32 flags = rejected | (rejects ? 2 : 0) | ((argc > 7 ? 7 : argc) << 2);
        MalValue slots[4] = {roots[3], roots[1], roots[2], mal_value_from_i32(flags)};
        handlers[rejected] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) ""), 1, assert_async_settled, slots, 4));
    }
    MalValue then;
    if (assert_get(vm, roots[4], "then", &then)) {
        MalCompletion attached = mal_vm_call_value(vm, then, roots[4], handlers, 2);
        if (attached.kind == MAL_COMPLETION_THROW) mal_promise_reject(vm, result, assert_clear_throw(vm));
    } else {
        mal_promise_reject(vm, result, assert_clear_throw(vm));
    }
    mal_gc_unroot(&handler_root);
done:
    MalValue promise = roots[3];
    mal_gc_unroot(&root);
    return promise;
}

ASSERT_FN(assert_rejects) {
    ASSERT_UNUSED;
    return assert_async(vm, args, argc, true);
}

ASSERT_FN(assert_does_not_reject) {
    ASSERT_UNUSED;
    return assert_async(vm, args, argc, false);
}

ASSERT_FN(assertion_error_constructor) {
    (void) receiver;
    MalValue options = ASSERT_ARG(0);
    if (!mal_value_is_object(options)) {
        mal_node_throw_invalid_arg_type(vm, "options", "of type object", options);
        return mal_value_new_undefined();
    }
    MalValue roots[4] = {options, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 4);
    MalValue result = mal_value_new_undefined();
    MalValue operator;
    if (!assert_get(vm, roots[0], "actual", &roots[1]) || !assert_get(vm, roots[0], "expected", &roots[2])
        || !assert_get(vm, roots[0], "message", &roots[3]) || !assert_get(vm, roots[0], "operator", &operator)) {
        goto done;
    }
    char operator_text[64] = "undefined";
    if (mal_value_is_string(operator)) {
        usize length = 0;
        MalString *string = mal_value_to_string(operator);
        const c16 *units = mal_string_code_units(string);
        for (; length < mal_string_length(string) && length + 1 < sizeof operator_text; length++) {
            operator_text[length] = units[length] < 128 ? (char) units[length] : '?';
        }
        operator_text[length] = '\0';
    }
    result = assert_error_build(vm, roots[1], roots[2], operator_text, roots[3],
        mal_value_is_undefined(new_target) ? callee : new_target);
    if (mal_value_is_object(result) && !mal_value_is_string(operator)) {
        mal_intrinsic_define_data(vm, mal_value_to_object(result), (const byte *) "operator", operator, ASSERT_VISIBLE);
    }
done:
    mal_gc_unroot(&root);
    return result;
}

ASSERT_FN(assert_comparison_constructor) {
    ASSERT_UNUSED;
    (void) args;
    (void) argc;
    return mal_value_from_object(mal_intrinsic_new_object(vm));
}

typedef struct AssertMethod {
    const char *name;
    i32 length;
    MalNativeFunctionCallback callback;
    MalNativeFunctionCallback strict;
} AssertMethod;

static const AssertMethod assert_methods[] = {
    {"ok", 2, assert_ok, assert_ok},
    {"equal", 3, assert_equal, assert_strict_equal},
    {"notEqual", 3, assert_not_equal, assert_not_strict_equal},
    {"deepEqual", 3, assert_deep_equal, assert_deep_strict_equal},
    {"notDeepEqual", 3, assert_not_deep_equal, assert_not_deep_strict_equal},
    {"deepStrictEqual", 3, assert_deep_strict_equal, assert_deep_strict_equal},
    {"notDeepStrictEqual", 3, assert_not_deep_strict_equal, assert_not_deep_strict_equal},
    {"strictEqual", 3, assert_strict_equal, assert_strict_equal},
    {"notStrictEqual", 3, assert_not_strict_equal, assert_not_strict_equal},
    {"partialDeepStrictEqual", 3, assert_partial_deep_strict_equal, assert_partial_deep_strict_equal},
    {"throws", 3, assert_throws, assert_throws},
    {"doesNotThrow", 3, assert_does_not_throw, assert_does_not_throw},
    {"rejects", 3, assert_rejects, assert_rejects},
    {"doesNotReject", 3, assert_does_not_reject, assert_does_not_reject},
    {"match", 3, assert_match, assert_match},
    {"doesNotMatch", 3, assert_does_not_match, assert_does_not_match},
    {"fail", 1, assert_fail, assert_fail},
    {"ifError", 1, assert_if_error, assert_if_error},
};

static MalValue assert_function(MalVm *vm, const char *name, i32 length, MalNativeFunctionCallback callback) {
    return mal_value_from_native_function_object(mal_native_function_object_new_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), length, callback));
}

static void assert_install_methods(MalVm *vm, MalObject *target, bool strict, MalValue *scratch) {
    for (usize i = 0; i < countof(assert_methods); i++) {
        const AssertMethod *method = &assert_methods[i];
        *scratch = assert_function(vm, method->name, method->length, strict ? method->strict : method->callback);
        mal_intrinsic_define_data(vm, target, (const byte *) method->name, *scratch, ASSERT_VISIBLE);
    }
}

ASSERT_FN(assert_class_constructor) {
    (void) receiver;
    MalValue roots[3] = {ASSERT_ARG(0), MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 3);
    if (!mal_vm_get_property(vm, mal_value_is_undefined(new_target) ? callee : new_target,
            assert_key(vm, "prototype"), &roots[1])) {
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    MalObject *instance = mal_object_new(&vm->heap, mal_value_is_object(roots[1])
        ? mal_value_to_object(roots[1]) : mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    roots[1] = mal_value_from_object(instance);
    // Node 26's Assert defaults to strict mode; only `strict: false` keeps the legacy methods.
    MalValue strict;
    if (assert_get(vm, roots[0], "strict", &strict) && !(mal_value_is_boolean(strict) && !mal_value_to_boolean(strict))) {
        assert_install_methods(vm, instance, true, &roots[2]);
    }
    MalValue result = assert_throwing(vm) ? mal_value_new_undefined() : roots[1];
    mal_gc_unroot(&root);
    return result;
}

static MalValue assert_constructor(MalVm *vm, const char *name, i32 length, MalNativeFunctionCallback callback,
    MalValue prototype) {
    MalNativeFunctionObject *function = mal_native_function_object_new_arity(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), length, callback);
    mal_native_function_object_set_constructor(function);
    mal_native_function_object_set_handles_new_target_prototype(function);
    MalValue value = mal_value_from_native_function_object(function);
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    mal_intrinsic_define_data(vm, (MalObject *) function, (const byte *) "prototype", prototype, MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, mal_value_to_object(prototype), (const byte *) "constructor", value, ASSERT_HIDDEN);
    mal_gc_unroot(&root);
    return value;
}

static void assert_build_modules(MalVm *vm) {
    MalValue roots[8];
    for (usize i = 0; i < countof(roots); i++) roots[i] = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[0] = assert_function(vm, "ok", 2, assert_ok);
    roots[1] = assert_function(vm, "strict", 2, assert_ok);
    vm->intrinsics[MAL_INTRINSIC_NODE_ASSERT_MODULE] = roots[0];
    vm->intrinsics[MAL_INTRINSIC_NODE_ASSERT_STRICT_MODULE] = roots[1];
    roots[2] = mal_value_from_object(mal_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ERROR_PROTOTYPE])));
    roots[3] = assert_constructor(vm, "AssertionError", 1, assertion_error_constructor, roots[2]);
    mal_object_set_prototype(mal_value_to_object(roots[3]),
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ERROR_CONSTRUCTOR]));
    roots[4] = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[5] = assert_constructor(vm, "Assert", 1, assert_class_constructor, roots[4]);
    assert_install_methods(vm, mal_value_to_object(roots[4]), false, &roots[7]);
    for (i32 strict = 0; strict < 2; strict++) {
        MalObject *target = mal_value_to_object(roots[strict]);
        assert_install_methods(vm, target, strict == 1, &roots[7]);
        mal_intrinsic_define_data(vm, target, (const byte *) "ok", roots[strict], ASSERT_VISIBLE);
        mal_intrinsic_define_data(vm, target, (const byte *) "AssertionError", roots[3], ASSERT_VISIBLE);
        mal_intrinsic_define_data(vm, target, (const byte *) "Assert", roots[5], ASSERT_VISIBLE);
        mal_intrinsic_define_data(vm, target, (const byte *) "strict", roots[1], ASSERT_VISIBLE);
    }
    mal_gc_unroot(&root);
}

void mal_host_install_node_assert(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    if (mal_value_is_undefined(vm->intrinsics[MAL_INTRINSIC_NODE_ASSERT_MODULE])) assert_build_modules(vm);
    mal_node_module_publish(vm, "node:assert", slots, count, vm->intrinsics[MAL_INTRINSIC_NODE_ASSERT_MODULE]);
}

void mal_host_install_node_assert_strict(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    if (mal_value_is_undefined(vm->intrinsics[MAL_INTRINSIC_NODE_ASSERT_MODULE])) assert_build_modules(vm);
    mal_node_module_publish(vm, "node:assert/strict", slots, count,
        vm->intrinsics[MAL_INTRINSIC_NODE_ASSERT_STRICT_MODULE]);
}

#endif /* MAL_NODE */
