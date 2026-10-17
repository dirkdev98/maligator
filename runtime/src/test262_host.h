#pragma once

typedef struct MalVm MalVm;
typedef struct MalObject MalObject;
typedef void (*MalTest262HostExtension)(MalVm *vm, MalObject *host);

/** Install the Test262 host object on the current realm's global object. */
void mal_test262_install(MalVm *vm);

/**
 * Extend every later $262, including those of created realms. Process-wide: the
 * runtime layer adds agents this way without the engine depending on it.
 */
void mal_test262_set_host_extension(MalTest262HostExtension extension);

/** Report the original completion and exception constructor independently of error display text. */
void mal_test262_report_completion(MalVm *vm, const char *phase);
