#pragma once

#include "object.h"

typedef struct MalVm MalVm;

/* Installs TransformStream, its controller, and the text and compression streams. */
void mal_transform_stream_install(MalVm *vm, MalObject *global_this);
