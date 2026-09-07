#pragma once

typedef struct MalVm MalVm;

/** Install the Test262 host object on the current realm's global object. */
void mal_test262_install(MalVm *vm);

/** Report the original completion and exception constructor independently of error display text. */
void mal_test262_report_completion(MalVm *vm, const char *phase);
