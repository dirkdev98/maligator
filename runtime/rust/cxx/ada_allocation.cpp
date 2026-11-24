#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <new>

[[noreturn, gnu::cold, gnu::noinline]] static void out_of_memory() {
    std::fputs("Maligator: out of memory\n", stderr);
    std::abort();
}

static void *allocate(std::size_t size) noexcept {
    return std::malloc(size == 0 ? 1 : size);
}

static void *allocate(std::size_t size, std::align_val_t alignment) noexcept {
    const auto bytes = static_cast<std::size_t>(alignment);
    if (bytes <= alignof(std::max_align_t)) return allocate(size);
    void *result;
    return posix_memalign(&result, bytes, size == 0 ? 1 : size) == 0 ? result : nullptr;
}

// Ada only crosses the C ABI. Allocation failure cannot unwind through the VM.
void *operator new(std::size_t size) {
    if (void *result = allocate(size)) return result;
    out_of_memory();
}

void *operator new(std::size_t size, std::align_val_t alignment) {
    if (void *result = allocate(size, alignment)) return result;
    out_of_memory();
}

void *operator new(std::size_t size, const std::nothrow_t &) noexcept { return allocate(size); }
void *operator new(std::size_t size, std::align_val_t alignment, const std::nothrow_t &) noexcept {
    return allocate(size, alignment);
}

void *operator new[](std::size_t size) { return ::operator new(size); }
void *operator new[](std::size_t size, std::align_val_t alignment) {
    return ::operator new(size, alignment);
}
void *operator new[](std::size_t size, const std::nothrow_t &tag) noexcept {
    return ::operator new(size, tag);
}
void *operator new[](std::size_t size, std::align_val_t alignment, const std::nothrow_t &tag) noexcept {
    return ::operator new(size, alignment, tag);
}

void operator delete(void *pointer) noexcept { std::free(pointer); }
void operator delete[](void *pointer) noexcept { std::free(pointer); }
void operator delete(void *pointer, std::size_t) noexcept { std::free(pointer); }
void operator delete[](void *pointer, std::size_t) noexcept { std::free(pointer); }
void operator delete(void *pointer, const std::nothrow_t &) noexcept { std::free(pointer); }
void operator delete[](void *pointer, const std::nothrow_t &) noexcept { std::free(pointer); }
void operator delete(void *pointer, std::align_val_t) noexcept { std::free(pointer); }
void operator delete[](void *pointer, std::align_val_t) noexcept { std::free(pointer); }
void operator delete(void *pointer, std::size_t, std::align_val_t) noexcept { std::free(pointer); }
void operator delete[](void *pointer, std::size_t, std::align_val_t) noexcept { std::free(pointer); }
void operator delete(void *pointer, std::align_val_t, const std::nothrow_t &) noexcept {
    std::free(pointer);
}
void operator delete[](void *pointer, std::align_val_t, const std::nothrow_t &) noexcept {
    std::free(pointer);
}
