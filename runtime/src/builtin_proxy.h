#pragma once

#include "./defaults.h"

typedef struct MalVm MalVm;

/**
 * Create the %Proxy% constructor (and Proxy.revocable) and store it in the
 * MAL_INTRINSIC_PROXY_CONSTRUCTOR slot. Proxy has no .prototype; its instances
 * are MalProxyObject exotics whose meta-object protocol routes through traps.
 */
void mal_builtin_proxy_install(MalVm *vm);
