#include "builtin_temporal.h"

#if MAL_TEMPORAL

#include <math.h>
#include <stdint.h>

#include "heap_string.h"
#include "intrinsics.h"
#include "temporal_object.h"
#include "utf8.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"
#include "temporal_rs/Duration.h"

// Maligator owns all observable JS coercion/property-order behavior; the
// generated temporal_capi surface owns validated calendrical arithmetic.

static MalValue temporal_throw(MalVm *vm, TemporalError error) {
    MalIntrinsic kind = error.kind == ErrorKind_Type
        ? MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE
        : MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE;
    mal_vm_throw_error(vm, kind, "Invalid Temporal value");
    return mal_value_new_undefined();
}

static MalValue temporal_throw_type(MalVm *vm, const byte *message) {
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message);
    return mal_value_new_undefined();
}

static bool duration_this(MalVm *vm, MalValue value, MalTemporalObject **out) {
    if (!mal_value_is_temporal_object(value)) {
        temporal_throw_type(vm, "Temporal.Duration method called on incompatible receiver");
        return false;
    }
    MalTemporalObject *object = mal_value_to_temporal_object(value);
    if (object->kind != MAL_TEMPORAL_DURATION || object->handle == nullptr) {
        temporal_throw_type(vm, "Temporal.Duration method called on incompatible receiver");
        return false;
    }
    *out = object;
    return true;
}

static MalValue duration_wrap(MalVm *vm, Duration *handle, MalObject *prototype) {
    return mal_value_from_temporal_object(mal_temporal_object_new(
        &vm->heap, prototype, MAL_TEMPORAL_DURATION, handle));
}

static MalValue duration_wrap_intrinsic(MalVm *vm, Duration *handle) {
    return duration_wrap(
        vm, handle,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_TEMPORAL_DURATION_PROTOTYPE]));
}

/** ToIntegerIfIntegral, including observable ToNumber and abrupt completion. */
static bool duration_component(MalVm *vm, MalValue value, f64 *out) {
    if (mal_value_is_undefined(value)) {
        *out = 0;
        return true;
    }
    f64 number;
    if (!mal_vm_to_number(vm, value, &number)) return false;
    if (!isfinite(number) || trunc(number) != number) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Temporal.Duration components must be finite integers");
        return false;
    }
    *out = number == 0 ? 0 : number; // canonicalize -0
    return true;
}

static bool duration_i64_component(MalVm *vm, MalValue value, i64 *out) {
    f64 number;
    if (!duration_component(vm, value, &number)) return false;
    if (number < (f64) INT64_MIN || number >= -(f64) INT64_MIN) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Temporal.Duration component is out of range");
        return false;
    }
    *out = (i64) number;
    return true;
}

static MalValue duration_constructor(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value;
    (void) callee;
    if (mal_value_is_undefined(new_target)) {
        return temporal_throw_type(vm, "Temporal.Duration must be called with new");
    }

    i64 whole[8] = {0};
    f64 fraction[2] = {0};
    for (i32 i = 0; i < 8; ++i) {
        MalValue value = i < arg_count ? args[i] : mal_value_new_undefined();
        if (!duration_i64_component(vm, value, &whole[i])) {
            return mal_value_new_undefined();
        }
    }
    for (i32 i = 0; i < 2; ++i) {
        MalValue value = i + 8 < arg_count ? args[i + 8] : mal_value_new_undefined();
        if (!duration_component(vm, value, &fraction[i])) {
            return mal_value_new_undefined();
        }
    }
    temporal_rs_Duration_create_result created = temporal_rs_Duration_create(
        whole[0], whole[1], whole[2], whole[3], whole[4], whole[5], whole[6], whole[7],
        fraction[0], fraction[1]);
    if (!created.is_ok) return temporal_throw(vm, created.err);

    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, new_target, MAL_INTRINSIC_TEMPORAL_DURATION_PROTOTYPE, &prototype)) {
        temporal_rs_Duration_destroy(created.ok);
        return mal_value_new_undefined();
    }
    return duration_wrap(vm, created.ok, prototype);
}

