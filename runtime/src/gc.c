#include "./gc.h"

#include <stdio.h>
#include <stdlib.h>

#include "./array_buffer_object.h"
#include "./array_object.h"
#include "./bound_function_object.h"
#include "./builtin_data_view.h"
#include "./builtin_finalization_registry.h"
#include "./builtin_iterator_helpers.h"
#include "./builtin_weak_ref.h"
#include "./function_object.h"
#include "./generator_object.h"
#include "./heap_string.h"
#include "./heap_symbol.h"
#include "./intl_object.h"
#include "./iterator_object.h"
#include "./map_object.h"
#include "./microtask.h"
#include "./module_namespace_object.h"
#include "./object.h"
#include "./primitive_wrapper_object.h"
#include "./promise_object.h"
#include "./property_store.h"
#include "./proxy_object.h"
#include "./regexp_object.h"
#include "./shape.h"
#include "./typed_array_object.h"
#include "./vm.h"
#include "mal_i18n.h"
#include "mal_regexp.h"

/*
 * Mutator-contract state + hooks. The flags stay false and the SATB hook is a
 * no-op until concurrent marking is enabled; the stop-the-world collector below
 * runs only when invoked explicitly (the gc() host hook), never from the
 * allocator or a safepoint, so an ordinary run never collects.
 */

#if MAL_GC_CONCURRENT
bool mal_gc_marking_active = false;
#endif

volatile bool mal_gc_poll = false;

MalRootFrame *mal_root_frame_head = nullptr;
MalRootSpan *mal_root_span_head = nullptr;

void mal_gc_satb_record(MalValue old_value) {
    (void) old_value;
}

/* Stress mode (MAL_GC_STRESS=N): collect every N gated safepoints to shake out
 * missing roots / trace edges. =1 collects at every dispatch (most aggressive);
 * larger N is faster for running broad suites under collection. Works on both
 * backends now that compiled frames publish root frames.
 * MAL_GC_VERIFY: after each sweep, assert no survivor/root points at a freed cell
 * (catches a missing root/edge that swept a still-reachable cell). */
static i32 g_gc_stress_interval = 0;
static i32 g_gc_stress_counter = 0;
static bool g_gc_verify_enabled = false;
static bool g_gc_verifying = false;

/* Auto-collection heap-growth policy: the first collection fires once this many
 * bytes have been allocated; after each one the next trigger is set past the
 * surviving set by at least this floor (so a small live set cannot thrash). */
#define MAL_GC_DEFAULT_THRESHOLD ((usize) 16 * 1024 * 1024)
#define MAL_GC_MIN_INCREMENT ((usize) 4 * 1024 * 1024)

usize mal_gc_next_at = (usize) -1;

void mal_gc_init(void) {
    const char *stress = getenv("MAL_GC_STRESS");
    if (stress != nullptr && stress[0] != '\0' && stress[0] != '0') {
        g_gc_stress_interval = atoi(stress);
        if (g_gc_stress_interval < 1) {
            g_gc_stress_interval = 1;
        }
        mal_gc_poll = true; // make the interpreter poll fire at every dispatch
    } else if (getenv("MAL_GC_OFF") == nullptr) {
        // Auto-collection (default): the allocator raises mal_gc_poll when
        // bytes_allocated reaches mal_gc_next_at; the next safepoint collects.
        const char *thr = getenv("MAL_GC_THRESHOLD");
        mal_gc_next_at =
            thr != nullptr ? (usize) strtoull(thr, nullptr, 10) : MAL_GC_DEFAULT_THRESHOLD;
        if (mal_gc_next_at == 0) {
            mal_gc_next_at = 1;
        }
    }
    g_gc_verify_enabled = getenv("MAL_GC_VERIFY") != nullptr;
    // Poisoning dead cells makes a use-after-free of a missed root crash loudly
    // rather than silently alias a recycled cell; pair it with verification.
    mal_heap_poison_on_free = g_gc_verify_enabled;
}

