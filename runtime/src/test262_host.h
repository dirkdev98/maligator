#pragma once

typedef struct MalVm MalVm;

/** Install the Test262 host object on the current realm's global object. */
void mal_test262_install(MalVm *vm);
