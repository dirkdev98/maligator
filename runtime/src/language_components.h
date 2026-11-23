#pragma once

#include <string.h>

#include "./defaults.h"
#include "regexp_engine.h"
#include "unicode.h"
#include "vm.h"

/*
 * Language components are built-ins that every runtime archive contains but a
 * program links only when the compiler retains them: the engine policy allows them
 * and the program can reach them. The compiler retains a component by listing its
 * installer in the image's host manifest. That reference links the component's own
 * translation unit, whose constructor registers the component below, and realm
 * initialization then installs every registered component the image lists, before
 * the primordials lock. A component that is not selected stays absent, so built-ins
 * outside it take the path the engine had without it.
 */

typedef enum MalLanguageComponentId {
    MAL_LANGUAGE_COMPONENT_MAP,
    MAL_LANGUAGE_COMPONENT_SET,
    MAL_LANGUAGE_COMPONENT_WEAK_REF,
    MAL_LANGUAGE_COMPONENT_FINALIZATION_REGISTRY,
    MAL_LANGUAGE_COMPONENT_DISPOSABLE_STACK,
    MAL_LANGUAGE_COMPONENT_MATH,
    MAL_LANGUAGE_COMPONENT_JSON,
    MAL_LANGUAGE_COMPONENT_ATOMICS,
    MAL_LANGUAGE_COMPONENT_PROXY,
    MAL_LANGUAGE_COMPONENT_DATE,
    MAL_LANGUAGE_COMPONENT_TEMPORAL,
    // The namespace precedes its services, which install onto it.
    MAL_LANGUAGE_COMPONENT_INTL,
    MAL_LANGUAGE_COMPONENT_INTL_COLLATOR,
    MAL_LANGUAGE_COMPONENT_INTL_PLURAL_RULES,
    MAL_LANGUAGE_COMPONENT_INTL_NUMBER_FORMAT,
    MAL_LANGUAGE_COMPONENT_INTL_DATE_TIME_FORMAT,
    MAL_LANGUAGE_COMPONENT_INTL_LIST_FORMAT,
    MAL_LANGUAGE_COMPONENT_INTL_DISPLAY_NAMES,
    MAL_LANGUAGE_COMPONENT_INTL_RELATIVE_TIME_FORMAT,
    MAL_LANGUAGE_COMPONENT_INTL_SEGMENTER,
    MAL_LANGUAGE_COMPONENT_INTL_DURATION_FORMAT,
    MAL_LANGUAGE_COMPONENT_COUNT,
} MalLanguageComponentId;

typedef struct MalLanguageComponent {
    /** The manifest entry that selects the component. It does nothing when run. */
    MalHostInstaller installer;
    /** The installer's symbol name, as wire images list it. */
    const char *name;
    /** Define the component's intrinsics in the current realm. */
    void (*install)(MalVm *vm);
    /** Component-specific entry points for built-ins outside the component. */
    const void *operations;
} MalLanguageComponent;

#define MAL_LANGUAGE_COMPONENT_INSTALLER(name) \
    void name(MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch)
