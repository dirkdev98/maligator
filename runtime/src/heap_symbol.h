#pragma once

#include "./defaults.h"
#include "heap.h"

typedef struct MalString MalString;

typedef struct MalSymbol {
    MalHeapHeader header;

    /**
     * Set for symbols created through the Symbol.for registry: keyFor
     * answers with the description, and CanBeHeldWeakly excludes them.
     */
    u32 registered : 1;

    /**
     * Set for the synthetic symbols that back private class members. They key
     * own properties just like ordinary symbols but stay hidden from
     * reflection (getOwnPropertySymbols / getOwnPropertyDescriptors).
     */
    u32 is_private : 1;

    // A truncated 1-based entry index, validated against each receiver's live key.
    u32 private_entry_hint : 30;

    MalString *description;
} MalSymbol;

static_assert(sizeof(MalSymbol) <= 16, "MalSymbol outgrew its 16-byte size class");

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

/**
 * Allocate a fresh private-member symbol (no description, hidden from
 * reflection). Each call yields a distinct identity.
 */
MalSymbol *mal_symbol_new_private(MalHeap *heap);

/**
 * Return whether the symbol backs a private class member.
 */
bool mal_symbol_is_private(const MalSymbol *symbol);
