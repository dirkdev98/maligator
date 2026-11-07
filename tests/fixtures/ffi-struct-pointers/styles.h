#ifndef STYLES_H
#define STYLES_H

typedef struct { float weight; int flags; } Style;

Style *style_new(void);
void style_destroy(Style *style);
float style_weight(Style style);
void style_set_flags(Style *style, int flags);
Style *style_shared(void);
int style_destroyed(void);

#endif
