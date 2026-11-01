#ifndef RELEASE_H
#define RELEASE_H
#include <stdbool.h>

typedef struct BusyResource BusyResource;
typedef struct AlwaysResource AlwaysResource;
enum { RELEASE_OK = 0, RELEASE_BUSY = 1 };

BusyResource *release_open(int value);
void release_busy(BusyResource *resource, bool busy);
int release_value(BusyResource *resource);
BusyResource *release_same(BusyResource *resource);
int release_close(BusyResource *resource);
void release_watch(BusyResource *resource, void (*callback)(BusyResource *, void *),
                   void *data, void (*release)(void *));
AlwaysResource *release_always_open(void);
int release_always_close(AlwaysResource *resource);
int release_always_read(AlwaysResource *resource);
int release_live(void);

#endif
