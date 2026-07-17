#include <limits.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>

/* Capture the ioctl request before defaults.h wraps sizeof; Darwin defines
 * TIOCGWINSZ in terms of sizeof and expands it at its use site. */
enum { MAL_TIOCGWINSZ = TIOCGWINSZ };

#include "node_tty.h"

#if MAL_NODE

#include "array_object.h"
#include "function_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "object.h"
#include "property_store.h"
#include "value.h"
#include "value_ops.h"
#include "vm_ops.h"

#define TTY_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)

typedef struct MalNodeTtySize {
    i32 columns;
    i32 rows;
    bool available;
} MalNodeTtySize;

static bool tty_fd_value(MalValue value, int *fd) {
    if (!mal_ops_is_number(value)) {
        return false;
    }
    f64 number = mal_ops_number_as_f64(value);
    if (!isfinite(number) || trunc(number) != number || number < 0 || number > INT_MAX) {
        return false;
    }
    *fd = (int) number;
    return true;
}

static MalNodeTtySize tty_size(int fd) {
    struct winsize size;
    if (ioctl(fd, MAL_TIOCGWINSZ, &size) != 0) {
        return (MalNodeTtySize) {0};
    }
    return (MalNodeTtySize) {
        .columns = (i32) size.ws_col,
        .rows = (i32) size.ws_row,
        .available = true,
    };
}

static MalValue tty_isatty(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) vm;
    (void) receiver;
    (void) new_target;
    (void) callee;
    int fd;
    return mal_value_new_boolean(
        argc > 0 && tty_fd_value(args[0], &fd) && isatty(fd) == 1);
}

static bool tty_receiver_fd(MalVm *vm, MalValue receiver, int *fd) {
    if (!mal_value_is_object(receiver)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "TTY stream method called on incompatible receiver");
        return false;
    }
    MalValue value;
    if (!mal_vm_get_property(
            vm, receiver, mal_intrinsic_string_key(vm, (const byte *) "fd"), &value)) {
        return false;
    }
    if (!tty_fd_value(value, fd)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "TTY stream has an invalid file descriptor");
        return false;
    }
    return true;
}

static i32 tty_color_depth(void) {
    const char *no_color = getenv("NO_COLOR");
    const char *term = getenv("TERM");
    const char *color_term = getenv("COLORTERM");
    if (no_color != nullptr || (term != nullptr && strcmp(term, "dumb") == 0)) {
        return 1;
    }
    if (color_term != nullptr
        && (strcmp(color_term, "truecolor") == 0 || strcmp(color_term, "24bit") == 0)) {
        return 24;
    }
    if (term != nullptr && strstr(term, "256color") != nullptr) {
        return 8;
    }
    return 4;
}

static MalValue tty_get_color_depth(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    int fd;
    if (!tty_receiver_fd(vm, receiver, &fd) || isatty(fd) != 1) {
        return mal_value_new_undefined();
    }
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    return mal_value_from_i32(tty_color_depth());
}

static MalValue tty_has_colors(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    int fd;
    if (!tty_receiver_fd(vm, receiver, &fd) || isatty(fd) != 1) {
        return mal_value_new_undefined();
    }
    i32 count = 16;
    if (argc > 0 && !mal_value_is_undefined(args[0])) {
        if (!mal_ops_is_number(args[0])) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "The color count must be a number");
            return mal_value_new_undefined();
        }
        f64 number = mal_ops_number_as_f64(args[0]);
        if (!isfinite(number) || trunc(number) != number || number < 2
            || number > 16777216) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                "The color count must be an integer between 2 and 16777216");
            return mal_value_new_undefined();
        }
        count = (i32) number;
    }
    return mal_value_new_boolean(count <= (1 << tty_color_depth()));
}

static MalValue tty_get_window_size(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    int fd;
    if (!tty_receiver_fd(vm, receiver, &fd)) {
        return mal_value_new_undefined();
    }
    MalNodeTtySize size = tty_size(fd);
    MalValue result =
        mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 2));
    MalRootSpan root;
    mal_gc_root(&root, &result, 1);
    MalArrayObject *array = mal_value_to_array_object(result);
    mal_array_object_store(array,
        (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(0)},
        size.available ? mal_value_from_i32(size.columns) : mal_value_new_undefined());
    mal_array_object_store(array,
        (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(1)},
        size.available ? mal_value_from_i32(size.rows) : mal_value_new_undefined());
    mal_gc_unroot(&root);
    return result;
}