typedef enum DurationField : u8 {
    DURATION_DAYS,
    DURATION_HOURS,
    DURATION_MICROSECONDS,
    DURATION_MILLISECONDS,
    DURATION_MINUTES,
    DURATION_MONTHS,
    DURATION_NANOSECONDS,
    DURATION_SECONDS,
    DURATION_WEEKS,
    DURATION_YEARS,
} DurationField;

static const byte *const duration_field_names[] = {
    "days", "hours", "microseconds", "milliseconds", "minutes",
    "months", "nanoseconds", "seconds", "weeks", "years",
};

/** ToTemporalPartialDurationRecord, in the specification's observable key order. */
static bool duration_partial_from_object(
    MalVm *vm, MalValue input, PartialDuration *partial, bool require_field
) {
    *partial = (PartialDuration) {0};
    bool any = false;
    for (i32 field = 0; field < (i32) countof(duration_field_names); ++field) {
        MalValue value;
        if (!mal_vm_get_property(
                vm, input, mal_intrinsic_string_key(vm, duration_field_names[field]), &value)) {
            return false;
        }
        if (mal_value_is_undefined(value)) continue;
        any = true;
        if (field == DURATION_MICROSECONDS || field == DURATION_NANOSECONDS) {
            f64 number;
            if (!duration_component(vm, value, &number)) return false;
            OptionF64 option = {.ok = number, .is_ok = true};
            if (field == DURATION_MICROSECONDS) partial->microseconds = option;
            else partial->nanoseconds = option;
        } else {
            i64 number;
            if (!duration_i64_component(vm, value, &number)) return false;
            OptionI64 option = {.ok = number, .is_ok = true};
            switch ((DurationField) field) {
                case DURATION_DAYS: partial->days = option; break;
                case DURATION_HOURS: partial->hours = option; break;
                case DURATION_MILLISECONDS: partial->milliseconds = option; break;
                case DURATION_MINUTES: partial->minutes = option; break;
                case DURATION_MONTHS: partial->months = option; break;
                case DURATION_SECONDS: partial->seconds = option; break;
                case DURATION_WEEKS: partial->weeks = option; break;
                case DURATION_YEARS: partial->years = option; break;
                case DURATION_MICROSECONDS:
                case DURATION_NANOSECONDS:
                    break;
            }
        }
    }
    if (require_field && !any) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Temporal.Duration property bag has no duration fields");
        return false;
    }
    return true;
}

/** ToTemporalDuration: clone branded instances, parse strings, or read a bag. */
static Duration *duration_from_like(MalVm *vm, MalValue input) {
    if (mal_value_is_temporal_object(input)) {
        MalTemporalObject *object = mal_value_to_temporal_object(input);
        if (object->kind == MAL_TEMPORAL_DURATION && object->handle != nullptr) {
            return temporal_rs_Duration_clone(object->handle);
        }
    }
    if (mal_value_is_string(input)) {
        MalString *string = mal_value_to_string(input);
        DiplomatString16View view = {
            .data = (const char16_t *) mal_string_code_units(string),
            .len = mal_string_length(string),
        };
        temporal_rs_Duration_from_utf16_result result =
            temporal_rs_Duration_from_utf16(view);
        if (!result.is_ok) {
            temporal_throw(vm, result.err);
            return nullptr;
        }
        return result.ok;
    }
    if (!mal_value_is_object(input)) {
        temporal_throw_type(vm, "Temporal.Duration.from requires a string or object");
        return nullptr;
    }
    PartialDuration partial;
    if (!duration_partial_from_object(vm, input, &partial, true)) return nullptr;
    temporal_rs_Duration_from_partial_duration_result result =
        temporal_rs_Duration_from_partial_duration(partial);
    if (!result.is_ok) {
        temporal_throw(vm, result.err);
        return nullptr;
    }
    return result.ok;
}

