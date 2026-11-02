#include "pins.h"
#include <stdlib.h>
struct Owner { int value; };
static int freed;
Owner *pins_new(void) {
    Owner *owner = malloc(sizeof(*owner));
    if (owner != NULL) owner->value = 41;
    return owner;
}
void pins_free(Owner *owner) { free(owner); freed++; }
int pins_value(Owner *owner, Choice input) { return owner->value += input.point.amount; }
int pins_array(Owner *owner, Choice input) { return owner->value += input.items[0]; }
int pins_freed(void) { return freed; }
