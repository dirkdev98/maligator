#include <stdio.h>

#include "env.h"
#include "thread.h"
#include "value.h"
#include "value_ops.h"

int main(void) {
    MalThread thread = {0};
    MalEnv env = {0};

    auto i = mal_value_from_i32(1500);
    mal_ops_add(&thread, &env, &thread.registers[0], i, i);
    if (thread.return_result != MAL_NORMAL) {
        return 1;
    }


    mal_value_debug(thread.registers[0]);
    printf("\n");

    return 0;
}
