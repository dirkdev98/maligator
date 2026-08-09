#include "builtin_temporal.h"

#if MAL_TEMPORAL

#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <time.h>

#include "ascii.h"
#include "builtin_bigint.h"
#include "heap_bigint.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "mal_i18n.h"
#include "temporal_object.h"
#include "utf8.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"
#include "temporal_rs/Duration.h"
#include "temporal_rs/AnyCalendarKind.h"
#include "temporal_rs/Calendar.h"
#include "temporal_rs/Instant.h"
#include "temporal_rs/PlainDate.h"
#include "temporal_rs/PlainDateTime.h"
#include "temporal_rs/PlainMonthDay.h"
#include "temporal_rs/PlainTime.h"
#include "temporal_rs/PlainYearMonth.h"
#include "temporal_rs/TimeZone.h"
#include "temporal_rs/ZonedDateTime.h"

// Maligator owns all observable JS coercion/property-order behavior; the
// generated temporal_capi surface owns validated calendrical arithmetic.

static MalValue plain_date_time_wrap_intrinsic(MalVm *vm, PlainDateTime *handle);
static MalValue plain_month_day_wrap_intrinsic(MalVm *vm, PlainMonthDay *handle);
static MalValue plain_year_month_wrap_intrinsic(MalVm *vm, PlainYearMonth *handle);
static MalValue zoned_date_time_wrap_intrinsic(MalVm *vm, ZonedDateTime *handle);
static bool temporal_to_string_rounding_options(
    MalVm *vm, MalValue value, ToStringRoundingOptions *options);
static MalValue temporal_write_to_string(MalVm *vm, DiplomatWrite *write);

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
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!duration_this(vm, this_value, &object)) return mal_value_new_undefined();
    ToStringRoundingOptions options;
    if (!temporal_to_string_rounding_options(
            vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), &options)) {
        return mal_value_new_undefined();
    }
    DiplomatWrite *write = diplomat_buffer_write_create(64);
    temporal_rs_Duration_to_string_result result =
        temporal_rs_Duration_to_string(object->handle, options, write);
    if (!result.is_ok) {
        diplomat_buffer_write_destroy(write);
        return temporal_throw(vm, result.err);
    }
    return temporal_write_to_string(vm, write);
}

static MalValue duration_to_string_no_options(
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

static bool temporal_options_object(MalVm *vm, MalValue value, bool *present) {
    if (mal_value_is_undefined(value)) {
        *present = false;
        return true;
    }
    if (!mal_value_is_object(value)) {
        temporal_throw_type(vm, "Temporal options must be an object");
        return false;
    }
    *present = true;
    return true;
}

static bool temporal_overflow_option(
    MalVm *vm, MalValue options, ArithmeticOverflow *overflow
) {
    bool present;
    if (!temporal_options_object(vm, options, &present)) return false;
    *overflow = ArithmeticOverflow_Constrain;
    if (!present) return true;
    MalValue value;
    if (!mal_vm_get_property(
            vm, options, mal_intrinsic_string_key(vm, "overflow"), &value)) {
        return false;
    }
    if (mal_value_is_undefined(value)) return true;
    MalString *string;
    if (!mal_vm_to_string(vm, value, &string)) return false;
    if (mal_string_equals_ascii(string, "constrain")) return true;
    if (mal_string_equals_ascii(string, "reject")) {
        *overflow = ArithmeticOverflow_Reject;
        return true;
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                       "Invalid Temporal overflow option");
    return false;
}

static bool temporal_unit_from_string(
    MalVm *vm, MalString *string, bool allow_auto, Unit *unit
) {
    struct { const char *name; Unit unit; } units[] = {
        {"nanosecond", Unit_Nanosecond}, {"nanoseconds", Unit_Nanosecond},
        {"microsecond", Unit_Microsecond}, {"microseconds", Unit_Microsecond},
        {"millisecond", Unit_Millisecond}, {"milliseconds", Unit_Millisecond},
        {"second", Unit_Second}, {"seconds", Unit_Second},
        {"minute", Unit_Minute}, {"minutes", Unit_Minute},
        {"hour", Unit_Hour}, {"hours", Unit_Hour},
        {"day", Unit_Day}, {"days", Unit_Day},
        {"week", Unit_Week}, {"weeks", Unit_Week},
        {"month", Unit_Month}, {"months", Unit_Month},
        {"year", Unit_Year}, {"years", Unit_Year},
    };
    if (allow_auto && mal_string_equals_ascii(string, "auto")) {
        *unit = Unit_Auto;
        return true;
    }
    for (usize i = 0; i < countof(units); ++i) {
        if (mal_string_equals_ascii(string, units[i].name)) {
            *unit = units[i].unit;
            return true;
        }
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                       "Invalid Temporal unit option");
    return false;
}

static bool temporal_rounding_mode_from_string(
    MalVm *vm, MalString *string, RoundingMode *mode
) {
    struct { const char *name; RoundingMode mode; } modes[] = {
        {"ceil", RoundingMode_Ceil}, {"floor", RoundingMode_Floor},
        {"expand", RoundingMode_Expand}, {"trunc", RoundingMode_Trunc},
        {"halfCeil", RoundingMode_HalfCeil}, {"halfFloor", RoundingMode_HalfFloor},
        {"halfExpand", RoundingMode_HalfExpand}, {"halfTrunc", RoundingMode_HalfTrunc},
        {"halfEven", RoundingMode_HalfEven},
    };
    for (usize i = 0; i < countof(modes); ++i) {
        if (mal_string_equals_ascii(string, modes[i].name)) {
            *mode = modes[i].mode;
            return true;
        }
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                       "Invalid Temporal roundingMode option");
    return false;
}

static bool temporal_get_unit_option(
    MalVm *vm, MalValue options, const byte *name, bool allow_auto,
    bool required, Unit fallback, Unit *out
) {
    MalValue value;
    if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, name), &value)) {
        return false;
    }
    if (mal_value_is_undefined(value)) {
        if (required) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                               "Required Temporal unit option is missing");
            return false;
        }
        *out = fallback;
        return true;
    }
    MalString *string;
    if (!mal_vm_to_string(vm, value, &string)) return false;
    return temporal_unit_from_string(vm, string, allow_auto, out);
}

static bool temporal_get_rounding_increment(
    MalVm *vm, MalValue options, u32 *out
) {
    MalValue value;
    if (!mal_vm_get_property(
            vm, options, mal_intrinsic_string_key(vm, "roundingIncrement"), &value)) {
        return false;
    }
    if (mal_value_is_undefined(value)) {
        *out = 1;
        return true;
    }
    f64 number;
    if (!mal_vm_to_number(vm, value, &number)) return false;
    if (!isfinite(number)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Invalid Temporal roundingIncrement option");
        return false;
    }
    number = trunc(number);
    if (number < 1 || number > 1000000000.0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Invalid Temporal roundingIncrement option");
        return false;
    }
    *out = (u32) number;
    return true;
}

static bool temporal_get_rounding_mode(
    MalVm *vm, MalValue options, RoundingMode fallback, RoundingMode *out
) {
    MalValue value;
    if (!mal_vm_get_property(
            vm, options, mal_intrinsic_string_key(vm, "roundingMode"), &value)) {
        return false;
    }
    if (mal_value_is_undefined(value)) {
        *out = fallback;
        return true;
    }
    MalString *string;
    if (!mal_vm_to_string(vm, value, &string)) return false;
    return temporal_rounding_mode_from_string(vm, string, out);
}

static MalValue temporal_write_to_string(MalVm *vm, DiplomatWrite *write) {
    MalString *string = mal_string_from_utf8(
        &vm->heap, (const byte *) diplomat_buffer_write_get_bytes(write),
        diplomat_buffer_write_len(write));
    diplomat_buffer_write_destroy(write);
    return mal_value_from_string(string);
}

static bool temporal_i32_integer(MalVm *vm, MalValue value, i32 *out) {
    f64 number;
    if (!mal_vm_to_number(vm, value, &number)) return false;
    if (!isfinite(number)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Temporal component must be finite");
        return false;
    }
    number = trunc(number);
    if (number < INT32_MIN || number > INT32_MAX) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Temporal component is out of range");
        return false;
    }
    *out = (i32) number;
    return true;
}

static bool temporal_calendar_kind(
    MalVm *vm, MalValue value, AnyCalendarKind *kind
) {
    if (mal_value_is_undefined(value)) {
        *kind = AnyCalendarKind_Iso;
        return true;
    }
    if (mal_value_is_temporal_object(value)) {
        MalTemporalObject *object = mal_value_to_temporal_object(value);
        const Calendar *calendar = nullptr;
        switch (object->kind) {
            case MAL_TEMPORAL_PLAIN_DATE:
                calendar = temporal_rs_PlainDate_calendar(object->handle); break;
            case MAL_TEMPORAL_PLAIN_DATE_TIME:
                calendar = temporal_rs_PlainDateTime_calendar(object->handle); break;
            case MAL_TEMPORAL_PLAIN_MONTH_DAY:
                calendar = temporal_rs_PlainMonthDay_calendar(object->handle); break;
            case MAL_TEMPORAL_PLAIN_YEAR_MONTH:
                calendar = temporal_rs_PlainYearMonth_calendar(object->handle); break;
            case MAL_TEMPORAL_ZONED_DATE_TIME:
                calendar = temporal_rs_ZonedDateTime_calendar(object->handle); break;
            case MAL_TEMPORAL_DURATION:
            case MAL_TEMPORAL_INSTANT:
            case MAL_TEMPORAL_PLAIN_TIME:
                break;
        }
        if (calendar != nullptr) {
            DiplomatStringView identifier = temporal_rs_Calendar_identifier(calendar);
            temporal_rs_AnyCalendarKind_get_for_str_result result =
                temporal_rs_AnyCalendarKind_get_for_str(identifier);
            if (result.is_ok) { *kind = result.ok; return true; }
        }
    }
    if (!mal_value_is_string(value)) {
        temporal_throw_type(vm, "Temporal calendar must be a string");
        return false;
    }
    MalString *string = mal_value_to_string(value);
    usize length;
    byte *utf8 = mal_string_to_utf8(string, &length);
    if (utf8 == nullptr) return temporal_throw_type(vm, "Unable to encode calendar"), false;
    temporal_rs_AnyCalendarKind_get_for_str_result result =
        temporal_rs_AnyCalendarKind_get_for_str(
            (DiplomatStringView) {.data = (const char *) utf8, .len = length});
    free(utf8);
    if (!result.is_ok) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Invalid Temporal calendar");
        return false;
    }
    *kind = result.ok;
    return true;
}

static bool temporal_calendar_string(
    MalVm *vm, MalValue value, AnyCalendarKind *kind
) {
    if (mal_value_is_undefined(value)) {
        *kind = AnyCalendarKind_Iso;
        return true;
    }
    if (mal_value_is_temporal_object(value)) {
        return temporal_calendar_kind(vm, value, kind);
    }
    if (!mal_value_is_string(value)) {
        temporal_throw_type(vm, "Temporal calendar must be a string");
        return false;
    }
    MalString *string = mal_value_to_string(value);
    usize length;
    byte *utf8 = mal_string_to_utf8(string, &length);
    if (utf8 == nullptr) return temporal_throw_type(vm, "Unable to encode calendar"), false;
    temporal_rs_AnyCalendarKind_parse_temporal_calendar_string_result result =
        temporal_rs_AnyCalendarKind_parse_temporal_calendar_string(
            (DiplomatStringView) {.data = (const char *) utf8, .len = length});
    free(utf8);
    if (!result.is_ok) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Invalid Temporal calendar");
        return false;
    }
    *kind = result.ok;
    return true;
}

static MalValue temporal_calendar_identifier(MalVm *vm, const Calendar *calendar) {
    DiplomatStringView identifier = temporal_rs_Calendar_identifier(calendar);
    return mal_value_from_string(mal_string_from_utf8(
        &vm->heap, (const byte *) identifier.data, identifier.len));
}

static bool temporal_display_calendar(
    MalVm *vm, MalValue options, DisplayCalendar *display
) {
    bool present;
    if (!temporal_options_object(vm, options, &present)) return false;
    *display = DisplayCalendar_Auto;
    if (!present) return true;
    MalValue value;
    if (!mal_vm_get_property(
            vm, options, mal_intrinsic_string_key(vm, "calendarName"), &value)) {
        return false;
    }
    if (mal_value_is_undefined(value)) return true;
    MalString *string;
    if (!mal_vm_to_string(vm, value, &string)) return false;
    if (mal_string_equals_ascii(string, "auto")) return true;
    if (mal_string_equals_ascii(string, "always")) *display = DisplayCalendar_Always;
    else if (mal_string_equals_ascii(string, "never")) *display = DisplayCalendar_Never;
    else if (mal_string_equals_ascii(string, "critical")) *display = DisplayCalendar_Critical;
    else {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Invalid calendarName option");
        return false;
    }
    return true;
}

static bool duration_relative_to(
    MalVm *vm, MalValue options, RelativeTo *relative
) {
    *relative = (RelativeTo) {0};
    bool present;
    if (!temporal_options_object(vm, options, &present)) return false;
    if (!present) return true;
    MalValue value;
    if (!mal_vm_get_property(
            vm, options, mal_intrinsic_string_key(vm, "relativeTo"), &value)) {
        return false;
    }
    if (mal_value_is_undefined(value)) return true;
    if (mal_value_is_temporal_object(value)) {
        MalTemporalObject *object = mal_value_to_temporal_object(value);
        if (object->kind == MAL_TEMPORAL_PLAIN_DATE) {
            relative->date = object->handle;
            return true;
        }
        if (object->kind == MAL_TEMPORAL_ZONED_DATE_TIME) {
            relative->zoned = object->handle;
            return true;
        }
    }
    temporal_throw_type(vm, "Unsupported Temporal relativeTo value");
    return false;
}

static MalValue duration_compare(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) new_target; (void) callee;
    Duration *one = duration_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined());
    if (one == nullptr) return mal_value_new_undefined();
    Duration *two = duration_from_like(
        vm, arg_count > 1 ? args[1] : mal_value_new_undefined());
    if (two == nullptr) {
        temporal_rs_Duration_destroy(one);
        return mal_value_new_undefined();
    }
    RelativeTo relative;
    if (!duration_relative_to(
            vm, arg_count > 2 ? args[2] : mal_value_new_undefined(), &relative)) {
        temporal_rs_Duration_destroy(one);
        temporal_rs_Duration_destroy(two);
        return mal_value_new_undefined();
    }
    temporal_rs_Duration_compare_result result =
        temporal_rs_Duration_compare(one, two, relative);
    temporal_rs_Duration_destroy(one);
    temporal_rs_Duration_destroy(two);
    return result.is_ok ? mal_value_from_i32(result.ok) : temporal_throw(vm, result.err);
}

static MalValue duration_with(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!duration_this(vm, this_value, &object)) return mal_value_new_undefined();
    MalValue input = arg_count > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_object(input) || mal_value_is_temporal_object(input)) {
        return temporal_throw_type(vm, "Temporal.Duration.with requires a property bag");
    }
    PartialDuration partial;
    if (!duration_partial_from_object(vm, input, &partial, true)) {
        return mal_value_new_undefined();
    }
    i64 whole[8] = {
        temporal_rs_Duration_years(object->handle),
        temporal_rs_Duration_months(object->handle),
        temporal_rs_Duration_weeks(object->handle),
        temporal_rs_Duration_days(object->handle),
        temporal_rs_Duration_hours(object->handle),
        temporal_rs_Duration_minutes(object->handle),
        temporal_rs_Duration_seconds(object->handle),
        temporal_rs_Duration_milliseconds(object->handle),
    };
    f64 fraction[2] = {
        temporal_rs_Duration_microseconds(object->handle),
        temporal_rs_Duration_nanoseconds(object->handle),
    };
    if (partial.years.is_ok) whole[0] = partial.years.ok;
    if (partial.months.is_ok) whole[1] = partial.months.ok;
    if (partial.weeks.is_ok) whole[2] = partial.weeks.ok;
    if (partial.days.is_ok) whole[3] = partial.days.ok;
    if (partial.hours.is_ok) whole[4] = partial.hours.ok;
    if (partial.minutes.is_ok) whole[5] = partial.minutes.ok;
    if (partial.seconds.is_ok) whole[6] = partial.seconds.ok;
    if (partial.milliseconds.is_ok) whole[7] = partial.milliseconds.ok;
    if (partial.microseconds.is_ok) fraction[0] = partial.microseconds.ok;
    if (partial.nanoseconds.is_ok) fraction[1] = partial.nanoseconds.ok;
    temporal_rs_Duration_create_result result = temporal_rs_Duration_create(
        whole[0], whole[1], whole[2], whole[3], whole[4], whole[5], whole[6], whole[7],
        fraction[0], fraction[1]);
    return result.is_ok ? duration_wrap_intrinsic(vm, result.ok)
                        : temporal_throw(vm, result.err);
}

static MalValue duration_round(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!duration_this(vm, this_value, &object)) return mal_value_new_undefined();
    MalValue value = arg_count > 0 ? args[0] : mal_value_new_undefined();
    RoundingOptions options = {0};
    RelativeTo relative = {0};
    if (mal_value_is_string(value)) {
        Unit unit;
        if (!temporal_unit_from_string(
                vm, mal_value_to_string(value), false, &unit)) {
            return mal_value_new_undefined();
        }
        options.smallest_unit = (Unit_option) {.ok = unit, .is_ok = true};
        options.largest_unit = (Unit_option) {.ok = Unit_Auto, .is_ok = true};
        options.rounding_mode = (RoundingMode_option) {
            .ok = RoundingMode_HalfExpand, .is_ok = true};
        options.increment = (OptionU32) {.ok = 1, .is_ok = true};
    } else {
        bool present;
        if (!temporal_options_object(vm, value, &present)) return mal_value_new_undefined();
        if (!present) return temporal_throw_type(vm, "Temporal.Duration.round requires an argument");
        Unit largest, smallest;
        RoundingMode mode;
        u32 increment;
        if (!temporal_get_unit_option(
                vm, value, "largestUnit", true, false, Unit_Auto, &largest) ||
            !temporal_get_rounding_increment(vm, value, &increment) ||
            !temporal_get_rounding_mode(vm, value, RoundingMode_HalfExpand, &mode) ||
            !temporal_get_unit_option(
                vm, value, "smallestUnit", false, false, Unit_Nanosecond, &smallest) ||
            !duration_relative_to(vm, value, &relative)) {
            return mal_value_new_undefined();
        }
        options.largest_unit = (Unit_option) {.ok = largest, .is_ok = true};
        options.smallest_unit = (Unit_option) {.ok = smallest, .is_ok = true};
        options.rounding_mode = (RoundingMode_option) {.ok = mode, .is_ok = true};
        options.increment = (OptionU32) {.ok = increment, .is_ok = true};
    }
    temporal_rs_Duration_round_result result =
        temporal_rs_Duration_round(object->handle, options, relative);
    return result.is_ok ? duration_wrap_intrinsic(vm, result.ok)
                        : temporal_throw(vm, result.err);
}

static MalValue duration_total(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!duration_this(vm, this_value, &object)) return mal_value_new_undefined();
    MalValue value = arg_count > 0 ? args[0] : mal_value_new_undefined();
    Unit unit;
    RelativeTo relative = {0};
    if (mal_value_is_string(value)) {
        if (!temporal_unit_from_string(vm, mal_value_to_string(value), false, &unit)) {
            return mal_value_new_undefined();
        }
    } else {
        bool present;
        if (!temporal_options_object(vm, value, &present)) return mal_value_new_undefined();
        if (!present || !temporal_get_unit_option(
                vm, value, "unit", false, true, Unit_Auto, &unit) ||
            !duration_relative_to(vm, value, &relative)) {
            return mal_value_new_undefined();
        }
    }
    temporal_rs_Duration_total_result result =
        temporal_rs_Duration_total(object->handle, unit, relative);
    return result.is_ok ? mal_ops_number_value(result.ok) : temporal_throw(vm, result.err);
}

static bool plain_time_this(MalVm *vm, MalValue value, MalTemporalObject **out) {
    if (!mal_value_is_temporal_object(value)) {
        temporal_throw_type(vm, "Temporal.PlainTime method called on incompatible receiver");
        return false;
    }
    MalTemporalObject *object = mal_value_to_temporal_object(value);
    if (object->kind != MAL_TEMPORAL_PLAIN_TIME || object->handle == nullptr) {
        temporal_throw_type(vm, "Temporal.PlainTime method called on incompatible receiver");
        return false;
    }
    *out = object;
    return true;
}

static MalValue plain_time_wrap(MalVm *vm, PlainTime *handle, MalObject *prototype) {
    return mal_value_from_temporal_object(mal_temporal_object_new(
        &vm->heap, prototype, MAL_TEMPORAL_PLAIN_TIME, handle));
}

static MalValue plain_time_wrap_intrinsic(MalVm *vm, PlainTime *handle) {
    return plain_time_wrap(
        vm, handle,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_TIME_PROTOTYPE]));
}

static bool temporal_u16_integer(
    MalVm *vm, MalValue value, u16 maximum, u16 *out
) {
    f64 number;
    if (mal_value_is_undefined(value)) number = 0;
    else if (!mal_vm_to_number(vm, value, &number)) return false;
    if (!isfinite(number)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Temporal component must be finite");
        return false;
    }
    number = trunc(number);
    if (number < 0 || number > maximum) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Temporal component is out of range");
        return false;
    }
    *out = (u16) number;
    return true;
}

static MalValue plain_time_constructor(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) callee;
    if (mal_value_is_undefined(new_target)) {
        return temporal_throw_type(vm, "Temporal.PlainTime must be called with new");
    }
    u16 values[6] = {0};
    const u16 maxima[6] = {UINT8_MAX, UINT8_MAX, UINT8_MAX,
                           UINT16_MAX, UINT16_MAX, UINT16_MAX};
    for (i32 i = 0; i < 6; ++i) {
        MalValue value = i < arg_count ? args[i] : mal_value_new_undefined();
        if (!temporal_u16_integer(vm, value, maxima[i], &values[i])) {
            return mal_value_new_undefined();
        }
    }
    temporal_rs_PlainTime_try_new_result result = temporal_rs_PlainTime_try_new(
        (u8) values[0], (u8) values[1], (u8) values[2],
        values[3], values[4], values[5]);
    if (!result.is_ok) return temporal_throw(vm, result.err);
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, new_target, MAL_INTRINSIC_TEMPORAL_PLAIN_TIME_PROTOTYPE, &prototype)) {
        temporal_rs_PlainTime_destroy(result.ok);
        return mal_value_new_undefined();
    }
    return plain_time_wrap(vm, result.ok, prototype);
}

typedef struct PlainTimeFields {
    f64 values[6];
    bool present[6];
    bool any;
} PlainTimeFields;

static const byte *const plain_time_field_names[] = {
    "hour", "microsecond", "millisecond", "minute", "nanosecond", "second",
};
static const u8 plain_time_field_slots[] = {0, 4, 3, 1, 5, 2};

static bool plain_time_read_fields(
    MalVm *vm, MalValue input, PlainTimeFields *fields, bool require_field
) {
    *fields = (PlainTimeFields) {0};
    for (usize i = 0; i < countof(plain_time_field_names); ++i) {
        MalValue value;
        if (!mal_vm_get_property(
                vm, input, mal_intrinsic_string_key(vm, plain_time_field_names[i]), &value)) {
            return false;
        }
        if (mal_value_is_undefined(value)) continue;
        f64 number;
        if (!mal_vm_to_number(vm, value, &number)) return false;
        if (!isfinite(number)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                               "Temporal component must be finite");
            return false;
        }
        number = trunc(number);
        usize slot = plain_time_field_slots[i];
        fields->values[slot] = number;
        fields->present[slot] = true;
        fields->any = true;
    }
    if (require_field && !fields->any) {
        temporal_throw_type(vm, "Temporal.PlainTime property bag has no time fields");
        return false;
    }
    return true;
}

