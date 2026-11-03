#ifndef FFI_PAIRS_H
#define FFI_PAIRS_H
typedef void (*PairVisit)(void *data);
double pair_dot(const double *left, unsigned char count, const double *right);
int pair_bytes(const unsigned char *left, const unsigned char *right, int count, PairVisit visit, void *data);
double pair_mixed(const double *values, const void *bytes, int count);
double pair_reversed(const void *bytes, const double *values, int count);
int pair_text(const char *text, const void *bytes, int count);
int pair_calls(void);
void pair_reset(void);
void pair_pointer(const double *left, const double *right, int *count);
void pair_capacity(double *output, int count, int *written, const double *left, const double *right);
#endif
