#include <stdio.h>

#include "env.h"
#include "thread.h"
#include "value.h"
#include "value_ops.h"

int main(void) {
    MalThread thread = {0};
    MalEnv env = {0};

    auto i = mal_value_from_i32(1500);
    if (mal_ops_add(&thread, &env, &thread.registers[0], i, i) != MAL_NORMAL) {
        return 1;
    }


    printf("%d", mal_value_to_i32(thread.registers[0]));

    return 0;
}