static bool plain_time_partial(
    MalVm *vm, const PlainTimeFields *fields, ArithmeticOverflow overflow,
    PartialTime *partial
) {
    *partial = (PartialTime) {0};
    const u16 maxima[6] = {23, 59, 59, 999, 999, 999};
    for (usize i = 0; i < 6; ++i) {
        if (!fields->present[i]) continue;
        f64 number = fields->values[i];
        if (number < 0 || number > maxima[i]) {
            if (overflow == ArithmeticOverflow_Reject) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                                   "Temporal.PlainTime field is out of range");
                return false;
            }
            if (number < 0) number = 0;
            if (number > maxima[i]) number = maxima[i];
        }
        switch (i) {
            case 0: partial->hour = (OptionU8) {.ok = (u8) number, .is_ok = true}; break;
            case 1: partial->minute = (OptionU8) {.ok = (u8) number, .is_ok = true}; break;
            case 2: partial->second = (OptionU8) {.ok = (u8) number, .is_ok = true}; break;
            case 3: partial->millisecond = (OptionU16) {.ok = (u16) number, .is_ok = true}; break;
            case 4: partial->microsecond = (OptionU16) {.ok = (u16) number, .is_ok = true}; break;
            case 5: partial->nanosecond = (OptionU16) {.ok = (u16) number, .is_ok = true}; break;
        }
    }
    return true;
}

static PlainTime *plain_time_from_like(
    MalVm *vm, MalValue input, MalValue options
) {
    if (mal_value_is_temporal_object(input)) {
        MalTemporalObject *object = mal_value_to_temporal_object(input);
        if (object->kind == MAL_TEMPORAL_PLAIN_TIME && object->handle != nullptr) {
            ArithmeticOverflow overflow;
            if (!temporal_overflow_option(vm, options, &overflow)) return nullptr;
            return temporal_rs_PlainTime_clone(object->handle);
        }
        if (object->kind == MAL_TEMPORAL_PLAIN_DATE_TIME && object->handle != nullptr) {
            ArithmeticOverflow overflow;
            if (!temporal_overflow_option(vm, options, &overflow)) return nullptr;
            return temporal_rs_PlainDateTime_to_plain_time(object->handle);
        }
        if (object->kind == MAL_TEMPORAL_ZONED_DATE_TIME && object->handle != nullptr) {
            ArithmeticOverflow overflow;
            if (!temporal_overflow_option(vm, options, &overflow)) return nullptr;
            return temporal_rs_ZonedDateTime_to_plain_time(object->handle);
        }
    }
    if (mal_value_is_string(input)) {
        MalString *string = mal_value_to_string(input);
        DiplomatString16View view = {
            .data = (const char16_t *) mal_string_code_units(string),
            .len = mal_string_length(string),
        };
        temporal_rs_PlainTime_from_utf16_result result =
            temporal_rs_PlainTime_from_utf16(view);
        if (!result.is_ok) {
            temporal_throw(vm, result.err);
            return nullptr;
        }
        ArithmeticOverflow overflow;
        if (!temporal_overflow_option(vm, options, &overflow)) {
            temporal_rs_PlainTime_destroy(result.ok);
            return nullptr;
        }
        return result.ok;
    }
    if (!mal_value_is_object(input)) {
        temporal_throw_type(vm, "Temporal.PlainTime.from requires a string or object");
        return nullptr;
    }
    PlainTimeFields fields;
    if (!plain_time_read_fields(vm, input, &fields, true)) return nullptr;
    ArithmeticOverflow overflow;
    if (!temporal_overflow_option(vm, options, &overflow)) return nullptr;
    PartialTime partial;
    if (!plain_time_partial(vm, &fields, overflow, &partial)) return nullptr;
    temporal_rs_PlainTime_from_partial_result result = temporal_rs_PlainTime_from_partial(
        partial, (ArithmeticOverflow_option) {.ok = overflow, .is_ok = true});
    if (!result.is_ok) {
        temporal_throw(vm, result.err);
        return nullptr;
    }
    return result.ok;
}

static MalValue plain_time_from(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) new_target; (void) callee;
    PlainTime *time = plain_time_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined(),
        arg_count > 1 ? args[1] : mal_value_new_undefined());
    return time == nullptr ? mal_value_new_undefined() : plain_time_wrap_intrinsic(vm, time);
}

#define PLAIN_TIME_GETTER(c_name, ffi_name) \
    static MalValue c_name(MalVm *vm, MalValue this_value, const MalValue *args, \
                           i32 arg_count, MalValue new_target, MalValue callee) { \
        (void) args; (void) arg_count; (void) new_target; (void) callee; \
        MalTemporalObject *object; \
        if (!plain_time_this(vm, this_value, &object)) return mal_value_new_undefined(); \
        return mal_value_from_i32((i32) ffi_name(object->handle)); \
    }

PLAIN_TIME_GETTER(plain_time_hour, temporal_rs_PlainTime_hour)
PLAIN_TIME_GETTER(plain_time_minute, temporal_rs_PlainTime_minute)
PLAIN_TIME_GETTER(plain_time_second, temporal_rs_PlainTime_second)
PLAIN_TIME_GETTER(plain_time_millisecond, temporal_rs_PlainTime_millisecond)
PLAIN_TIME_GETTER(plain_time_microsecond, temporal_rs_PlainTime_microsecond)
PLAIN_TIME_GETTER(plain_time_nanosecond, temporal_rs_PlainTime_nanosecond)

static MalValue plain_time_compare(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) new_target; (void) callee;
    PlainTime *one = plain_time_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), mal_value_new_undefined());
    if (one == nullptr) return mal_value_new_undefined();
    PlainTime *two = plain_time_from_like(
        vm, arg_count > 1 ? args[1] : mal_value_new_undefined(), mal_value_new_undefined());
    if (two == nullptr) {
        temporal_rs_PlainTime_destroy(one);
        return mal_value_new_undefined();
    }
    i8 comparison = temporal_rs_PlainTime_compare(one, two);
    temporal_rs_PlainTime_destroy(one);
    temporal_rs_PlainTime_destroy(two);
    return mal_value_from_i32(comparison);
}

static MalValue plain_time_add_or_subtract(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, bool subtract
) {
    MalTemporalObject *object;
    if (!plain_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    Duration *duration = duration_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined());
    if (duration == nullptr) return mal_value_new_undefined();
    PlainTime *handle = nullptr;
    TemporalError error = {0};
    bool ok;
    if (subtract) {
        temporal_rs_PlainTime_subtract_result result =
            temporal_rs_PlainTime_subtract(object->handle, duration);
        ok = result.is_ok;
        if (ok) handle = result.ok; else error = result.err;
    } else {
        temporal_rs_PlainTime_add_result result =
            temporal_rs_PlainTime_add(object->handle, duration);
        ok = result.is_ok;
        if (ok) handle = result.ok; else error = result.err;
    }
    temporal_rs_Duration_destroy(duration);
    return ok ? plain_time_wrap_intrinsic(vm, handle) : temporal_throw(vm, error);
}

static MalValue plain_time_add(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    return plain_time_add_or_subtract(vm, this_value, args, arg_count, false);
}

static MalValue plain_time_subtract(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    return plain_time_add_or_subtract(vm, this_value, args, arg_count, true);
}

static MalValue plain_time_equals(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    PlainTime *other = plain_time_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), mal_value_new_undefined());
    if (other == nullptr) return mal_value_new_undefined();
    bool equal = temporal_rs_PlainTime_equals(object->handle, other);
    temporal_rs_PlainTime_destroy(other);
    return mal_value_new_boolean(equal);
}

static MalValue plain_time_with(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    MalValue fields_value = arg_count > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_object(fields_value) || mal_value_is_temporal_object(fields_value)) {
        return temporal_throw_type(vm, "Temporal.PlainTime.with requires a property bag");
    }
    MalValue rejected;
    if (!mal_vm_get_property(
            vm, fields_value, mal_intrinsic_string_key(vm, "calendar"), &rejected)) {
        return mal_value_new_undefined();
    }
    if (!mal_value_is_undefined(rejected)) {
        return temporal_throw_type(vm, "Temporal.PlainTime.with rejects calendar");
    }
    if (!mal_vm_get_property(
            vm, fields_value, mal_intrinsic_string_key(vm, "timeZone"), &rejected)) {
        return mal_value_new_undefined();
    }
    if (!mal_value_is_undefined(rejected)) {
        return temporal_throw_type(vm, "Temporal.PlainTime.with rejects timeZone");
    }
    PlainTimeFields fields;
    if (!plain_time_read_fields(vm, fields_value, &fields, true)) {
        return mal_value_new_undefined();
    }
    ArithmeticOverflow overflow;
    if (!temporal_overflow_option(
            vm, arg_count > 1 ? args[1] : mal_value_new_undefined(), &overflow)) {
        return mal_value_new_undefined();
    }
    PartialTime partial;
    if (!plain_time_partial(vm, &fields, overflow, &partial)) {
        return mal_value_new_undefined();
    }
    temporal_rs_PlainTime_with_result result = temporal_rs_PlainTime_with(
        object->handle, partial,
        (ArithmeticOverflow_option) {.ok = overflow, .is_ok = true});
    return result.is_ok ? plain_time_wrap_intrinsic(vm, result.ok)
                        : temporal_throw(vm, result.err);
}

static bool plain_time_rounding_options(
    MalVm *vm, MalValue value, RoundingOptions *options
) {
    *options = (RoundingOptions) {0};
    if (mal_value_is_string(value)) {
        Unit unit;
        if (!temporal_unit_from_string(vm, mal_value_to_string(value), false, &unit)) {
            return false;
        }
        options->smallest_unit = (Unit_option) {.ok = unit, .is_ok = true};
        options->rounding_mode = (RoundingMode_option) {
            .ok = RoundingMode_HalfExpand, .is_ok = true};
        options->increment = (OptionU32) {.ok = 1, .is_ok = true};
        return true;
    }
    bool present;
    if (!temporal_options_object(vm, value, &present)) return false;
    if (!present) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Temporal.PlainTime.round requires an argument");
        return false;
    }
    u32 increment;
    RoundingMode mode;
    Unit smallest;
    if (!temporal_get_rounding_increment(vm, value, &increment) ||
        !temporal_get_rounding_mode(vm, value, RoundingMode_HalfExpand, &mode) ||
        !temporal_get_unit_option(
            vm, value, "smallestUnit", false, true, Unit_Auto, &smallest)) {
        return false;
    }
    options->smallest_unit = (Unit_option) {.ok = smallest, .is_ok = true};
    options->rounding_mode = (RoundingMode_option) {.ok = mode, .is_ok = true};
    options->increment = (OptionU32) {.ok = increment, .is_ok = true};
    return true;
}

static MalValue plain_time_round(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    RoundingOptions options;
    if (!plain_time_rounding_options(
            vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), &options)) {
        return mal_value_new_undefined();
    }
    temporal_rs_PlainTime_round_result result =
        temporal_rs_PlainTime_round(object->handle, options);
    return result.is_ok ? plain_time_wrap_intrinsic(vm, result.ok)
                        : temporal_throw(vm, result.err);
}

static bool plain_time_difference_settings(
    MalVm *vm, MalValue value, DifferenceSettings *settings
) {
    *settings = (DifferenceSettings) {0};
    bool present;
    if (!temporal_options_object(vm, value, &present)) return false;
    Unit largest = Unit_Hour;
    Unit smallest = Unit_Nanosecond;
    RoundingMode mode = RoundingMode_Trunc;
    u32 increment = 1;
    if (present &&
        (!temporal_get_unit_option(
             vm, value, "largestUnit", true, false, Unit_Auto, &largest) ||
         !temporal_get_rounding_increment(vm, value, &increment) ||
         !temporal_get_rounding_mode(vm, value, RoundingMode_Trunc, &mode) ||
         !temporal_get_unit_option(
             vm, value, "smallestUnit", false, false, Unit_Nanosecond, &smallest))) {
        return false;
    }
    if (largest == Unit_Auto) largest = Unit_Hour;
    settings->largest_unit = (Unit_option) {.ok = largest, .is_ok = true};
    settings->smallest_unit = (Unit_option) {.ok = smallest, .is_ok = true};
    settings->rounding_mode = (RoundingMode_option) {.ok = mode, .is_ok = true};
    settings->increment = (OptionU32) {.ok = increment, .is_ok = true};
    return true;
}

static MalValue plain_time_difference(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, bool since
) {
    MalTemporalObject *object;
    if (!plain_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    PlainTime *other = plain_time_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), mal_value_new_undefined());
    if (other == nullptr) return mal_value_new_undefined();
    DifferenceSettings settings;
    if (!plain_time_difference_settings(
            vm, arg_count > 1 ? args[1] : mal_value_new_undefined(), &settings)) {
        temporal_rs_PlainTime_destroy(other);
        return mal_value_new_undefined();
    }
    Duration *handle = nullptr;
    TemporalError error = {0};
    bool ok;
    if (since) {
        temporal_rs_PlainTime_since_result result =
            temporal_rs_PlainTime_since(object->handle, other, settings);
        ok = result.is_ok;
        if (ok) handle = result.ok; else error = result.err;
    } else {
        temporal_rs_PlainTime_until_result result =
            temporal_rs_PlainTime_until(object->handle, other, settings);
        ok = result.is_ok;
        if (ok) handle = result.ok; else error = result.err;
    }
    temporal_rs_PlainTime_destroy(other);
    return ok ? duration_wrap_intrinsic(vm, handle) : temporal_throw(vm, error);
}

static MalValue plain_time_since(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    return plain_time_difference(vm, this_value, args, arg_count, true);
}

static MalValue plain_time_until(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    return plain_time_difference(vm, this_value, args, arg_count, false);
}

static MalValue plain_time_to_string_default(MalVm *vm, MalValue this_value) {
    MalTemporalObject *object;
    if (!plain_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    DiplomatWrite *write = diplomat_buffer_write_create(32);
    if (write == nullptr) return temporal_throw_type(vm, "Unable to format Temporal.PlainTime");
    ToStringRoundingOptions options = {
        .precision = {.is_minute = false, .precision = {.is_ok = false}},
        .smallest_unit = {.is_ok = false}, .rounding_mode = {.is_ok = false},
    };
    temporal_rs_PlainTime_to_ixdtf_string_result result =
        temporal_rs_PlainTime_to_ixdtf_string(object->handle, options, write);
    if (!result.is_ok) {
        diplomat_buffer_write_destroy(write);
        return temporal_throw(vm, result.err);
    }
    return temporal_write_to_string(vm, write);
}

static bool temporal_to_string_rounding_options(
    MalVm *vm, MalValue value, ToStringRoundingOptions *options
) {
    *options = (ToStringRoundingOptions) {
        .precision = {.is_minute = false, .precision = {.is_ok = false}},
        .smallest_unit = {.is_ok = false},
        .rounding_mode = {.ok = RoundingMode_Trunc, .is_ok = true},
    };
    bool present;
    if (!temporal_options_object(vm, value, &present)) return false;
    if (!present) return true;

    MalValue digits_value;
    if (!mal_vm_get_property(
            vm, value, mal_intrinsic_string_key(vm, "fractionalSecondDigits"),
            &digits_value)) {
        return false;
    }
    if (!mal_value_is_undefined(digits_value)) {
        if (mal_ops_is_number(digits_value)) {
            f64 digits;
            if (!mal_vm_to_number(vm, digits_value, &digits) || !isfinite(digits)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                                   "Invalid fractionalSecondDigits option");
                return false;
            }
            digits = floor(digits);
            if (digits < 0 || digits > 9) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                                   "Invalid fractionalSecondDigits option");
                return false;
            }
            options->precision.precision =
                (OptionU8) {.ok = (u8) digits, .is_ok = true};
        } else {
            MalString *digits;
            if (!mal_vm_to_string(vm, digits_value, &digits)) return false;
            if (!mal_string_equals_ascii(digits, "auto")) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                                   "Invalid fractionalSecondDigits option");
                return false;
            }
        }
    }

    RoundingMode mode;
    if (!temporal_get_rounding_mode(vm, value, RoundingMode_Trunc, &mode)) {
        return false;
    }
    options->rounding_mode = (RoundingMode_option) {.ok = mode, .is_ok = true};

    MalValue smallest_value;
    if (!mal_vm_get_property(
            vm, value, mal_intrinsic_string_key(vm, "smallestUnit"),
            &smallest_value)) {
        return false;
    }
    if (!mal_value_is_undefined(smallest_value)) {
        MalString *smallest_string;
        if (!mal_vm_to_string(vm, smallest_value, &smallest_string)) return false;
        Unit smallest;
        if (!temporal_unit_from_string(vm, smallest_string, false, &smallest)) {
            return false;
        }
        if (smallest < Unit_Nanosecond || smallest > Unit_Minute) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                               "Invalid smallestUnit for Temporal string");
            return false;
        }
        options->smallest_unit = (Unit_option) {.ok = smallest, .is_ok = true};
        options->precision.is_minute = smallest == Unit_Minute;
        if (!options->precision.is_minute) {
            u8 digits = smallest == Unit_Second ? 0
                : smallest == Unit_Millisecond ? 3
                : smallest == Unit_Microsecond ? 6 : 9;
            options->precision.precision = (OptionU8) {.ok = digits, .is_ok = true};
        }
    }
    return true;
}

static MalValue plain_time_to_string(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    ToStringRoundingOptions options;
    if (!temporal_to_string_rounding_options(
            vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), &options)) {
        return mal_value_new_undefined();
    }
    DiplomatWrite *write = diplomat_buffer_write_create(32);
    if (write == nullptr) return temporal_throw_type(vm, "Unable to format Temporal.PlainTime");
    temporal_rs_PlainTime_to_ixdtf_string_result result =
        temporal_rs_PlainTime_to_ixdtf_string(object->handle, options, write);
    if (!result.is_ok) {
        diplomat_buffer_write_destroy(write);
        return temporal_throw(vm, result.err);
    }
    return temporal_write_to_string(vm, write);
}

static MalValue plain_time_to_string_no_options(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    return plain_time_to_string_default(vm, this_value);
}

static MalValue plain_time_value_of(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) args; (void) arg_count; (void) new_target; (void) callee;
    return temporal_throw_type(vm, "Cannot convert Temporal.PlainTime to a primitive");
}

static bool plain_date_this(MalVm *vm, MalValue value, MalTemporalObject **out) {
    if (!mal_value_is_temporal_object(value)) {
        temporal_throw_type(vm, "Temporal.PlainDate method called on incompatible receiver");
        return false;
    }
    MalTemporalObject *object = mal_value_to_temporal_object(value);
    if (object->kind != MAL_TEMPORAL_PLAIN_DATE || object->handle == nullptr) {
        temporal_throw_type(vm, "Temporal.PlainDate method called on incompatible receiver");
        return false;
    }
    *out = object;
    return true;
}

static MalValue plain_date_wrap(MalVm *vm, PlainDate *handle, MalObject *prototype) {
    return mal_value_from_temporal_object(mal_temporal_object_new(
        &vm->heap, prototype, MAL_TEMPORAL_PLAIN_DATE, handle));
}

static MalValue plain_date_wrap_intrinsic(MalVm *vm, PlainDate *handle) {
    return plain_date_wrap(
        vm, handle,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_DATE_PROTOTYPE]));
}

static MalValue plain_date_constructor(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) callee;
    if (mal_value_is_undefined(new_target)) {
        return temporal_throw_type(vm, "Temporal.PlainDate must be called with new");
    }
    i32 year;
    u16 month, day;
    if (!temporal_i32_integer(
            vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), &year) ||
        !temporal_u16_integer(
            vm, arg_count > 1 ? args[1] : mal_value_new_undefined(), UINT8_MAX, &month) ||
        !temporal_u16_integer(
            vm, arg_count > 2 ? args[2] : mal_value_new_undefined(), UINT8_MAX, &day)) {
        return mal_value_new_undefined();
    }
    AnyCalendarKind calendar;
    if (!temporal_calendar_kind(
            vm, arg_count > 3 ? args[3] : mal_value_new_undefined(), &calendar)) {
        return mal_value_new_undefined();
    }
    temporal_rs_PlainDate_try_new_result result =
        temporal_rs_PlainDate_try_new(year, (u8) month, (u8) day, calendar);
    if (!result.is_ok) return temporal_throw(vm, result.err);
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, new_target, MAL_INTRINSIC_TEMPORAL_PLAIN_DATE_PROTOTYPE, &prototype)) {
        temporal_rs_PlainDate_destroy(result.ok);
        return mal_value_new_undefined();
    }
    return plain_date_wrap(vm, result.ok, prototype);
}

typedef struct PlainDatePartial {
    PartialDate partial;
    byte *month_code;
    byte *era;
} PlainDatePartial;

static void plain_date_partial_destroy(PlainDatePartial *fields) {
    free(fields->month_code);
    free(fields->era);
}

static bool plain_date_partial_from_object_impl(
    MalVm *vm, MalValue input, PlainDatePartial *fields, bool require_field
) {
    *fields = (PlainDatePartial) {0};
    fields->partial.calendar = AnyCalendarKind_Iso;
    MalValue value;
    if (!mal_vm_get_property(
            vm, input, mal_intrinsic_string_key(vm, "calendar"), &value) ||
        !temporal_calendar_string(vm, value, &fields->partial.calendar)) {
        return false;
    }
    const byte *names[] = {"day", "era", "eraYear", "month", "monthCode", "year"};
    bool any = false;
    for (usize i = 0; i < countof(names); ++i) {
        if (!mal_vm_get_property(vm, input, mal_intrinsic_string_key(vm, names[i]), &value)) {
            plain_date_partial_destroy(fields);
            return false;
        }
        if (mal_value_is_undefined(value)) continue;
        any = true;
        if (i == 1 || i == 4) {
            MalString *string;
            if (!mal_vm_to_string(vm, value, &string)) {
                plain_date_partial_destroy(fields);
                return false;
            }
            usize length;
            byte *utf8 = mal_string_to_utf8(string, &length);
            if (utf8 == nullptr) {
                plain_date_partial_destroy(fields);
                return temporal_throw_type(vm, "Unable to encode Temporal field"), false;
            }
            if (i == 1) {
                fields->era = utf8;
                fields->partial.era =
                    (DiplomatStringView) {.data = (const char *) utf8, .len = length};
            } else {
                fields->month_code = utf8;
                fields->partial.month_code =
                    (DiplomatStringView) {.data = (const char *) utf8, .len = length};
            }
        } else if (i == 0 || i == 3) {
            u16 number;
            if (!temporal_u16_integer(vm, value, UINT8_MAX, &number)) {
                plain_date_partial_destroy(fields);
                return false;
            }
            OptionU8 option = {.ok = (u8) number, .is_ok = true};
            if (i == 0) fields->partial.day = option;
            else fields->partial.month = option;
        } else {
            i32 number;
            if (!temporal_i32_integer(vm, value, &number)) {
                plain_date_partial_destroy(fields);
                return false;
            }
            OptionI32 option = {.ok = number, .is_ok = true};
            if (i == 2) fields->partial.era_year = option;
            else fields->partial.year = option;
        }
    }
    if (require_field && !any) {
        plain_date_partial_destroy(fields);
        temporal_throw_type(vm, "Temporal.PlainDate property bag has no date fields");
        return false;
    }
    return true;
}

static bool plain_date_partial_from_object(
    MalVm *vm, MalValue input, PlainDatePartial *fields
) {
    return plain_date_partial_from_object_impl(vm, input, fields, true);
}

static PlainDate *plain_date_from_like(
    MalVm *vm, MalValue input, MalValue options
) {
    if (mal_value_is_temporal_object(input)) {
        MalTemporalObject *object = mal_value_to_temporal_object(input);
        if (object->kind == MAL_TEMPORAL_PLAIN_DATE && object->handle != nullptr) {
            ArithmeticOverflow overflow;
            if (!temporal_overflow_option(vm, options, &overflow)) return nullptr;
            return temporal_rs_PlainDate_clone(object->handle);
        }
        if (object->kind == MAL_TEMPORAL_PLAIN_DATE_TIME && object->handle != nullptr) {
            ArithmeticOverflow overflow;
            if (!temporal_overflow_option(vm, options, &overflow)) return nullptr;
            return temporal_rs_PlainDateTime_to_plain_date(object->handle);
        }
        if (object->kind == MAL_TEMPORAL_ZONED_DATE_TIME && object->handle != nullptr) {
            ArithmeticOverflow overflow;
            if (!temporal_overflow_option(vm, options, &overflow)) return nullptr;
            return temporal_rs_ZonedDateTime_to_plain_date(object->handle);
        }
    }
    if (mal_value_is_string(input)) {
        MalString *string = mal_value_to_string(input);
        DiplomatString16View view = {
            .data = (const char16_t *) mal_string_code_units(string),
            .len = mal_string_length(string),
        };
        temporal_rs_PlainDate_from_utf16_result result =
            temporal_rs_PlainDate_from_utf16(view);
        if (!result.is_ok) {
            temporal_throw(vm, result.err);
            return nullptr;
        }
        ArithmeticOverflow overflow;
        if (!temporal_overflow_option(vm, options, &overflow)) {
            temporal_rs_PlainDate_destroy(result.ok);
            return nullptr;
        }
        return result.ok;
    }
    if (!mal_value_is_object(input)) {
        temporal_throw_type(vm, "Temporal.PlainDate.from requires a string or object");
        return nullptr;
    }
    PlainDatePartial fields;
    if (!plain_date_partial_from_object(vm, input, &fields)) return nullptr;
    ArithmeticOverflow overflow;
    if (!temporal_overflow_option(vm, options, &overflow)) {
        plain_date_partial_destroy(&fields);
        return nullptr;
    }
    temporal_rs_PlainDate_from_partial_result result =
        temporal_rs_PlainDate_from_partial(
            fields.partial,
            (ArithmeticOverflow_option) {.ok = overflow, .is_ok = true});
    plain_date_partial_destroy(&fields);
    if (!result.is_ok) {
        temporal_throw(vm, result.err);
        return nullptr;
    }
    return result.ok;
}

