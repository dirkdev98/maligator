#include "vm.h"
#include "value_ops.h"
#include "vm_ops.h"
#include <stdio.h>

extern const MalRuntimeImage mal_runtime_image;

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    MalCallable *entry = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, entry);
    if (vm.completion.kind != MAL_COMPLETION_NORMAL) return 1;
    for (i32 i = 0; i < mal_runtime_image.global_count; i++) {
        MalValue value = vm.globals[i];
        if (mal_ops_is_number(value)) {
            f64 number = mal_ops_number_as_f64(value);
            if (isnan(number)) puts("number NaN");
            else if (isinf(number)) puts(number < 0 ? "number -Infinity" : "number Infinity");
            else printf("number %.17g\n", number);
        } else if (mal_value_is_boolean(value)) printf("boolean %d\n", mal_value_to_boolean(value));
        else if (mal_value_is_string(value)) {
            MalString *string = mal_value_to_string(value);
            printf("string ");
            for (usize j = 0; j < mal_string_length(string); j++) printf("%s%u", j == 0 ? "" : ",", (unsigned) mal_string_code_units(string)[j]);
            puts("");
        } else if (mal_value_is_undefined(value)) puts("undefined");
        else if (mal_value_is_null(value)) puts("null");
        else puts("object");
    }
    vm.globals[0] = mal_value_from_string(vm.string_constant_atoms[0]);
    while (mal_string_length(mal_value_to_string(vm.globals[0])) <= MAL_STRING_MAX_CODE_UNITS / 2) {
        MalString *string = mal_value_to_string(vm.globals[0]);
        vm.globals[0] = mal_vm_concat_strings_known(&vm, string, string);
        if (vm.completion.kind == MAL_COMPLETION_THROW) return 2;
    }
    MalString *limit_string = mal_value_to_string(vm.globals[0]);
    mal_vm_concat_strings_known(&vm, limit_string, limit_string);
    if (vm.completion.kind != MAL_COMPLETION_THROW ||
        mal_value_to_object(vm.completion.value)->prototype !=
            mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE])) return 3;
    MalValue thrown = vm.completion.value;
    if (!mal_value_is_undefined(mal_vm_concat_strings_known(&vm, limit_string, limit_string)) ||
        vm.completion.value != thrown) return 4;
    mal_vm_free_callable(entry);
    mal_vm_free(&vm);
    return 0;
}