void mal_gc_safepoint(MalVm *vm) {
    // Only safe to collect when no native builtin is active: its C-local scratch
    // is not enumerable as a root, so collecting inside one could free values it
    // still holds. Compiled frames are fine (they publish root frames); all other
    // live state is in the interpreter frames + value stack, covered by the scan.
    if (vm->gc_native_frames != 0) {
        return;
    }
    if (g_gc_stress_interval != 0) {
        if (++g_gc_stress_counter >= g_gc_stress_interval) {
            g_gc_stress_counter = 0;
            mal_gc_collect(vm);
        }
        return;
    }
    // Auto mode: the poll was raised because bytes_allocated crossed the trigger.
    // Collect (which advances mal_gc_next_at) and lower the poll until the next.
    mal_gc_collect(vm);
    mal_gc_poll = false;
}

// ---------------------------------------------------------------------------
// Stop-the-world mark/sweep collector.
//
// Tri-color marking with an explicit grey worklist (no recursion): roots are
// shaded grey, then drained, tracing each cell's outgoing edges. The header mark
// field is the colour. A non-moving sweep then finalizes and reclaims unreached
// cells. Single mutator, single thread: the whole thing runs to completion at
// the call site. Shapes and closure environments are not GC cells yet (they are
// malloc'd directly), so they are traced through but never marked or swept.
// ---------------------------------------------------------------------------

static MalVm *g_gc_vm = nullptr;
static MalHeapHeader **g_grey = nullptr;
static usize g_grey_count = 0;
static usize g_grey_capacity = 0;

static void mal_gc_grey_push(MalHeapHeader *cell) {
    if (g_grey_count == g_grey_capacity) {
        g_grey_capacity = g_grey_capacity == 0 ? 4096 : g_grey_capacity * 2;
        g_grey = realloc(g_grey, g_grey_capacity * sizeof(MalHeapHeader *));
    }
    g_grey[g_grey_count++] = cell;
}

// Weak collections (WeakMap/WeakSet) reached during the main mark. Their entry
// key/value edges are NOT traced there; the ephemeron pass after the mark marks
// each value whose key is live (a fixpoint) and drops entries with dead keys.
static MalMapObject **g_weak_maps = nullptr;
static usize g_weak_maps_count = 0;
static usize g_weak_maps_capacity = 0;

static void mal_gc_register_weak_map(MalMapObject *map) {
    if (g_weak_maps_count == g_weak_maps_capacity) {
        g_weak_maps_capacity = g_weak_maps_capacity == 0 ? 64 : g_weak_maps_capacity * 2;
        g_weak_maps = realloc(g_weak_maps, g_weak_maps_capacity * sizeof(MalMapObject *));
    }
    g_weak_maps[g_weak_maps_count++] = map;
}

// WeakRefs reached during the main mark: their target edge is weak, so it is not
// followed here; the weak pass nulls the target if it did not otherwise survive.
static MalWeakRefObject **g_weak_refs = nullptr;
static usize g_weak_refs_count = 0;
static usize g_weak_refs_capacity = 0;

static void mal_gc_register_weak_ref(MalWeakRefObject *ref) {
    if (g_weak_refs_count == g_weak_refs_capacity) {
        g_weak_refs_capacity = g_weak_refs_capacity == 0 ? 64 : g_weak_refs_capacity * 2;
        g_weak_refs = realloc(g_weak_refs, g_weak_refs_capacity * sizeof(MalWeakRefObject *));
    }
    g_weak_refs[g_weak_refs_count++] = ref;
}

// FinalizationRegistries reached during the main mark. Their cells' target +
// unregister_token are weak edges; the weak pass enqueues a cleanup job for each
// reclaimed target and unlinks that cell.
static MalFinalizationRegistryObject **g_fin_regs = nullptr;
static usize g_fin_regs_count = 0;
static usize g_fin_regs_capacity = 0;

static void mal_gc_register_fin_reg(MalFinalizationRegistryObject *reg) {
    if (g_fin_regs_count == g_fin_regs_capacity) {
        g_fin_regs_capacity = g_fin_regs_capacity == 0 ? 32 : g_fin_regs_capacity * 2;
        g_fin_regs = realloc(g_fin_regs, g_fin_regs_capacity * sizeof(MalFinalizationRegistryObject *));
    }
    g_fin_regs[g_fin_regs_count++] = reg;
}

// Scratch list of dead keys to delete from a weak collection after its pass
// (deleting mid-iteration is avoided).
static MalKey *g_dead_keys = nullptr;
static usize g_dead_keys_count = 0;
static usize g_dead_keys_capacity = 0;