static MalValue duration_from(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) new_target; (void) callee;
    MalValue input = arg_count > 0 ? args[0] : mal_value_new_undefined();
    Duration *duration = duration_from_like(vm, input);
    return duration == nullptr ? mal_value_new_undefined()
                               : duration_wrap_intrinsic(vm, duration);
}

#define DURATION_GETTER_I64(c_name, ffi_name) \
    static MalValue c_name(MalVm *vm, MalValue this_value, const MalValue *args, \
                           i32 arg_count, MalValue new_target, MalValue callee) { \
        (void) args; (void) arg_count; (void) new_target; (void) callee; \
        MalTemporalObject *object; \
        if (!duration_this(vm, this_value, &object)) return mal_value_new_undefined(); \
        return mal_ops_number_value((f64) ffi_name(object->handle)); \
    }

DURATION_GETTER_I64(duration_years, temporal_rs_Duration_years)
DURATION_GETTER_I64(duration_months, temporal_rs_Duration_months)
DURATION_GETTER_I64(duration_weeks, temporal_rs_Duration_weeks)
DURATION_GETTER_I64(duration_days, temporal_rs_Duration_days)
DURATION_GETTER_I64(duration_hours, temporal_rs_Duration_hours)
DURATION_GETTER_I64(duration_minutes, temporal_rs_Duration_minutes)
DURATION_GETTER_I64(duration_seconds, temporal_rs_Duration_seconds)
DURATION_GETTER_I64(duration_milliseconds, temporal_rs_Duration_milliseconds)
DURATION_GETTER_I64(duration_microseconds, temporal_rs_Duration_microseconds)
DURATION_GETTER_I64(duration_nanoseconds, temporal_rs_Duration_nanoseconds)

static MalValue duration_sign(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!duration_this(vm, this_value, &object)) return mal_value_new_undefined();
    return mal_value_from_i32((i32) temporal_rs_Duration_sign(object->handle));
}

static MalValue duration_blank(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!duration_this(vm, this_value, &object)) return mal_value_new_undefined();
    return mal_value_new_boolean(temporal_rs_Duration_is_zero(object->handle));
}

static MalValue duration_abs(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!duration_this(vm, this_value, &object)) return mal_value_new_undefined();
    return duration_wrap_intrinsic(vm, temporal_rs_Duration_abs(object->handle));
}

static MalValue duration_negated(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!duration_this(vm, this_value, &object)) return mal_value_new_undefined();
    return duration_wrap_intrinsic(vm, temporal_rs_Duration_negated(object->handle));
}

static MalValue duration_add_or_subtract(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, bool subtract
) {
    MalTemporalObject *object;
    if (!duration_this(vm, this_value, &object)) return mal_value_new_undefined();
    Duration *other = duration_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined());
    if (other == nullptr) return mal_value_new_undefined();
    Duration *result_handle = nullptr;
    TemporalError error = {0};
    bool is_ok;
    if (subtract) {
        temporal_rs_Duration_subtract_result result =
            temporal_rs_Duration_subtract(object->handle, other);
        is_ok = result.is_ok;
        if (is_ok) result_handle = result.ok;
        else error = result.err;
    } else {
        temporal_rs_Duration_add_result result =
            temporal_rs_Duration_add(object->handle, other);
        is_ok = result.is_ok;
        if (is_ok) result_handle = result.ok;
        else error = result.err;
    }
    temporal_rs_Duration_destroy(other);
    if (!is_ok) return temporal_throw(vm, error);
    return duration_wrap_intrinsic(vm, result_handle);
}

static MalValue duration_add(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    return duration_add_or_subtract(vm, this_value, args, arg_count, false);
}

static MalValue duration_subtract(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    return duration_add_or_subtract(vm, this_value, args, arg_count, true);
}

