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

# Three-layer split (isolate_todo.md): engine / host / runtime, each a STATIC
# archive built at the configured -O flags (CMAKE_C_FLAGS). Dependency direction is
# runtime -> host -> engine; the engine is host-agnostic and MUST link standalone
# (the test262 gate links only libLibMaligator.a, so its build is the proof).
# Splitting the single archive into three does not change optimization: each .c is
# still its own -O2 translation unit and the final cc links the archives together;
# archive-member granularity also means an engine-only program never pulls host or
# runtime objects.
#
# CONFIGURE_DEPENDS so a plain `cmake --build` re-globs newly added translation
# units. GLOB (not GLOB_RECURSE) for the engine so it excludes the host/ + runtime/
# subdirs.

# --- engine: spec-compliant ECMAScript VM (values, GC, compile+execute, builtins,
#     fiber/safepoint substrate). src/*.c only. ---
file(GLOB ENGINE_SOURCES CONFIGURE_DEPENDS "src/*.c")
add_library(LibMaligator STATIC ${ENGINE_SOURCES})
# src/*.c includes the per-domain headers "mal_i18n.h" (Date tz + Intl) and
# "mal_regexp.h" (the RegExp engine), both under rust/include.
target_include_directories(LibMaligator PUBLIC "src" "rust/include")

# --- host: platform abstraction (reactor, scheduler, host context). ---
file(GLOB HOST_SOURCES CONFIGURE_DEPENDS "src/host/*.c")
add_library(MalHost STATIC ${HOST_SOURCES})
target_include_directories(MalHost PUBLIC "src/host")
target_link_libraries(MalHost PUBLIC LibMaligator)

# --- runtime: the API personality (setTimeout now; fetch / node shims later). ---
file(GLOB RUNTIME_SOURCES CONFIGURE_DEPENDS "src/runtime/*.c")
add_library(MalRuntime STATIC ${RUNTIME_SOURCES})
target_include_directories(MalRuntime PUBLIC "src/runtime")
target_link_libraries(MalRuntime PUBLIC MalHost)

# The cargo-built Rust staticlib (mal_rust: Intl + RegExp + later Temporal),
# referenced by name. Built out-of-band (src/rust-build.ts) into .cache.
add_library(mal_rust STATIC IMPORTED)
set_target_properties(mal_rust PROPERTIES
    IMPORTED_LOCATION "${CMAKE_SOURCE_DIR}/../.cache/cargo-target/release/libmal_rust.a")

# Dev-only harness (AGENTS.md local-verification flow). EXCLUDE_FROM_ALL so a
# plain `cmake --build` (used by the test262 runner) builds only the libraries.
# Links all three layers + rust.
add_executable(MaligatorTest EXCLUDE_FROM_ALL test.c)
target_link_libraries(MaligatorTest MalRuntime MalHost LibMaligator mal_rust)
