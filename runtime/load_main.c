#include "vm.h"
#include "vm_load.h"
#include "bigint128.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Dev harness for the definition wire format (.malw, the serialize-vm.ts format).
//
//   MaligatorLoad <prog.malw>            load into a fresh VM and run it
//   MaligatorLoad --splice <base> <prog> init on <base>, run it, then splice
//                                        <prog> at a nonzero base and run that
//
// The first mode is the slice-2 differential (a loaded program must behave like
// the C-baked path). The --splice mode is the slice-4 check: with a silent base
// establishing nonzero function/global/string bases, the spliced program must
// behave exactly as if run standalone — i.e. the rebasing is correct.

static u8 *read_file(const char *path, usize *len_out) {
    FILE *file = fopen(path, "rb");
    if (file == nullptr) {
        perror("fopen");
        return nullptr;
    }
    if (fseek(file, 0, SEEK_END) != 0) {
        fclose(file);
        return nullptr;
    }
    long length = ftell(file);
    if (length < 0 || fseek(file, 0, SEEK_SET) != 0) {
        fclose(file);
        return nullptr;
    }
    u8 *buffer = malloc((size_t) length);
    if (buffer == nullptr || fread(buffer, 1, (size_t) length, file) != (size_t) length) {
        fclose(file);
        free(buffer);
        return nullptr;
    }
    fclose(file);
    *len_out = (usize) length;
    return buffer;
}

static MalLoadedDefinition *load(const char *path) {
    usize len = 0;
    u8 *buffer = read_file(path, &len);
    if (buffer == nullptr) {
        return nullptr;
    }
    const char *err = "ok";
    MalLoadedDefinition *loaded = mal_vm_load_definition(buffer, len, &err);
    free(buffer);
    if (loaded == nullptr) {
        fprintf(stderr, "mal_vm_load_definition(%s): %s\n", path, err);
    }
    return loaded;
}

static void dump_loaded_scalars(const MalVmDefinition *definition) {
    for (i32 i = 0; i < definition->string_constant_count; i++) {
        const MalString *string = &definition->string_constants[i];
        const c16 *units = mal_string_code_units(string);
        printf("string[%d]", i);
        for (usize j = 0; j < mal_string_length(string); j++) {
            printf(" %04x", (unsigned) units[j]);
        }
        putchar('\n');
    }
    for (i32 i = 0; i < definition->bigint_constant_count; i++) {
        u128 bits = mal_bigint128_bits(mal_bigint_value(&definition->bigint_constants[i]));
        printf("bigint[%d] %016llx%016llx\n", i,
               (unsigned long long) (bits >> 64), (unsigned long long) bits);
    }
    for (i32 i = 0; i < definition->literal_template_data_count; i++) {
        printf("literal[%d] %08x\n", i, definition->literal_template_data[i]);
    }
    for (i32 function_index = 0; function_index < definition->function_count; function_index++) {
        const MalFunction *function = &definition->functions[function_index];
        for (i32 instruction_index = 0; instruction_index < function->instruction_count; instruction_index++) {
            const MalInstruction *instruction = &function->instructions[instruction_index];
            if (instruction->opcode == MAL_OP_CREATE_F64) {
                u64 bits = ((u64) instruction->as.create_f64.bits_high << 32) |
                           instruction->as.create_f64.bits_low;
                printf("f64[%d:%d] %016llx\n", function_index, instruction_index,
                       (unsigned long long) bits);
            }
        }
    }
}

int main(int argc, char **argv) {
    bool splice = argc >= 4 && strcmp(argv[1], "--splice") == 0;
    if (argc < 2 || (splice && argc < 4)) {
        fprintf(stderr, "usage: %s <file.malw> | --splice <base.malw> <prog.malw>\n", argv[0]);
        return 2;
    }

    MalVm vm;
    MalLoadedDefinition *base = load(splice ? argv[2] : argv[1]);
    if (base == nullptr) {
        return 2;
    }
    if (getenv("MAL_DUMP_LOADED_SCALARS") != nullptr) {
        dump_loaded_scalars(mal_loaded_definition_get(base));
    }
    mal_vm_init(&vm, mal_loaded_definition_get(base));

    // A from-wire definition's installers are unresolved (null), so this is a
    // no-op here; the call site stays uniform with the C-baked entry points. The
    // launch context carries the loader's own command line (never consulted, as
    // the installers are null).
    MalHostLaunchContext launch = {.argc = argc, .argv = argv};
    mal_vm_run_host_installs(&vm, &launch);

    MalCallable *callable = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, callable);
    int code = vm.completion.kind == MAL_COMPLETION_THROW ? 1 : 0;

    MalLoadedDefinition *spliced = nullptr;
    if (splice) {
        spliced = load(argv[3]);
        if (spliced == nullptr) {
            return 2;
        }
        vm.completion = (MalCompletion){.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
        i32 entry = mal_vm_splice_definition(&vm, mal_loaded_definition_get(spliced));
        MalCallable *spliced_callable = mal_vm_create_callable(&vm, entry);
        mal_vm_run(&vm, spliced_callable);
        code = vm.completion.kind == MAL_COMPLETION_THROW ? 1 : 0;
        if (getenv("MAL_GC_AT_EXIT") != nullptr) {
            mal_vm_free_callable(spliced_callable);
        }
    }

    if (getenv("MAL_GC_AT_EXIT") != nullptr) {
        mal_gc_collect(&vm);
        mal_vm_free_callable(callable);
        mal_vm_free(&vm);
        mal_vm_loaded_definition_free(base);
        mal_vm_loaded_definition_free(spliced);
    }

    return code;
}
