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
target_include_directories(LibMaligator PUBLIC "src")

add_executable(MaligatorTest test.c)
target_link_libraries(MaligatorTest LibMaligator)