static void mal_gc_dead_key_push(MalKey key) {
    if (g_dead_keys_count == g_dead_keys_capacity) {
        g_dead_keys_capacity = g_dead_keys_capacity == 0 ? 64 : g_dead_keys_capacity * 2;
        g_dead_keys = realloc(g_dead_keys, g_dead_keys_capacity * sizeof(MalKey));
    }
    g_dead_keys[g_dead_keys_count++] = key;
}

/** Shade a cell grey: a managed, non-immortal cell reached for the first time.
 * In verify mode it instead asserts the cell is already marked — a reachable but
 * unmarked cell means a trace edge was missed. */
static void mal_gc_shade(MalHeapHeader *cell) {
    if (cell == nullptr || cell->storage == MAL_HEAP_STORAGE_IMMORTAL) {
        return;
    }
    if (g_gc_verifying) {
        if (cell->mark == MAL_MARK_FREE) {
            fprintf(stderr, "[gc verify] live cell points to a freed cell type=%d: "
                "a root or trace edge was missed, the target was swept while still "
                "reachable\n", cell->type);
            abort();
        }
        return;
    }
    if (cell->mark == MAL_MARK_BLACK) {
        return;
    }
    cell->mark = MAL_MARK_BLACK;
    mal_gc_grey_push(cell);
}

static void mal_gc_mark_value(MalValue value) {
    if (mal_value_is_heap(value)) {
        mal_gc_shade(mal_value_to_heap(value));
    }
}

/** Whether a value is live for weak-reference purposes: a non-heap or immortal
 * value is always live; a managed cell is live iff the main mark reached it. */
static bool mal_gc_is_marked(MalValue value) {
    if (!mal_value_is_heap(value)) {
        return true;
    }
    MalHeapHeader *cell = mal_value_to_heap(value);
    return cell->storage == MAL_HEAP_STORAGE_IMMORTAL || cell->mark == MAL_MARK_BLACK;
}

static void mal_gc_mark_values(const MalValue *values, i32 count) {
    if (values == nullptr) {
        return;
    }
    for (i32 i = 0; i < count; ++i) {
        mal_gc_mark_value(values[i]);
    }
}

static void mal_gc_mark_object(MalObject *object) {
    if (object != nullptr) {
        mal_gc_shade(&object->header);
    }
}

static void mal_gc_mark_string(MalString *string) {
    if (string != nullptr) {
        mal_gc_shade(&string->header);
    }
}

/** Trace a table's live entries (keys + inline values + descriptor refs). */
static void mal_gc_trace_table(MalTable *table) {
    if (table == nullptr) {
        return;
    }
    MalTableIter iter;
    mal_table_iter_init(&iter, table, MAL_TABLE_ITER_STORAGE);
    MalKey key;
    void *entry;
    while (mal_table_iter_next(&iter, &key, &entry)) {
        mal_gc_mark_value(key.value);
        mal_gc_mark_value(mal_table_entry_value(table, entry));
        MalPropertyDesc *desc = mal_table_entry_data(table, entry);
        if (desc != nullptr) {
            mal_gc_mark_value(desc->value);
            mal_gc_mark_value(desc->getter);
            mal_gc_mark_value(desc->setter);
        }
    }
}

/** Shade a closure environment cell. Its captured slots and parent chain are
 * traced when the cell is drained from the grey worklist (mal_gc_trace_cell,
 * MAL_HEAP_ENV) — keeping reachable envs (and only those) alive through a sweep. */
static void mal_gc_trace_env(MalEnv *env) {
    if (env != nullptr) {
        mal_gc_shade(&env->header);
    }
}

/** Trace an interpreter / generator activation frame. */
static void mal_gc_trace_frame(MalVmFrame *frame) {
    if (frame->function != nullptr) {
        mal_gc_mark_values(frame->registers, frame->function->register_count);
    }
    mal_gc_mark_values(frame->arguments, frame->argument_count);
    mal_gc_mark_value(frame->this_value);
    mal_gc_mark_value(frame->arguments_object);
    mal_gc_mark_value(frame->callee);
    mal_gc_mark_value(frame->new_target);
    mal_gc_mark_values(frame->with_objects, frame->with_count);
    mal_gc_trace_env(frame->env);
}

/** Common edges of every MalObject-based cell: prototype, inline slots, overflow.
 * The shape is not a GC cell, but its property keys can be heap strings (a
 * computed/concatenated key), so they are marked here through the owning object. */
