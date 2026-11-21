#include "./intl_object.h"

#include "builtin_intl.h"
#include "language_components.h"

void mal_intl_object_init(MalHeap *heap, MalIntlObject *intl, MalObject *prototype, MalIntlKind kind, void *handle, MalValue data) {
    mal_object_init_deferred(heap, &intl->object, prototype);
    intl->kind = kind;
    intl->handle = handle;
    intl->data = data;
    intl->bound = mal_value_new_undefined();
}

MalIntlObject *mal_intl_object_new(MalHeap *heap, MalObject *prototype, MalIntlKind kind, void *handle, MalValue data) {
    MalIntlObject *intl = mal_heap_alloc(heap, sizeof(MalIntlObject), MAL_HEAP_INTL_OBJECT);
    mal_intl_object_init(heap, intl, prototype, kind, handle, data);
    return intl;
}

usize mal_intl_object_release_handle(MalIntlKind kind, void *handle) {
    MalLanguageComponentId component;
    switch (kind) {
        case MAL_INTL_COLLATOR: component = MAL_LANGUAGE_COMPONENT_INTL_COLLATOR; break;
        case MAL_INTL_PLURAL_RULES: component = MAL_LANGUAGE_COMPONENT_INTL_PLURAL_RULES; break;
        case MAL_INTL_NUMBER_FORMAT: component = MAL_LANGUAGE_COMPONENT_INTL_NUMBER_FORMAT; break;
        case MAL_INTL_DATE_TIME_FORMAT: component = MAL_LANGUAGE_COMPONENT_INTL_DATE_TIME_FORMAT; break;
        case MAL_INTL_LIST_FORMAT: component = MAL_LANGUAGE_COMPONENT_INTL_LIST_FORMAT; break;
        case MAL_INTL_RELATIVE_TIME_FORMAT: component = MAL_LANGUAGE_COMPONENT_INTL_RELATIVE_TIME_FORMAT; break;
        case MAL_INTL_DURATION_FORMAT: component = MAL_LANGUAGE_COMPONENT_INTL_DURATION_FORMAT; break;
        default: return 0;
    }
    // Only an installed service creates handles, so its component is linked.
    const MalIntlServiceOperations *service = mal_language_component_operations(component);
    return service->release(handle);
}
