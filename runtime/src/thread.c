#include "thread.h"

void mal_thread_init(MalThread *thread) {
    thread->return_result = MAL_NORMAL;
    thread->return_value = mal_value_new_undefined();
    thread->register_base = 0;

    for (int i = 0; i < MAL_REG_CAP; ++i) {
        thread->registers[i] = mal_value_new_undefined();
    }
}

void mal_thread_base_push(MalThread *thread, i32 caller_reg_count, i32 callee_reg_count) {
    thread->register_base += caller_reg_count;

    for (int i = thread->register_base; i < thread->register_base + callee_reg_count; ++i) {
        thread->registers[i] = mal_value_new_undefined();
    }
}

void mal_thread_base_pop(MalThread *thread, i32 caller_reg_count) {
    thread->register_base -= caller_reg_count;
}

MalValue mal_thread_get(MalThread *thread, i32 register_index) {
    return thread->registers[thread->register_base + register_index];
}

void mal_thread_set(MalThread *thread, i32 register_index, MalValue value) {
    thread->registers[thread->register_base + register_index] = value;
}