static MalValue plain_date_from(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) new_target; (void) callee;
    PlainDate *handle = plain_date_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined(),
        arg_count > 1 ? args[1] : mal_value_new_undefined());
    return handle == nullptr ? mal_value_new_undefined() : plain_date_wrap_intrinsic(vm, handle);
}

static MalValue plain_date_compare(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) new_target; (void) callee;
    PlainDate *one = plain_date_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), mal_value_new_undefined());
    if (one == nullptr) return mal_value_new_undefined();
    PlainDate *two = plain_date_from_like(
        vm, arg_count > 1 ? args[1] : mal_value_new_undefined(), mal_value_new_undefined());
    if (two == nullptr) {
        temporal_rs_PlainDate_destroy(one);
        return mal_value_new_undefined();
    }
    i8 comparison = temporal_rs_PlainDate_compare(one, two);
    temporal_rs_PlainDate_destroy(one);
    temporal_rs_PlainDate_destroy(two);
    return mal_value_from_i32(comparison);
}

#define PLAIN_DATE_GETTER(c_name, ffi_name) \
    static MalValue c_name(MalVm *vm, MalValue this_value, const MalValue *args, \
                           i32 arg_count, MalValue new_target, MalValue callee) { \
        (void) args; (void) arg_count; (void) new_target; (void) callee; \
        MalTemporalObject *object; \
        if (!plain_date_this(vm, this_value, &object)) return mal_value_new_undefined(); \
        return mal_value_from_i32((i32) ffi_name(object->handle)); \
    }

PLAIN_DATE_GETTER(plain_date_year, temporal_rs_PlainDate_year)
PLAIN_DATE_GETTER(plain_date_month, temporal_rs_PlainDate_month)
PLAIN_DATE_GETTER(plain_date_day, temporal_rs_PlainDate_day)
PLAIN_DATE_GETTER(plain_date_day_of_week, temporal_rs_PlainDate_day_of_week)
PLAIN_DATE_GETTER(plain_date_day_of_year, temporal_rs_PlainDate_day_of_year)
PLAIN_DATE_GETTER(plain_date_days_in_week, temporal_rs_PlainDate_days_in_week)
PLAIN_DATE_GETTER(plain_date_days_in_month, temporal_rs_PlainDate_days_in_month)
PLAIN_DATE_GETTER(plain_date_days_in_year, temporal_rs_PlainDate_days_in_year)
PLAIN_DATE_GETTER(plain_date_months_in_year, temporal_rs_PlainDate_months_in_year)

static MalValue plain_date_calendar_id(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_date_this(vm, this_value, &object)) return mal_value_new_undefined();
    return temporal_calendar_identifier(
        vm, temporal_rs_PlainDate_calendar(object->handle));
}

static MalValue plain_date_month_code(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_date_this(vm, this_value, &object)) return mal_value_new_undefined();
    DiplomatWrite *write = diplomat_buffer_write_create(8);
    temporal_rs_PlainDate_month_code(object->handle, write);
    return temporal_write_to_string(vm, write);
}

static MalValue plain_date_in_leap_year(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_date_this(vm, this_value, &object)) return mal_value_new_undefined();
    return mal_value_new_boolean(temporal_rs_PlainDate_in_leap_year(object->handle));
}

static MalValue plain_date_era(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_date_this(vm, this_value, &object)) return mal_value_new_undefined();
    DiplomatWrite *write = diplomat_buffer_write_create(16);
    temporal_rs_PlainDate_era(object->handle, write);
    if (diplomat_buffer_write_len(write) == 0) {
        diplomat_buffer_write_destroy(write);
        return mal_value_new_undefined();
    }
    return temporal_write_to_string(vm, write);
}

static MalValue plain_date_era_year(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_date_this(vm, this_value, &object)) return mal_value_new_undefined();
    temporal_rs_PlainDate_era_year_result result =
        temporal_rs_PlainDate_era_year(object->handle);
    return result.is_ok ? mal_value_from_i32(result.ok) : mal_value_new_undefined();
}

static MalValue plain_date_optional_week(
    MalVm *vm, MalValue this_value, bool year
) {
    MalTemporalObject *object;
    if (!plain_date_this(vm, this_value, &object)) return mal_value_new_undefined();
    if (year) {
        temporal_rs_PlainDate_year_of_week_result result =
            temporal_rs_PlainDate_year_of_week(object->handle);
        return result.is_ok ? mal_value_from_i32(result.ok) : mal_value_new_undefined();
    }
    temporal_rs_PlainDate_week_of_year_result result =
        temporal_rs_PlainDate_week_of_year(object->handle);
    return result.is_ok ? mal_value_from_i32(result.ok) : mal_value_new_undefined();
}

static MalValue plain_date_week_of_year(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    return plain_date_optional_week(vm, this_value, false);
}

static MalValue plain_date_year_of_week(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    return plain_date_optional_week(vm, this_value, true);
}

static MalValue plain_date_add_or_subtract(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, bool subtract
) {
    MalTemporalObject *object;
    if (!plain_date_this(vm, this_value, &object)) return mal_value_new_undefined();
    Duration *duration = duration_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined());
    if (duration == nullptr) return mal_value_new_undefined();
    ArithmeticOverflow overflow;
    if (!temporal_overflow_option(
            vm, arg_count > 1 ? args[1] : mal_value_new_undefined(), &overflow)) {
        temporal_rs_Duration_destroy(duration);
        return mal_value_new_undefined();
    }
    PlainDate *handle = nullptr;
    TemporalError error = {0};
    bool ok;
    ArithmeticOverflow_option option = {.ok = overflow, .is_ok = true};
    if (subtract) {
        temporal_rs_PlainDate_subtract_result result =
            temporal_rs_PlainDate_subtract(object->handle, duration, option);
        ok = result.is_ok; if (ok) handle = result.ok; else error = result.err;
    } else {
        temporal_rs_PlainDate_add_result result =
            temporal_rs_PlainDate_add(object->handle, duration, option);
        ok = result.is_ok; if (ok) handle = result.ok; else error = result.err;
    }
    temporal_rs_Duration_destroy(duration);
    return ok ? plain_date_wrap_intrinsic(vm, handle) : temporal_throw(vm, error);
}

static MalValue plain_date_add(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    return plain_date_add_or_subtract(vm, this_value, args, arg_count, false);
}

static MalValue plain_date_subtract(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    return plain_date_add_or_subtract(vm, this_value, args, arg_count, true);
}

static MalValue plain_date_equals(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_date_this(vm, this_value, &object)) return mal_value_new_undefined();
    PlainDate *other = plain_date_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), mal_value_new_undefined());
    if (other == nullptr) return mal_value_new_undefined();
    bool equal = temporal_rs_PlainDate_equals(object->handle, other);
    temporal_rs_PlainDate_destroy(other);
    return mal_value_new_boolean(equal);
}

static bool plain_date_difference_settings(
    MalVm *vm, MalValue value, DifferenceSettings *settings
) {
    *settings = (DifferenceSettings) {0};
    bool present;
    if (!temporal_options_object(vm, value, &present)) return false;
    Unit largest = Unit_Day;
    Unit smallest = Unit_Day;
    RoundingMode mode = RoundingMode_Trunc;
    u32 increment = 1;
    if (present &&
        (!temporal_get_unit_option(
             vm, value, "largestUnit", true, false, Unit_Auto, &largest) ||
         !temporal_get_rounding_increment(vm, value, &increment) ||
         !temporal_get_rounding_mode(vm, value, RoundingMode_Trunc, &mode) ||
         !temporal_get_unit_option(
             vm, value, "smallestUnit", false, false, Unit_Day, &smallest))) {
        return false;
    }
    if (largest == Unit_Auto) largest = Unit_Day;
    settings->largest_unit = (Unit_option) {.ok = largest, .is_ok = true};
    settings->smallest_unit = (Unit_option) {.ok = smallest, .is_ok = true};
    settings->rounding_mode = (RoundingMode_option) {.ok = mode, .is_ok = true};
    settings->increment = (OptionU32) {.ok = increment, .is_ok = true};
    return true;
}

static MalValue plain_date_difference(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, bool since
) {
    MalTemporalObject *object;
    if (!plain_date_this(vm, this_value, &object)) return mal_value_new_undefined();
    PlainDate *other = plain_date_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), mal_value_new_undefined());
    if (other == nullptr) return mal_value_new_undefined();
    DifferenceSettings settings;
    if (!plain_date_difference_settings(
            vm, arg_count > 1 ? args[1] : mal_value_new_undefined(), &settings)) {
        temporal_rs_PlainDate_destroy(other);
        return mal_value_new_undefined();
    }
    Duration *handle = nullptr;
    TemporalError error = {0};
    bool ok;
    if (since) {
        temporal_rs_PlainDate_since_result result =
            temporal_rs_PlainDate_since(object->handle, other, settings);
        ok = result.is_ok; if (ok) handle = result.ok; else error = result.err;
    } else {
        temporal_rs_PlainDate_until_result result =
            temporal_rs_PlainDate_until(object->handle, other, settings);
        ok = result.is_ok; if (ok) handle = result.ok; else error = result.err;
    }
    temporal_rs_PlainDate_destroy(other);
    return ok ? duration_wrap_intrinsic(vm, handle) : temporal_throw(vm, error);
}

static MalValue plain_date_since(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    return plain_date_difference(vm, this_value, args, arg_count, true);
}

static MalValue plain_date_until(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    return plain_date_difference(vm, this_value, args, arg_count, false);
}

static MalValue plain_date_with(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_date_this(vm, this_value, &object)) return mal_value_new_undefined();
    MalValue fields_value = arg_count > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_object(fields_value) || mal_value_is_temporal_object(fields_value)) {
        return temporal_throw_type(vm, "Temporal.PlainDate.with requires a property bag");
    }
    PlainDatePartial fields;
    if (!plain_date_partial_from_object(vm, fields_value, &fields)) {
        return mal_value_new_undefined();
    }
    ArithmeticOverflow overflow;
    if (!temporal_overflow_option(
            vm, arg_count > 1 ? args[1] : mal_value_new_undefined(), &overflow)) {
        plain_date_partial_destroy(&fields);
        return mal_value_new_undefined();
    }
    temporal_rs_PlainDate_with_result result = temporal_rs_PlainDate_with(
        object->handle, fields.partial,
        (ArithmeticOverflow_option) {.ok = overflow, .is_ok = true});
    plain_date_partial_destroy(&fields);
    return result.is_ok ? plain_date_wrap_intrinsic(vm, result.ok)
                        : temporal_throw(vm, result.err);
}

static MalValue plain_date_with_calendar(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_date_this(vm, this_value, &object)) return mal_value_new_undefined();
    AnyCalendarKind calendar;
    if (!temporal_calendar_kind(
            vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), &calendar)) {
        return mal_value_new_undefined();
    }
    return plain_date_wrap_intrinsic(
        vm, temporal_rs_PlainDate_with_calendar(object->handle, calendar));
}

static MalValue plain_date_to_plain_date_time(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_date_this(vm, this_value, &object)) return mal_value_new_undefined();
    PlainTime *time = nullptr;
    if (arg_count > 0 && !mal_value_is_undefined(args[0])) {
        time = plain_time_from_like(vm, args[0], mal_value_new_undefined());
        if (time == nullptr) return mal_value_new_undefined();
    }
    temporal_rs_PlainDate_to_plain_date_time_result result =
        temporal_rs_PlainDate_to_plain_date_time(object->handle, time);
    if (time != nullptr) temporal_rs_PlainTime_destroy(time);
    return result.is_ok ? plain_date_time_wrap_intrinsic(vm, result.ok)
                        : temporal_throw(vm, result.err);
}

static MalValue plain_date_to_plain_month_day(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_date_this(vm, this_value, &object)) return mal_value_new_undefined();
    temporal_rs_PlainDate_to_plain_month_day_result result =
        temporal_rs_PlainDate_to_plain_month_day(object->handle);
    return result.is_ok ? plain_month_day_wrap_intrinsic(vm, result.ok)
                        : temporal_throw(vm, result.err);
}

static MalValue plain_date_to_plain_year_month(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_date_this(vm, this_value, &object)) return mal_value_new_undefined();
    temporal_rs_PlainDate_to_plain_year_month_result result =
        temporal_rs_PlainDate_to_plain_year_month(object->handle);
    return result.is_ok ? plain_year_month_wrap_intrinsic(vm, result.ok)
                        : temporal_throw(vm, result.err);
}

static MalValue plain_date_to_string_impl(
    MalVm *vm, MalValue this_value, MalValue options, bool read_options
) {
    MalTemporalObject *object;
    if (!plain_date_this(vm, this_value, &object)) return mal_value_new_undefined();
    DisplayCalendar display = DisplayCalendar_Auto;
    if (read_options && !temporal_display_calendar(vm, options, &display)) {
        return mal_value_new_undefined();
    }
    DiplomatWrite *write = diplomat_buffer_write_create(32);
    temporal_rs_PlainDate_to_ixdtf_string(object->handle, display, write);
    return temporal_write_to_string(vm, write);
}

static MalValue plain_date_to_string(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    return plain_date_to_string_impl(
        vm, this_value, arg_count > 0 ? args[0] : mal_value_new_undefined(), true);
}

static MalValue plain_date_to_string_no_options(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    return plain_date_to_string_impl(vm, this_value, mal_value_new_undefined(), false);
}

static MalValue plain_date_value_of(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) args; (void) arg_count; (void) new_target; (void) callee;
    return temporal_throw_type(vm, "Cannot convert Temporal.PlainDate to a primitive");
}

static bool plain_date_time_this(MalVm *vm, MalValue value, MalTemporalObject **out) {
    if (!mal_value_is_temporal_object(value)) {
        temporal_throw_type(vm, "Temporal.PlainDateTime method called on incompatible receiver");
        return false;
    }
    MalTemporalObject *object = mal_value_to_temporal_object(value);
    if (object->kind != MAL_TEMPORAL_PLAIN_DATE_TIME || object->handle == nullptr) {
        temporal_throw_type(vm, "Temporal.PlainDateTime method called on incompatible receiver");
        return false;
    }
    *out = object;
    return true;
}

static MalValue plain_date_time_wrap(
    MalVm *vm, PlainDateTime *handle, MalObject *prototype
) {
    return mal_value_from_temporal_object(mal_temporal_object_new(
        &vm->heap, prototype, MAL_TEMPORAL_PLAIN_DATE_TIME, handle));
}

static MalValue plain_date_time_wrap_intrinsic(MalVm *vm, PlainDateTime *handle) {
    return plain_date_time_wrap(
        vm, handle,
        mal_value_to_object(
            vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_DATE_TIME_PROTOTYPE]));
}

static MalValue plain_date_time_constructor(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) callee;
    if (mal_value_is_undefined(new_target)) {
        return temporal_throw_type(vm, "Temporal.PlainDateTime must be called with new");
    }
    i32 year;
    u16 values[8] = {0};
    const u16 maxima[8] = {UINT8_MAX, UINT8_MAX, UINT8_MAX, UINT8_MAX,
                           UINT8_MAX, UINT16_MAX, UINT16_MAX, UINT16_MAX};
    if (!temporal_i32_integer(
            vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), &year)) {
        return mal_value_new_undefined();
    }
    for (i32 i = 0; i < 8; ++i) {
        MalValue value = i + 1 < arg_count ? args[i + 1] : mal_value_new_undefined();
        if (!temporal_u16_integer(vm, value, maxima[i], &values[i])) {
            return mal_value_new_undefined();
        }
    }
    AnyCalendarKind calendar;
    if (!temporal_calendar_kind(
            vm, arg_count > 9 ? args[9] : mal_value_new_undefined(), &calendar)) {
        return mal_value_new_undefined();
    }
    temporal_rs_PlainDateTime_try_new_result result =
        temporal_rs_PlainDateTime_try_new(
            year, (u8) values[0], (u8) values[1], (u8) values[2],
            (u8) values[3], (u8) values[4], values[5], values[6], values[7], calendar);
    if (!result.is_ok) return temporal_throw(vm, result.err);
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, new_target, MAL_INTRINSIC_TEMPORAL_PLAIN_DATE_TIME_PROTOTYPE,
            &prototype)) {
        temporal_rs_PlainDateTime_destroy(result.ok);
        return mal_value_new_undefined();
    }
    return plain_date_time_wrap(vm, result.ok, prototype);
}

static PlainDateTime *plain_date_time_from_like(
    MalVm *vm, MalValue input, MalValue options
) {
    if (mal_value_is_temporal_object(input)) {
        MalTemporalObject *object = mal_value_to_temporal_object(input);
        if (object->kind == MAL_TEMPORAL_PLAIN_DATE_TIME && object->handle != nullptr) {
            ArithmeticOverflow overflow;
            if (!temporal_overflow_option(vm, options, &overflow)) return nullptr;
            return temporal_rs_PlainDateTime_clone(object->handle);
        }
        if (object->kind == MAL_TEMPORAL_PLAIN_DATE && object->handle != nullptr) {
            ArithmeticOverflow overflow;
            if (!temporal_overflow_option(vm, options, &overflow)) return nullptr;
            temporal_rs_PlainDate_to_plain_date_time_result result =
                temporal_rs_PlainDate_to_plain_date_time(object->handle, nullptr);
            if (!result.is_ok) {
                temporal_throw(vm, result.err);
                return nullptr;
            }
            return result.ok;
        }
        if (object->kind == MAL_TEMPORAL_ZONED_DATE_TIME && object->handle != nullptr) {
            ArithmeticOverflow overflow;
            if (!temporal_overflow_option(vm, options, &overflow)) return nullptr;
            return temporal_rs_ZonedDateTime_to_plain_datetime(object->handle);
        }
    }
    if (mal_value_is_string(input)) {
        MalString *string = mal_value_to_string(input);
        DiplomatString16View view = {
            .data = (const char16_t *) mal_string_code_units(string),
            .len = mal_string_length(string),
        };
        temporal_rs_PlainDateTime_from_utf16_result result =
            temporal_rs_PlainDateTime_from_utf16(view);
        if (!result.is_ok) {
            temporal_throw(vm, result.err);
            return nullptr;
        }
        ArithmeticOverflow overflow;
        if (!temporal_overflow_option(vm, options, &overflow)) {
            temporal_rs_PlainDateTime_destroy(result.ok);
            return nullptr;
        }
        return result.ok;
    }
    if (!mal_value_is_object(input)) {
        temporal_throw_type(vm, "Temporal.PlainDateTime.from requires a string or object");
        return nullptr;
    }
    PlainDatePartial date;
    if (!plain_date_partial_from_object(vm, input, &date)) return nullptr;
    PlainTimeFields time_fields;
    if (!plain_time_read_fields(vm, input, &time_fields, false)) {
        plain_date_partial_destroy(&date);
        return nullptr;
    }
    ArithmeticOverflow overflow;
    if (!temporal_overflow_option(vm, options, &overflow)) {
        plain_date_partial_destroy(&date);
        return nullptr;
    }
    PartialTime time;
    if (!plain_time_partial(vm, &time_fields, overflow, &time)) {
        plain_date_partial_destroy(&date);
        return nullptr;
    }
    PartialDateTime partial = {.date = date.partial, .time = time};
    temporal_rs_PlainDateTime_from_partial_result result =
        temporal_rs_PlainDateTime_from_partial(
            partial, (ArithmeticOverflow_option) {.ok = overflow, .is_ok = true});
    plain_date_partial_destroy(&date);
    if (!result.is_ok) {
        temporal_throw(vm, result.err);
        return nullptr;
    }
    return result.ok;
}

static MalValue plain_date_time_from(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) new_target; (void) callee;
    PlainDateTime *handle = plain_date_time_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined(),
        arg_count > 1 ? args[1] : mal_value_new_undefined());
    return handle == nullptr ? mal_value_new_undefined()
                             : plain_date_time_wrap_intrinsic(vm, handle);
}

static MalValue plain_date_time_compare(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) new_target; (void) callee;
    PlainDateTime *one = plain_date_time_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), mal_value_new_undefined());
    if (one == nullptr) return mal_value_new_undefined();
    PlainDateTime *two = plain_date_time_from_like(
        vm, arg_count > 1 ? args[1] : mal_value_new_undefined(), mal_value_new_undefined());
    if (two == nullptr) {
        temporal_rs_PlainDateTime_destroy(one);
        return mal_value_new_undefined();
    }
    i8 comparison = temporal_rs_PlainDateTime_compare(one, two);
    temporal_rs_PlainDateTime_destroy(one);
    temporal_rs_PlainDateTime_destroy(two);
    return mal_value_from_i32(comparison);
}

#define PLAIN_DATE_TIME_GETTER(c_name, ffi_name) \
    static MalValue c_name(MalVm *vm, MalValue this_value, const MalValue *args, \
                           i32 arg_count, MalValue new_target, MalValue callee) { \
        (void) args; (void) arg_count; (void) new_target; (void) callee; \
        MalTemporalObject *object; \
        if (!plain_date_time_this(vm, this_value, &object)) return mal_value_new_undefined(); \
        return mal_value_from_i32((i32) ffi_name(object->handle)); \
    }

PLAIN_DATE_TIME_GETTER(plain_date_time_year, temporal_rs_PlainDateTime_year)
PLAIN_DATE_TIME_GETTER(plain_date_time_month, temporal_rs_PlainDateTime_month)
PLAIN_DATE_TIME_GETTER(plain_date_time_day, temporal_rs_PlainDateTime_day)
PLAIN_DATE_TIME_GETTER(plain_date_time_hour, temporal_rs_PlainDateTime_hour)
PLAIN_DATE_TIME_GETTER(plain_date_time_minute, temporal_rs_PlainDateTime_minute)
PLAIN_DATE_TIME_GETTER(plain_date_time_second, temporal_rs_PlainDateTime_second)
PLAIN_DATE_TIME_GETTER(plain_date_time_millisecond, temporal_rs_PlainDateTime_millisecond)
PLAIN_DATE_TIME_GETTER(plain_date_time_microsecond, temporal_rs_PlainDateTime_microsecond)
PLAIN_DATE_TIME_GETTER(plain_date_time_nanosecond, temporal_rs_PlainDateTime_nanosecond)
PLAIN_DATE_TIME_GETTER(plain_date_time_day_of_week, temporal_rs_PlainDateTime_day_of_week)
PLAIN_DATE_TIME_GETTER(plain_date_time_day_of_year, temporal_rs_PlainDateTime_day_of_year)
PLAIN_DATE_TIME_GETTER(plain_date_time_days_in_week, temporal_rs_PlainDateTime_days_in_week)
PLAIN_DATE_TIME_GETTER(plain_date_time_days_in_month, temporal_rs_PlainDateTime_days_in_month)
PLAIN_DATE_TIME_GETTER(plain_date_time_days_in_year, temporal_rs_PlainDateTime_days_in_year)
PLAIN_DATE_TIME_GETTER(plain_date_time_months_in_year, temporal_rs_PlainDateTime_months_in_year)

static MalValue plain_date_time_calendar_id(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    return temporal_calendar_identifier(
        vm, temporal_rs_PlainDateTime_calendar(object->handle));
}

static MalValue plain_date_time_month_code(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    DiplomatWrite *write = diplomat_buffer_write_create(8);
    temporal_rs_PlainDateTime_month_code(object->handle, write);
    return temporal_write_to_string(vm, write);
}

static MalValue plain_date_time_in_leap_year(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    return mal_value_new_boolean(
        temporal_rs_PlainDateTime_in_leap_year(object->handle));
}

static MalValue plain_date_time_week_of_year(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    temporal_rs_PlainDateTime_week_of_year_result result =
        temporal_rs_PlainDateTime_week_of_year(object->handle);
    return result.is_ok ? mal_value_from_i32(result.ok) : mal_value_new_undefined();
}

