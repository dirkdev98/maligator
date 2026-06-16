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

file(GLOB_RECURSE SOURCE_FILES "src/*.c")


add_library(LibMaligator STATIC ${SOURCE_FILES})
# src/*.c includes "mal_i18n.h" (Date timezone offsets + Intl). The Rust shim
# itself is built by cargo via src/i18n-build.ts and linked at the final cc; the
# static archive just needs the header on its include path.
target_include_directories(LibMaligator PUBLIC "src" "i18n/include")

# The cargo-built Rust staticlib, referenced by name so the dev MaligatorTest
# executable can link. Built out-of-band (src/i18n-build.ts) into .cache.
add_library(mal_i18n STATIC IMPORTED)
set_target_properties(mal_i18n PROPERTIES
    IMPORTED_LOCATION "${CMAKE_SOURCE_DIR}/../.cache/cargo-target/release/libmal_i18n.a")

# Dev-only harness (AGENTS.md local-verification flow). EXCLUDE_FROM_ALL so a
# plain `cmake --build` (used by the test262 runner) builds only the library and
# never fails on the Rust symbols before the shim has been built.
add_executable(MaligatorTest EXCLUDE_FROM_ALL test.c)
target_link_libraries(MaligatorTest LibMaligator mal_i18n)