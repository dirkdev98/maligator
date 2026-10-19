#pragma once

#include "./defaults.h"
#include "object.h"

typedef struct MalVm MalVm;

/* Defines util.MIMEType and util.MIMEParams on `util`. */
void mal_node_util_mime_install(MalVm *vm, MalObject *util);