static MalValue tty_set_raw_mode(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    int fd;
    if (!tty_receiver_fd(vm, receiver, &fd)) {
        return mal_value_new_undefined();
    }
    bool enabled = argc > 0 && mal_value_to_boolean(args[0]);
    struct termios mode;
    if (tcgetattr(fd, &mode) != 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            "Failed to read TTY mode");
        return mal_value_new_undefined();
    }
    if (enabled) {
        mode.c_iflag &= (tcflag_t) ~(BRKINT | ICRNL | INPCK | ISTRIP | IXON);
        mode.c_oflag &= (tcflag_t) ~OPOST;
        mode.c_cflag |= CS8;
        mode.c_lflag &= (tcflag_t) ~(ECHO | ICANON | IEXTEN | ISIG);
        mode.c_cc[VMIN] = 1;
        mode.c_cc[VTIME] = 0;
    } else {
        mode.c_iflag |= BRKINT | ICRNL | INPCK | ISTRIP | IXON;
        mode.c_oflag |= OPOST;
        mode.c_lflag |= ICANON | ECHO;
        mode.c_lflag |= IEXTEN | ISIG;
    }
    if (tcsetattr(fd, TCSANOW, &mode) != 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            "Failed to update TTY mode");
        return mal_value_new_undefined();
    }
    mal_object_set(mal_value_to_object(receiver),
        mal_intrinsic_string_key(vm, (const byte *) "isRaw"),
        mal_value_new_boolean(enabled));
    return receiver;
}

static MalValue tty_stream_construct(
    MalVm *vm, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee, bool readable) {
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            readable ? "Class constructor ReadStream cannot be invoked without 'new'"
                     : "Class constructor WriteStream cannot be invoked without 'new'");
        return mal_value_new_undefined();
    }
    int fd;
    if (argc < 1 || !tty_fd_value(args[0], &fd)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "The file descriptor must be a non-negative integer");
        return mal_value_new_undefined();
    }
    if (isatty(fd) != 1) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            "TTY initialization failed: file descriptor is not a terminal");
        return mal_value_new_undefined();
    }

    MalObject *prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    MalValue prototype_value = mal_vm_function_prototype(vm, new_target);
    if (!mal_value_is_object(prototype_value)) {
        prototype_value = mal_vm_function_prototype(vm, callee);
    }
    if (mal_value_is_object(prototype_value)) {
        prototype = mal_value_to_object(prototype_value);
    }

    MalValue instance = mal_value_from_object(mal_object_new(&vm->heap, prototype));
    MalRootSpan root;
    mal_gc_root(&root, &instance, 1);
    MalObject *object = mal_value_to_object(instance);
    mal_intrinsic_define_data(
        vm, object, (const byte *) "fd", mal_value_from_i32(fd), TTY_VISIBLE);
    mal_intrinsic_define_data(vm, object, (const byte *) "isTTY",
        mal_value_new_boolean(true), TTY_VISIBLE);
    if (readable) {
        mal_intrinsic_define_data(vm, object, (const byte *) "isRaw",
            mal_value_new_boolean(false), TTY_VISIBLE);
    } else {
        MalNodeTtySize size = tty_size(fd);
        mal_intrinsic_define_data(vm, object, (const byte *) "columns",
            size.available ? mal_value_from_i32(size.columns)
                           : mal_value_new_undefined(),
            TTY_VISIBLE);
        mal_intrinsic_define_data(vm, object, (const byte *) "rows",
            size.available ? mal_value_from_i32(size.rows)
                           : mal_value_new_undefined(),
            TTY_VISIBLE);
    }
    mal_gc_unroot(&root);
    return instance;
}

static MalValue tty_read_stream(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    return tty_stream_construct(vm, args, argc, new_target, callee, true);
}

static MalValue tty_write_stream(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    return tty_stream_construct(vm, args, argc, new_target, callee, false);
}

