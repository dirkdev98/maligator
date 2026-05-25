#pragma once

#include "./defaults.h"
#include "heap.h"

typedef struct MalString MalString;

typedef struct MalSymbol {
    MalHeapHeader header;
    MalString *description;
} MalSymbol;

/**
 * Initialize a symbol allocation in caller-provided storage.
 */
void mal_symbol_init(MalSymbol *symbol, MalString *description);

/**
 * Allocate and initialize a new symbol.
 */
MalSymbol *mal_symbol_new(MalHeap *heap, MalString *description);

/**
 * Return the symbol description, or NULL when absent.
 */
MalString *mal_symbol_description(const MalSymbol *symbol);