static MalValue duration_to_string_default(MalVm *vm, MalValue this_value) {
    MalTemporalObject *object;
    if (!duration_this(vm, this_value, &object)) return mal_value_new_undefined();
    DiplomatWrite *write = diplomat_buffer_write_create(64);
    if (write == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Unable to format Temporal.Duration");
        return mal_value_new_undefined();
    }
    ToStringRoundingOptions options = {
        .precision = {.is_minute = false, .precision = {.is_ok = false}},
        .smallest_unit = {.is_ok = false},
        .rounding_mode = {.is_ok = false},
    };
    temporal_rs_Duration_to_string_result result =
        temporal_rs_Duration_to_string(object->handle, options, write);
    if (!result.is_ok) {
        diplomat_buffer_write_destroy(write);
        return temporal_throw(vm, result.err);
    }
    MalString *string = mal_string_from_utf8(
        &vm->heap, (const byte *) diplomat_buffer_write_get_bytes(write),
        diplomat_buffer_write_len(write));
    diplomat_buffer_write_destroy(write);
    return mal_value_from_string(string);
}

static MalValue duration_to_string(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    return duration_to_string_default(vm, this_value);
}

static MalValue duration_value_of(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) args; (void) arg_count; (void) new_target; (void) callee;
    return temporal_throw_type(vm, "Cannot convert Temporal.Duration to a primitive");
}

static MalValue temporal_unimplemented_constructor(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) args; (void) arg_count; (void) new_target; (void) callee;
    return temporal_throw_type(vm, "Temporal constructor is not implemented yet");
}

static void temporal_set_tag(MalVm *vm, MalObject *object, const byte *tag) {
    MalPropertyDesc desc = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, tag)), MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(
        object, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &desc);
}

static void temporal_install_placeholder(
    MalVm *vm, MalObject *temporal, const byte *name, i32 length,
    MalIntrinsic constructor_slot, MalIntrinsic prototype_slot
) {
    MalObject *function_prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalObject *prototype = mal_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, name), length,
        temporal_unimplemented_constructor);
    vm->intrinsics[constructor_slot] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[prototype_slot] = mal_value_from_object(prototype);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype",
                              vm->intrinsics[prototype_slot], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor",
                              vm->intrinsics[constructor_slot],
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, temporal, name, vm->intrinsics[constructor_slot],
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
}