static MalValue plain_date_time_year_of_week(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    temporal_rs_PlainDateTime_year_of_week_result result =
        temporal_rs_PlainDateTime_year_of_week(object->handle);
    return result.is_ok ? mal_value_from_i32(result.ok) : mal_value_new_undefined();
}

static MalValue plain_date_time_era(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    DiplomatWrite *write = diplomat_buffer_write_create(16);
    temporal_rs_PlainDateTime_era(object->handle, write);
    if (diplomat_buffer_write_len(write) == 0) {
        diplomat_buffer_write_destroy(write);
        return mal_value_new_undefined();
    }
    return temporal_write_to_string(vm, write);
}

static MalValue plain_date_time_era_year(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    temporal_rs_PlainDateTime_era_year_result result =
        temporal_rs_PlainDateTime_era_year(object->handle);
    return result.is_ok ? mal_value_from_i32(result.ok) : mal_value_new_undefined();
}

static MalValue plain_date_time_add_or_subtract(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, bool subtract
) {
    MalTemporalObject *object;
    if (!plain_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    Duration *duration = duration_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined());
    if (duration == nullptr) return mal_value_new_undefined();
    ArithmeticOverflow overflow;
    if (!temporal_overflow_option(
            vm, arg_count > 1 ? args[1] : mal_value_new_undefined(), &overflow)) {
        temporal_rs_Duration_destroy(duration);
        return mal_value_new_undefined();
    }
    PlainDateTime *handle = nullptr;
    TemporalError error = {0};
    bool ok;
    ArithmeticOverflow_option option = {.ok = overflow, .is_ok = true};
    if (subtract) {
        temporal_rs_PlainDateTime_subtract_result result =
            temporal_rs_PlainDateTime_subtract(object->handle, duration, option);
        ok = result.is_ok; if (ok) handle = result.ok; else error = result.err;
    } else {
        temporal_rs_PlainDateTime_add_result result =
            temporal_rs_PlainDateTime_add(object->handle, duration, option);
        ok = result.is_ok; if (ok) handle = result.ok; else error = result.err;
    }
    temporal_rs_Duration_destroy(duration);
    return ok ? plain_date_time_wrap_intrinsic(vm, handle) : temporal_throw(vm, error);
}

static MalValue plain_date_time_add(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    return plain_date_time_add_or_subtract(vm, this_value, args, arg_count, false);
}

static MalValue plain_date_time_subtract(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    return plain_date_time_add_or_subtract(vm, this_value, args, arg_count, true);
}

static MalValue plain_date_time_equals(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    PlainDateTime *other = plain_date_time_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), mal_value_new_undefined());
    if (other == nullptr) return mal_value_new_undefined();
    bool equal = temporal_rs_PlainDateTime_equals(object->handle, other);
    temporal_rs_PlainDateTime_destroy(other);
    return mal_value_new_boolean(equal);
}

static MalValue plain_date_time_difference(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, bool since
) {
    MalTemporalObject *object;
    if (!plain_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    PlainDateTime *other = plain_date_time_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), mal_value_new_undefined());
    if (other == nullptr) return mal_value_new_undefined();
    DifferenceSettings settings = {0};
    bool present;
    MalValue options = arg_count > 1 ? args[1] : mal_value_new_undefined();
    if (!temporal_options_object(vm, options, &present)) {
        temporal_rs_PlainDateTime_destroy(other);
        return mal_value_new_undefined();
    }
    Unit largest = Unit_Day, smallest = Unit_Nanosecond;
    RoundingMode mode = RoundingMode_Trunc;
    u32 increment = 1;
    if (present &&
        (!temporal_get_unit_option(
             vm, options, "largestUnit", true, false, Unit_Auto, &largest) ||
         !temporal_get_rounding_increment(vm, options, &increment) ||
         !temporal_get_rounding_mode(vm, options, RoundingMode_Trunc, &mode) ||
         !temporal_get_unit_option(
             vm, options, "smallestUnit", false, false, Unit_Nanosecond, &smallest))) {
        temporal_rs_PlainDateTime_destroy(other);
        return mal_value_new_undefined();
    }
    if (largest == Unit_Auto) largest = Unit_Day;
    settings.largest_unit = (Unit_option) {.ok = largest, .is_ok = true};
    settings.smallest_unit = (Unit_option) {.ok = smallest, .is_ok = true};
    settings.rounding_mode = (RoundingMode_option) {.ok = mode, .is_ok = true};
    settings.increment = (OptionU32) {.ok = increment, .is_ok = true};
    Duration *handle = nullptr;
    TemporalError error = {0};
    bool ok;
    if (since) {
        temporal_rs_PlainDateTime_since_result result =
            temporal_rs_PlainDateTime_since(object->handle, other, settings);
        ok = result.is_ok; if (ok) handle = result.ok; else error = result.err;
    } else {
        temporal_rs_PlainDateTime_until_result result =
            temporal_rs_PlainDateTime_until(object->handle, other, settings);
        ok = result.is_ok; if (ok) handle = result.ok; else error = result.err;
    }
    temporal_rs_PlainDateTime_destroy(other);
    return ok ? duration_wrap_intrinsic(vm, handle) : temporal_throw(vm, error);
}

static MalValue plain_date_time_since(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    return plain_date_time_difference(vm, this_value, args, arg_count, true);
}

static MalValue plain_date_time_until(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    return plain_date_time_difference(vm, this_value, args, arg_count, false);
}

static MalValue plain_date_time_round(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    RoundingOptions options;
    if (!plain_time_rounding_options(
            vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), &options)) {
        return mal_value_new_undefined();
    }
    temporal_rs_PlainDateTime_round_result result =
        temporal_rs_PlainDateTime_round(object->handle, options);
    return result.is_ok ? plain_date_time_wrap_intrinsic(vm, result.ok)
                        : temporal_throw(vm, result.err);
}

static MalValue plain_date_time_with_calendar(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    AnyCalendarKind calendar;
    if (!temporal_calendar_kind(
            vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), &calendar)) {
        return mal_value_new_undefined();
    }
    return plain_date_time_wrap_intrinsic(
        vm, temporal_rs_PlainDateTime_with_calendar(object->handle, calendar));
}

static MalValue plain_date_time_with_plain_time(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    PlainTime *time = nullptr;
    if (arg_count > 0 && !mal_value_is_undefined(args[0])) {
        time = plain_time_from_like(vm, args[0], mal_value_new_undefined());
        if (time == nullptr) return mal_value_new_undefined();
    }
    temporal_rs_PlainDateTime_with_time_result result =
        temporal_rs_PlainDateTime_with_time(object->handle, time);
    if (time != nullptr) temporal_rs_PlainTime_destroy(time);
    return result.is_ok ? plain_date_time_wrap_intrinsic(vm, result.ok)
                        : temporal_throw(vm, result.err);
}

static MalValue plain_date_time_to_plain_date(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    return plain_date_wrap_intrinsic(
        vm, temporal_rs_PlainDateTime_to_plain_date(object->handle));
}

static MalValue plain_date_time_to_plain_time(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    return plain_time_wrap_intrinsic(
        vm, temporal_rs_PlainDateTime_to_plain_time(object->handle));
}

static MalValue plain_date_time_to_string_impl(
    MalVm *vm, MalValue this_value, MalValue options_value, bool read_options
) {
    MalTemporalObject *object;
    if (!plain_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    ToStringRoundingOptions options = {
        .precision = {.is_minute = false, .precision = {.is_ok = false}},
        .smallest_unit = {.is_ok = false},
        .rounding_mode = {.ok = RoundingMode_Trunc, .is_ok = true},
    };
    DisplayCalendar display = DisplayCalendar_Auto;
    if (read_options &&
        (!temporal_to_string_rounding_options(vm, options_value, &options) ||
         !temporal_display_calendar(vm, options_value, &display))) {
        return mal_value_new_undefined();
    }
    DiplomatWrite *write = diplomat_buffer_write_create(48);
    temporal_rs_PlainDateTime_to_ixdtf_string(
        object->handle, options, display, write);
    return temporal_write_to_string(vm, write);
}

static MalValue plain_date_time_to_string(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    return plain_date_time_to_string_impl(
        vm, this_value, arg_count > 0 ? args[0] : mal_value_new_undefined(), true);
}

static MalValue plain_date_time_to_string_no_options(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    return plain_date_time_to_string_impl(
        vm, this_value, mal_value_new_undefined(), false);
}

static MalValue plain_date_time_value_of(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) args; (void) arg_count; (void) new_target; (void) callee;
    return temporal_throw_type(vm, "Cannot convert Temporal.PlainDateTime to a primitive");
}

static bool plain_year_month_this(MalVm *vm, MalValue value, MalTemporalObject **out) {
    if (!mal_value_is_temporal_object(value)) {
        temporal_throw_type(vm, "Temporal.PlainYearMonth method called on incompatible receiver");
        return false;
    }
    MalTemporalObject *object = mal_value_to_temporal_object(value);
    if (object->kind != MAL_TEMPORAL_PLAIN_YEAR_MONTH || object->handle == nullptr) {
        temporal_throw_type(vm, "Temporal.PlainYearMonth method called on incompatible receiver");
        return false;
    }
    *out = object;
    return true;
}

static MalValue plain_year_month_wrap(
    MalVm *vm, PlainYearMonth *handle, MalObject *prototype
) {
    return mal_value_from_temporal_object(mal_temporal_object_new(
        &vm->heap, prototype, MAL_TEMPORAL_PLAIN_YEAR_MONTH, handle));
}

static MalValue plain_year_month_wrap_intrinsic(MalVm *vm, PlainYearMonth *handle) {
    return plain_year_month_wrap(
        vm, handle,
        mal_value_to_object(
            vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_YEAR_MONTH_PROTOTYPE]));
}

static MalValue plain_year_month_constructor(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) callee;
    if (mal_value_is_undefined(new_target)) {
        return temporal_throw_type(vm, "Temporal.PlainYearMonth must be called with new");
    }
    i32 year;
    u16 month, reference_day;
    if (!temporal_i32_integer(
            vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), &year) ||
        !temporal_u16_integer(
            vm, arg_count > 1 ? args[1] : mal_value_new_undefined(), UINT8_MAX, &month)) {
        return mal_value_new_undefined();
    }
    AnyCalendarKind calendar;
    if (!temporal_calendar_kind(
            vm, arg_count > 2 ? args[2] : mal_value_new_undefined(), &calendar)) {
        return mal_value_new_undefined();
    }
    if (arg_count > 3 && !mal_value_is_undefined(args[3])) {
        if (!temporal_u16_integer(vm, args[3], UINT8_MAX, &reference_day)) {
            return mal_value_new_undefined();
        }
    } else reference_day = 1;
    temporal_rs_PlainYearMonth_try_new_with_overflow_result result =
        temporal_rs_PlainYearMonth_try_new_with_overflow(
            year, (u8) month,
            (OptionU8) {.ok = (u8) reference_day, .is_ok = true},
            calendar, ArithmeticOverflow_Reject);
    if (!result.is_ok) return temporal_throw(vm, result.err);
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, new_target, MAL_INTRINSIC_TEMPORAL_PLAIN_YEAR_MONTH_PROTOTYPE,
            &prototype)) {
        temporal_rs_PlainYearMonth_destroy(result.ok);
        return mal_value_new_undefined();
    }
    return plain_year_month_wrap(vm, result.ok, prototype);
}

static PlainYearMonth *plain_year_month_from_like(
    MalVm *vm, MalValue input, MalValue options
) {
    if (mal_value_is_temporal_object(input)) {
        MalTemporalObject *object = mal_value_to_temporal_object(input);
        if (object->kind == MAL_TEMPORAL_PLAIN_YEAR_MONTH && object->handle != nullptr) {
            ArithmeticOverflow overflow;
            if (!temporal_overflow_option(vm, options, &overflow)) return nullptr;
            return temporal_rs_PlainYearMonth_clone(object->handle);
        }
    }
    if (mal_value_is_string(input)) {
        MalString *string = mal_value_to_string(input);
        DiplomatString16View view = {
            .data = (const char16_t *) mal_string_code_units(string),
            .len = mal_string_length(string),
        };
        temporal_rs_PlainYearMonth_from_utf16_result result =
            temporal_rs_PlainYearMonth_from_utf16(view);
        if (!result.is_ok) {
            temporal_throw(vm, result.err);
            return nullptr;
        }
        ArithmeticOverflow overflow;
        if (!temporal_overflow_option(vm, options, &overflow)) {
            temporal_rs_PlainYearMonth_destroy(result.ok);
            return nullptr;
        }
        return result.ok;
    }
    if (!mal_value_is_object(input)) {
        temporal_throw_type(vm, "Temporal.PlainYearMonth.from requires a string or object");
        return nullptr;
    }
    PlainDatePartial fields;
    if (!plain_date_partial_from_object(vm, input, &fields)) return nullptr;
    ArithmeticOverflow overflow;
    if (!temporal_overflow_option(vm, options, &overflow)) {
        plain_date_partial_destroy(&fields);
        return nullptr;
    }
    temporal_rs_PlainYearMonth_from_partial_result result =
        temporal_rs_PlainYearMonth_from_partial(
            fields.partial,
            (ArithmeticOverflow_option) {.ok = overflow, .is_ok = true});
    plain_date_partial_destroy(&fields);
    if (!result.is_ok) {
        temporal_throw(vm, result.err);
        return nullptr;
    }
    return result.ok;
}

static MalValue plain_year_month_from(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) new_target; (void) callee;
    PlainYearMonth *handle = plain_year_month_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined(),
        arg_count > 1 ? args[1] : mal_value_new_undefined());
    return handle == nullptr ? mal_value_new_undefined()
                             : plain_year_month_wrap_intrinsic(vm, handle);
}

static MalValue plain_year_month_compare(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) new_target; (void) callee;
    PlainYearMonth *one = plain_year_month_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), mal_value_new_undefined());
    if (one == nullptr) return mal_value_new_undefined();
    PlainYearMonth *two = plain_year_month_from_like(
        vm, arg_count > 1 ? args[1] : mal_value_new_undefined(), mal_value_new_undefined());
    if (two == nullptr) {
        temporal_rs_PlainYearMonth_destroy(one);
        return mal_value_new_undefined();
    }
    i8 comparison = temporal_rs_PlainYearMonth_compare(one, two);
    temporal_rs_PlainYearMonth_destroy(one);
    temporal_rs_PlainYearMonth_destroy(two);
    return mal_value_from_i32(comparison);
}

#define PLAIN_YEAR_MONTH_GETTER(c_name, ffi_name) \
    static MalValue c_name(MalVm *vm, MalValue this_value, const MalValue *args, \
                           i32 arg_count, MalValue new_target, MalValue callee) { \
        (void) args; (void) arg_count; (void) new_target; (void) callee; \
        MalTemporalObject *object; \
        if (!plain_year_month_this(vm, this_value, &object)) return mal_value_new_undefined(); \
        return mal_value_from_i32((i32) ffi_name(object->handle)); \
    }

PLAIN_YEAR_MONTH_GETTER(plain_year_month_year, temporal_rs_PlainYearMonth_year)
PLAIN_YEAR_MONTH_GETTER(plain_year_month_month, temporal_rs_PlainYearMonth_month)
PLAIN_YEAR_MONTH_GETTER(plain_year_month_days_in_month, temporal_rs_PlainYearMonth_days_in_month)
PLAIN_YEAR_MONTH_GETTER(plain_year_month_days_in_year, temporal_rs_PlainYearMonth_days_in_year)
PLAIN_YEAR_MONTH_GETTER(plain_year_month_months_in_year, temporal_rs_PlainYearMonth_months_in_year)

static MalValue plain_year_month_calendar_id(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_year_month_this(vm, this_value, &object)) return mal_value_new_undefined();
    return temporal_calendar_identifier(
        vm, temporal_rs_PlainYearMonth_calendar(object->handle));
}

static MalValue plain_year_month_month_code(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_year_month_this(vm, this_value, &object)) return mal_value_new_undefined();
    DiplomatWrite *write = diplomat_buffer_write_create(8);
    temporal_rs_PlainYearMonth_month_code(object->handle, write);
    return temporal_write_to_string(vm, write);
}

static MalValue plain_year_month_in_leap_year(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_year_month_this(vm, this_value, &object)) return mal_value_new_undefined();
    return mal_value_new_boolean(
        temporal_rs_PlainYearMonth_in_leap_year(object->handle));
}

static MalValue plain_year_month_equals(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_year_month_this(vm, this_value, &object)) return mal_value_new_undefined();
    PlainYearMonth *other = plain_year_month_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), mal_value_new_undefined());
    if (other == nullptr) return mal_value_new_undefined();
    bool equal = temporal_rs_PlainYearMonth_equals(object->handle, other);
    temporal_rs_PlainYearMonth_destroy(other);
    return mal_value_new_boolean(equal);
}

static MalValue plain_year_month_difference(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, bool since
) {
    MalTemporalObject *object;
    if (!plain_year_month_this(vm, this_value, &object)) return mal_value_new_undefined();
    PlainYearMonth *other = plain_year_month_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), mal_value_new_undefined());
    if (other == nullptr) return mal_value_new_undefined();
    MalValue options = arg_count > 1 ? args[1] : mal_value_new_undefined();
    bool present;
    if (!temporal_options_object(vm, options, &present)) {
        temporal_rs_PlainYearMonth_destroy(other);
        return mal_value_new_undefined();
    }
    Unit largest = Unit_Year, smallest = Unit_Month;
    RoundingMode mode = RoundingMode_Trunc;
    u32 increment = 1;
    if (present &&
        (!temporal_get_unit_option(
             vm, options, "largestUnit", true, false, Unit_Auto, &largest) ||
         !temporal_get_rounding_increment(vm, options, &increment) ||
         !temporal_get_rounding_mode(vm, options, RoundingMode_Trunc, &mode) ||
         !temporal_get_unit_option(
             vm, options, "smallestUnit", false, false, Unit_Month, &smallest))) {
        temporal_rs_PlainYearMonth_destroy(other);
        return mal_value_new_undefined();
    }
    if (largest == Unit_Auto) largest = Unit_Year;
    DifferenceSettings settings = {
        .largest_unit = {.ok = largest, .is_ok = true},
        .smallest_unit = {.ok = smallest, .is_ok = true},
        .rounding_mode = {.ok = mode, .is_ok = true},
        .increment = {.ok = increment, .is_ok = true},
    };
    Duration *handle = nullptr;
    TemporalError error = {0};
    bool ok;
    if (since) {
        temporal_rs_PlainYearMonth_since_result result =
            temporal_rs_PlainYearMonth_since(object->handle, other, settings);
        ok = result.is_ok; if (ok) handle = result.ok; else error = result.err;
    } else {
        temporal_rs_PlainYearMonth_until_result result =
            temporal_rs_PlainYearMonth_until(object->handle, other, settings);
        ok = result.is_ok; if (ok) handle = result.ok; else error = result.err;
    }
    temporal_rs_PlainYearMonth_destroy(other);
    return ok ? duration_wrap_intrinsic(vm, handle) : temporal_throw(vm, error);
}

static MalValue plain_year_month_since(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    return plain_year_month_difference(vm, this_value, args, arg_count, true);
}

static MalValue plain_year_month_until(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    return plain_year_month_difference(vm, this_value, args, arg_count, false);
}

static MalValue plain_year_month_with(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_year_month_this(vm, this_value, &object)) return mal_value_new_undefined();
    MalValue input = arg_count > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_object(input) || mal_value_is_temporal_object(input)) {
        return temporal_throw_type(vm, "Temporal.PlainYearMonth.with requires a property bag");
    }
    PlainDatePartial fields;
    if (!plain_date_partial_from_object(vm, input, &fields)) return mal_value_new_undefined();
    ArithmeticOverflow overflow;
    if (!temporal_overflow_option(
            vm, arg_count > 1 ? args[1] : mal_value_new_undefined(), &overflow)) {
        plain_date_partial_destroy(&fields);
        return mal_value_new_undefined();
    }
    temporal_rs_PlainYearMonth_with_result result = temporal_rs_PlainYearMonth_with(
        object->handle, fields.partial,
        (ArithmeticOverflow_option) {.ok = overflow, .is_ok = true});
    plain_date_partial_destroy(&fields);
    return result.is_ok ? plain_year_month_wrap_intrinsic(vm, result.ok)
                        : temporal_throw(vm, result.err);
}

static MalValue plain_year_month_to_plain_date(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_year_month_this(vm, this_value, &object)) return mal_value_new_undefined();
    MalValue input = arg_count > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_object(input)) {
        return temporal_throw_type(vm, "Temporal.PlainYearMonth.toPlainDate requires an object");
    }
    MalValue value;
    if (!mal_vm_get_property(vm, input, mal_intrinsic_string_key(vm, "day"), &value)) {
        return mal_value_new_undefined();
    }
    u16 day;
    if (!temporal_u16_integer(vm, value, UINT8_MAX, &day)) return mal_value_new_undefined();
    PartialDate partial = {.calendar = AnyCalendarKind_Iso,
                           .day = {.ok = (u8) day, .is_ok = true}};
    temporal_rs_PlainYearMonth_to_plain_date_result result =
        temporal_rs_PlainYearMonth_to_plain_date(
            object->handle, (PartialDate_option) {.ok = partial, .is_ok = true});
    return result.is_ok ? plain_date_wrap_intrinsic(vm, result.ok)
                        : temporal_throw(vm, result.err);
}

static MalValue plain_year_month_era(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_year_month_this(vm, this_value, &object)) return mal_value_new_undefined();
    DiplomatWrite *write = diplomat_buffer_write_create(16);
    temporal_rs_PlainYearMonth_era(object->handle, write);
    if (diplomat_buffer_write_len(write) == 0) {
        diplomat_buffer_write_destroy(write);
        return mal_value_new_undefined();
    }
    return temporal_write_to_string(vm, write);
}

static MalValue plain_year_month_era_year(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_year_month_this(vm, this_value, &object)) return mal_value_new_undefined();
    temporal_rs_PlainYearMonth_era_year_result result =
        temporal_rs_PlainYearMonth_era_year(object->handle);
    return result.is_ok ? mal_value_from_i32(result.ok) : mal_value_new_undefined();
}

static MalValue plain_year_month_add_or_subtract(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, bool subtract
) {
    MalTemporalObject *object;
    if (!plain_year_month_this(vm, this_value, &object)) return mal_value_new_undefined();
    Duration *duration = duration_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined());
    if (duration == nullptr) return mal_value_new_undefined();
    ArithmeticOverflow overflow;
    if (!temporal_overflow_option(
            vm, arg_count > 1 ? args[1] : mal_value_new_undefined(), &overflow)) {
        temporal_rs_Duration_destroy(duration);
        return mal_value_new_undefined();
    }
    PlainYearMonth *handle = nullptr;
    TemporalError error = {0};
    bool ok;
    if (subtract) {
        temporal_rs_PlainYearMonth_subtract_result result =
            temporal_rs_PlainYearMonth_subtract(object->handle, duration, overflow);
        ok = result.is_ok; if (ok) handle = result.ok; else error = result.err;
    } else {
        temporal_rs_PlainYearMonth_add_result result =
            temporal_rs_PlainYearMonth_add(object->handle, duration, overflow);
        ok = result.is_ok; if (ok) handle = result.ok; else error = result.err;
    }
    temporal_rs_Duration_destroy(duration);
    return ok ? plain_year_month_wrap_intrinsic(vm, handle) : temporal_throw(vm, error);
}

static MalValue plain_year_month_add(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    return plain_year_month_add_or_subtract(vm, this_value, args, arg_count, false);
}

static MalValue plain_year_month_subtract(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    return plain_year_month_add_or_subtract(vm, this_value, args, arg_count, true);
}

static MalValue plain_year_month_to_string_impl(
    MalVm *vm, MalValue this_value, MalValue options, bool read_options
) {
    MalTemporalObject *object;
    if (!plain_year_month_this(vm, this_value, &object)) return mal_value_new_undefined();
    DisplayCalendar display = DisplayCalendar_Auto;
    if (read_options && !temporal_display_calendar(vm, options, &display)) {
        return mal_value_new_undefined();
    }
    DiplomatWrite *write = diplomat_buffer_write_create(32);
    temporal_rs_PlainYearMonth_to_ixdtf_string(object->handle, display, write);
    return temporal_write_to_string(vm, write);
}

static MalValue plain_year_month_to_string(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    return plain_year_month_to_string_impl(
        vm, this_value, arg_count > 0 ? args[0] : mal_value_new_undefined(), true);
}

static MalValue plain_year_month_to_string_no_options(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    return plain_year_month_to_string_impl(
        vm, this_value, mal_value_new_undefined(), false);
}

