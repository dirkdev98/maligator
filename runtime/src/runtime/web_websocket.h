#pragma once

#include "vm.h"

/* Defines WebSocket, MessageEvent and CloseEvent on `module` and the global object. */
void mal_web_websocket_install(MalVm *vm, MalObject *module);
