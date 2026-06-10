#include "module_namespace_object.h"

void mal_module_namespace_object_init(
    MalHeap *heap,
    MalModuleNamespaceObject *ns,
    MalModuleNamespaceExport *exports,
    i32 export_count
) {
    // Null [[Prototype]] and non-extensible: stores, defineProperty, and
    // setPrototypeOf then fail through the ordinary object machinery, leaving
    // only [[Get]]/enumeration/descriptors to special-case.
    mal_object_init(heap, &ns->object, MAL_HEAP_MODULE_NAMESPACE_OBJECT, nullptr);
    ns->object.extensible = false;
    ns->exports = exports;
    ns->export_count = export_count;
}

MalModuleNamespaceObject *mal_module_namespace_object_new(
    MalHeap *heap,
    MalModuleNamespaceExport *exports,
    i32 export_count
) {
    MalModuleNamespaceObject *ns = mal_heap_alloc(
        heap,
        sizeof(MalModuleNamespaceObject),
        MAL_HEAP_MODULE_NAMESPACE_OBJECT
    );
    mal_module_namespace_object_init(heap, ns, exports, export_count);
    return ns;
}
