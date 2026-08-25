// Trivial program: the fiber Phase-0 test (runtime/fiber_test_main.c) only needs
// a valid mal_runtime_image to stand up a real isolate (heap + intrinsics). The
// program body itself is never run.
globalThis;
