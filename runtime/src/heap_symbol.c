#include "heap_symbol.h"

void mal_symbol_init(MalSymbol *symbol, MalString *description) {
    mal_heap_header_init(&symbol->header, MAL_HEAP_SYMBOL);
    symbol->description = description;
}

MalSymbol *mal_symbol_new(MalHeap *heap, MalString *description) {
    MalSymbol *symbol = mal_heap_alloc(heap, sizeof(MalSymbol), MAL_HEAP_SYMBOL);
    mal_symbol_init(symbol, description);

    return symbol;
}

MalString *mal_symbol_description(const MalSymbol *symbol) {
    return symbol->description;
}
