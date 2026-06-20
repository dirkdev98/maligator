#pragma once

#include "./defaults.h"
#include "intrinsics.h"
#include "value.h"

/**
 * Install the DataView constructor and DataView.prototype.
 */
void mal_builtin_data_view_install(MalVm *vm);

/**
 * The ArrayBuffer a DataView reads through ([[ViewedArrayBuffer]]). Exposed so
 * the collector can trace the view -> buffer edge without seeing the struct.
 */
MalArrayBufferObject *mal_data_view_object_buffer(const MalDataViewObject *view);