static void mal_gc_trace_object_common(MalObject *object) {
    mal_gc_mark_object(object->prototype);
    const MalShape *shape = object->shape;
    if (object->slots != nullptr) {
        for (u32 i = 0; i < shape->inline_count; ++i) {
            mal_gc_mark_value(shape->props[i].key.value);
            mal_gc_mark_value(object->slots[shape->props[i].slot]);
        }
    }
    mal_gc_trace_table(object->overflow);
}

/** Trace a cell's outgoing edges (the cell is already BLACK). */
static void mal_gc_trace_cell(MalHeapHeader *cell) {
    switch (cell->type) {
        case MAL_HEAP_STRING:
        case MAL_HEAP_BIGINT:
            return; // leaves (code_units / digits are non-pointer payload)
        case MAL_HEAP_SYMBOL:
            mal_gc_mark_string(((MalSymbol *) cell)->description);
            return;
        case MAL_HEAP_ENV: {
            // Not a MalObject: trace the parent env and this env's captured slots
            // (the count is stored on the env, so synthetic per-iteration envs trace
            // too).
            MalEnv *env = (MalEnv *) cell;
            if (env->parent != nullptr) {
                mal_gc_shade(&env->parent->header);
            }
            mal_gc_mark_values(env->slots, env->slot_count);
            return;
        }
        default:
            break;
    }

    MalObject *object = (MalObject *) cell;
    mal_gc_trace_object_common(object);

    switch (cell->type) {
        case MAL_HEAP_ARRAY_OBJECT: {
            // Dense element vector: trace the live region [0, dense_count). Hole
            // sentinels are static (non-pointer) values, so marking them is a no-op.
            MalArrayObject *array = (MalArrayObject *) cell;
            if (array->elements != nullptr) {
                mal_gc_mark_values(array->elements, (i32) array->dense_count);
            }
            break;
        }
        case MAL_HEAP_FUNCTION_OBJECT:
            mal_gc_trace_env(((MalFunctionObject *) cell)->creation_env);
            break;
        case MAL_HEAP_NATIVE_FUNCTION_OBJECT: {
            MalNativeFunctionObject *fn = (MalNativeFunctionObject *) cell;
            mal_gc_mark_string(fn->name);
            mal_gc_mark_values(fn->slots, fn->slot_count);
            break;
        }
        case MAL_HEAP_BOUND_FUNCTION_OBJECT: {
            MalBoundFunctionObject *bound = (MalBoundFunctionObject *) cell;
            mal_gc_mark_value(bound->target);
            mal_gc_mark_value(bound->bound_this);
            mal_gc_mark_values(bound->bound_args, bound->bound_count);
            break;
        }
        case MAL_HEAP_PRIMITIVE_WRAPPER_OBJECT:
            mal_gc_mark_value(((MalPrimitiveWrapperObject *) cell)->primitive_data);
            break;
        case MAL_HEAP_ITERATOR_OBJECT:
            mal_gc_mark_value(((MalIteratorObject *) cell)->target);
            break;
        case MAL_HEAP_MAP_OBJECT:
        case MAL_HEAP_SET_OBJECT: {
            MalMapObject *map = (MalMapObject *) cell;
            // A weak collection's entries are not strong edges: defer them to the
            // ephemeron pass (which marks values of live keys and drops the rest).
            // In verify mode the pass has already run, so trace them as a normal
            // dangling check — every survivor must be live.
            if (map->weak && !g_gc_verifying) {
                mal_gc_register_weak_map(map);
            } else {
                mal_gc_trace_table(map->entries);
            }
            break;
        }
        case MAL_HEAP_TYPED_ARRAY_OBJECT:
            mal_gc_mark_object((MalObject *) ((MalTypedArrayObject *) cell)->buffer);
            break;
        case MAL_HEAP_DATA_VIEW_OBJECT:
            mal_gc_mark_object((MalObject *) mal_data_view_object_buffer((MalDataViewObject *) cell));
            break;
        case MAL_HEAP_PROXY_OBJECT: {
            MalProxyObject *proxy = (MalProxyObject *) cell;
            mal_gc_mark_value(proxy->target);
            mal_gc_mark_value(proxy->handler);
            break;
        }
        case MAL_HEAP_INTL_OBJECT: {
            MalIntlObject *intl = (MalIntlObject *) cell;
            mal_gc_mark_value(intl->data);
            mal_gc_mark_value(intl->bound);
            break;
        }
        case MAL_HEAP_REGEXP_OBJECT: {
            MalRegExpObject *re = (MalRegExpObject *) cell;
            mal_gc_mark_string(re->source);
            mal_gc_mark_string(re->flags);
            break;
        }
        case MAL_HEAP_REGEXP_STRING_ITERATOR_OBJECT: {
            MalRegExpStringIteratorObject *it = (MalRegExpStringIteratorObject *) cell;
            mal_gc_mark_value(it->regexp);
            mal_gc_mark_string(it->string);
            break;
        }
        case MAL_HEAP_ITERATOR_HELPER_OBJECT: {
            MalIteratorHelperObject *ih = (MalIteratorHelperObject *) cell;
            mal_gc_mark_value(ih->iterator);
            mal_gc_mark_value(ih->next_method);
            mal_gc_mark_value(ih->callback);
            mal_gc_mark_value(ih->inner_iterator);
            mal_gc_mark_value(ih->inner_next);
            mal_gc_mark_value(ih->sources);
            mal_gc_mark_value(ih->source_methods);
            break;
        }
        case MAL_HEAP_WEAK_REF_OBJECT:
            // The target is a weak edge: register for the weak pass, do not follow
            // it. In verify mode the pass has run (target is undefined or a
            // survivor), so trace it as an ordinary dangling check.
            if (g_gc_verifying) {
                mal_gc_mark_value(((MalWeakRefObject *) cell)->target);
            } else {
                mal_gc_register_weak_ref((MalWeakRefObject *) cell);
            }
            break;
        case MAL_HEAP_FINALIZATION_REGISTRY_OBJECT: {
            MalFinalizationRegistryObject *reg = (MalFinalizationRegistryObject *) cell;
            mal_gc_mark_value(reg->cleanup_callback); // strong
            for (MalFinRegCell *fc = reg->cells; fc != nullptr; fc = fc->next) {
                mal_gc_mark_value(fc->held_value); // strong; passed to the callback
                if (g_gc_verifying) {
                    // Survivors after the pass: targets/tokens must be live too.
                    mal_gc_mark_value(fc->target);
                    mal_gc_mark_value(fc->unregister_token);
                }
            }
            // target / unregister_token are weak edges, handled by the weak pass.
            if (!g_gc_verifying) {
                mal_gc_register_fin_reg(reg);
            }
            break;
        }
        case MAL_HEAP_MODULE_NAMESPACE_OBJECT: {
            MalModuleNamespaceObject *ns = (MalModuleNamespaceObject *) cell;
            for (i32 i = 0; i < ns->export_count; ++i) {
                mal_gc_mark_string(ns->exports[i].name);
            }
            break;
        }
        case MAL_HEAP_GENERATOR_OBJECT: {
            MalGeneratorObject *gen = (MalGeneratorObject *) cell;
            mal_gc_trace_frame(&gen->frame);
            mal_gc_mark_value(gen->yielded_value);
            mal_gc_mark_value(gen->async_resolve);
            mal_gc_mark_value(gen->async_reject);
            if (gen->awaited_by != nullptr) {
                mal_gc_shade(&gen->awaited_by->object.header);
            }
            // Pending async-generator requests (malloc'd nodes, traced via the
            // owner): each holds a settle capability + the resume value, live until
            // the driver dequeues it. Missing this swept queued resolve/reject
            // functions out from under a pending next/throw/return.
            for (MalAsyncGeneratorRequest *req = gen->agen_queue_head; req != nullptr; req = req->next) {
                mal_gc_mark_value(req->resolve);
                mal_gc_mark_value(req->reject);
                mal_gc_mark_value(req->value);
            }
            break;
        }
        case MAL_HEAP_PROMISE_OBJECT: {
            MalPromiseObject *promise = (MalPromiseObject *) cell;
            mal_gc_mark_value(promise->result);
            for (MalPromiseReaction *r = promise->fulfill_reactions; r != nullptr; r = r->next) {
                mal_gc_mark_value(r->cap_resolve);
                mal_gc_mark_value(r->cap_reject);
                mal_gc_mark_value(r->handler);
            }
            for (MalPromiseReaction *r = promise->reject_reactions; r != nullptr; r = r->next) {
                mal_gc_mark_value(r->cap_resolve);
                mal_gc_mark_value(r->cap_reject);
                mal_gc_mark_value(r->handler);
            }
            if (promise->async_owner != nullptr) {
                mal_gc_shade(&promise->async_owner->object.header);
            }
            break;
        }
        default:
            break; // OBJECT / ARRAY (elements live in the overflow table) / DATE:
                    // common edges only
    }
}