static MalValue plain_year_month_value_of(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) args; (void) arg_count; (void) new_target; (void) callee;
    return temporal_throw_type(vm, "Cannot convert Temporal.PlainYearMonth to a primitive");
}

static bool plain_month_day_this(MalVm *vm, MalValue value, MalTemporalObject **out) {
    if (!mal_value_is_temporal_object(value)) {
        temporal_throw_type(vm, "Temporal.PlainMonthDay method called on incompatible receiver");
        return false;
    }
    MalTemporalObject *object = mal_value_to_temporal_object(value);
    if (object->kind != MAL_TEMPORAL_PLAIN_MONTH_DAY || object->handle == nullptr) {
        temporal_throw_type(vm, "Temporal.PlainMonthDay method called on incompatible receiver");
        return false;
    }
    *out = object;
    return true;
}

static MalValue plain_month_day_wrap(
    MalVm *vm, PlainMonthDay *handle, MalObject *prototype
) {
    return mal_value_from_temporal_object(mal_temporal_object_new(
        &vm->heap, prototype, MAL_TEMPORAL_PLAIN_MONTH_DAY, handle));
}

static MalValue plain_month_day_wrap_intrinsic(MalVm *vm, PlainMonthDay *handle) {
    return plain_month_day_wrap(
        vm, handle,
        mal_value_to_object(
            vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_MONTH_DAY_PROTOTYPE]));
}

static MalValue plain_month_day_constructor(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) callee;
    if (mal_value_is_undefined(new_target)) {
        return temporal_throw_type(vm, "Temporal.PlainMonthDay must be called with new");
    }
    u16 month, day;
    if (!temporal_u16_integer(
            vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), UINT8_MAX, &month) ||
        !temporal_u16_integer(
            vm, arg_count > 1 ? args[1] : mal_value_new_undefined(), UINT8_MAX, &day)) {
        return mal_value_new_undefined();
    }
    AnyCalendarKind calendar;
    if (!temporal_calendar_kind(
            vm, arg_count > 2 ? args[2] : mal_value_new_undefined(), &calendar)) {
        return mal_value_new_undefined();
    }
    i32 reference_year = 1972;
    if (arg_count > 3 && !mal_value_is_undefined(args[3]) &&
        !temporal_i32_integer(vm, args[3], &reference_year)) {
        return mal_value_new_undefined();
    }
    temporal_rs_PlainMonthDay_try_new_with_overflow_result result =
        temporal_rs_PlainMonthDay_try_new_with_overflow(
            (u8) month, (u8) day, calendar, ArithmeticOverflow_Reject,
            (OptionI32) {.ok = reference_year, .is_ok = true});
    if (!result.is_ok) return temporal_throw(vm, result.err);
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, new_target, MAL_INTRINSIC_TEMPORAL_PLAIN_MONTH_DAY_PROTOTYPE,
            &prototype)) {
        temporal_rs_PlainMonthDay_destroy(result.ok);
        return mal_value_new_undefined();
    }
    return plain_month_day_wrap(vm, result.ok, prototype);
}

static PlainMonthDay *plain_month_day_from_like(
    MalVm *vm, MalValue input, MalValue options
) {
    if (mal_value_is_temporal_object(input)) {
        MalTemporalObject *object = mal_value_to_temporal_object(input);
        if (object->kind == MAL_TEMPORAL_PLAIN_MONTH_DAY && object->handle != nullptr) {
            ArithmeticOverflow overflow;
            if (!temporal_overflow_option(vm, options, &overflow)) return nullptr;
            return temporal_rs_PlainMonthDay_clone(object->handle);
        }
    }
    if (mal_value_is_string(input)) {
        MalString *string = mal_value_to_string(input);
        DiplomatString16View view = {
            .data = (const char16_t *) mal_string_code_units(string),
            .len = mal_string_length(string),
        };
        temporal_rs_PlainMonthDay_from_utf16_result result =
            temporal_rs_PlainMonthDay_from_utf16(view);
        if (!result.is_ok) {
            temporal_throw(vm, result.err);
            return nullptr;
        }
        ArithmeticOverflow overflow;
        if (!temporal_overflow_option(vm, options, &overflow)) {
            temporal_rs_PlainMonthDay_destroy(result.ok);
            return nullptr;
        }
        return result.ok;
    }
    if (!mal_value_is_object(input)) {
        temporal_throw_type(vm, "Temporal.PlainMonthDay.from requires a string or object");
        return nullptr;
    }
    PlainDatePartial fields;
    if (!plain_date_partial_from_object(vm, input, &fields)) return nullptr;
    ArithmeticOverflow overflow;
    if (!temporal_overflow_option(vm, options, &overflow)) {
        plain_date_partial_destroy(&fields);
        return nullptr;
    }
    temporal_rs_PlainMonthDay_from_partial_result result =
        temporal_rs_PlainMonthDay_from_partial(
            fields.partial,
            (ArithmeticOverflow_option) {.ok = overflow, .is_ok = true});
    plain_date_partial_destroy(&fields);
    if (!result.is_ok) {
        temporal_throw(vm, result.err);
        return nullptr;
    }
    return result.ok;
}

static MalValue plain_month_day_from(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) new_target; (void) callee;
    PlainMonthDay *handle = plain_month_day_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined(),
        arg_count > 1 ? args[1] : mal_value_new_undefined());
    return handle == nullptr ? mal_value_new_undefined()
                             : plain_month_day_wrap_intrinsic(vm, handle);
}

#define PLAIN_MONTH_DAY_GETTER(c_name, ffi_name) \
    static MalValue c_name(MalVm *vm, MalValue this_value, const MalValue *args, \
                           i32 arg_count, MalValue new_target, MalValue callee) { \
        (void) args; (void) arg_count; (void) new_target; (void) callee; \
        MalTemporalObject *object; \
        if (!plain_month_day_this(vm, this_value, &object)) return mal_value_new_undefined(); \
        return mal_value_from_i32((i32) ffi_name(object->handle)); \
    }

PLAIN_MONTH_DAY_GETTER(plain_month_day_month, temporal_rs_PlainMonthDay_month)
PLAIN_MONTH_DAY_GETTER(plain_month_day_day, temporal_rs_PlainMonthDay_day)

static MalValue plain_month_day_calendar_id(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_month_day_this(vm, this_value, &object)) return mal_value_new_undefined();
    return temporal_calendar_identifier(
        vm, temporal_rs_PlainMonthDay_calendar(object->handle));
}

static MalValue plain_month_day_month_code(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_month_day_this(vm, this_value, &object)) return mal_value_new_undefined();
    DiplomatWrite *write = diplomat_buffer_write_create(8);
    temporal_rs_PlainMonthDay_month_code(object->handle, write);
    return temporal_write_to_string(vm, write);
}

static MalValue plain_month_day_equals(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_month_day_this(vm, this_value, &object)) return mal_value_new_undefined();
    PlainMonthDay *other = plain_month_day_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), mal_value_new_undefined());
    if (other == nullptr) return mal_value_new_undefined();
    bool equal = temporal_rs_PlainMonthDay_equals(object->handle, other);
    temporal_rs_PlainMonthDay_destroy(other);
    return mal_value_new_boolean(equal);
}

static MalValue plain_month_day_with(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_month_day_this(vm, this_value, &object)) return mal_value_new_undefined();
    MalValue input = arg_count > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_object(input) || mal_value_is_temporal_object(input)) {
        return temporal_throw_type(vm, "Temporal.PlainMonthDay.with requires a property bag");
    }
    PlainDatePartial fields;
    if (!plain_date_partial_from_object(vm, input, &fields)) return mal_value_new_undefined();
    ArithmeticOverflow overflow;
    if (!temporal_overflow_option(
            vm, arg_count > 1 ? args[1] : mal_value_new_undefined(), &overflow)) {
        plain_date_partial_destroy(&fields);
        return mal_value_new_undefined();
    }
    temporal_rs_PlainMonthDay_with_result result = temporal_rs_PlainMonthDay_with(
        object->handle, fields.partial,
        (ArithmeticOverflow_option) {.ok = overflow, .is_ok = true});
    plain_date_partial_destroy(&fields);
    return result.is_ok ? plain_month_day_wrap_intrinsic(vm, result.ok)
                        : temporal_throw(vm, result.err);
}

static MalValue plain_month_day_to_plain_date(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_month_day_this(vm, this_value, &object)) return mal_value_new_undefined();
    MalValue input = arg_count > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_object(input)) {
        return temporal_throw_type(vm, "Temporal.PlainMonthDay.toPlainDate requires an object");
    }
    MalValue value;
    if (!mal_vm_get_property(vm, input, mal_intrinsic_string_key(vm, "year"), &value)) {
        return mal_value_new_undefined();
    }
    i32 year;
    if (!temporal_i32_integer(vm, value, &year)) return mal_value_new_undefined();
    PartialDate partial = {.calendar = AnyCalendarKind_Iso,
                           .year = {.ok = year, .is_ok = true}};
    temporal_rs_PlainMonthDay_to_plain_date_result result =
        temporal_rs_PlainMonthDay_to_plain_date(
            object->handle, (PartialDate_option) {.ok = partial, .is_ok = true});
    return result.is_ok ? plain_date_wrap_intrinsic(vm, result.ok)
                        : temporal_throw(vm, result.err);
}

static MalValue plain_month_day_to_string_impl(
    MalVm *vm, MalValue this_value, MalValue options, bool read_options
) {
    MalTemporalObject *object;
    if (!plain_month_day_this(vm, this_value, &object)) return mal_value_new_undefined();
    DisplayCalendar display = DisplayCalendar_Auto;
    if (read_options && !temporal_display_calendar(vm, options, &display)) {
        return mal_value_new_undefined();
    }
    DiplomatWrite *write = diplomat_buffer_write_create(32);
    temporal_rs_PlainMonthDay_to_ixdtf_string(object->handle, display, write);
    return temporal_write_to_string(vm, write);
}

static MalValue plain_month_day_to_string(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    return plain_month_day_to_string_impl(
        vm, this_value, arg_count > 0 ? args[0] : mal_value_new_undefined(), true);
}

static MalValue plain_month_day_to_string_no_options(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    return plain_month_day_to_string_impl(
        vm, this_value, mal_value_new_undefined(), false);
}

static MalValue plain_month_day_value_of(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) args; (void) arg_count; (void) new_target; (void) callee;
    return temporal_throw_type(vm, "Cannot convert Temporal.PlainMonthDay to a primitive");
}

static I128Nanoseconds temporal_i128_to_nanoseconds(i128 value) {
    bool negative = value < 0;
    u128 magnitude = negative ? (u128) (-(value + 1)) + 1 : (u128) value;
    return (I128Nanoseconds) {
        .high = (u64) (magnitude >> 64) | (negative ? ((u64) 1 << 63) : 0),
        .low = (u64) magnitude,
    };
}

static i128 temporal_nanoseconds_to_i128(I128Nanoseconds value) {
    bool negative = (value.high & ((u64) 1 << 63)) != 0;
    u128 magnitude = ((u128) (value.high & ~((u64) 1 << 63)) << 64) | value.low;
    if (!negative) return (i128) magnitude;
    return magnitude == ((u128) 1 << 127) ? (i128) magnitude : -(i128) magnitude;
}

static bool instant_this(MalVm *vm, MalValue value, MalTemporalObject **out) {
    if (!mal_value_is_temporal_object(value)) {
        temporal_throw_type(vm, "Temporal.Instant method called on incompatible receiver");
        return false;
    }
    MalTemporalObject *object = mal_value_to_temporal_object(value);
    if (object->kind != MAL_TEMPORAL_INSTANT || object->handle == nullptr) {
        temporal_throw_type(vm, "Temporal.Instant method called on incompatible receiver");
        return false;
    }
    *out = object;
    return true;
}

static MalValue instant_wrap(MalVm *vm, Instant *handle, MalObject *prototype) {
    return mal_value_from_temporal_object(mal_temporal_object_new(
        &vm->heap, prototype, MAL_TEMPORAL_INSTANT, handle));
}

static MalValue instant_wrap_intrinsic(MalVm *vm, Instant *handle) {
    return instant_wrap(
        vm, handle,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_TEMPORAL_INSTANT_PROTOTYPE]));
}

MalValue mal_builtin_temporal_instant_from_epoch_milliseconds(
    MalVm *vm,
    f64 milliseconds
) {
    temporal_rs_Instant_from_epoch_milliseconds_result result =
        temporal_rs_Instant_from_epoch_milliseconds((i64) milliseconds);
    return result.is_ok ? instant_wrap_intrinsic(vm, result.ok)
                        : temporal_throw(vm, result.err);
}

static Instant *instant_from_bigint(MalVm *vm, MalValue value) {
    i128 nanoseconds;
    if (!mal_bigint_to_bigint(vm, value, &nanoseconds)) return nullptr;
    temporal_rs_Instant_try_new_result result =
        temporal_rs_Instant_try_new(temporal_i128_to_nanoseconds(nanoseconds));
    if (!result.is_ok) {
        temporal_throw(vm, result.err);
        return nullptr;
    }
    return result.ok;
}

static MalValue instant_constructor(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) callee;
    if (mal_value_is_undefined(new_target)) {
        return temporal_throw_type(vm, "Temporal.Instant must be called with new");
    }
    Instant *handle = instant_from_bigint(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined());
    if (handle == nullptr) return mal_value_new_undefined();
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, new_target, MAL_INTRINSIC_TEMPORAL_INSTANT_PROTOTYPE, &prototype)) {
        temporal_rs_Instant_destroy(handle);
        return mal_value_new_undefined();
    }
    return instant_wrap(vm, handle, prototype);
}

static Instant *instant_from_like(MalVm *vm, MalValue input) {
    if (mal_value_is_temporal_object(input)) {
        MalTemporalObject *object = mal_value_to_temporal_object(input);
        if (object->kind == MAL_TEMPORAL_INSTANT && object->handle != nullptr) {
            return temporal_rs_Instant_clone(object->handle);
        }
        if (object->kind == MAL_TEMPORAL_ZONED_DATE_TIME && object->handle != nullptr) {
            return temporal_rs_ZonedDateTime_to_instant(object->handle);
        }
    }
    if (!mal_value_is_string(input) && !mal_value_is_object(input)) {
        temporal_throw_type(vm, "Temporal.Instant input must be a string or object");
        return nullptr;
    }
    MalString *string;
    if (!mal_vm_to_string(vm, input, &string)) return nullptr;
    DiplomatString16View view = {
        .data = (const char16_t *) mal_string_code_units(string),
        .len = mal_string_length(string),
    };
    temporal_rs_Instant_from_utf16_result result = temporal_rs_Instant_from_utf16(view);
    if (!result.is_ok) {
        temporal_throw(vm, result.err);
        return nullptr;
    }
    return result.ok;
}

static MalValue instant_from(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) new_target; (void) callee;
    Instant *handle = instant_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined());
    return handle == nullptr ? mal_value_new_undefined() : instant_wrap_intrinsic(vm, handle);
}

static MalValue instant_from_epoch_milliseconds(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) new_target; (void) callee;
    f64 number;
    if (!mal_vm_to_number(
            vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), &number)) {
        return mal_value_new_undefined();
    }
    if (!isfinite(number) || trunc(number) != number ||
        number < (f64) INT64_MIN || number >= -(f64) INT64_MIN) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Invalid epoch milliseconds");
        return mal_value_new_undefined();
    }
    return mal_builtin_temporal_instant_from_epoch_milliseconds(vm, number);
}

static MalValue instant_from_epoch_nanoseconds(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) new_target; (void) callee;
    Instant *handle = instant_from_bigint(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined());
    return handle == nullptr ? mal_value_new_undefined() : instant_wrap_intrinsic(vm, handle);
}

static MalValue instant_epoch_milliseconds(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!instant_this(vm, this_value, &object)) return mal_value_new_undefined();
    return mal_ops_number_value((f64) temporal_rs_Instant_epoch_milliseconds(object->handle));
}

static MalValue instant_epoch_nanoseconds(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!instant_this(vm, this_value, &object)) return mal_value_new_undefined();
    i128 nanoseconds = temporal_nanoseconds_to_i128(
        temporal_rs_Instant_epoch_nanoseconds(object->handle));
    return mal_value_from_bigint(mal_bigint_new(&vm->heap, nanoseconds));
}

static MalValue instant_compare(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) new_target; (void) callee;
    Instant *one = instant_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined());
    if (one == nullptr) return mal_value_new_undefined();
    Instant *two = instant_from_like(
        vm, arg_count > 1 ? args[1] : mal_value_new_undefined());
    if (two == nullptr) {
        temporal_rs_Instant_destroy(one);
        return mal_value_new_undefined();
    }
    i8 comparison = temporal_rs_Instant_compare(one, two);
    temporal_rs_Instant_destroy(one);
    temporal_rs_Instant_destroy(two);
    return mal_value_from_i32(comparison);
}

static MalValue instant_add_or_subtract(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, bool subtract
) {
    MalTemporalObject *object;
    if (!instant_this(vm, this_value, &object)) return mal_value_new_undefined();
    Duration *duration = duration_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined());
    if (duration == nullptr) return mal_value_new_undefined();
    Instant *handle = nullptr;
    TemporalError error = {0};
    bool ok;
    if (subtract) {
        temporal_rs_Instant_subtract_result result =
            temporal_rs_Instant_subtract(object->handle, duration);
        ok = result.is_ok;
        if (ok) handle = result.ok; else error = result.err;
    } else {
        temporal_rs_Instant_add_result result =
            temporal_rs_Instant_add(object->handle, duration);
        ok = result.is_ok;
        if (ok) handle = result.ok; else error = result.err;
    }
    temporal_rs_Duration_destroy(duration);
    return ok ? instant_wrap_intrinsic(vm, handle) : temporal_throw(vm, error);
}

static MalValue instant_add(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    return instant_add_or_subtract(vm, this_value, args, arg_count, false);
}

static MalValue instant_subtract(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    return instant_add_or_subtract(vm, this_value, args, arg_count, true);
}

static MalValue instant_equals(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!instant_this(vm, this_value, &object)) return mal_value_new_undefined();
    Instant *other = instant_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined());
    if (other == nullptr) return mal_value_new_undefined();
    bool equal = temporal_rs_Instant_equals(object->handle, other);
    temporal_rs_Instant_destroy(other);
    return mal_value_new_boolean(equal);
}

static bool instant_difference_settings(
    MalVm *vm, MalValue value, DifferenceSettings *settings
) {
    *settings = (DifferenceSettings) {0};
    bool present;
    if (!temporal_options_object(vm, value, &present)) return false;
    Unit largest = Unit_Second;
    Unit smallest = Unit_Nanosecond;
    RoundingMode mode = RoundingMode_Trunc;
    u32 increment = 1;
    if (present &&
        (!temporal_get_unit_option(
             vm, value, "largestUnit", true, false, Unit_Auto, &largest) ||
         !temporal_get_rounding_increment(vm, value, &increment) ||
         !temporal_get_rounding_mode(vm, value, RoundingMode_Trunc, &mode) ||
         !temporal_get_unit_option(
             vm, value, "smallestUnit", false, false, Unit_Nanosecond, &smallest))) {
        return false;
    }
    if (largest == Unit_Auto) {
        largest = smallest > Unit_Second ? smallest : Unit_Second;
    }
    settings->largest_unit = (Unit_option) {.ok = largest, .is_ok = true};
    settings->smallest_unit = (Unit_option) {.ok = smallest, .is_ok = true};
    settings->rounding_mode = (RoundingMode_option) {.ok = mode, .is_ok = true};
    settings->increment = (OptionU32) {.ok = increment, .is_ok = true};
    return true;
}

static MalValue instant_difference(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, bool since
) {
    MalTemporalObject *object;
    if (!instant_this(vm, this_value, &object)) return mal_value_new_undefined();
    Instant *other = instant_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined());
    if (other == nullptr) return mal_value_new_undefined();
    DifferenceSettings settings;
    if (!instant_difference_settings(
            vm, arg_count > 1 ? args[1] : mal_value_new_undefined(), &settings)) {
        temporal_rs_Instant_destroy(other);
        return mal_value_new_undefined();
    }
    Duration *handle = nullptr;
    TemporalError error = {0};
    bool ok;
    if (since) {
        temporal_rs_Instant_since_result result =
            temporal_rs_Instant_since(object->handle, other, settings);
        ok = result.is_ok;
        if (ok) handle = result.ok; else error = result.err;
    } else {
        temporal_rs_Instant_until_result result =
            temporal_rs_Instant_until(object->handle, other, settings);
        ok = result.is_ok;
        if (ok) handle = result.ok; else error = result.err;
    }
    temporal_rs_Instant_destroy(other);
    return ok ? duration_wrap_intrinsic(vm, handle) : temporal_throw(vm, error);
}

static MalValue instant_since(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    return instant_difference(vm, this_value, args, arg_count, true);
}

static MalValue instant_until(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    return instant_difference(vm, this_value, args, arg_count, false);
}

static MalValue instant_round(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!instant_this(vm, this_value, &object)) return mal_value_new_undefined();
    RoundingOptions options;
    if (!plain_time_rounding_options(
            vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), &options)) {
        return mal_value_new_undefined();
    }
    temporal_rs_Instant_round_result result =
        temporal_rs_Instant_round(object->handle, options);
    return result.is_ok ? instant_wrap_intrinsic(vm, result.ok)
                        : temporal_throw(vm, result.err);
}

static bool temporal_time_zone_from_value(
    MalVm *vm, MalValue value, TimeZone *zone
) {
    if (!mal_value_is_string(value)) {
        temporal_throw_type(vm, "Temporal time zone must be a string");
        return false;
    }
    MalString *string = mal_value_to_string(value);
    usize length;
    byte *utf8 = mal_string_to_utf8(string, &length);
    if (utf8 == nullptr) return temporal_throw_type(vm, "Unable to encode time zone"), false;
    temporal_rs_TimeZone_try_from_str_result result = temporal_rs_TimeZone_try_from_str(
        (DiplomatStringView) {.data = (const char *) utf8, .len = length});
    free(utf8);
    if (!result.is_ok) {
        temporal_throw(vm, result.err);
        return false;
    }
    *zone = result.ok;
    return true;
}

static MalValue instant_to_string_impl(
    MalVm *vm, MalValue this_value, MalValue options_value, bool read_options
) {
    MalTemporalObject *object;
    if (!instant_this(vm, this_value, &object)) return mal_value_new_undefined();
    ToStringRoundingOptions options = {
        .precision = {.is_minute = false, .precision = {.is_ok = false}},
        .smallest_unit = {.is_ok = false},
        .rounding_mode = {.ok = RoundingMode_Trunc, .is_ok = true},
    };
    TimeZone_option zone = {.is_ok = false};
    if (read_options) {
        if (!temporal_to_string_rounding_options(vm, options_value, &options)) {
            return mal_value_new_undefined();
        }
        if (!mal_value_is_undefined(options_value)) {
            MalValue zone_value;
            if (!mal_vm_get_property(
                    vm, options_value, mal_intrinsic_string_key(vm, "timeZone"),
                    &zone_value)) {
                return mal_value_new_undefined();
            }
            if (!mal_value_is_undefined(zone_value)) {
                if (!temporal_time_zone_from_value(vm, zone_value, &zone.ok)) {
                    return mal_value_new_undefined();
                }
                zone.is_ok = true;
            }
        }
    }
    DiplomatWrite *write = diplomat_buffer_write_create(48);
    if (write == nullptr) return temporal_throw_type(vm, "Unable to format Temporal.Instant");
    temporal_rs_Instant_to_ixdtf_string_with_compiled_data_result result =
        temporal_rs_Instant_to_ixdtf_string_with_compiled_data(
            object->handle, zone, options, write);
    if (!result.is_ok) {
        diplomat_buffer_write_destroy(write);
        return temporal_throw(vm, result.err);
    }
    return temporal_write_to_string(vm, write);
}

static MalValue instant_to_string(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    return instant_to_string_impl(
        vm, this_value, arg_count > 0 ? args[0] : mal_value_new_undefined(), true);
}

static MalValue instant_to_string_no_options(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    return instant_to_string_impl(vm, this_value, mal_value_new_undefined(), false);
}

static MalValue instant_value_of(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) args; (void) arg_count; (void) new_target; (void) callee;
    return temporal_throw_type(vm, "Cannot convert Temporal.Instant to a primitive");
}

