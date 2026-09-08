#include "vm.h"
MalValue mal_known_native_date_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_utc(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_utc(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_now(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_now(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_parse(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_parse(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_get_date(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_get_date(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_get_day(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_get_day(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_get_full_year(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_get_full_year(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_get_hours(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_get_hours(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_get_milliseconds(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_get_milliseconds(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_get_minutes(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_get_minutes(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_get_month(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_get_month(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_get_seconds(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_get_seconds(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_get_time(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_get_time(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_get_timezone_offset(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_get_timezone_offset(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_get_utc_date(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_get_utc_date(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_get_utc_day(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_get_utc_day(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_get_utc_full_year(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_get_utc_full_year(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_get_utc_hours(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_get_utc_hours(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_get_utc_milliseconds(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_get_utc_milliseconds(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_get_utc_minutes(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_get_utc_minutes(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_get_utc_month(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_get_utc_month(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_get_utc_seconds(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_get_utc_seconds(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_get_year(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_get_year(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_set_date(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_set_date(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_set_full_year(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_set_full_year(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_set_hours(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_set_hours(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_set_milliseconds(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_set_milliseconds(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_set_minutes(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_set_minutes(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_set_month(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_set_month(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_set_seconds(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_set_seconds(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_set_time(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_set_time(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_set_utc_date(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_set_utc_date(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_set_utc_full_year(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_set_utc_full_year(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_set_utc_hours(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_set_utc_hours(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_set_utc_milliseconds(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_set_utc_milliseconds(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_set_utc_minutes(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_set_utc_minutes(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_set_utc_month(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_set_utc_month(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_set_utc_seconds(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_set_utc_seconds(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_set_year(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_set_year(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_to_date_string(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_to_date_string(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_to_utc_string(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_to_utc_string(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_to_iso_string(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_to_iso_string(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_to_json(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_to_json(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_to_locale_date_string(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_to_locale_date_string(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_to_locale_string(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_to_locale_string(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_to_locale_time_string(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_to_locale_time_string(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_to_string(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_to_string(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_to_temporal_instant(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_TEMPORAL)
    return date_proto_to_temporal_instant(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_date_proto_to_time_string(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_to_time_string(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_date_proto_to_primitive(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return date_proto_to_primitive(vm, receiver, args, count, target, callee);
}
