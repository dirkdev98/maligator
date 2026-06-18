#pragma once

#include "./defaults.h"
#include "heap_string.h"
#include "object.h"

typedef struct MalVm MalVm;
typedef struct MalHeap MalHeap;

/**
 * Parsed RegExp flag bits, in the spec `.flags` string order (d g i m s u v y).
 * Distinct from the regress-facing MAL_REGEXP_FLAG_* in mal_regexp.h: this set
 * also carries g/y/d, which are engine-external (the C side drives lastIndex,
 * sticky anchoring, and the indices array — regress never sees them).
 */
typedef enum MalRegExpFlag {
    MAL_REGEXP_JS_HAS_INDICES = 1 << 0, // d
    MAL_REGEXP_JS_GLOBAL = 1 << 1,      // g
    MAL_REGEXP_JS_IGNORE_CASE = 1 << 2, // i
    MAL_REGEXP_JS_MULTILINE = 1 << 3,   // m
    MAL_REGEXP_JS_DOT_ALL = 1 << 4,     // s
    MAL_REGEXP_JS_UNICODE = 1 << 5,     // u
    MAL_REGEXP_JS_UNICODE_SETS = 1 << 6, // v
    MAL_REGEXP_JS_STICKY = 1 << 7,      // y
} MalRegExpFlag;

/**
 * A RegExp object: an ordinary object plus the [[RegExpMatcher]] (the compiled
 * regress handle, host-owned and never freed), [[OriginalSource]], and
 * [[OriginalFlags]]. `lastIndex` is a spec data property, stored on the object's
 * property table (not a C field). See builtin_regexp.c for the abstract ops.
 */
typedef struct MalRegExpObject {
    MalObject object;
    void *matcher;        // [[RegExpMatcher]] — mal_regexp handle (leaked, no GC)
    MalString *source;    // [[OriginalSource]] (the raw pattern; .source escapes it)
    MalString *flags;     // [[OriginalFlags]] (the flags string as given)
    u32 flag_bits;        // parsed MalRegExpFlag bits (cache of `flags`)
} MalRegExpObject;

/**
 * Initialize RegExp object state in caller-provided storage. The matcher/source/
 * flags slots are left null; RegExpInitialize (in builtin_regexp.c) fills them.
 */
void mal_regexp_object_init(MalHeap *heap, MalRegExpObject *regexp, MalObject *prototype);

/**
 * Allocate and initialize a new (uninitialized-slots) RegExp object.
 */
MalRegExpObject *mal_regexp_object_new(MalHeap *heap, MalObject *prototype);

/**
 * A RegExp String Iterator: the lazy iterator returned by
 * RegExp.prototype[@@matchAll] / String.prototype.matchAll. Holds the matcher
 * RegExp, the iterated string, and the global/unicode/done iteration state.
 */
typedef struct MalRegExpStringIteratorObject {
    MalObject object;
    MalValue regexp;     // [[IteratingRegExp]]
    MalString *string;   // [[IteratedString]]
    bool global;         // [[Global]]
    bool unicode;        // [[Unicode]]
    bool done;           // [[Done]]
} MalRegExpStringIteratorObject;

void mal_regexp_string_iterator_object_init(
    MalHeap *heap, MalRegExpStringIteratorObject *iterator, MalObject *prototype, MalValue regexp, MalString *string,
    bool global, bool unicode
);

MalRegExpStringIteratorObject *mal_regexp_string_iterator_object_new(
    MalHeap *heap, MalObject *prototype, MalValue regexp, MalString *string, bool global, bool unicode
);
