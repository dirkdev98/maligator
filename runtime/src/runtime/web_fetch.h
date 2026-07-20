#pragma once

typedef struct MalVm MalVm;
typedef struct MalObject MalObject;

/*
 * WinterTC fetch server (runtime layer). Installs `Response` + the `Mal` namespace
 * (with `serve`) on globalThis, and registers the GC body-finalizers. Called by the
 * host entry only (like the host timers), so the bare test262 environment is
 * unaffected.
 */
void mal_fetch_install(MalVm *vm, MalObject *global_this);
