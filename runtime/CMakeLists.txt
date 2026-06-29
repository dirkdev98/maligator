cmake_minimum_required(VERSION 4.1)
project(LibMaligator C)

set(CMAKE_C_STANDARD 23)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

#if(MSVC)
#    target_compile_options(LibMaligator PRIVATE /W4 /WX)
#else()
#    target_compile_options(LibMaligator PRIVATE -Wall -Wextra -Werror -Wpedantic -Wshadow)
#endif()

# CONFIGURE_DEPENDS so a plain `cmake --build` re-globs and picks up newly added
# translation units (e.g. builtin_eval.c / compiler_wire.c) without a manual
# reconfigure of an already-configured build dir.
file(GLOB_RECURSE SOURCE_FILES CONFIGURE_DEPENDS "src/*.c")


add_library(LibMaligator STATIC ${SOURCE_FILES})
# src/*.c includes the per-domain headers "mal_i18n.h" (Date tz + Intl) and
# "mal_regexp.h" (the RegExp engine), both under rust/include. The Rust shim is
# built by cargo via src/rust-build.ts and linked at the final cc; the static
# archive just needs its headers on the include path.
target_include_directories(LibMaligator PUBLIC "src" "rust/include")

# The cargo-built Rust staticlib (mal_rust: Intl + RegExp + later Temporal),
# referenced by name so the dev MaligatorTest executable can link. Built
# out-of-band (src/rust-build.ts) into .cache.
add_library(mal_rust STATIC IMPORTED)
set_target_properties(mal_rust PROPERTIES
    IMPORTED_LOCATION "${CMAKE_SOURCE_DIR}/../.cache/cargo-target/release/libmal_rust.a")

# Dev-only harness (AGENTS.md local-verification flow). EXCLUDE_FROM_ALL so a
# plain `cmake --build` (used by the test262 runner) builds only the library and
# never fails on the Rust symbols before the shim has been built.
add_executable(MaligatorTest EXCLUDE_FROM_ALL test.c)
target_link_libraries(MaligatorTest LibMaligator mal_rust)