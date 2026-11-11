#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ascii.h"
#include "gc.h"
#include "object.h"
#include "vm.h"
#include "vm_ops.h"

extern const MalRuntimeImage mal_runtime_image;
#define CHECK(test) do { if (!(test)) { fprintf(stderr, "constant-pool-growth:%d: %s\n", __LINE__, #test); return false; } } while (0)

typedef struct {
    MalRuntimeImage image;
    MalFunction functions[4];
    MalInstruction instructions[4][4];
    u64 bigint_digits[9];
} LoadedConstants;

static void init_string(MalString *string, const char *text) {
    mal_string_init_external_latin1(string, (const u8 *) text, strlen(text));
    string->header.storage = MAL_HEAP_STORAGE_IMMORTAL;
}

static bool initialize(LoadedConstants *loaded, i32 strings, i32 bigints,
                       const char *first, const char *last, i128 value) {
    memset(loaded, 0, sizeof(*loaded));
    loaded->image.string_constant_count = strings;
    loaded->image.string_constants = malloc((usize) strings * sizeof(MalString));
    loaded->image.bigint_constant_count = bigints;
    loaded->image.bigint_constants = malloc((usize) bigints * sizeof(MalBigInt));
    CHECK(loaded->image.string_constants != nullptr && loaded->image.bigint_constants != nullptr);
    for (i32 i = 0; i < strings; i++) init_string(&loaded->image.string_constants[i], "filler");
    init_string(&loaded->image.string_constants[0], first);
    init_string(&loaded->image.string_constants[1], "sv");
    init_string(&loaded->image.string_constants[2], "\xe4");
    init_string(&loaded->image.string_constants[3], "z");
    init_string(&loaded->image.string_constants[strings - 1], last);
    loaded->bigint_digits[0] = (u32) value;
    loaded->bigint_digits[countof(loaded->bigint_digits) - 1] = 1;
    for (i32 i = 0; i < bigints; i++) loaded->image.bigint_constants[i] = (MalBigInt) {
        .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_BIGINT),
        .sign = 1, .digit_count = countof(loaded->bigint_digits), .data.digits = loaded->bigint_digits,
    };
    for (i32 f = 0; f < 3; f++) {
        loaded->instructions[f][0] = f == 2
            ? (MalInstruction) {.opcode = MAL_OP_CREATE_BIGINT, .as.create_bigint = {.dst = 0, .bigint_index = bigints - 1}}
            : (MalInstruction) {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 0, .string_index = f == 0 ? 0 : strings - 1}};
        loaded->instructions[f][1] = (MalInstruction) {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}};
        loaded->functions[f] = (MalFunction) {
            .instructions = loaded->instructions[f], .instruction_count = 2,
            .register_count = 1, .name_string_index = -1, .file_index = -1,
            .closure_capture_owner_count = -1, .argument_retention_limit = -1,
            .kind = MAL_FUNCTION_KIND_NORMAL,
        };
    }
    loaded->instructions[3][0] = (MalInstruction) {.opcode = MAL_OP_CREATE_STRING,
        .as.create_string = {.dst = 0, .string_index = 2}};
    loaded->instructions[3][1] = (MalInstruction) {.opcode = MAL_OP_CREATE_STRING,
        .as.create_string = {.dst = 1, .string_index = 3}};
    loaded->instructions[3][2] = (MalInstruction) {.opcode = MAL_OP_PREPARED_STRING_COMPARE,
        .as.prepared_string_compare = {.dst = 0, .left = 0, .right = 1, .locale_options = 1u << 6}};
    loaded->instructions[3][3] = (MalInstruction) {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}};
    loaded->functions[3] = loaded->functions[0];
    loaded->functions[3].instructions = loaded->instructions[3];
    loaded->functions[3].instruction_count = 4;
    loaded->functions[3].register_count = 2;
    loaded->image.function_count = 4;
    loaded->image.functions = loaded->functions;
    return true;
}