// --- Roots -----------------------------------------------------------------

/** Trace a microtask job's live MalValue fields (queued or currently running). */
static void mal_gc_mark_job(MalJob *job) {
    mal_gc_mark_value(job->handler);
    mal_gc_mark_value(job->cap_resolve);
    mal_gc_mark_value(job->cap_reject);
    mal_gc_mark_value(job->argument);
    mal_gc_mark_value(job->then);
    mal_gc_mark_value(job->thenable);
    mal_gc_mark_value(job->resolve_fn);
    mal_gc_mark_value(job->reject_fn);
}

static void mal_gc_scan_roots(MalVm *vm) {
    mal_gc_mark_values(vm->value_stack, vm->value_stack_size);
    for (i32 i = 0; i < vm->frame_count; ++i) {
        mal_gc_trace_frame(&vm->frames[i]);
    }
    mal_gc_mark_values(vm->globals, vm->definition->global_count);
    mal_gc_mark_values(vm->intrinsics, MAL_INTRINSIC_COUNT);
    mal_gc_mark_value(vm->completion.value);
    mal_gc_mark_values(vm->unhandled_rejections, vm->unhandled_count);
    mal_gc_mark_value(vm->entry_async_promise);
    mal_gc_trace_table(vm->symbol_registry);
    mal_gc_trace_table(vm->atoms);

    for (MalJob *job = vm->job_head; job != nullptr; job = job->next) {
        mal_gc_mark_job(job);
    }
    if (vm->active_job != nullptr) {
        mal_gc_mark_job(vm->active_job);
    }
    mal_gc_mark_values(vm->kept_objects, vm->kept_count);

    if (vm->cjs_registry != nullptr) {
        for (i32 i = 0; i < vm->definition->cjs_module_count; ++i) {
            mal_gc_mark_value(vm->cjs_registry[i].module_object);
        }
    }

    // Compiled (native-backend) activation frames: each links a MalRootFrame whose
    // slots alias its live MalValue registers. Plus any transient C scratch a
    // builtin rooted with a root span.
    for (MalRootFrame *frame = mal_root_frame_head; frame != nullptr; frame = frame->prev) {
        mal_gc_mark_values(frame->slots, frame->desc->slot_count);
        mal_gc_trace_env(frame->env);
    }
    for (MalRootSpan *span = mal_root_span_head; span != nullptr; span = span->prev) {
        mal_gc_mark_values(span->slots, span->count);
    }
}

