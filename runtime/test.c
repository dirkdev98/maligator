#include <stdio.h>

#include "value.h"

int main(void) {
    auto i = mal_value_from_i32(1500);
    auto di = mal_value_to_i32(i);

    auto b = mal_value_new_boolean(true);
    auto db = mal_value_to_boolean(b);

    printf("%d, %d", di, db);

    return 0;
}
