#include "builtin_date.h"
#include "language_components.h"

static const MalDateOperations date_operations = {.parse = mal_builtin_date_parse_known};

MAL_LANGUAGE_COMPONENT_UNIT(mal_host_install_intrinsic_date, MAL_LANGUAGE_COMPONENT_DATE, mal_builtin_date_install, &date_operations)
