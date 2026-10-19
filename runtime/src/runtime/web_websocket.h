#pragma once

#include "vm.h"

/* Defines WebSocket, MessageEvent and CloseEvent on `module` and the global object. */
void mal_web_websocket_install(MalVm *vm, MalObject *module);
/* A trusted MessageEvent of `type` (null without the web event classes); `ports` must be an array. */
MalValue mal_web_message_event_new(MalVm *vm, const char *type, MalValue data, MalValue ports, MalValue source);
