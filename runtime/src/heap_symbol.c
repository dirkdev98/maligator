#include "heap_symbol.h"

void mal_symbol_init(MalSymbol *symbol, MalString *description) {
    mal_heap_header_init(&symbol->header, MAL_HEAP_SYMBOL);
    symbol->description = description;
    symbol->registered = false;
    symbol->is_private = false;
    symbol->private_entry_hint = 0;
}

MalSymbol *mal_symbol_new(MalHeap *heap, MalString *description) {
    MalSymbol *symbol = mal_heap_alloc(heap, sizeof(MalSymbol), MAL_HEAP_SYMBOL);
    mal_symbol_init(symbol, description);

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
