#include "heap_symbol.h"

MalSymbol *mal_symbol_new(MalHeap *heap, MalString *description) {
    MalSymbol *symbol = mal_heap_alloc(heap, sizeof(MalSymbol), MAL_HEAP_SYMBOL);
    symbol->description = description;
    symbol->registered = false;
    symbol->is_private = false;
    symbol->private_table_resident = false;
    symbol->private_entry_hint = 0;

    return symbol;
}

MalString *mal_symbol_description(const MalSymbol *symbol) {
    return symbol->description;
}

MalSymbol *mal_symbol_new_private(MalHeap *heap) {
    MalSymbol *symbol = mal_symbol_new(heap, nullptr);
    symbol->is_private = true;

    return symbol;
}

bool mal_symbol_is_private(const MalSymbol *symbol) {
    return symbol->is_private;
}
