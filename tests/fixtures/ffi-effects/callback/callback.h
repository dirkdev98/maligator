#ifndef FFI_EFFECT_CALLBACK_H
#define FFI_EFFECT_CALLBACK_H
void effects_scope(void (*callback)(void *), void *data);
int effects_nested(void);
#endif