static MalValue execute(MalVm *vm, i32 function) {
    return mal_vm_interpret_function(vm, function, MAL_VALUE_UNDEFINED,
        MAL_VALUE_UNDEFINED, nullptr, 0, MAL_VALUE_UNDEFINED, nullptr);
}

static bool collates_after(MalVm *vm, i32 function) {
    MalValue value = execute(vm, function);
    f64 result;
    return vm->completion.kind == MAL_COMPLETION_NORMAL &&
        mal_ops_try_number_as_f64(value, &result) && result > 0;
}

static bool check_growth(MalVm *vm, LoadedConstants *first, LoadedConstants *second) {
    MalValue roots[5] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED,
        MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    i32 first_function = mal_vm_splice_runtime_image(vm, &first->image);
    CHECK(first_function >= 0 && vm->completion.kind == MAL_COMPLETION_NORMAL);
    CHECK(collates_after(vm, first_function + 3));
    roots[0] = execute(vm, first_function + 1);
    roots[1] = execute(vm, first_function + 2);
    CHECK(mal_value_is_string(roots[0]) && mal_string_equals_ascii(mal_value_to_string(roots[0]), "retained-key"));
    CHECK(mal_value_is_bigint(roots[1]) && mal_bigint_compare(mal_value_to_bigint(roots[1]), &first->image.bigint_constants[0]) == 0);
    roots[2] = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    MalKey key;
    CHECK(mal_vm_to_property_key(vm, roots[0], &key));
    CHECK(mal_vm_set_property(vm, roots[2], key, roots[1], roots[2]));
    // Widening must mutate this VM's stable row, even after its directory grows.
    const c16 *units = mal_string_code_units(mal_value_to_string(roots[0]));
    CHECK(units[0] == 'r');
    i32 second_function = mal_vm_splice_runtime_image(vm, &second->image);
    CHECK(second_function >= 0 && vm->completion.kind == MAL_COMPLETION_NORMAL);
    CHECK(collates_after(vm, second_function + 3));
    roots[3] = execute(vm, second_function + 1);
    roots[4] = execute(vm, second_function + 2);
    mal_gc_collect(vm);
    CHECK(mal_string_equals_ascii(mal_value_to_string(roots[0]), "retained-key"));
    CHECK(mal_bigint_compare(mal_value_to_bigint(roots[1]), &first->image.bigint_constants[0]) == 0);
    CHECK(mal_string_equals_ascii(mal_value_to_string(roots[3]), "new-key"));
    CHECK(mal_bigint_compare(mal_value_to_bigint(roots[4]), &second->image.bigint_constants[0]) == 0);
    CHECK(execute(vm, first_function + 1) == roots[0]);
    CHECK(execute(vm, first_function + 2) == roots[1]);
    MalValue duplicate = execute(vm, second_function);
    CHECK(mal_vm_to_property_key(vm, duplicate, &key));
    MalValue observed;
    CHECK(mal_vm_get_property(vm, roots[2], key, &observed) && observed == roots[1]);
    CHECK(vm->completion.kind == MAL_COMPLETION_NORMAL);
    MalRuntimeImage oversized = {.string_constant_count = INT32_MAX};
    CHECK(mal_vm_splice_runtime_image(vm, &oversized) == -1);
    CHECK(vm->completion.kind == MAL_COMPLETION_THROW);
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = MAL_VALUE_UNDEFINED};
    CHECK(execute(vm, first_function + 1) == roots[0]);
    mal_gc_unroot(&span);
    return true;
}

int main(void) {
    LoadedConstants first, second;
    if (!initialize(&first, 131073, 16385, "first-key", "retained-key", 817) ||
        !initialize(&second, 3 * 4096 + 1, 3 * 4096 + 1, "retained-key", "new-key", 927)) return 1;
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    bool ok = check_growth(&vm, &first, &second);
    mal_vm_free(&vm);
    free(first.image.string_constants);
    free(first.image.bigint_constants);
    free(second.image.string_constants);
    free(second.image.bigint_constants);
    if (!ok) return 1;
    puts("constant-pool-growth PASS");
    return 0;
}