static MalValue instant_to_zoned_date_time_iso(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!instant_this(vm, this_value, &object)) return mal_value_new_undefined();
    TimeZone zone;
    if (!temporal_time_zone_from_value(
            vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), &zone)) {
        return mal_value_new_undefined();
    }
    temporal_rs_Instant_to_zoned_date_time_iso_result result =
        temporal_rs_Instant_to_zoned_date_time_iso(object->handle, zone);
    return result.is_ok ? zoned_date_time_wrap_intrinsic(vm, result.ok)
                        : temporal_throw(vm, result.err);
}

static bool zoned_date_time_this(MalVm *vm, MalValue value, MalTemporalObject **out) {
    if (!mal_value_is_temporal_object(value)) {
        temporal_throw_type(vm, "Temporal.ZonedDateTime method called on incompatible receiver");
        return false;
    }
    MalTemporalObject *object = mal_value_to_temporal_object(value);
    if (object->kind != MAL_TEMPORAL_ZONED_DATE_TIME || object->handle == nullptr) {
        temporal_throw_type(vm, "Temporal.ZonedDateTime method called on incompatible receiver");
        return false;
    }
    *out = object;
    return true;
}

static MalValue zoned_date_time_wrap(
    MalVm *vm, ZonedDateTime *handle, MalObject *prototype
) {
    return mal_value_from_temporal_object(mal_temporal_object_new(
        &vm->heap, prototype, MAL_TEMPORAL_ZONED_DATE_TIME, handle));
}

static MalValue zoned_date_time_wrap_intrinsic(MalVm *vm, ZonedDateTime *handle) {
    return zoned_date_time_wrap(
        vm, handle,
        mal_value_to_object(
            vm->intrinsics[MAL_INTRINSIC_TEMPORAL_ZONED_DATE_TIME_PROTOTYPE]));
}

static ZonedDateTime *zoned_date_time_from_like_options(
    MalVm *vm, MalValue input, MalValue options
) {
    if (mal_value_is_temporal_object(input)) {
        MalTemporalObject *object = mal_value_to_temporal_object(input);
        if (object->kind == MAL_TEMPORAL_ZONED_DATE_TIME && object->handle != nullptr) {
            ArithmeticOverflow overflow;
            if (!temporal_overflow_option(vm, options, &overflow)) return nullptr;
            return temporal_rs_ZonedDateTime_clone(object->handle);
        }
    }
    if (mal_value_is_string(input)) {
        MalString *string = mal_value_to_string(input);
        DiplomatString16View view = {
            .data = (const char16_t *) mal_string_code_units(string),
            .len = mal_string_length(string),
        };
        temporal_rs_ZonedDateTime_from_utf16_result validated =
            temporal_rs_ZonedDateTime_from_utf16(
                view, Disambiguation_Compatible, OffsetDisambiguation_Reject);
        if (!validated.is_ok) {
            temporal_throw(vm, validated.err);
            return nullptr;
        }
        temporal_rs_ZonedDateTime_destroy(validated.ok);
        Disambiguation disambiguation = Disambiguation_Compatible;
        OffsetDisambiguation offset = OffsetDisambiguation_Reject;
        ArithmeticOverflow overflow;
        bool present;
        if (!temporal_options_object(vm, options, &present)) return nullptr;
        if (present) {
            MalValue value;
            MalString *option;
            if (!mal_vm_get_property(
                    vm, options, mal_intrinsic_string_key(vm, "disambiguation"),
                    &value)) return nullptr;
            if (!mal_value_is_undefined(value)) {
                if (!mal_vm_to_string(vm, value, &option)) return nullptr;
                if (mal_string_equals_ascii(option, "compatible")) {}
                else if (mal_string_equals_ascii(option, "earlier"))
                    disambiguation = Disambiguation_Earlier;
                else if (mal_string_equals_ascii(option, "later"))
                    disambiguation = Disambiguation_Later;
                else if (mal_string_equals_ascii(option, "reject"))
                    disambiguation = Disambiguation_Reject;
                else {
                    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                                       "Invalid Temporal disambiguation option");
                    return nullptr;
                }
            }
            if (!mal_vm_get_property(
                    vm, options, mal_intrinsic_string_key(vm, "offset"), &value)) {
                return nullptr;
            }
            if (!mal_value_is_undefined(value)) {
                if (!mal_vm_to_string(vm, value, &option)) return nullptr;
                if (mal_string_equals_ascii(option, "use")) offset = OffsetDisambiguation_Use;
                else if (mal_string_equals_ascii(option, "prefer"))
                    offset = OffsetDisambiguation_Prefer;
                else if (mal_string_equals_ascii(option, "ignore"))
                    offset = OffsetDisambiguation_Ignore;
                else if (mal_string_equals_ascii(option, "reject")) {}
                else {
                    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                                       "Invalid Temporal offset option");
                    return nullptr;
                }
            }
        }
        if (!temporal_overflow_option(vm, options, &overflow)) return nullptr;
        temporal_rs_ZonedDateTime_from_utf16_result result =
            temporal_rs_ZonedDateTime_from_utf16(view, disambiguation, offset);
        if (!result.is_ok) {
            temporal_throw(vm, result.err);
            return nullptr;
        }
        return result.ok;
    }
    if (!mal_value_is_object(input)) {
        temporal_throw_type(vm, "Temporal.ZonedDateTime input must be a string or object");
        return nullptr;
    }

    ArithmeticOverflow overflow = ArithmeticOverflow_Constrain;

    PlainDatePartial date;
    if (!plain_date_partial_from_object(vm, input, &date)) return nullptr;
    PlainTimeFields time_fields;
    if (!plain_time_read_fields(vm, input, &time_fields, false)) {
        plain_date_partial_destroy(&date);
        return nullptr;
    }
    PartialTime time;
    if (!plain_time_partial(vm, &time_fields, overflow, &time)) {
        plain_date_partial_destroy(&date);
        return nullptr;
    }
    MalValue value;
    if (!mal_vm_get_property(
            vm, input, mal_intrinsic_string_key(vm, "offset"), &value)) {
        plain_date_partial_destroy(&date);
        return nullptr;
    }
    byte *offset_data = nullptr;
    OptionStringView offset = {.is_ok = false};
    if (!mal_value_is_undefined(value)) {
        MalString *string;
        if (!mal_vm_to_string(vm, value, &string)) {
            plain_date_partial_destroy(&date);
            return nullptr;
        }
        usize length;
        offset_data = mal_string_to_utf8(string, &length);
        if (offset_data == nullptr) {
            plain_date_partial_destroy(&date);
            temporal_throw_type(vm, "Unable to encode Temporal offset");
            return nullptr;
        }
        offset = (OptionStringView) {
            .ok = {.data = (const char *) offset_data, .len = length}, .is_ok = true};
    }
    if (!mal_vm_get_property(
            vm, input, mal_intrinsic_string_key(vm, "timeZone"), &value)) {
        free(offset_data); plain_date_partial_destroy(&date); return nullptr;
    }
    TimeZone zone;
    if (!temporal_time_zone_from_value(vm, value, &zone)) {
        free(offset_data); plain_date_partial_destroy(&date); return nullptr;
    }
    Disambiguation disambiguation = Disambiguation_Compatible;
    OffsetDisambiguation offset_option = OffsetDisambiguation_Reject;
    bool options_present;
    if (!temporal_options_object(vm, options, &options_present)) {
        free(offset_data); plain_date_partial_destroy(&date); return nullptr;
    }
    if (options_present) {
        MalValue option_value;
        MalString *string;
        if (!mal_vm_get_property(
                vm, options, mal_intrinsic_string_key(vm, "disambiguation"),
                &option_value)) {
            free(offset_data); plain_date_partial_destroy(&date); return nullptr;
        }
        if (!mal_value_is_undefined(option_value)) {
            if (!mal_vm_to_string(vm, option_value, &string)) {
                free(offset_data); plain_date_partial_destroy(&date); return nullptr;
            }
            if (mal_string_equals_ascii(string, "compatible")) {}
            else if (mal_string_equals_ascii(string, "earlier"))
                disambiguation = Disambiguation_Earlier;
            else if (mal_string_equals_ascii(string, "later"))
                disambiguation = Disambiguation_Later;
            else if (mal_string_equals_ascii(string, "reject"))
                disambiguation = Disambiguation_Reject;
            else {
                free(offset_data); plain_date_partial_destroy(&date);
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                                   "Invalid Temporal disambiguation option");
                return nullptr;
            }
        }
        if (!mal_vm_get_property(
                vm, options, mal_intrinsic_string_key(vm, "offset"), &option_value)) {
            free(offset_data); plain_date_partial_destroy(&date); return nullptr;
        }
        if (!mal_value_is_undefined(option_value)) {
            if (!mal_vm_to_string(vm, option_value, &string)) {
                free(offset_data); plain_date_partial_destroy(&date); return nullptr;
            }
            if (mal_string_equals_ascii(string, "use")) offset_option = OffsetDisambiguation_Use;
            else if (mal_string_equals_ascii(string, "prefer"))
                offset_option = OffsetDisambiguation_Prefer;
            else if (mal_string_equals_ascii(string, "ignore"))
                offset_option = OffsetDisambiguation_Ignore;
            else if (mal_string_equals_ascii(string, "reject")) {}
            else {
                free(offset_data); plain_date_partial_destroy(&date);
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                                   "Invalid Temporal offset option");
                return nullptr;
            }
        }
    }
    if (!temporal_overflow_option(vm, options, &overflow)) {
        free(offset_data); plain_date_partial_destroy(&date); return nullptr;
    }
    PartialZonedDateTime partial = {
        .date = date.partial, .time = time, .offset = offset,
        .timezone = {.ok = zone, .is_ok = true},
    };
    temporal_rs_ZonedDateTime_from_partial_result result =
        temporal_rs_ZonedDateTime_from_partial(
            partial, (ArithmeticOverflow_option) {.ok = overflow, .is_ok = true},
            (Disambiguation_option) {.ok = disambiguation, .is_ok = true},
            (OffsetDisambiguation_option) {.ok = offset_option, .is_ok = true});
    free(offset_data);
    plain_date_partial_destroy(&date);
    if (!result.is_ok) {
        temporal_throw(vm, result.err);
        return nullptr;
    }
    return result.ok;
}

static ZonedDateTime *zoned_date_time_from_like(MalVm *vm, MalValue input) {
    return zoned_date_time_from_like_options(vm, input, mal_value_new_undefined());
}

static MalValue zoned_date_time_constructor(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) callee;
    if (mal_value_is_undefined(new_target)) {
        return temporal_throw_type(vm, "Temporal.ZonedDateTime must be called with new");
    }
    i128 nanoseconds;
    if (!mal_bigint_to_bigint(
            vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), &nanoseconds)) {
        return mal_value_new_undefined();
    }
    TimeZone zone;
    if (!temporal_time_zone_from_value(
            vm, arg_count > 1 ? args[1] : mal_value_new_undefined(), &zone)) {
        return mal_value_new_undefined();
    }
    AnyCalendarKind calendar;
    if (!temporal_calendar_kind(
            vm, arg_count > 2 ? args[2] : mal_value_new_undefined(), &calendar)) {
        return mal_value_new_undefined();
    }
    temporal_rs_ZonedDateTime_try_new_result result = temporal_rs_ZonedDateTime_try_new(
        temporal_i128_to_nanoseconds(nanoseconds), calendar, zone);
    if (!result.is_ok) return temporal_throw(vm, result.err);
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, new_target, MAL_INTRINSIC_TEMPORAL_ZONED_DATE_TIME_PROTOTYPE,
            &prototype)) {
        temporal_rs_ZonedDateTime_destroy(result.ok);
        return mal_value_new_undefined();
    }
    return zoned_date_time_wrap(vm, result.ok, prototype);
}

static MalValue zoned_date_time_from(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) new_target; (void) callee;
    ZonedDateTime *handle = zoned_date_time_from_like_options(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined(),
        arg_count > 1 ? args[1] : mal_value_new_undefined());
    return handle == nullptr ? mal_value_new_undefined()
                             : zoned_date_time_wrap_intrinsic(vm, handle);
}

static MalValue zoned_date_time_compare(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) new_target; (void) callee;
    ZonedDateTime *one = zoned_date_time_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined());
    if (one == nullptr) return mal_value_new_undefined();
    ZonedDateTime *two = zoned_date_time_from_like(
        vm, arg_count > 1 ? args[1] : mal_value_new_undefined());
    if (two == nullptr) {
        temporal_rs_ZonedDateTime_destroy(one);
        return mal_value_new_undefined();
    }
    i8 result = temporal_rs_ZonedDateTime_compare_instant(one, two);
    temporal_rs_ZonedDateTime_destroy(one);
    temporal_rs_ZonedDateTime_destroy(two);
    return mal_value_from_i32(result);
}

#define ZONED_DATE_TIME_GETTER(c_name, ffi_name) \
    static MalValue c_name(MalVm *vm, MalValue this_value, const MalValue *args, \
                           i32 arg_count, MalValue new_target, MalValue callee) { \
        (void) args; (void) arg_count; (void) new_target; (void) callee; \
        MalTemporalObject *object; \
        if (!zoned_date_time_this(vm, this_value, &object)) \
            return mal_value_new_undefined(); \
        return mal_value_from_i32((i32) ffi_name(object->handle)); \
    }

ZONED_DATE_TIME_GETTER(zoned_date_time_year, temporal_rs_ZonedDateTime_year)
ZONED_DATE_TIME_GETTER(zoned_date_time_month, temporal_rs_ZonedDateTime_month)
ZONED_DATE_TIME_GETTER(zoned_date_time_day, temporal_rs_ZonedDateTime_day)
ZONED_DATE_TIME_GETTER(zoned_date_time_hour, temporal_rs_ZonedDateTime_hour)
ZONED_DATE_TIME_GETTER(zoned_date_time_minute, temporal_rs_ZonedDateTime_minute)
ZONED_DATE_TIME_GETTER(zoned_date_time_second, temporal_rs_ZonedDateTime_second)
ZONED_DATE_TIME_GETTER(zoned_date_time_millisecond, temporal_rs_ZonedDateTime_millisecond)
ZONED_DATE_TIME_GETTER(zoned_date_time_microsecond, temporal_rs_ZonedDateTime_microsecond)
ZONED_DATE_TIME_GETTER(zoned_date_time_nanosecond, temporal_rs_ZonedDateTime_nanosecond)
ZONED_DATE_TIME_GETTER(zoned_date_time_day_of_week, temporal_rs_ZonedDateTime_day_of_week)
ZONED_DATE_TIME_GETTER(zoned_date_time_day_of_year, temporal_rs_ZonedDateTime_day_of_year)
ZONED_DATE_TIME_GETTER(zoned_date_time_days_in_week, temporal_rs_ZonedDateTime_days_in_week)
ZONED_DATE_TIME_GETTER(zoned_date_time_days_in_month, temporal_rs_ZonedDateTime_days_in_month)
ZONED_DATE_TIME_GETTER(zoned_date_time_days_in_year, temporal_rs_ZonedDateTime_days_in_year)
ZONED_DATE_TIME_GETTER(zoned_date_time_months_in_year, temporal_rs_ZonedDateTime_months_in_year)

static MalValue zoned_date_time_epoch_milliseconds(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!zoned_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    return mal_ops_number_value(
        (f64) temporal_rs_ZonedDateTime_epoch_milliseconds(object->handle));
}

static MalValue zoned_date_time_epoch_nanoseconds(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!zoned_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    i128 value = temporal_nanoseconds_to_i128(
        temporal_rs_ZonedDateTime_epoch_nanoseconds(object->handle));
    return mal_value_from_bigint(mal_bigint_new(&vm->heap, value));
}

static MalValue zoned_date_time_offset_nanoseconds(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!zoned_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    return mal_ops_number_value(
        (f64) temporal_rs_ZonedDateTime_offset_nanoseconds(object->handle));
}

static MalValue zoned_date_time_string_getter(
    MalVm *vm, MalValue this_value, bool timezone, bool month_code
) {
    MalTemporalObject *object;
    if (!zoned_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    DiplomatWrite *write = diplomat_buffer_write_create(32);
    if (timezone) {
        temporal_rs_TimeZone_identifier(
            temporal_rs_ZonedDateTime_timezone(object->handle), write);
    } else if (month_code) {
        temporal_rs_ZonedDateTime_month_code(object->handle, write);
    } else {
        temporal_rs_ZonedDateTime_offset_result result =
            temporal_rs_ZonedDateTime_offset(object->handle, write);
        if (!result.is_ok) {
            diplomat_buffer_write_destroy(write);
            return temporal_throw(vm, result.err);
        }
    }
    return temporal_write_to_string(vm, write);
}

#define ZONED_STRING_GETTER(c_name, timezone, month_code) \
    static MalValue c_name(MalVm *vm, MalValue this_value, const MalValue *args, \
                           i32 arg_count, MalValue new_target, MalValue callee) { \
        (void) args; (void) arg_count; (void) new_target; (void) callee; \
        return zoned_date_time_string_getter(vm, this_value, timezone, month_code); \
    }

ZONED_STRING_GETTER(zoned_date_time_time_zone_id, true, false)
ZONED_STRING_GETTER(zoned_date_time_month_code, false, true)
ZONED_STRING_GETTER(zoned_date_time_offset, false, false)

static MalValue zoned_date_time_calendar_id(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!zoned_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    return temporal_calendar_identifier(
        vm, temporal_rs_ZonedDateTime_calendar(object->handle));
}

static MalValue zoned_date_time_in_leap_year(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!zoned_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    return mal_value_new_boolean(
        temporal_rs_ZonedDateTime_in_leap_year(object->handle));
}

static MalValue zoned_date_time_hours_in_day(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!zoned_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    temporal_rs_ZonedDateTime_hours_in_day_result result =
        temporal_rs_ZonedDateTime_hours_in_day(object->handle);
    return result.is_ok ? mal_ops_number_value(result.ok) : temporal_throw(vm, result.err);
}

static MalValue zoned_date_time_optional_week(
    MalVm *vm, MalValue this_value, bool year
) {
    MalTemporalObject *object;
    if (!zoned_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    if (year) {
        temporal_rs_ZonedDateTime_year_of_week_result result =
            temporal_rs_ZonedDateTime_year_of_week(object->handle);
        return result.is_ok ? mal_value_from_i32(result.ok) : mal_value_new_undefined();
    }
    temporal_rs_ZonedDateTime_week_of_year_result result =
        temporal_rs_ZonedDateTime_week_of_year(object->handle);
    return result.is_ok ? mal_value_from_i32(result.ok) : mal_value_new_undefined();
}

static MalValue zoned_date_time_era(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!zoned_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    DiplomatWrite *write = diplomat_buffer_write_create(16);
    temporal_rs_ZonedDateTime_era(object->handle, write);
    if (diplomat_buffer_write_len(write) == 0) {
        diplomat_buffer_write_destroy(write);
        return mal_value_new_undefined();
    }
    return temporal_write_to_string(vm, write);
}

static MalValue zoned_date_time_era_year(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!zoned_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    temporal_rs_ZonedDateTime_era_year_result result =
        temporal_rs_ZonedDateTime_era_year(object->handle);
    return result.is_ok ? mal_value_from_i32(result.ok) : mal_value_new_undefined();
}

static MalValue zoned_date_time_week_of_year(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    return zoned_date_time_optional_week(vm, this_value, false);
}

static MalValue zoned_date_time_year_of_week(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    return zoned_date_time_optional_week(vm, this_value, true);
}

static MalValue zoned_date_time_add_or_subtract(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, bool subtract
) {
    MalTemporalObject *object;
    if (!zoned_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    Duration *duration = duration_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined());
    if (duration == nullptr) return mal_value_new_undefined();
    ArithmeticOverflow overflow;
    if (!temporal_overflow_option(
            vm, arg_count > 1 ? args[1] : mal_value_new_undefined(), &overflow)) {
        temporal_rs_Duration_destroy(duration);
        return mal_value_new_undefined();
    }
    ZonedDateTime *handle = nullptr;
    TemporalError error = {0};
    bool ok;
    if (subtract) {
        temporal_rs_ZonedDateTime_subtract_result result =
            temporal_rs_ZonedDateTime_subtract(
                object->handle, duration,
                (ArithmeticOverflow_option) {.ok = overflow, .is_ok = true});
        ok = result.is_ok; if (ok) handle = result.ok; else error = result.err;
    } else {
        temporal_rs_ZonedDateTime_add_result result = temporal_rs_ZonedDateTime_add(
            object->handle, duration,
            (ArithmeticOverflow_option) {.ok = overflow, .is_ok = true});
        ok = result.is_ok; if (ok) handle = result.ok; else error = result.err;
    }
    temporal_rs_Duration_destroy(duration);
    return ok ? zoned_date_time_wrap_intrinsic(vm, handle) : temporal_throw(vm, error);
}

#define ZONED_BINARY_METHOD(name, subtract) \
    static MalValue name(MalVm *vm, MalValue this_value, const MalValue *args, \
                         i32 arg_count, MalValue new_target, MalValue callee) { \
        (void) new_target; (void) callee; \
        return zoned_date_time_add_or_subtract( \
            vm, this_value, args, arg_count, subtract); \
    }

ZONED_BINARY_METHOD(zoned_date_time_add, false)
ZONED_BINARY_METHOD(zoned_date_time_subtract, true)

static MalValue zoned_date_time_equals(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!zoned_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    ZonedDateTime *other = zoned_date_time_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined());
    if (other == nullptr) return mal_value_new_undefined();
    bool equal = temporal_rs_ZonedDateTime_equals(object->handle, other);
    temporal_rs_ZonedDateTime_destroy(other);
    return mal_value_new_boolean(equal);
}

static bool zoned_date_time_difference_settings(
    MalVm *vm, MalValue value, DifferenceSettings *settings
) {
    *settings = (DifferenceSettings) {0};
    bool present;
    if (!temporal_options_object(vm, value, &present)) return false;
    Unit largest = Unit_Hour, smallest = Unit_Nanosecond;
    RoundingMode mode = RoundingMode_Trunc;
    u32 increment = 1;
    if (present &&
        (!temporal_get_unit_option(vm, value, "largestUnit", true, false,
                                   Unit_Auto, &largest) ||
         !temporal_get_rounding_increment(vm, value, &increment) ||
         !temporal_get_rounding_mode(vm, value, RoundingMode_Trunc, &mode) ||
         !temporal_get_unit_option(vm, value, "smallestUnit", false, false,
                                   Unit_Nanosecond, &smallest))) return false;
    if (largest == Unit_Auto) largest = smallest > Unit_Hour ? smallest : Unit_Hour;
    settings->largest_unit = (Unit_option) {.ok = largest, .is_ok = true};
    settings->smallest_unit = (Unit_option) {.ok = smallest, .is_ok = true};
    settings->rounding_mode = (RoundingMode_option) {.ok = mode, .is_ok = true};
    settings->increment = (OptionU32) {.ok = increment, .is_ok = true};
    return true;
}

static MalValue zoned_date_time_difference(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, bool since
) {
    MalTemporalObject *object;
    if (!zoned_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    ZonedDateTime *other = zoned_date_time_from_like(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined());
    if (other == nullptr) return mal_value_new_undefined();
    DifferenceSettings settings;
    if (!zoned_date_time_difference_settings(
            vm, arg_count > 1 ? args[1] : mal_value_new_undefined(), &settings)) {
        temporal_rs_ZonedDateTime_destroy(other);
        return mal_value_new_undefined();
    }
    Duration *handle = nullptr;
    TemporalError error = {0};
    bool ok;
    if (since) {
        temporal_rs_ZonedDateTime_since_result result =
            temporal_rs_ZonedDateTime_since(object->handle, other, settings);
        ok = result.is_ok; if (ok) handle = result.ok; else error = result.err;
    } else {
        temporal_rs_ZonedDateTime_until_result result =
            temporal_rs_ZonedDateTime_until(object->handle, other, settings);
        ok = result.is_ok; if (ok) handle = result.ok; else error = result.err;
    }
    temporal_rs_ZonedDateTime_destroy(other);
    return ok ? duration_wrap_intrinsic(vm, handle) : temporal_throw(vm, error);
}

#define ZONED_DIFFERENCE_METHOD(name, since) \
    static MalValue name(MalVm *vm, MalValue this_value, const MalValue *args, \
                         i32 arg_count, MalValue new_target, MalValue callee) { \
        (void) new_target; (void) callee; \
        return zoned_date_time_difference(vm, this_value, args, arg_count, since); \
    }

ZONED_DIFFERENCE_METHOD(zoned_date_time_since, true)
ZONED_DIFFERENCE_METHOD(zoned_date_time_until, false)

static MalValue zoned_date_time_round(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!zoned_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    RoundingOptions options;
    if (!plain_time_rounding_options(
            vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), &options)) {
        return mal_value_new_undefined();
    }
    temporal_rs_ZonedDateTime_round_result result =
        temporal_rs_ZonedDateTime_round(object->handle, options);
    return result.is_ok ? zoned_date_time_wrap_intrinsic(vm, result.ok)
                        : temporal_throw(vm, result.err);
}

static MalValue zoned_date_time_to_instant(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!zoned_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    return instant_wrap_intrinsic(
        vm, temporal_rs_ZonedDateTime_to_instant(object->handle));
}

static MalValue zoned_date_time_to_plain_date(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!zoned_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    return plain_date_wrap_intrinsic(
        vm, temporal_rs_ZonedDateTime_to_plain_date(object->handle));
}

static MalValue zoned_date_time_to_plain_time(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!zoned_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    return plain_time_wrap_intrinsic(
        vm, temporal_rs_ZonedDateTime_to_plain_time(object->handle));
}

static MalValue zoned_date_time_to_plain_date_time(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!zoned_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    return plain_date_time_wrap_intrinsic(
        vm, temporal_rs_ZonedDateTime_to_plain_datetime(object->handle));
}

static MalValue zoned_date_time_start_of_day(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!zoned_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    temporal_rs_ZonedDateTime_start_of_day_result result =
        temporal_rs_ZonedDateTime_start_of_day(object->handle);
    return result.is_ok ? zoned_date_time_wrap_intrinsic(vm, result.ok)
                        : temporal_throw(vm, result.err);
}

static MalValue zoned_date_time_get_time_zone_transition(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!zoned_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    MalString *string;
    if (!mal_vm_to_string(
            vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), &string)) {
        return mal_value_new_undefined();
    }
    TransitionDirection direction;
    if (mal_string_equals_ascii(string, "next")) direction = TransitionDirection_Next;
    else if (mal_string_equals_ascii(string, "previous")) {
        direction = TransitionDirection_Previous;
    } else {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Invalid Temporal transition direction");
        return mal_value_new_undefined();
    }
    temporal_rs_ZonedDateTime_get_time_zone_transition_result result =
        temporal_rs_ZonedDateTime_get_time_zone_transition(object->handle, direction);
    if (!result.is_ok) {
        if (result.err.kind == ErrorKind_Generic) return mal_value_new_null();
        return temporal_throw(vm, result.err);
    }
    return result.ok == nullptr ? mal_value_new_null()
                                : zoned_date_time_wrap_intrinsic(vm, result.ok);
}

