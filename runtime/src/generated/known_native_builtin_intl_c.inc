#include "vm.h"
MalValue mal_known_native_intl_segments_containing(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_SEGMENTER)
    return intl_segments_containing(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_segments_iterator(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_SEGMENTER)
    return intl_segments_iterator(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_segment_iterator_next(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_SEGMENTER)
    return intl_segment_iterator_next(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_collator_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_COLLATOR)
    return intl_collator_constructor(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_collator_get_compare(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_COLLATOR)
    return intl_collator_get_compare(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_collator_resolved_options(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_COLLATOR)
    return intl_collator_resolved_options(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_collator_supported_locales_of(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_COLLATOR)
    return intl_collator_supported_locales_of(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_date_time_format_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_DATE_TIME_FORMAT)
    return intl_date_time_format_constructor(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_date_time_format_get_format(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_DATE_TIME_FORMAT)
    return intl_date_time_format_get_format(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_date_time_format_range(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_DATE_TIME_FORMAT)
    return intl_date_time_format_range(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_date_time_format_range_to_parts(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_DATE_TIME_FORMAT)
    return intl_date_time_format_range_to_parts(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_date_time_format_resolved_options(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_DATE_TIME_FORMAT)
    return intl_date_time_format_resolved_options(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_date_time_format_supported_locales_of(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_DATE_TIME_FORMAT)
    return intl_date_time_format_supported_locales_of(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_display_names_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_DISPLAY_NAMES)
    return intl_display_names_constructor(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_display_names_of(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_DISPLAY_NAMES)
    return intl_display_names_of(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_display_names_resolved_options(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_DISPLAY_NAMES)
    return intl_display_names_resolved_options(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_display_names_supported_locales_of(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_DISPLAY_NAMES)
    return intl_display_names_supported_locales_of(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_duration_format_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_DURATION_FORMAT)
    return intl_duration_format_constructor(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_duration_format_format(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_DURATION_FORMAT)
    return intl_duration_format_format(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_duration_format_format_to_parts(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_DURATION_FORMAT)
    return intl_duration_format_format_to_parts(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_duration_format_resolved_options(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_DURATION_FORMAT)
    return intl_duration_format_resolved_options(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_duration_format_supported_locales_of(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_DURATION_FORMAT)
    return intl_duration_format_supported_locales_of(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_list_format_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_LIST_FORMAT)
    return intl_list_format_constructor(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_list_format_format(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_LIST_FORMAT)
    return intl_list_format_format(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_list_format_format_to_parts(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_LIST_FORMAT)
    return intl_list_format_format_to_parts(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_list_format_resolved_options(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_LIST_FORMAT)
    return intl_list_format_resolved_options(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_list_format_supported_locales_of(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_LIST_FORMAT)
    return intl_list_format_supported_locales_of(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_locale_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL)
    return intl_locale_constructor(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_locale_get_base_name(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL)
    return intl_locale_get_base_name(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_locale_get_calendar(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL)
    return intl_locale_get_calendar(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_locale_get_case_first(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL)
    return intl_locale_get_case_first(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_locale_get_collation(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL)
    return intl_locale_get_collation(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_locale_get_hour_cycle(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL)
    return intl_locale_get_hour_cycle(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_locale_get_language(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL)
    return intl_locale_get_language(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_locale_maximize(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL)
    return intl_locale_maximize(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_locale_minimize(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL)
    return intl_locale_minimize(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_locale_get_numbering_system(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL)
    return intl_locale_get_numbering_system(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_locale_get_numeric(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL)
    return intl_locale_get_numeric(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_locale_get_region(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL)
    return intl_locale_get_region(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_locale_get_script(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL)
    return intl_locale_get_script(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_locale_to_string(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL)
    return intl_locale_to_string(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_number_format_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_NUMBER_FORMAT)
    return intl_number_format_constructor(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_number_format_get_format(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_NUMBER_FORMAT)
    return intl_number_format_get_format(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_number_format_resolved_options(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_NUMBER_FORMAT)
    return intl_number_format_resolved_options(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_number_format_supported_locales_of(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_NUMBER_FORMAT)
    return intl_number_format_supported_locales_of(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_plural_rules_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_PLURAL_RULES)
    return intl_plural_rules_constructor(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_plural_rules_resolved_options(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_PLURAL_RULES)
    return intl_plural_rules_resolved_options(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_plural_rules_select(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_PLURAL_RULES)
    return intl_plural_rules_select(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_plural_rules_supported_locales_of(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_PLURAL_RULES)
    return intl_plural_rules_supported_locales_of(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_relative_time_format_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_RELATIVE_TIME_FORMAT)
    return intl_relative_time_format_constructor(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_relative_time_format_format(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_RELATIVE_TIME_FORMAT)
    return intl_relative_time_format_format(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_relative_time_format_format_to_parts(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_RELATIVE_TIME_FORMAT)
    return intl_relative_time_format_format_to_parts(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_relative_time_format_resolved_options(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_RELATIVE_TIME_FORMAT)
    return intl_relative_time_format_resolved_options(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_relative_time_format_supported_locales_of(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_RELATIVE_TIME_FORMAT)
    return intl_relative_time_format_supported_locales_of(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_segmenter_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_SEGMENTER)
    return intl_segmenter_constructor(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_segmenter_resolved_options(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_SEGMENTER)
    return intl_segmenter_resolved_options(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_segmenter_segment(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_SEGMENTER)
    return intl_segmenter_segment(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_segmenter_supported_locales_of(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL) && (MAL_INTL_HAS_SEGMENTER)
    return intl_segmenter_supported_locales_of(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_get_canonical_locales(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL)
    return intl_get_canonical_locales(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_intl_supported_values_of(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_INTL)
    return intl_supported_values_of(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