void mal_builtin_temporal_install(MalVm *vm) {
    MalObject *object_prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    MalObject *function_prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalObject *temporal = mal_object_new(&vm->heap, object_prototype);
    vm->intrinsics[MAL_INTRINSIC_TEMPORAL] = mal_value_from_object(temporal);

    MalObject *duration_prototype = mal_object_new(&vm->heap, object_prototype);
    MalNativeFunctionObject *duration_ctor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "Duration"), 0,
        duration_constructor);
    vm->intrinsics[MAL_INTRINSIC_TEMPORAL_DURATION_CONSTRUCTOR] =
        mal_value_from_native_function_object(duration_ctor);
    vm->intrinsics[MAL_INTRINSIC_TEMPORAL_DURATION_PROTOTYPE] =
        mal_value_from_object(duration_prototype);
    mal_intrinsic_define_data(vm, (MalObject *) duration_ctor, "prototype",
                              vm->intrinsics[MAL_INTRINSIC_TEMPORAL_DURATION_PROTOTYPE],
                              MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, duration_prototype, "constructor",
                              vm->intrinsics[MAL_INTRINSIC_TEMPORAL_DURATION_CONSTRUCTOR],
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_method_n(vm, (MalObject *) duration_ctor, "from", 1, duration_from);
    mal_intrinsic_define_data(vm, temporal, "Duration",
                              vm->intrinsics[MAL_INTRINSIC_TEMPORAL_DURATION_CONSTRUCTOR],
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    struct {
        const byte *name;
        MalNativeFunctionCallback getter;
    } getters[] = {
        {"years", duration_years}, {"months", duration_months},
        {"weeks", duration_weeks}, {"days", duration_days},
        {"hours", duration_hours}, {"minutes", duration_minutes},
        {"seconds", duration_seconds}, {"milliseconds", duration_milliseconds},
        {"microseconds", duration_microseconds}, {"nanoseconds", duration_nanoseconds},
        {"sign", duration_sign}, {"blank", duration_blank},
    };
    for (usize i = 0; i < countof(getters); ++i) {
        byte getter_name[32] = "get ";
        usize length = 4;
        const byte *source = getters[i].name;
        while (*source != '\0' && length + 1 < sizeof(getter_name)) {
            getter_name[length++] = *source++;
        }
        getter_name[length] = '\0';
        mal_intrinsic_define_accessor_n(
            vm, duration_prototype, mal_intrinsic_string_key(vm, getters[i].name),
            getter_name, 0, getters[i].getter, nullptr, 0, nullptr,
            MAL_PROPERTY_CONFIGURABLE);
    }
    mal_intrinsic_define_method_n(vm, duration_prototype, "abs", 0, duration_abs);
    mal_intrinsic_define_method_n(vm, duration_prototype, "add", 1, duration_add);
    mal_intrinsic_define_method_n(vm, duration_prototype, "negated", 0, duration_negated);
    mal_intrinsic_define_method_n(vm, duration_prototype, "subtract", 1, duration_subtract);
    mal_intrinsic_define_method_n(vm, duration_prototype, "toJSON", 0, duration_to_string);
    mal_intrinsic_define_method_n(vm, duration_prototype, "toLocaleString", 0, duration_to_string);
    mal_intrinsic_define_method_n(vm, duration_prototype, "toString", 0, duration_to_string);
    mal_intrinsic_define_method_n(vm, duration_prototype, "valueOf", 0, duration_value_of);
    temporal_set_tag(vm, duration_prototype, "Temporal.Duration");

    temporal_install_placeholder(vm, temporal, "Instant", 1,
        MAL_INTRINSIC_TEMPORAL_INSTANT_CONSTRUCTOR,
        MAL_INTRINSIC_TEMPORAL_INSTANT_PROTOTYPE);
    MalObject *now = mal_object_new(&vm->heap, object_prototype);
    temporal_set_tag(vm, now, "Temporal.Now");
    mal_intrinsic_define_data(vm, temporal, "Now", mal_value_from_object(now),
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    temporal_install_placeholder(vm, temporal, "PlainDate", 3,
        MAL_INTRINSIC_TEMPORAL_PLAIN_DATE_CONSTRUCTOR,
        MAL_INTRINSIC_TEMPORAL_PLAIN_DATE_PROTOTYPE);
    temporal_install_placeholder(vm, temporal, "PlainDateTime", 3,
        MAL_INTRINSIC_TEMPORAL_PLAIN_DATE_TIME_CONSTRUCTOR,
        MAL_INTRINSIC_TEMPORAL_PLAIN_DATE_TIME_PROTOTYPE);
    temporal_install_placeholder(vm, temporal, "PlainMonthDay", 2,
        MAL_INTRINSIC_TEMPORAL_PLAIN_MONTH_DAY_CONSTRUCTOR,
        MAL_INTRINSIC_TEMPORAL_PLAIN_MONTH_DAY_PROTOTYPE);
    temporal_install_placeholder(vm, temporal, "PlainTime", 0,
        MAL_INTRINSIC_TEMPORAL_PLAIN_TIME_CONSTRUCTOR,
        MAL_INTRINSIC_TEMPORAL_PLAIN_TIME_PROTOTYPE);
    temporal_install_placeholder(vm, temporal, "PlainYearMonth", 2,
        MAL_INTRINSIC_TEMPORAL_PLAIN_YEAR_MONTH_CONSTRUCTOR,
        MAL_INTRINSIC_TEMPORAL_PLAIN_YEAR_MONTH_PROTOTYPE);
    temporal_install_placeholder(vm, temporal, "ZonedDateTime", 2,
        MAL_INTRINSIC_TEMPORAL_ZONED_DATE_TIME_CONSTRUCTOR,
        MAL_INTRINSIC_TEMPORAL_ZONED_DATE_TIME_PROTOTYPE);
    temporal_set_tag(vm, temporal, "Temporal");
}

#else

void mal_builtin_temporal_install(MalVm *vm) { (void) vm; }

#endif