static MalValue zoned_date_time_with_time_zone(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!zoned_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    TimeZone zone;
    if (!temporal_time_zone_from_value(
            vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), &zone)) {
        return mal_value_new_undefined();
    }
    temporal_rs_ZonedDateTime_with_timezone_result result =
        temporal_rs_ZonedDateTime_with_timezone(object->handle, zone);
    return result.is_ok ? zoned_date_time_wrap_intrinsic(vm, result.ok)
                        : temporal_throw(vm, result.err);
}

static bool zoned_date_time_option_string(
    MalVm *vm, MalValue options, const byte *name, const byte *fallback,
    MalString **out
) {
    bool present;
    if (!temporal_options_object(vm, options, &present)) return false;
    if (!present) {
        *out = mal_intrinsic_ascii(vm, fallback);
        return true;
    }
    MalValue value;
    if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, name), &value)) {
        return false;
    }
    if (mal_value_is_undefined(value)) {
        *out = mal_intrinsic_ascii(vm, fallback);
        return true;
    }
    return mal_vm_to_string(vm, value, out);
}

static bool zoned_date_time_disambiguation_options(
    MalVm *vm, MalValue options, Disambiguation *disambiguation,
    OffsetDisambiguation *offset
) {
    MalString *string;
    if (!zoned_date_time_option_string(
            vm, options, "disambiguation", "compatible", &string)) return false;
    if (mal_string_equals_ascii(string, "compatible")) {
        *disambiguation = Disambiguation_Compatible;
    } else if (mal_string_equals_ascii(string, "earlier")) {
        *disambiguation = Disambiguation_Earlier;
    } else if (mal_string_equals_ascii(string, "later")) {
        *disambiguation = Disambiguation_Later;
    } else if (mal_string_equals_ascii(string, "reject")) {
        *disambiguation = Disambiguation_Reject;
    } else {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Invalid Temporal disambiguation option");
        return false;
    }
    if (!zoned_date_time_option_string(vm, options, "offset", "prefer", &string)) {
        return false;
    }
    if (mal_string_equals_ascii(string, "use")) *offset = OffsetDisambiguation_Use;
    else if (mal_string_equals_ascii(string, "prefer")) {
        *offset = OffsetDisambiguation_Prefer;
    } else if (mal_string_equals_ascii(string, "ignore")) {
        *offset = OffsetDisambiguation_Ignore;
    } else if (mal_string_equals_ascii(string, "reject")) {
        *offset = OffsetDisambiguation_Reject;
    } else {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Invalid Temporal offset option");
        return false;
    }
    return true;
}

static MalValue zoned_date_time_with(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!zoned_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    MalValue input = arg_count > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_object(input) || mal_value_is_temporal_object(input)) {
        return temporal_throw_type(vm, "Temporal.ZonedDateTime.with requires a property bag");
    }
    MalValue value;
    if (!mal_vm_get_property(
            vm, input, mal_intrinsic_string_key(vm, "calendar"), &value)) {
        return mal_value_new_undefined();
    }
    if (!mal_value_is_undefined(value)) {
        return temporal_throw_type(vm, "Temporal.ZonedDateTime.with rejects calendar");
    }
    PlainDatePartial date;
    if (!plain_date_partial_from_object_impl(vm, input, &date, false)) {
        return mal_value_new_undefined();
    }
    PlainTimeFields time_fields;
    if (!plain_time_read_fields(vm, input, &time_fields, false)) {
        plain_date_partial_destroy(&date);
        return mal_value_new_undefined();
    }
    PartialTime time;
    if (!plain_time_partial(
            vm, &time_fields, ArithmeticOverflow_Constrain, &time)) {
        plain_date_partial_destroy(&date);
        return mal_value_new_undefined();
    }
    if (!mal_vm_get_property(
            vm, input, mal_intrinsic_string_key(vm, "offset"), &value)) {
        plain_date_partial_destroy(&date);
        return mal_value_new_undefined();
    }
    byte *offset_data = nullptr;
    OptionStringView offset_string = {.is_ok = false};
    if (!mal_value_is_undefined(value)) {
        MalString *string;
        if (!mal_vm_to_string(vm, value, &string)) {
            plain_date_partial_destroy(&date);
            return mal_value_new_undefined();
        }
        usize length;
        offset_data = mal_string_to_utf8(string, &length);
        if (offset_data == nullptr) {
            plain_date_partial_destroy(&date);
            return temporal_throw_type(vm, "Unable to encode Temporal offset");
        }
        offset_string = (OptionStringView) {
            .ok = {.data = (const char *) offset_data, .len = length}, .is_ok = true};
    }
    if (!mal_vm_get_property(
            vm, input, mal_intrinsic_string_key(vm, "timeZone"), &value)) {
        free(offset_data); plain_date_partial_destroy(&date);
        return mal_value_new_undefined();
    }
    if (!mal_value_is_undefined(value)) {
        free(offset_data); plain_date_partial_destroy(&date);
        return temporal_throw_type(vm, "Temporal.ZonedDateTime.with rejects timeZone");
    }
    MalValue options = arg_count > 1 ? args[1] : mal_value_new_undefined();
    Disambiguation disambiguation;
    OffsetDisambiguation offset;
    ArithmeticOverflow overflow;
    if (!zoned_date_time_disambiguation_options(
            vm, options, &disambiguation, &offset) ||
        !temporal_overflow_option(vm, options, &overflow)) {
        free(offset_data); plain_date_partial_destroy(&date);
        return mal_value_new_undefined();
    }
    PartialZonedDateTime partial = {
        .date = date.partial, .time = time, .offset = offset_string,
        .timezone = {.is_ok = false},
    };
    temporal_rs_ZonedDateTime_with_result result = temporal_rs_ZonedDateTime_with(
        object->handle, partial,
        (Disambiguation_option) {.ok = disambiguation, .is_ok = true},
        (OffsetDisambiguation_option) {.ok = offset, .is_ok = true},
        (ArithmeticOverflow_option) {.ok = overflow, .is_ok = true});
    free(offset_data);
    plain_date_partial_destroy(&date);
    return result.is_ok ? zoned_date_time_wrap_intrinsic(vm, result.ok)
                        : temporal_throw(vm, result.err);
}

static MalValue zoned_date_time_with_calendar(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!zoned_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    AnyCalendarKind calendar;
    if (!temporal_calendar_kind(
            vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), &calendar)) {
        return mal_value_new_undefined();
    }
    return zoned_date_time_wrap_intrinsic(
        vm, temporal_rs_ZonedDateTime_with_calendar(object->handle, calendar));
}

static MalValue zoned_date_time_with_plain_time(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!zoned_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    PlainTime *time = nullptr;
    bool owned = false;
    if (arg_count > 0 && !mal_value_is_undefined(args[0])) {
        time = plain_time_from_like(vm, args[0], mal_value_new_undefined());
        if (time == nullptr) return mal_value_new_undefined();
        owned = true;
    }
    temporal_rs_ZonedDateTime_with_plain_time_result result =
        temporal_rs_ZonedDateTime_with_plain_time(object->handle, time);
    if (owned) temporal_rs_PlainTime_destroy(time);
    return result.is_ok ? zoned_date_time_wrap_intrinsic(vm, result.ok)
                        : temporal_throw(vm, result.err);
}

static MalValue zoned_date_time_to_string_impl(
    MalVm *vm, MalValue this_value, MalValue options_value, bool read_options
) {
    MalTemporalObject *object;
    if (!zoned_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    ToStringRoundingOptions rounding = {
        .precision = {.is_minute = false, .precision = {.is_ok = false}},
        .smallest_unit = {.is_ok = false},
        .rounding_mode = {.ok = RoundingMode_Trunc, .is_ok = true},
    };
    DisplayCalendar calendar = DisplayCalendar_Auto;
    DisplayOffset offset = DisplayOffset_Auto;
    DisplayTimeZone timezone = DisplayTimeZone_Auto;
    if (read_options) {
        if (!temporal_display_calendar(vm, options_value, &calendar) ||
            !temporal_to_string_rounding_options(vm, options_value, &rounding)) {
            return mal_value_new_undefined();
        }
        if (!mal_value_is_undefined(options_value)) {
            MalValue value;
            MalString *string;
            if (!mal_vm_get_property(
                    vm, options_value, mal_intrinsic_string_key(vm, "offset"),
                    &value)) return mal_value_new_undefined();
            if (!mal_value_is_undefined(value)) {
                if (!mal_vm_to_string(vm, value, &string)) return mal_value_new_undefined();
                if (mal_string_equals_ascii(string, "never")) offset = DisplayOffset_Never;
                else if (!mal_string_equals_ascii(string, "auto")) {
                    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                                       "Invalid Temporal offset display option");
                    return mal_value_new_undefined();
                }
            }
            if (!mal_vm_get_property(
                    vm, options_value, mal_intrinsic_string_key(vm, "timeZoneName"),
                    &value)) return mal_value_new_undefined();
            if (!mal_value_is_undefined(value)) {
                if (!mal_vm_to_string(vm, value, &string)) return mal_value_new_undefined();
                if (mal_string_equals_ascii(string, "never")) timezone = DisplayTimeZone_Never;
                else if (mal_string_equals_ascii(string, "critical"))
                    timezone = DisplayTimeZone_Critical;
                else if (!mal_string_equals_ascii(string, "auto")) {
                    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                                       "Invalid Temporal timeZoneName option");
                    return mal_value_new_undefined();
                }
            }
        }
    }
    DiplomatWrite *write = diplomat_buffer_write_create(80);
    temporal_rs_ZonedDateTime_to_ixdtf_string_result result =
        temporal_rs_ZonedDateTime_to_ixdtf_string(
            object->handle, offset, timezone, calendar, rounding, write);
    if (!result.is_ok) {
        diplomat_buffer_write_destroy(write);
        return temporal_throw(vm, result.err);
    }
    return temporal_write_to_string(vm, write);
}

static MalValue zoned_date_time_to_string(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    return zoned_date_time_to_string_impl(
        vm, this_value, arg_count > 0 ? args[0] : mal_value_new_undefined(), true);
}

static MalValue zoned_date_time_to_string_no_options(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) args; (void) arg_count; (void) new_target; (void) callee;
    return zoned_date_time_to_string_impl(
        vm, this_value, mal_value_new_undefined(), false);
}

static MalValue zoned_date_time_value_of(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) args; (void) arg_count; (void) new_target; (void) callee;
    return temporal_throw_type(vm, "Cannot convert Temporal.ZonedDateTime to a primitive");
}

static bool temporal_now_nanoseconds(MalVm *vm, i128 *out) {
    struct timespec time;
    if (timespec_get(&time, TIME_UTC) != TIME_UTC) {
        temporal_throw_type(vm, "Unable to read the system clock");
        return false;
    }
    *out = (i128) time.tv_sec * 1000000000 + time.tv_nsec;
    return true;
}

static bool temporal_now_zone(MalVm *vm, MalValue value, TimeZone *out) {
    if (mal_value_is_undefined(value)) {
        u8 identifier[256];
        i32 length = mal_i18n_local_tz_name(identifier, (i32) sizeof(identifier));
        if (length < 0 || length > (i32) sizeof(identifier)) {
            temporal_throw_type(vm, "Unable to resolve the system time zone");
            return false;
        }
        temporal_rs_TimeZone_try_from_identifier_str_result result =
            temporal_rs_TimeZone_try_from_identifier_str(
                (DiplomatStringView) {
                    .data = (const char *) identifier, .len = (usize) length});
        if (!result.is_ok) {
            temporal_throw(vm, result.err);
            return false;
        }
        *out = result.ok;
        return true;
    }
    return temporal_time_zone_from_value(vm, value, out);
}

static Instant *temporal_now_instant_handle(MalVm *vm) {
    i128 nanoseconds;
    if (!temporal_now_nanoseconds(vm, &nanoseconds)) return nullptr;
    temporal_rs_Instant_try_new_result result =
        temporal_rs_Instant_try_new(temporal_i128_to_nanoseconds(nanoseconds));
    if (!result.is_ok) {
        temporal_throw(vm, result.err);
        return nullptr;
    }
    return result.ok;
}

static ZonedDateTime *temporal_now_zoned_handle(
    MalVm *vm, MalValue zone_value
) {
    i128 nanoseconds;
    if (!temporal_now_nanoseconds(vm, &nanoseconds)) return nullptr;
    TimeZone zone;
    if (!temporal_now_zone(vm, zone_value, &zone)) return nullptr;
    temporal_rs_ZonedDateTime_try_new_result result = temporal_rs_ZonedDateTime_try_new(
        temporal_i128_to_nanoseconds(nanoseconds), AnyCalendarKind_Iso, zone);
    if (!result.is_ok) {
        temporal_throw(vm, result.err);
        return nullptr;
    }
    return result.ok;
}

static MalValue temporal_now_instant(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) args; (void) arg_count; (void) new_target; (void) callee;
    Instant *handle = temporal_now_instant_handle(vm);
    return handle == nullptr ? mal_value_new_undefined()
                             : instant_wrap_intrinsic(vm, handle);
}

static MalValue temporal_now_zoned_date_time_iso(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) new_target; (void) callee;
    ZonedDateTime *handle = temporal_now_zoned_handle(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined());
    return handle == nullptr ? mal_value_new_undefined()
                             : zoned_date_time_wrap_intrinsic(vm, handle);
}

static MalValue temporal_now_plain_date_time_iso(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) new_target; (void) callee;
    ZonedDateTime *zoned = temporal_now_zoned_handle(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined());
    if (zoned == nullptr) return mal_value_new_undefined();
    PlainDateTime *handle = temporal_rs_ZonedDateTime_to_plain_datetime(zoned);
    temporal_rs_ZonedDateTime_destroy(zoned);
    return plain_date_time_wrap_intrinsic(vm, handle);
}

static MalValue temporal_now_plain_date_iso(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) new_target; (void) callee;
    ZonedDateTime *zoned = temporal_now_zoned_handle(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined());
    if (zoned == nullptr) return mal_value_new_undefined();
    PlainDate *handle = temporal_rs_ZonedDateTime_to_plain_date(zoned);
    temporal_rs_ZonedDateTime_destroy(zoned);
    return plain_date_wrap_intrinsic(vm, handle);
}

static MalValue temporal_now_plain_time_iso(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) new_target; (void) callee;
    ZonedDateTime *zoned = temporal_now_zoned_handle(
        vm, arg_count > 0 ? args[0] : mal_value_new_undefined());
    if (zoned == nullptr) return mal_value_new_undefined();
    PlainTime *handle = temporal_rs_ZonedDateTime_to_plain_time(zoned);
    temporal_rs_ZonedDateTime_destroy(zoned);
    return plain_time_wrap_intrinsic(vm, handle);
}

static MalValue temporal_now_time_zone_id(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value; (void) args; (void) arg_count; (void) new_target; (void) callee;
    u8 identifier[256];
    i32 length = mal_i18n_local_tz_name(identifier, (i32) sizeof(identifier));
    if (length < 0 || length > (i32) sizeof(identifier)) {
        return temporal_throw_type(vm, "Unable to resolve the system time zone");
    }
    return mal_value_from_string(mal_string_from_utf8(
        &vm->heap, (const byte *) identifier, (usize) length));
}

static MalValue plain_date_time_to_zoned_date_time(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_date_time_this(vm, this_value, &object)) return mal_value_new_undefined();
    TimeZone zone;
    if (!temporal_time_zone_from_value(
            vm, arg_count > 0 ? args[0] : mal_value_new_undefined(), &zone)) {
        return mal_value_new_undefined();
    }
    MalString *string;
    if (!zoned_date_time_option_string(
            vm, arg_count > 1 ? args[1] : mal_value_new_undefined(),
            "disambiguation", "compatible", &string)) {
        return mal_value_new_undefined();
    }
    Disambiguation disambiguation;
    if (mal_string_equals_ascii(string, "compatible")) {
        disambiguation = Disambiguation_Compatible;
    } else if (mal_string_equals_ascii(string, "earlier")) {
        disambiguation = Disambiguation_Earlier;
    } else if (mal_string_equals_ascii(string, "later")) {
        disambiguation = Disambiguation_Later;
    } else if (mal_string_equals_ascii(string, "reject")) {
        disambiguation = Disambiguation_Reject;
    } else {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Invalid Temporal disambiguation option");
        return mal_value_new_undefined();
    }
    temporal_rs_PlainDateTime_to_zoned_date_time_result result =
        temporal_rs_PlainDateTime_to_zoned_date_time(
            object->handle, zone, disambiguation);
    return result.is_ok ? zoned_date_time_wrap_intrinsic(vm, result.ok)
                        : temporal_throw(vm, result.err);
}

static MalValue plain_date_to_zoned_date_time(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) new_target; (void) callee;
    MalTemporalObject *object;
    if (!plain_date_this(vm, this_value, &object)) return mal_value_new_undefined();
    MalValue input = arg_count > 0 ? args[0] : mal_value_new_undefined();
    MalValue zone_value = input;
    PlainTime *time = nullptr;
    if (mal_value_is_object(input) && !mal_value_is_string(input)) {
        MalValue value;
        if (!mal_vm_get_property(
                vm, input, mal_intrinsic_string_key(vm, "plainTime"), &value)) {
            return mal_value_new_undefined();
        }
        if (!mal_value_is_undefined(value)) {
            time = plain_time_from_like(vm, value, mal_value_new_undefined());
            if (time == nullptr) return mal_value_new_undefined();
        }
        if (!mal_vm_get_property(
                vm, input, mal_intrinsic_string_key(vm, "timeZone"), &zone_value)) {
            if (time != nullptr) temporal_rs_PlainTime_destroy(time);
            return mal_value_new_undefined();
        }
    }
    TimeZone zone;
    if (!temporal_time_zone_from_value(vm, zone_value, &zone)) {
        if (time != nullptr) temporal_rs_PlainTime_destroy(time);
        return mal_value_new_undefined();
    }
    temporal_rs_PlainDate_to_zoned_date_time_result result =
        temporal_rs_PlainDate_to_zoned_date_time(object->handle, zone, time);
    if (time != nullptr) temporal_rs_PlainTime_destroy(time);
    return result.is_ok ? zoned_date_time_wrap_intrinsic(vm, result.ok)
                        : temporal_throw(vm, result.err);
}

static void temporal_set_tag(MalVm *vm, MalObject *object, const byte *tag) {
    MalPropertyDesc desc = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, tag)), MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(
        object, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &desc);
}

static void temporal_install_plain_date(MalVm *vm, MalObject *temporal) {
    MalObject *object_prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    MalObject *function_prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalObject *prototype = mal_object_new(&vm->heap, object_prototype);
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "PlainDate"), 3,
        plain_date_constructor);
    vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_DATE_CONSTRUCTOR] =
        mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_DATE_PROTOTYPE] =
        mal_value_from_object(prototype);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype",
                              vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_DATE_PROTOTYPE],
                              MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor",
                              vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_DATE_CONSTRUCTOR],
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "compare", 2,
                                  plain_date_compare);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "from", 1,
                                  plain_date_from);
    mal_intrinsic_define_data(vm, temporal, "PlainDate",
                              vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_DATE_CONSTRUCTOR],
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    struct {
        const byte *name;
        MalNativeFunctionCallback getter;
    } getters[] = {
        {"calendarId", plain_date_calendar_id}, {"year", plain_date_year},
        {"month", plain_date_month}, {"monthCode", plain_date_month_code},
        {"day", plain_date_day}, {"dayOfWeek", plain_date_day_of_week},
        {"dayOfYear", plain_date_day_of_year}, {"weekOfYear", plain_date_week_of_year},
        {"yearOfWeek", plain_date_year_of_week}, {"daysInWeek", plain_date_days_in_week},
        {"daysInMonth", plain_date_days_in_month}, {"daysInYear", plain_date_days_in_year},
        {"monthsInYear", plain_date_months_in_year}, {"inLeapYear", plain_date_in_leap_year},
        {"era", plain_date_era}, {"eraYear", plain_date_era_year},
    };
    for (usize i = 0; i < countof(getters); ++i) {
        byte getter_name[32] = "get ";
        usize length = 4;
        for (const byte *source = getters[i].name;
             *source != '\0' && length + 1 < sizeof(getter_name); ++source) {
            getter_name[length++] = *source;
        }
        getter_name[length] = '\0';
        mal_intrinsic_define_accessor_n(
            vm, prototype, mal_intrinsic_string_key(vm, getters[i].name),
            getter_name, 0, getters[i].getter, nullptr, 0, nullptr,
            MAL_PROPERTY_CONFIGURABLE);
    }
    mal_intrinsic_define_method_n(vm, prototype, "add", 1, plain_date_add);
    mal_intrinsic_define_method_n(vm, prototype, "equals", 1, plain_date_equals);
    mal_intrinsic_define_method_n(vm, prototype, "since", 1, plain_date_since);
    mal_intrinsic_define_method_n(vm, prototype, "subtract", 1, plain_date_subtract);
    mal_intrinsic_define_method_n(vm, prototype, "toJSON", 0,
                                  plain_date_to_string_no_options);
    mal_intrinsic_define_method_n(vm, prototype, "toLocaleString", 0,
                                  plain_date_to_string_no_options);
    mal_intrinsic_define_method_n(vm, prototype, "toString", 0, plain_date_to_string);
    mal_intrinsic_define_method_n(vm, prototype, "toPlainDateTime", 0,
                                  plain_date_to_plain_date_time);
    mal_intrinsic_define_method_n(vm, prototype, "toZonedDateTime", 1,
                                  plain_date_to_zoned_date_time);
    mal_intrinsic_define_method_n(vm, prototype, "toPlainMonthDay", 0,
                                  plain_date_to_plain_month_day);
    mal_intrinsic_define_method_n(vm, prototype, "toPlainYearMonth", 0,
                                  plain_date_to_plain_year_month);
    mal_intrinsic_define_method_n(vm, prototype, "until", 1, plain_date_until);
    mal_intrinsic_define_method_n(vm, prototype, "valueOf", 0, plain_date_value_of);
    mal_intrinsic_define_method_n(vm, prototype, "with", 1, plain_date_with);
    mal_intrinsic_define_method_n(vm, prototype, "withCalendar", 1,
                                  plain_date_with_calendar);
    temporal_set_tag(vm, prototype, "Temporal.PlainDate");
}