MAL_LANGUAGE_COMPONENT_INSTALLER(mal_host_install_intrinsic_map);
MAL_LANGUAGE_COMPONENT_INSTALLER(mal_host_install_intrinsic_set);
MAL_LANGUAGE_COMPONENT_INSTALLER(mal_host_install_intrinsic_weak_ref);
MAL_LANGUAGE_COMPONENT_INSTALLER(mal_host_install_intrinsic_finalization_registry);
MAL_LANGUAGE_COMPONENT_INSTALLER(mal_host_install_intrinsic_disposable_stack);
MAL_LANGUAGE_COMPONENT_INSTALLER(mal_host_install_intrinsic_math);
MAL_LANGUAGE_COMPONENT_INSTALLER(mal_host_install_intrinsic_json);
MAL_LANGUAGE_COMPONENT_INSTALLER(mal_host_install_intrinsic_atomics);
MAL_LANGUAGE_COMPONENT_INSTALLER(mal_host_install_intrinsic_proxy);
MAL_LANGUAGE_COMPONENT_INSTALLER(mal_host_install_intrinsic_date);
MAL_LANGUAGE_COMPONENT_INSTALLER(mal_host_install_temporal);
MAL_LANGUAGE_COMPONENT_INSTALLER(mal_host_install_intl);
MAL_LANGUAGE_COMPONENT_INSTALLER(mal_host_install_intl_collator);
MAL_LANGUAGE_COMPONENT_INSTALLER(mal_host_install_intl_plural_rules);
MAL_LANGUAGE_COMPONENT_INSTALLER(mal_host_install_intl_number_format);
MAL_LANGUAGE_COMPONENT_INSTALLER(mal_host_install_intl_date_time_format);
MAL_LANGUAGE_COMPONENT_INSTALLER(mal_host_install_intl_list_format);
MAL_LANGUAGE_COMPONENT_INSTALLER(mal_host_install_intl_display_names);
MAL_LANGUAGE_COMPONENT_INSTALLER(mal_host_install_intl_relative_time_format);
MAL_LANGUAGE_COMPONENT_INSTALLER(mal_host_install_intl_segmenter);
MAL_LANGUAGE_COMPONENT_INSTALLER(mal_host_install_intl_duration_format);
#undef MAL_LANGUAGE_COMPONENT_INSTALLER

/** Components linked into this process, filled by their constructors before main. */
extern const MalLanguageComponent *mal_language_components[MAL_LANGUAGE_COMPONENT_COUNT];

/**
 * Resolve a language installer for a wire image. Keep the direct references at
 * the loader so linking realm initialization alone leaves both engines optional.
 */
static inline MalHostInstaller mal_language_component_resolve_installer(const char *name, usize length) {
#define MATCH_LANGUAGE_INSTALLER(symbol) \
    if (length == sizeof(#symbol) - 1 && memcmp(name, #symbol, length) == 0) return symbol
    MATCH_LANGUAGE_INSTALLER(mal_host_install_regexp);
    MATCH_LANGUAGE_INSTALLER(mal_host_install_unicode_normalization);
#undef MATCH_LANGUAGE_INSTALLER
    for (i32 id = 0; id < MAL_LANGUAGE_COMPONENT_COUNT; id++) {
        const MalLanguageComponent *component = mal_language_components[id];
        if (component != nullptr && strlen(component->name) == length &&
            memcmp(component->name, name, length) == 0) {
            return component->installer;
        }
    }
    return nullptr;
}

/** Whether the component is linked and the VM's image selects it. */
bool mal_language_component_selected(const MalVm *vm, MalLanguageComponentId id);

/** Install the selected components from `first` through `last`, in identifier order. */
void mal_language_components_install(MalVm *vm, MalLanguageComponentId first, MalLanguageComponentId last);

/** The operations of a linked component, or null when it is not linked. */
static inline const void *mal_language_component_operations(MalLanguageComponentId id) {
    const MalLanguageComponent *component = mal_language_components[id];
    return component == nullptr ? nullptr : component->operations;
}

/**
 * Define one component's manifest installer and register it at process startup.
 * Each component needs a translation unit of its own: loading a unit runs all of
 * its constructors, so a shared unit would register, and link, every component in it.
 */
#define MAL_LANGUAGE_COMPONENT_UNIT(installer_name, id, install_function, operations_value) \
    void installer_name(MalVm *vm, const MalHostInstallSlot *slots, i32 count, \
        const MalHostLaunchContext *launch) { \
        (void) vm; \
        (void) slots; \
        (void) count; \
        (void) launch; \
    } \
    static const MalLanguageComponent language_component = { \
        .installer = installer_name, \
        .name = #installer_name, \
        .install = install_function, \
        .operations = operations_value, \
    }; \
    __attribute__((constructor)) static void language_component_register(void) { \
        mal_language_components[id] = &language_component; \
    }