// --- Finalization ----------------------------------------------------------

static void mal_gc_finalize_cell(MalHeapHeader *cell) {
    switch (cell->type) {
        case MAL_HEAP_STRING: {
            MalString *string = (MalString *) cell;
            if (string->storage == MAL_STRING_STORAGE_OWNED) {
                gc_free_raw(&g_gc_vm->heap, (void *) string->code_units);
                string->code_units = nullptr;
            }
            return;
        }
        case MAL_HEAP_SYMBOL:
        case MAL_HEAP_BIGINT:
        case MAL_HEAP_ENV:
            return; // no owned side allocations (env slots are inline, not a MalObject)
        default:
            break;
    }

    // MalObject-based cell: free its type-specific owned memory, then the common
    // overflow table and inline-slots buffer. Idempotent (null after free).
    switch (cell->type) {
        case MAL_HEAP_ARRAY_OBJECT: {
            MalArrayObject *array = (MalArrayObject *) cell;
            if (array->elements != nullptr) {
                free(array->elements);
                array->elements = nullptr;
                array->capacity = 0;
                array->dense_count = 0;
            }
            break;
        }
        case MAL_HEAP_MAP_OBJECT:
        case MAL_HEAP_SET_OBJECT: {
            MalMapObject *map = (MalMapObject *) cell;
            if (map->entries != nullptr) {
                mal_table_free(map->entries);
                map->entries = nullptr;
            }
            break;
        }
        case MAL_HEAP_ARRAY_BUFFER_OBJECT: {
            MalArrayBufferObject *buffer = (MalArrayBufferObject *) cell;
            if (!buffer->detached && buffer->data != nullptr) {
                free(buffer->data);
                buffer->data = nullptr;
                buffer->detached = true;
            }
            break;
        }
        case MAL_HEAP_NATIVE_FUNCTION_OBJECT: {
            MalNativeFunctionObject *fn = (MalNativeFunctionObject *) cell;
            if (fn->slots != nullptr) {
                gc_free_raw(&g_gc_vm->heap, fn->slots);
                fn->slots = nullptr;
            }
            break;
        }
        case MAL_HEAP_BOUND_FUNCTION_OBJECT: {
            MalBoundFunctionObject *bound = (MalBoundFunctionObject *) cell;
            if (bound->bound_args != nullptr) {
                gc_free_raw(&g_gc_vm->heap, bound->bound_args);
                bound->bound_args = nullptr;
            }
            break;
        }
        case MAL_HEAP_REGEXP_OBJECT: {
            MalRegExpObject *re = (MalRegExpObject *) cell;
            if (re->matcher != nullptr) {
                mal_regexp_free(re->matcher);
                re->matcher = nullptr;
            }
            break;
        }
        case MAL_HEAP_INTL_OBJECT: {
            MalIntlObject *intl = (MalIntlObject *) cell;
            if (intl->handle != nullptr) {
                if (intl->kind == MAL_INTL_COLLATOR) {
                    mal_i18n_collator_free(intl->handle);
                } else if (intl->kind == MAL_INTL_PLURAL_RULES) {
                    mal_i18n_plural_rules_free(intl->handle);
                }
                intl->handle = nullptr;
            }
            break;
        }
        case MAL_HEAP_MODULE_NAMESPACE_OBJECT: {
            MalModuleNamespaceObject *ns = (MalModuleNamespaceObject *) cell;
            if (ns->exports != nullptr) {
                free(ns->exports);
                ns->exports = nullptr;
            }
            break;
        }
        case MAL_HEAP_FINALIZATION_REGISTRY_OBJECT: {
            MalFinalizationRegistryObject *reg = (MalFinalizationRegistryObject *) cell;
            MalFinRegCell *fc = reg->cells;
            while (fc != nullptr) {
                MalFinRegCell *next = fc->next;
                free(fc);
                fc = next;
            }
            reg->cells = nullptr;
            break;
        }
        default:
            break;
    }

    MalObject *object = (MalObject *) cell;
    if (object->overflow != nullptr) {
        mal_table_free(object->overflow);
        object->overflow = nullptr;
    }
    if (object->slots != nullptr) {
        free(object->slots);
        object->slots = nullptr;
    }
}

