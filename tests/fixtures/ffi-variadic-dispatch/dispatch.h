#pragma once
#include <stddef.h>
enum { DISPATCH_MARKER = 42, DISPATCH_SMALL = 1, DISPATCH_MIXED = 2, DISPATCH_ARRAY = 3, DISPATCH_OUT = 4, DISPATCH_CALLBACK = 5 };
double dispatch_apply(int marker, ...);
int dispatch_empty(int count, ...);
int dispatch_calls(void);