static MalValue tty_new_function(
    MalVm *vm, const char *name, i32 length, MalNativeFunctionCallback callback) {
    return mal_value_from_native_function_object(mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), length, callback));
}

static void tty_initialize_constructor(
    MalVm *vm, MalValue constructor_value, MalValue prototype_value) {
    MalNativeFunctionObject *constructor =
        mal_value_to_native_function_object(constructor_value);
    mal_native_function_object_set_constructor(constructor);
    mal_intrinsic_define_data(vm, (MalObject *) constructor,
        (const byte *) "prototype", prototype_value, MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, mal_value_to_object(prototype_value),
        (const byte *) "constructor", constructor_value,
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
}

void mal_host_install_node_tty(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    enum {
        TTY_ISATTY,
        TTY_READ_STREAM,
        TTY_WRITE_STREAM,
        TTY_DEFAULT,
        TTY_READ_PROTOTYPE,
        TTY_WRITE_PROTOTYPE,
        TTY_VALUE_COUNT,
    };
    MalValue values[TTY_VALUE_COUNT];
    for (usize i = 0; i < countof(values); i++) {
        values[i] = mal_value_new_undefined();
    }
    MalRootSpan root;
    mal_gc_root(&root, values, countof(values));

    MalObject *object_prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    values[TTY_READ_PROTOTYPE] =
        mal_value_from_object(mal_object_new(&vm->heap, object_prototype));
    values[TTY_WRITE_PROTOTYPE] =
        mal_value_from_object(mal_object_new(&vm->heap, object_prototype));
    values[TTY_ISATTY] = tty_new_function(vm, "isatty", 1, tty_isatty);
    values[TTY_READ_STREAM] =
        tty_new_function(vm, "ReadStream", 1, tty_read_stream);
    values[TTY_WRITE_STREAM] =
        tty_new_function(vm, "WriteStream", 1, tty_write_stream);
    tty_initialize_constructor(
        vm, values[TTY_READ_STREAM], values[TTY_READ_PROTOTYPE]);
    tty_initialize_constructor(
        vm, values[TTY_WRITE_STREAM], values[TTY_WRITE_PROTOTYPE]);

    mal_intrinsic_define_method_n(vm,
        mal_value_to_object(values[TTY_READ_PROTOTYPE]),
        (const byte *) "setRawMode", 1, tty_set_raw_mode);
    mal_intrinsic_define_method_n(vm,
        mal_value_to_object(values[TTY_WRITE_PROTOTYPE]),
        (const byte *) "getColorDepth", 1, tty_get_color_depth);
    mal_intrinsic_define_method_n(vm,
        mal_value_to_object(values[TTY_WRITE_PROTOTYPE]),
        (const byte *) "hasColors", 1, tty_has_colors);
    mal_intrinsic_define_method_n(vm,
        mal_value_to_object(values[TTY_WRITE_PROTOTYPE]),
        (const byte *) "getWindowSize", 0, tty_get_window_size);

    values[TTY_DEFAULT] = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalObject *namespace = mal_value_to_object(values[TTY_DEFAULT]);
    mal_intrinsic_define_data(vm, namespace, (const byte *) "isatty",
        values[TTY_ISATTY], TTY_VISIBLE);
    mal_intrinsic_define_data(vm, namespace, (const byte *) "ReadStream",
        values[TTY_READ_STREAM], TTY_VISIBLE);
    mal_intrinsic_define_data(vm, namespace, (const byte *) "WriteStream",
        values[TTY_WRITE_STREAM], TTY_VISIBLE);

    for (i32 i = 0; i < count; i++) {
        MalValue value = mal_value_new_undefined();
        if (strcmp(slots[i].name, "isatty") == 0) {
            value = values[TTY_ISATTY];
        } else if (strcmp(slots[i].name, "ReadStream") == 0) {
            value = values[TTY_READ_STREAM];
        } else if (strcmp(slots[i].name, "WriteStream") == 0) {
            value = values[TTY_WRITE_STREAM];
        } else if (strcmp(slots[i].name, "default") == 0) {
            value = values[TTY_DEFAULT];
        }
        if (!mal_value_is_undefined(value)) {
            vm->globals[slots[i].slot] = value;
        }
    }
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
