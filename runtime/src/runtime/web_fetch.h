#pragma once

typedef struct MalVm MalVm;
typedef struct MalObject MalObject;

/** Install the shared web/Node body types and their GC hooks in a host realm. */
void mal_fetch_types_install(MalVm *vm, MalObject *global_this);

/** Install the web body types and the WinterTC `Mal.serve` host entry. */
void mal_fetch_install(MalVm *vm, MalObject *global_this);
