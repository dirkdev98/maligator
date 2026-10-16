#include "dev_runner.h"

extern const MalDevelopmentImage mal_fragment_images[];
extern const int mal_fragment_image_count;
extern const char mal_fragment_entry_path[];

int main(int argc, char **argv) {
    return mal_dev_run_images(
        mal_fragment_images, mal_fragment_image_count, nullptr, mal_fragment_entry_path,
        argc, argv, MAL_WEB_PLATFORM != 0, MAL_NODE != 0, nullptr);
}