// --- Entry point -----------------------------------------------------------

/** Verify visitor: re-trace a survivor's edges (in verify mode shading aborts on
 * a freed target). FREE cells are dead this cycle and are skipped. */
static void mal_gc_verify_cell(MalHeapHeader *cell) {
    if (cell->mark != MAL_MARK_FREE) {
        mal_gc_trace_cell(cell);
    }
}

/** Post-sweep dangling-pointer check (MAL_GC_VERIFY): every root and surviving
 * cell must point only at other survivors, never at a cell the sweep just freed.
 * A freed target means marking missed a live cell (a missing root or trace edge)
 * and swept it from under a still-reachable reference — the exact corruption that
 * later reads as a use-after-free. Runs right after the sweep, before any new
 * allocation can recycle a freed cell, so MAL_MARK_FREE is unambiguous. */
static void mal_gc_verify(MalVm *vm) {
    g_gc_verifying = true;
    mal_gc_scan_roots(vm);
    mal_heap_walk_cells(&vm->heap, mal_gc_verify_cell);
    g_gc_verifying = false;
}

/** Drain the grey worklist, tracing each cell's strong edges. */
static void mal_gc_drain(void) {
    while (g_grey_count > 0) {
        mal_gc_trace_cell(g_grey[--g_grey_count]);
    }
}

/** Weak-reference processing, after the main mark has drained. Today: the
 * WeakMap/WeakSet ephemeron pass. A weak entry's value is live iff its key is
 * live, and marking a value can revive another collection's key, so iterate the
 * "mark values of live keys" step to a fixpoint; then drop entries whose key did
 * not survive. Keys are tested, never shaded — that is what makes them weak. */
