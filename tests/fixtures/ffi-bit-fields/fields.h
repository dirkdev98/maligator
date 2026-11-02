#include <stdbool.h>
enum FieldMode { MODE_ZERO = 0, MODE_SEVEN = 7 };

typedef struct Flags {
    unsigned small : 3;
    int offset : 5;
    unsigned : 2;
    unsigned : 0;
    unsigned long long narrow : 7;
    unsigned long long wide : 33;
    signed long long balance : 40;
    bool enabled : 1;
    enum FieldMode mode : 3;
    enum { INLINE_ZERO = 0, INLINE_SEVEN = 7 } inline_mode : 3;
} Flags;

typedef struct __attribute__((packed)) PackedFlags {
    unsigned first : 3;
    unsigned second : 21;
} PackedFlags;

typedef struct FlagBox { Flags flags; unsigned version : 4; } FlagBox;
typedef struct FlagState { unsigned mode : 3; unsigned long long count : 33; } FlagState;

Flags fields_copy(Flags value);
PackedFlags fields_packed(PackedFlags value);
FlagBox fields_box(FlagBox value);
void fields_visit(Flags value, Flags (*callback)(Flags));
unsigned long long fields_state(FlagState *state);
void fields_configure(FlagState *state, unsigned mode, unsigned long long count);
