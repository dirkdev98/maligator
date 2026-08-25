#include "vm.h"
#include "perf_stats.h"
#include "vm_load.h"
#include "bigint128.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Dev harness for the program wire format (.malw, the program-image-codec.ts format).
//
//   MaligatorLoad <prog.malw>            load into a fresh VM and run it
//   MaligatorLoad --splice <base> <prog> init on <base>, run it, then splice
//                                        <prog> at a nonzero base and run that
//
// The first mode is the slice-2 differential (a loaded runtime image must behave like
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

static MalLoadedRuntimeImage *load(const char *path) {
    usize len = 0;
    u8 *buffer = read_file(path, &len);
    if (buffer == nullptr) {
        return nullptr;
    }
    const char *err = "ok";
    MalLoadedRuntimeImage *loaded = mal_runtime_image_load(buffer, len, &err);
    free(buffer);
    if (loaded == nullptr) {
        fprintf(stderr, "mal_runtime_image_load(%s): %s\n", path, err);
    }
    return loaded;
}

static void dump_loaded_scalars(const MalRuntimeImage *program) {
    for (i32 i = 0; i < program->string_constant_count; i++) {
        const MalString *string = &program->string_constants[i];
        const c16 *units = mal_string_code_units(string);
        printf("string[%d]", i);
        for (usize j = 0; j < mal_string_length(string); j++) {
            printf(" %04x", (unsigned) units[j]);
        }
        putchar('\n');
    }
    for (i32 i = 0; i < program->bigint_constant_count; i++) {
        u128 bits = mal_bigint128_bits(mal_bigint_value(&program->bigint_constants[i]));
        printf("bigint[%d] %016llx%016llx\n", i,
               (unsigned long long) (bits >> 64), (unsigned long long) bits);
    }
    for (i32 i = 0; i < program->literal_template_data_count; i++) {
        printf("literal[%d] %08x\n", i, program->literal_template_data[i]);
    }
    for (i32 function_index = 0; function_index < program->function_count; function_index++) {
        const MalFunction *function = &program->functions[function_index];
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

static bool precompiled_literal_shapes_ready(
    const MalVm *vm,
    const MalRuntimeImage *program,
    i32 function_base,
    i32 string_base
) {
    for (i32 i = 0; i < program->precompiled_literal_shape_count; i++) {
        const MalPrecompiledLiteralShape *descriptor =
            &program->precompiled_literal_shapes[i];
        i32 function_index = descriptor->function_index + function_base;
        MalShape **row = vm->literal_shape_cache[function_index];
        if (row == nullptr || row[descriptor->shape_cache_index] == nullptr) return false;
        const MalShape *shape = row[descriptor->shape_cache_index];
        if (shape->inline_count != (u32) descriptor->key_count) return false;
        for (i32 key = 0; key < descriptor->key_count; key++) {
            i32 string_index = descriptor->key_string_indices[key] + string_base;
            if (string_index < 0
                || string_index >= vm->runtime_image->string_constant_count
                || shape->props[key].slot != (u32) key
                || shape->props[key].key != mal_value_from_heap(
                    (MalHeapHeader *) vm->string_constant_atoms[string_index])) {
                return false;
            }
        }
    }
    return true;
}

int main(int argc, char **argv) {
    bool splice = argc >= 4 && strcmp(argv[1], "--splice") == 0;
    if (argc < 2 || (splice && argc < 4)) {
        fprintf(stderr, "usage: %s <file.malw> | --splice <base.malw> <prog.malw>\n", argv[0]);
        return 2;
    }

    MalVm vm;
    MalLoadedRuntimeImage *base = load(splice ? argv[2] : argv[1]);
    if (base == nullptr) {
        return 2;
    }
    if (getenv("MAL_DUMP_LOADED_SCALARS") != nullptr) {
        dump_loaded_scalars(mal_loaded_runtime_image_get(base));
    }
    mal_vm_init(&vm, mal_loaded_runtime_image_get(base));
    if (getenv("MAL_EXPECT_PRECOMPILED_SHAPES") != nullptr
        && !precompiled_literal_shapes_ready(
            &vm, mal_loaded_runtime_image_get(base), 0, 0)) {
        fprintf(stderr, "precompiled literal shapes were not initialized\n");
        return 1;
    }

    // A from-wire program's installers are unresolved (null), so this is a
    // no-op here; the call site stays uniform with the C-baked entry points. The
    // launch context carries the loader's own command line (never consulted, as
    // the installers are null).
    MalHostLaunchContext launch = {.argc = argc, .argv = argv};
    mal_vm_run_host_installs(&vm, &launch);

    MalCallable *callable = mal_vm_create_callable(&vm, 0);
    mal_perf_stats_reset();
    mal_vm_run(&vm, callable);
    int code = vm.completion.kind == MAL_COMPLETION_THROW ? 1 : 0;

    MalLoadedRuntimeImage *spliced = nullptr;
    if (splice) {
        spliced = load(argv[3]);
        if (spliced == nullptr) {
            return 2;
        }
        vm.completion = (MalCompletion){.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
		i32 string_base = vm.runtime_image->string_constant_count;
        i32 entry = mal_vm_splice_runtime_image(&vm, mal_loaded_runtime_image_get(spliced));
        if (getenv("MAL_EXPECT_PRECOMPILED_SHAPES") != nullptr
            && !precompiled_literal_shapes_ready(
                &vm, mal_loaded_runtime_image_get(spliced), entry, string_base)) {
            fprintf(stderr, "spliced precompiled literal shapes were not initialized\n");
            return 1;
        }
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
        mal_loaded_runtime_image_free(base);
        mal_loaded_runtime_image_free(spliced);
    }

    return code;
}
