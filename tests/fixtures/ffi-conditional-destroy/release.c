#include "release.h"
#include <stdlib.h>

struct BusyResource {
    int value;
    bool busy;
    void (*callback)(BusyResource *, void *);
    void *data;
    void (*release)(void *);
};
struct AlwaysResource { int value; };
static int live;

BusyResource *release_open(int value) {
    BusyResource *resource = calloc(1, sizeof(*resource));
    if (resource != NULL) { resource->value = value; live++; }
    return resource;
}

void release_busy(BusyResource *resource, bool busy) { resource->busy = busy; }
int release_value(BusyResource *resource) { return resource->value; }
BusyResource *release_same(BusyResource *resource) { return resource; }

int release_close(BusyResource *resource) {
    if (resource == NULL) return RELEASE_OK;
    if (resource->callback != NULL) resource->callback(resource, resource->data);
    if (resource->busy) return RELEASE_BUSY;
    if (resource->release != NULL) resource->release(resource->data);
    free(resource);
    live--;
    return RELEASE_OK;
}

void release_watch(BusyResource *resource, void (*callback)(BusyResource *, void *),
                   void *data, void (*release)(void *)) {
    if (resource->release != NULL) resource->release(resource->data);
    resource->callback = callback;
    resource->data = data;
    resource->release = release;
}

AlwaysResource *release_always_open(void) {
    AlwaysResource *resource = malloc(sizeof(*resource));
    if (resource != NULL) { resource->value = 9; live++; }
    return resource;
}
int release_always_close(AlwaysResource *resource) { free(resource); live--; return 7; }
int release_always_read(AlwaysResource *resource) { return resource->value; }
int release_live(void) { return live; }
