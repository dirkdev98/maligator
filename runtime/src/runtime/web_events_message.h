#pragma once

#include "vm.h"

typedef enum MalWebNodeEventKind {
    MAL_WEB_NODE_MESSAGE_EVENT,
    MAL_WEB_NODE_CLOSE_EVENT,
    MAL_WEB_NODE_ERROR_EVENT,
    MAL_WEB_NODE_EVENT_COUNT,
} MalWebNodeEventKind;

bool mal_web_node_events_ensure(MalVm *vm);
void mal_web_node_events_export(MalVm *vm, MalObject *module);
MalKey mal_web_node_event_slots_key(void);
MalValue mal_web_node_event_slots(MalValue receiver);
MalValue mal_web_node_event_new(MalVm *vm, MalWebNodeEventKind kind, const char *type);
void mal_web_node_event_set(MalVm *vm, MalValue event, const char *name, MalValue value);

/* A MessageEvent carrying received port data. `ports` must be an array. */
MalValue mal_web_message_event_new(MalVm *vm, const char *type, MalValue data, MalValue ports, MalValue source);
void mal_host_install_web_node_events(MalVm *vm, const MalHostInstallSlot *slots,
    i32 count, const MalHostLaunchContext *launch);