static void temporal_install_plain_date_time(MalVm *vm, MalObject *temporal) {
    MalObject *object_prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    MalObject *function_prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalObject *prototype = mal_object_new(&vm->heap, object_prototype);
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "PlainDateTime"), 3,
        plain_date_time_constructor);
    vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_DATE_TIME_CONSTRUCTOR] =
        mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_DATE_TIME_PROTOTYPE] =
        mal_value_from_object(prototype);
    mal_intrinsic_define_data(
        vm, (MalObject *) constructor, "prototype",
        vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_DATE_TIME_PROTOTYPE],
        MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(
        vm, prototype, "constructor",
        vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_DATE_TIME_CONSTRUCTOR],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "compare", 2,
                                  plain_date_time_compare);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "from", 1,
                                  plain_date_time_from);
    mal_intrinsic_define_data(
        vm, temporal, "PlainDateTime",
        vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_DATE_TIME_CONSTRUCTOR],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    struct {
        const byte *name;
        MalNativeFunctionCallback getter;
    } getters[] = {
        {"calendarId", plain_date_time_calendar_id}, {"year", plain_date_time_year},
        {"month", plain_date_time_month}, {"monthCode", plain_date_time_month_code},
        {"day", plain_date_time_day}, {"hour", plain_date_time_hour},
        {"minute", plain_date_time_minute}, {"second", plain_date_time_second},
        {"millisecond", plain_date_time_millisecond},
        {"microsecond", plain_date_time_microsecond},
        {"nanosecond", plain_date_time_nanosecond},
        {"dayOfWeek", plain_date_time_day_of_week},
        {"dayOfYear", plain_date_time_day_of_year},
        {"daysInWeek", plain_date_time_days_in_week},
        {"daysInMonth", plain_date_time_days_in_month},
        {"daysInYear", plain_date_time_days_in_year},
        {"monthsInYear", plain_date_time_months_in_year},
        {"inLeapYear", plain_date_time_in_leap_year},
        {"weekOfYear", plain_date_time_week_of_year},
        {"yearOfWeek", plain_date_time_year_of_week},
        {"era", plain_date_time_era}, {"eraYear", plain_date_time_era_year},
    };
    for (usize i = 0; i < countof(getters); ++i) {
        byte getter_name[32] = "get ";
        usize length = 4;
        for (const byte *source = getters[i].name;
             *source != '\0' && length + 1 < sizeof(getter_name); ++source) {
            getter_name[length++] = *source;
        }
        getter_name[length] = '\0';
        mal_intrinsic_define_accessor_n(
            vm, prototype, mal_intrinsic_string_key(vm, getters[i].name),
            getter_name, 0, getters[i].getter, nullptr, 0, nullptr,
            MAL_PROPERTY_CONFIGURABLE);
    }
    mal_intrinsic_define_method_n(vm, prototype, "add", 1, plain_date_time_add);
    mal_intrinsic_define_method_n(vm, prototype, "equals", 1, plain_date_time_equals);
    mal_intrinsic_define_method_n(vm, prototype, "round", 1, plain_date_time_round);
    mal_intrinsic_define_method_n(vm, prototype, "since", 1, plain_date_time_since);
    mal_intrinsic_define_method_n(vm, prototype, "subtract", 1,
                                  plain_date_time_subtract);
    mal_intrinsic_define_method_n(vm, prototype, "toJSON", 0,
                                  plain_date_time_to_string_no_options);
    mal_intrinsic_define_method_n(vm, prototype, "toLocaleString", 0,
                                  plain_date_time_to_string_no_options);
    mal_intrinsic_define_method_n(vm, prototype, "toPlainDate", 0,
                                  plain_date_time_to_plain_date);
    mal_intrinsic_define_method_n(vm, prototype, "toPlainTime", 0,
                                  plain_date_time_to_plain_time);
    mal_intrinsic_define_method_n(vm, prototype, "toString", 0,
                                  plain_date_time_to_string);
    mal_intrinsic_define_method_n(vm, prototype, "toZonedDateTime", 1,
                                  plain_date_time_to_zoned_date_time);
    mal_intrinsic_define_method_n(vm, prototype, "until", 1, plain_date_time_until);
    mal_intrinsic_define_method_n(vm, prototype, "valueOf", 0,
                                  plain_date_time_value_of);
    mal_intrinsic_define_method_n(vm, prototype, "withCalendar", 1,
                                  plain_date_time_with_calendar);
    mal_intrinsic_define_method_n(vm, prototype, "withPlainTime", 0,
                                  plain_date_time_with_plain_time);
    temporal_set_tag(vm, prototype, "Temporal.PlainDateTime");
}

static void temporal_install_plain_year_month(MalVm *vm, MalObject *temporal) {
    MalObject *object_prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    MalObject *function_prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalObject *prototype = mal_object_new(&vm->heap, object_prototype);
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "PlainYearMonth"), 2,
        plain_year_month_constructor);
    vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_YEAR_MONTH_CONSTRUCTOR] =
        mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_YEAR_MONTH_PROTOTYPE] =
        mal_value_from_object(prototype);
    mal_intrinsic_define_data(
        vm, (MalObject *) constructor, "prototype",
        vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_YEAR_MONTH_PROTOTYPE],
        MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(
        vm, prototype, "constructor",
        vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_YEAR_MONTH_CONSTRUCTOR],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "compare", 2,
                                  plain_year_month_compare);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "from", 1,
                                  plain_year_month_from);
    mal_intrinsic_define_data(
        vm, temporal, "PlainYearMonth",
        vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_YEAR_MONTH_CONSTRUCTOR],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    struct { const byte *name; MalNativeFunctionCallback getter; } getters[] = {
        {"calendarId", plain_year_month_calendar_id}, {"year", plain_year_month_year},
        {"month", plain_year_month_month}, {"monthCode", plain_year_month_month_code},
        {"daysInMonth", plain_year_month_days_in_month},
        {"daysInYear", plain_year_month_days_in_year},
        {"monthsInYear", plain_year_month_months_in_year},
        {"inLeapYear", plain_year_month_in_leap_year},
        {"era", plain_year_month_era}, {"eraYear", plain_year_month_era_year},
    };
    for (usize i = 0; i < countof(getters); ++i) {
        byte name[32] = "get "; usize length = 4;
        for (const byte *source = getters[i].name;
             *source != '\0' && length + 1 < sizeof(name); ++source) name[length++] = *source;
        name[length] = '\0';
        mal_intrinsic_define_accessor_n(
            vm, prototype, mal_intrinsic_string_key(vm, getters[i].name), name, 0,
            getters[i].getter, nullptr, 0, nullptr, MAL_PROPERTY_CONFIGURABLE);
    }
    mal_intrinsic_define_method_n(vm, prototype, "add", 1, plain_year_month_add);
    mal_intrinsic_define_method_n(vm, prototype, "equals", 1, plain_year_month_equals);
    mal_intrinsic_define_method_n(vm, prototype, "since", 1, plain_year_month_since);
    mal_intrinsic_define_method_n(vm, prototype, "subtract", 1,
                                  plain_year_month_subtract);
    mal_intrinsic_define_method_n(vm, prototype, "toJSON", 0,
                                  plain_year_month_to_string_no_options);
    mal_intrinsic_define_method_n(vm, prototype, "toLocaleString", 0,
                                  plain_year_month_to_string_no_options);
    mal_intrinsic_define_method_n(vm, prototype, "toString", 0,
                                  plain_year_month_to_string);
    mal_intrinsic_define_method_n(vm, prototype, "toPlainDate", 1,
                                  plain_year_month_to_plain_date);
    mal_intrinsic_define_method_n(vm, prototype, "until", 1, plain_year_month_until);
    mal_intrinsic_define_method_n(vm, prototype, "valueOf", 0,
                                  plain_year_month_value_of);
    mal_intrinsic_define_method_n(vm, prototype, "with", 1, plain_year_month_with);
    temporal_set_tag(vm, prototype, "Temporal.PlainYearMonth");
}

static void temporal_install_plain_month_day(MalVm *vm, MalObject *temporal) {
    MalObject *object_prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    MalObject *function_prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalObject *prototype = mal_object_new(&vm->heap, object_prototype);
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "PlainMonthDay"), 2,
        plain_month_day_constructor);
    vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_MONTH_DAY_CONSTRUCTOR] =
        mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_MONTH_DAY_PROTOTYPE] =
        mal_value_from_object(prototype);
    mal_intrinsic_define_data(
        vm, (MalObject *) constructor, "prototype",
        vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_MONTH_DAY_PROTOTYPE],
        MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(
        vm, prototype, "constructor",
        vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_MONTH_DAY_CONSTRUCTOR],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "from", 1,
                                  plain_month_day_from);
    mal_intrinsic_define_data(
        vm, temporal, "PlainMonthDay",
        vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_MONTH_DAY_CONSTRUCTOR],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    struct { const byte *name; MalNativeFunctionCallback getter; } getters[] = {
        {"calendarId", plain_month_day_calendar_id}, {"month", plain_month_day_month},
        {"monthCode", plain_month_day_month_code}, {"day", plain_month_day_day},
    };
    for (usize i = 0; i < countof(getters); ++i) {
        byte name[32] = "get "; usize length = 4;
        for (const byte *source = getters[i].name;
             *source != '\0' && length + 1 < sizeof(name); ++source) name[length++] = *source;
        name[length] = '\0';
        mal_intrinsic_define_accessor_n(
            vm, prototype, mal_intrinsic_string_key(vm, getters[i].name), name, 0,
            getters[i].getter, nullptr, 0, nullptr, MAL_PROPERTY_CONFIGURABLE);
    }
    mal_intrinsic_define_method_n(vm, prototype, "equals", 1, plain_month_day_equals);
    mal_intrinsic_define_method_n(vm, prototype, "toPlainDate", 1,
                                  plain_month_day_to_plain_date);
    mal_intrinsic_define_method_n(vm, prototype, "toJSON", 0,
                                  plain_month_day_to_string_no_options);
    mal_intrinsic_define_method_n(vm, prototype, "toLocaleString", 0,
                                  plain_month_day_to_string_no_options);
    mal_intrinsic_define_method_n(vm, prototype, "toString", 0,
                                  plain_month_day_to_string);
    mal_intrinsic_define_method_n(vm, prototype, "valueOf", 0,
                                  plain_month_day_value_of);
    mal_intrinsic_define_method_n(vm, prototype, "with", 1, plain_month_day_with);
    temporal_set_tag(vm, prototype, "Temporal.PlainMonthDay");
}

static void temporal_install_zoned_date_time(MalVm *vm, MalObject *temporal) {
    MalObject *object_prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    MalObject *function_prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalObject *prototype = mal_object_new(&vm->heap, object_prototype);
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "ZonedDateTime"), 2,
        zoned_date_time_constructor);
    vm->intrinsics[MAL_INTRINSIC_TEMPORAL_ZONED_DATE_TIME_CONSTRUCTOR] =
        mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_TEMPORAL_ZONED_DATE_TIME_PROTOTYPE] =
        mal_value_from_object(prototype);
    mal_intrinsic_define_data(
        vm, (MalObject *) constructor, "prototype",
        vm->intrinsics[MAL_INTRINSIC_TEMPORAL_ZONED_DATE_TIME_PROTOTYPE],
        MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(
        vm, prototype, "constructor",
        vm->intrinsics[MAL_INTRINSIC_TEMPORAL_ZONED_DATE_TIME_CONSTRUCTOR],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "compare", 2,
                                  zoned_date_time_compare);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "from", 1,
                                  zoned_date_time_from);
    mal_intrinsic_define_data(
        vm, temporal, "ZonedDateTime",
        vm->intrinsics[MAL_INTRINSIC_TEMPORAL_ZONED_DATE_TIME_CONSTRUCTOR],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    struct { const byte *name; MalNativeFunctionCallback getter; } getters[] = {
        {"calendarId", zoned_date_time_calendar_id},
        {"timeZoneId", zoned_date_time_time_zone_id},
        {"year", zoned_date_time_year}, {"month", zoned_date_time_month},
        {"monthCode", zoned_date_time_month_code}, {"day", zoned_date_time_day},
        {"hour", zoned_date_time_hour}, {"minute", zoned_date_time_minute},
        {"second", zoned_date_time_second},
        {"millisecond", zoned_date_time_millisecond},
        {"microsecond", zoned_date_time_microsecond},
        {"nanosecond", zoned_date_time_nanosecond},
        {"epochMilliseconds", zoned_date_time_epoch_milliseconds},
        {"epochNanoseconds", zoned_date_time_epoch_nanoseconds},
        {"offset", zoned_date_time_offset},
        {"offsetNanoseconds", zoned_date_time_offset_nanoseconds},
        {"dayOfWeek", zoned_date_time_day_of_week},
        {"dayOfYear", zoned_date_time_day_of_year},
        {"weekOfYear", zoned_date_time_week_of_year},
        {"yearOfWeek", zoned_date_time_year_of_week},
        {"hoursInDay", zoned_date_time_hours_in_day},
        {"daysInWeek", zoned_date_time_days_in_week},
        {"daysInMonth", zoned_date_time_days_in_month},
        {"daysInYear", zoned_date_time_days_in_year},
        {"monthsInYear", zoned_date_time_months_in_year},
        {"inLeapYear", zoned_date_time_in_leap_year},
        {"era", zoned_date_time_era}, {"eraYear", zoned_date_time_era_year},
    };
    for (usize i = 0; i < countof(getters); ++i) {
        byte name[40] = "get "; usize length = 4;
        for (const byte *source = getters[i].name;
             *source != '\0' && length + 1 < sizeof(name); ++source) name[length++] = *source;
        name[length] = '\0';
        mal_intrinsic_define_accessor_n(
            vm, prototype, mal_intrinsic_string_key(vm, getters[i].name), name, 0,
            getters[i].getter, nullptr, 0, nullptr, MAL_PROPERTY_CONFIGURABLE);
    }
    mal_intrinsic_define_method_n(vm, prototype, "add", 1, zoned_date_time_add);
    mal_intrinsic_define_method_n(vm, prototype, "equals", 1, zoned_date_time_equals);
    mal_intrinsic_define_method_n(vm, prototype, "getTimeZoneTransition", 1,
                                  zoned_date_time_get_time_zone_transition);
    mal_intrinsic_define_method_n(vm, prototype, "round", 1, zoned_date_time_round);
    mal_intrinsic_define_method_n(vm, prototype, "since", 1, zoned_date_time_since);
    mal_intrinsic_define_method_n(vm, prototype, "startOfDay", 0,
                                  zoned_date_time_start_of_day);
    mal_intrinsic_define_method_n(vm, prototype, "subtract", 1,
                                  zoned_date_time_subtract);
    mal_intrinsic_define_method_n(vm, prototype, "toInstant", 0,
                                  zoned_date_time_to_instant);
    mal_intrinsic_define_method_n(vm, prototype, "toJSON", 0,
                                  zoned_date_time_to_string_no_options);
    mal_intrinsic_define_method_n(vm, prototype, "toLocaleString", 0,
                                  zoned_date_time_to_string_no_options);
    mal_intrinsic_define_method_n(vm, prototype, "toPlainDate", 0,
                                  zoned_date_time_to_plain_date);
    mal_intrinsic_define_method_n(vm, prototype, "toPlainDateTime", 0,
                                  zoned_date_time_to_plain_date_time);
    mal_intrinsic_define_method_n(vm, prototype, "toPlainTime", 0,
                                  zoned_date_time_to_plain_time);
    mal_intrinsic_define_method_n(vm, prototype, "toString", 0,
                                  zoned_date_time_to_string);
    mal_intrinsic_define_method_n(vm, prototype, "until", 1, zoned_date_time_until);
    mal_intrinsic_define_method_n(vm, prototype, "valueOf", 0,
                                  zoned_date_time_value_of);
    mal_intrinsic_define_method_n(vm, prototype, "with", 1,
                                  zoned_date_time_with);
    mal_intrinsic_define_method_n(vm, prototype, "withCalendar", 1,
                                  zoned_date_time_with_calendar);
    mal_intrinsic_define_method_n(vm, prototype, "withPlainTime", 0,
                                  zoned_date_time_with_plain_time);
    mal_intrinsic_define_method_n(vm, prototype, "withTimeZone", 1,
                                  zoned_date_time_with_time_zone);
    temporal_set_tag(vm, prototype, "Temporal.ZonedDateTime");
}

static void temporal_install_instant(MalVm *vm, MalObject *temporal) {
    MalObject *object_prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    MalObject *function_prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalObject *prototype = mal_object_new(&vm->heap, object_prototype);
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "Instant"), 1,
        instant_constructor);
    vm->intrinsics[MAL_INTRINSIC_TEMPORAL_INSTANT_CONSTRUCTOR] =
        mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_TEMPORAL_INSTANT_PROTOTYPE] =
        mal_value_from_object(prototype);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype",
                              vm->intrinsics[MAL_INTRINSIC_TEMPORAL_INSTANT_PROTOTYPE],
                              MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor",
                              vm->intrinsics[MAL_INTRINSIC_TEMPORAL_INSTANT_CONSTRUCTOR],
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "compare", 2,
                                  instant_compare);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "from", 1,
                                  instant_from);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor,
                                  "fromEpochMilliseconds", 1,
                                  instant_from_epoch_milliseconds);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor,
                                  "fromEpochNanoseconds", 1,
                                  instant_from_epoch_nanoseconds);
    mal_intrinsic_define_data(vm, temporal, "Instant",
                              vm->intrinsics[MAL_INTRINSIC_TEMPORAL_INSTANT_CONSTRUCTOR],
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    mal_intrinsic_define_accessor_n(
        vm, prototype, mal_intrinsic_string_key(vm, "epochMilliseconds"),
        "get epochMilliseconds", 0, instant_epoch_milliseconds, nullptr, 0, nullptr,
        MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_accessor_n(
        vm, prototype, mal_intrinsic_string_key(vm, "epochNanoseconds"),
        "get epochNanoseconds", 0, instant_epoch_nanoseconds, nullptr, 0, nullptr,
        MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_method_n(vm, prototype, "add", 1, instant_add);
    mal_intrinsic_define_method_n(vm, prototype, "equals", 1, instant_equals);
    mal_intrinsic_define_method_n(vm, prototype, "round", 1, instant_round);
    mal_intrinsic_define_method_n(vm, prototype, "since", 1, instant_since);
    mal_intrinsic_define_method_n(vm, prototype, "subtract", 1, instant_subtract);
    mal_intrinsic_define_method_n(vm, prototype, "toJSON", 0,
                                  instant_to_string_no_options);
    mal_intrinsic_define_method_n(vm, prototype, "toLocaleString", 0,
                                  instant_to_string_no_options);
    mal_intrinsic_define_method_n(vm, prototype, "toString", 0, instant_to_string);
    mal_intrinsic_define_method_n(vm, prototype, "toZonedDateTimeISO", 1,
                                  instant_to_zoned_date_time_iso);
    mal_intrinsic_define_method_n(vm, prototype, "until", 1, instant_until);
    mal_intrinsic_define_method_n(vm, prototype, "valueOf", 0, instant_value_of);
    temporal_set_tag(vm, prototype, "Temporal.Instant");
}

static void temporal_install_plain_time(MalVm *vm, MalObject *temporal) {
    MalObject *object_prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    MalObject *function_prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalObject *prototype = mal_object_new(&vm->heap, object_prototype);
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "PlainTime"), 0,
        plain_time_constructor);
    vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_TIME_CONSTRUCTOR] =
        mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_TIME_PROTOTYPE] =
        mal_value_from_object(prototype);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype",
                              vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_TIME_PROTOTYPE],
                              MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor",
                              vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_TIME_CONSTRUCTOR],
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "compare", 2,
                                  plain_time_compare);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "from", 1,
                                  plain_time_from);
    mal_intrinsic_define_data(vm, temporal, "PlainTime",
                              vm->intrinsics[MAL_INTRINSIC_TEMPORAL_PLAIN_TIME_CONSTRUCTOR],
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    struct {
        const byte *name;
        MalNativeFunctionCallback getter;
    } getters[] = {
        {"hour", plain_time_hour}, {"minute", plain_time_minute},
        {"second", plain_time_second}, {"millisecond", plain_time_millisecond},
        {"microsecond", plain_time_microsecond}, {"nanosecond", plain_time_nanosecond},
    };
    for (usize i = 0; i < countof(getters); ++i) {
        byte getter_name[32] = "get ";
        usize length = 4;
        for (const byte *source = getters[i].name;
             *source != '\0' && length + 1 < sizeof(getter_name); ++source) {
            getter_name[length++] = *source;
        }
        getter_name[length] = '\0';
        mal_intrinsic_define_accessor_n(
            vm, prototype, mal_intrinsic_string_key(vm, getters[i].name),
            getter_name, 0, getters[i].getter, nullptr, 0, nullptr,
            MAL_PROPERTY_CONFIGURABLE);
    }
    mal_intrinsic_define_method_n(vm, prototype, "add", 1, plain_time_add);
    mal_intrinsic_define_method_n(vm, prototype, "equals", 1, plain_time_equals);
    mal_intrinsic_define_method_n(vm, prototype, "round", 1, plain_time_round);
    mal_intrinsic_define_method_n(vm, prototype, "since", 1, plain_time_since);
    mal_intrinsic_define_method_n(vm, prototype, "subtract", 1, plain_time_subtract);
    mal_intrinsic_define_method_n(vm, prototype, "toJSON", 0,
                                  plain_time_to_string_no_options);
    mal_intrinsic_define_method_n(vm, prototype, "toLocaleString", 0,
                                  plain_time_to_string_no_options);
    mal_intrinsic_define_method_n(vm, prototype, "toString", 0, plain_time_to_string);
    mal_intrinsic_define_method_n(vm, prototype, "until", 1, plain_time_until);
    mal_intrinsic_define_method_n(vm, prototype, "valueOf", 0, plain_time_value_of);
    mal_intrinsic_define_method_n(vm, prototype, "with", 1, plain_time_with);
    temporal_set_tag(vm, prototype, "Temporal.PlainTime");
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
    mal_intrinsic_define_method_n(vm, (MalObject *) duration_ctor, "compare", 2,
                                  duration_compare);
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
    mal_intrinsic_define_method_n(vm, duration_prototype, "round", 1, duration_round);
    mal_intrinsic_define_method_n(vm, duration_prototype, "subtract", 1, duration_subtract);
    mal_intrinsic_define_method_n(vm, duration_prototype, "toJSON", 0,
                                  duration_to_string_no_options);
    mal_intrinsic_define_method_n(vm, duration_prototype, "toLocaleString", 0,
                                  duration_to_string_no_options);
    mal_intrinsic_define_method_n(vm, duration_prototype, "toString", 0, duration_to_string);
    mal_intrinsic_define_method_n(vm, duration_prototype, "total", 1, duration_total);
    mal_intrinsic_define_method_n(vm, duration_prototype, "valueOf", 0, duration_value_of);
    mal_intrinsic_define_method_n(vm, duration_prototype, "with", 1, duration_with);
    temporal_set_tag(vm, duration_prototype, "Temporal.Duration");

    temporal_install_instant(vm, temporal);
    MalObject *now = mal_object_new(&vm->heap, object_prototype);
    mal_intrinsic_define_method_n(vm, now, "instant", 0, temporal_now_instant);
    mal_intrinsic_define_method_n(vm, now, "plainDateISO", 0,
                                  temporal_now_plain_date_iso);
    mal_intrinsic_define_method_n(vm, now, "plainDateTimeISO", 0,
                                  temporal_now_plain_date_time_iso);
    mal_intrinsic_define_method_n(vm, now, "plainTimeISO", 0,
                                  temporal_now_plain_time_iso);
    mal_intrinsic_define_method_n(vm, now, "timeZoneId", 0,
                                  temporal_now_time_zone_id);
    mal_intrinsic_define_method_n(vm, now, "zonedDateTimeISO", 0,
                                  temporal_now_zoned_date_time_iso);
    temporal_set_tag(vm, now, "Temporal.Now");
    mal_intrinsic_define_data(vm, temporal, "Now", mal_value_from_object(now),
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    temporal_install_plain_date(vm, temporal);
    temporal_install_plain_date_time(vm, temporal);
    temporal_install_plain_month_day(vm, temporal);
    temporal_install_plain_time(vm, temporal);
    temporal_install_plain_year_month(vm, temporal);
    temporal_install_zoned_date_time(vm, temporal);
    temporal_set_tag(vm, temporal, "Temporal");
}

#else

void mal_builtin_temporal_install(MalVm *vm) { (void) vm; }

#endif
