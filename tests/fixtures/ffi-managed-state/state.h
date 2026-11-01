#ifndef MANAGED_STATE_H
#define MANAGED_STATE_H
#include <stddef.h>

typedef struct ManagedBase { int tag; } ManagedBase;
typedef struct ManagedState {
    ManagedBase base;
    const unsigned char *next_in;
    unsigned int avail_in;
    unsigned char *next_out;
    unsigned int avail_out;
    unsigned long total;
} ManagedState;
typedef struct ManagedNarrow { unsigned char *data; unsigned char length; } ManagedNarrow;
typedef struct ManagedSigned { unsigned char *data; int length; } ManagedSigned;
typedef struct ManagedConst { unsigned char *const data; unsigned int length; } ManagedConst;
typedef struct ManagedBits { unsigned char *data; unsigned int length : 3; } ManagedBits;
typedef struct ManagedOpaque ManagedOpaque;
typedef struct ManagedResource { int *value; } ManagedResource;
typedef struct ManagedPacket { ManagedResource resources[1]; } ManagedPacket;
typedef struct ManagedWide { char bytes[512]; } ManagedWide;
typedef struct ManagedTextBase { int tag; } ManagedTextBase;
typedef struct ManagedText {
    ManagedTextBase base;
    char *text;
    unsigned int remaining;
} ManagedText;
typedef struct ManagedTextNarrow { const char *text; unsigned char remaining; } ManagedTextNarrow;
typedef struct ManagedTextVoid { void *text; unsigned int remaining; } ManagedTextVoid;

int managed_text_advance(ManagedText *state, unsigned int count);
void managed_text_write(ManagedText *state, unsigned char value);
void managed_text_bad(ManagedText *state, int mode);
int managed_text_empty(ManagedText *state);
void managed_text_wait(ManagedTextBase *state);
void managed_text_wait_started(void);
void managed_text_release(void);

int managed_copy(ManagedState *state);
int managed_copy_wait(ManagedState *state);
int managed_alias(ManagedState *first, ManagedState *second);
int managed_base_copy(ManagedBase *state);
void managed_visit(ManagedState *state, void (*callback)(void *), void *data);
void managed_bad(ManagedState *state, int mode);
void managed_negative(ManagedSigned *state);
int managed_abi_size(int size);
int managed_many(ManagedState *const *states, size_t count);
int managed_many_wait(ManagedState *const *states, size_t count);
int managed_indirect(ManagedState **state);
const unsigned char *managed_remaining(ManagedState *state, size_t *length);
ManagedResource managed_resource_new(int value);
void managed_resource_free(ManagedResource value);
int managed_packet(ManagedPacket packet, void (*callback)(void *), void *data);
int managed_packet_wait(ManagedPacket packet);
int managed_copy_slow(ManagedState *state);
int managed_small_size(unsigned char size);
void managed_lend(void (*callback)(ManagedState *, void *), void *data);

#endif