static void mal_gc_weak_pass(void) {
    bool changed = true;
    while (changed) {
        changed = false;
        for (usize i = 0; i < g_weak_maps_count; ++i) {
            MalTable *entries = g_weak_maps[i]->entries;
            if (entries == nullptr) {
                continue;
            }
            MalTableIter iter;
            mal_table_iter_init(&iter, entries, MAL_TABLE_ITER_STORAGE);
            MalKey key;
            void *entry;
            while (mal_table_iter_next(&iter, &key, &entry)) {
                if (!mal_gc_is_marked(key.value)) {
                    continue;
                }
                MalValue value = mal_table_entry_value(entries, entry);
                if (mal_value_is_heap(value) && !mal_gc_is_marked(value)) {
                    mal_gc_mark_value(value);
                    changed = true;
                }
            }
        }
        mal_gc_drain(); // a freshly marked value may revive another weak key
    }

    // Drop entries whose key did not survive (collected first; deleting mid-
    // iteration is avoided). The values, if dead, are reclaimed by the sweep.
    for (usize i = 0; i < g_weak_maps_count; ++i) {
        MalTable *entries = g_weak_maps[i]->entries;
        if (entries == nullptr) {
            continue;
        }
        g_dead_keys_count = 0;
        MalTableIter iter;
        mal_table_iter_init(&iter, entries, MAL_TABLE_ITER_STORAGE);
        MalKey key;
        void *entry;
        while (mal_table_iter_next(&iter, &key, &entry)) {
            if (!mal_gc_is_marked(key.value)) {
                mal_gc_dead_key_push(key);
            }
        }
        for (usize d = 0; d < g_dead_keys_count; ++d) {
            mal_table_delete(entries, g_dead_keys[d]);
        }
        // mal_table_delete only tombstones; without compaction a churning weak
        // collection's order array grows without bound. Weak collections have no
        // JS iteration surface, so compacting (which renumbers storage) is safe.
        if (g_dead_keys_count > 0) {
            mal_table_compact(entries);
        }
    }

    // WeakRef: null any target that did not otherwise survive, so a later deref()
    // sees undefined rather than a reclaimed cell.
    for (usize i = 0; i < g_weak_refs_count; ++i) {
        if (!mal_gc_is_marked(g_weak_refs[i]->target)) {
            g_weak_refs[i]->target = mal_value_new_undefined();
        }
    }

    // FinalizationRegistry: for each cell whose target was reclaimed, enqueue a
    // cleanup job (callback(heldValue) — never the dead target) and unlink the
    // cell. The held value was marked strongly above, so it survives to the job.
    for (usize i = 0; i < g_fin_regs_count; ++i) {
        MalFinalizationRegistryObject *reg = g_fin_regs[i];
        MalFinRegCell **link = &reg->cells;
        while (*link != nullptr) {
            MalFinRegCell *fc = *link;
            if (!mal_gc_is_marked(fc->target)) {
                mal_vm_enqueue_reaction_job(g_gc_vm, reg->cleanup_callback, false,
                    mal_value_new_undefined(), mal_value_new_undefined(), fc->held_value);
                *link = fc->next;
                free(fc);
            } else {
                link = &fc->next;
            }
        }
    }
}

void mal_gc_collect(MalVm *vm) {
    g_gc_vm = vm;
    g_grey_count = 0;
    g_weak_maps_count = 0;
    g_weak_refs_count = 0;
    g_fin_regs_count = 0;

    mal_gc_scan_roots(vm);
    mal_gc_drain();

    mal_gc_weak_pass();

    mal_heap_sweep(&vm->heap, mal_gc_finalize_cell);

    if (g_gc_verify_enabled) {
        mal_gc_verify(vm);
    }

    // Advance the auto-collection trigger past the surviving set (heap doubling
    // with a floor): collect again only after another ~live-set of allocation.
    if (mal_gc_next_at != (usize) -1) {
        usize grow = vm->heap.live_bytes * 2;
        if (grow < MAL_GC_MIN_INCREMENT) {
            grow = MAL_GC_MIN_INCREMENT;
        }
        mal_gc_next_at = vm->heap.bytes_allocated + grow;
    }

    g_gc_vm = nullptr;
}
