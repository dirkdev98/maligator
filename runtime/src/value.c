#include <stdio.h>
#include "heap_bigint.h"
#include "heap_string.h"
#include "proxy_object.h"
#include "primitive_wrapper_object.h"
#include "value.h"


bool mal_value_is_function_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_FUNCTION_OBJECT);
}

bool mal_value_is_native_function_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_NATIVE_FUNCTION_OBJECT);
}

bool mal_value_is_bound_function_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_BOUND_FUNCTION_OBJECT);
}

bool mal_value_is_array_object(MalValue value) {
    return (value & MAL_VALUE_CLASS_MASK) == MAL_VALUE_ARRAY;
}

bool mal_value_is_module_namespace_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_MODULE_NAMESPACE_OBJECT);
}

MalModuleNamespaceObject *mal_value_to_module_namespace_object(MalValue value) {
    return (MalModuleNamespaceObject *) mal_value_to_heap(value);
}

MalValue mal_value_from_module_namespace_object(MalModuleNamespaceObject *ns) {
    return mal_value_from_heap((MalHeapHeader *) ns);
}

bool mal_value_is_map_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_MAP_OBJECT);
}

bool mal_value_is_set_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_SET_OBJECT);
}

bool mal_value_is_date_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_DATE_OBJECT);
}

bool mal_value_is_weak_ref_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_WEAK_REF_OBJECT);
}

MalWeakRefObject *mal_value_to_weak_ref_object(MalValue value) {
    return (MalWeakRefObject *) mal_value_to_heap(value);
}

MalValue mal_value_from_weak_ref_object(MalWeakRefObject *ref) {
    return mal_value_from_heap((MalHeapHeader *) ref);
}

bool mal_value_is_finalization_registry_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_FINALIZATION_REGISTRY_OBJECT);
}

MalFinalizationRegistryObject *mal_value_to_finalization_registry_object(MalValue value) {
    return (MalFinalizationRegistryObject *) mal_value_to_heap(value);
}

MalValue mal_value_from_finalization_registry_object(MalFinalizationRegistryObject *reg) {
    return mal_value_from_heap((MalHeapHeader *) reg);
}

MalDateObject *mal_value_to_date_object(MalValue value) {
    return (MalDateObject *) mal_value_to_heap(value);
}

MalValue mal_value_from_date_object(MalDateObject *date) {
    return mal_value_from_heap((MalHeapHeader *) date);
}

bool mal_value_is_intl_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_INTL_OBJECT);
}

bool mal_value_is_regexp_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_REGEXP_OBJECT);
}

MalRegExpObject *mal_value_to_regexp_object(MalValue value) {
    return (MalRegExpObject *) mal_value_to_heap(value);
}

MalValue mal_value_from_regexp_object(MalRegExpObject *regexp) {
    return mal_value_from_heap((MalHeapHeader *) regexp);
}

bool mal_value_is_response_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_RESPONSE_OBJECT);
}

MalResponseObject *mal_value_to_response_object(MalValue value) {
    return (MalResponseObject *) mal_value_to_heap(value);
}

MalValue mal_value_from_response_object(MalResponseObject *response) {
    return mal_value_from_heap((MalHeapHeader *) response);
}

bool mal_value_is_request_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_REQUEST_OBJECT);
}

MalRequestObject *mal_value_to_request_object(MalValue value) {
    return (MalRequestObject *) mal_value_to_heap(value);
}

MalValue mal_value_from_request_object(MalRequestObject *request) {
    return mal_value_from_heap((MalHeapHeader *) request);
}

bool mal_value_is_headers_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_HEADERS_OBJECT);
}

MalHeadersObject *mal_value_to_headers_object(MalValue value) {
    return (MalHeadersObject *) mal_value_to_heap(value);
}

MalValue mal_value_from_headers_object(MalHeadersObject *headers) {
    return mal_value_from_heap((MalHeapHeader *) headers);
}

bool mal_value_is_url_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_URL_OBJECT);
}

MalUrlObject *mal_value_to_url_object(MalValue value) {
    return (MalUrlObject *) mal_value_to_heap(value);
}

MalValue mal_value_from_url_object(MalUrlObject *url) {
    return mal_value_from_heap((MalHeapHeader *) url);
}

bool mal_value_is_url_search_params_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_URL_SEARCH_PARAMS_OBJECT);
}

MalUrlSearchParamsObject *mal_value_to_url_search_params_object(MalValue value) {
    return (MalUrlSearchParamsObject *) mal_value_to_heap(value);
}

MalValue mal_value_from_url_search_params_object(MalUrlSearchParamsObject *params) {
    return mal_value_from_heap((MalHeapHeader *) params);
}

bool mal_value_is_event_target_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_EVENT_TARGET_OBJECT);
}

MalEventTargetObject *mal_value_to_event_target_object(MalValue value) {
    return (MalEventTargetObject *) mal_value_to_heap(value);
}

MalValue mal_value_from_event_target_object(MalEventTargetObject *target) {
    return mal_value_from_heap((MalHeapHeader *) target);
}

bool mal_value_is_readable_stream_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_READABLE_STREAM_OBJECT);
}

MalReadableStreamObject *mal_value_to_readable_stream_object(MalValue value) {
    return (MalReadableStreamObject *) mal_value_to_heap(value);
}

MalValue mal_value_from_readable_stream_object(MalReadableStreamObject *stream) {
    return mal_value_from_heap((MalHeapHeader *) stream);
}

bool mal_value_is_regexp_string_iterator_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_REGEXP_STRING_ITERATOR_OBJECT);
}

MalRegExpStringIteratorObject *mal_value_to_regexp_string_iterator_object(MalValue value) {
    return (MalRegExpStringIteratorObject *) mal_value_to_heap(value);
}

MalValue mal_value_from_regexp_string_iterator_object(MalRegExpStringIteratorObject *iterator) {
    return mal_value_from_heap((MalHeapHeader *) iterator);
}

MalIntlObject *mal_value_to_intl_object(MalValue value) {
    return (MalIntlObject *) mal_value_to_heap(value);
}

MalValue mal_value_from_intl_object(MalIntlObject *intl) {
    return mal_value_from_heap((MalHeapHeader *) intl);
}

bool mal_value_is_iterator_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_ITERATOR_OBJECT);
}

bool mal_value_is_generator_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_GENERATOR_OBJECT);
}

bool mal_value_is_array_buffer_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_ARRAY_BUFFER_OBJECT);
}

bool mal_value_is_typed_array_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_TYPED_ARRAY_OBJECT);
}

bool mal_value_is_data_view_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_DATA_VIEW_OBJECT);
}

bool mal_value_is_promise_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_PROMISE_OBJECT);
}

bool mal_value_is_iterator_helper_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_ITERATOR_HELPER_OBJECT);
}

bool mal_value_is_primitive_wrapper(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_PRIMITIVE_WRAPPER_OBJECT);
}

MalPrimitiveWrapperObject *mal_value_to_primitive_wrapper(MalValue value) {
    return (MalPrimitiveWrapperObject *) mal_value_to_heap(value);
}

MalValue mal_value_from_primitive_wrapper(MalPrimitiveWrapperObject *wrapper) {
    return mal_value_from_heap((MalHeapHeader *) wrapper);
}

/** A JS Number in any of its NaN-boxing encodings. */
static bool mal_value_is_number_value(MalValue value) {
    return mal_value_is_int32(value) ||
        mal_value_is_f64_or_nan(value) ||
        value == MAL_VALUE_NEGATIVE_ZERO ||
        value == MAL_VALUE_POSITIVE_INFINITY ||
        value == MAL_VALUE_NEGATIVE_INFINITY;
}

bool mal_value_this_string_value(MalValue value, MalValue *out) {
    if (mal_value_is_string(value)) {
        *out = value;
        return true;
    }
    if (mal_value_is_primitive_wrapper(value)) {
        MalPrimitiveWrapperObject *wrapper = mal_value_to_primitive_wrapper(value);
        if (wrapper->kind == MAL_PRIMITIVE_WRAPPER_STRING) {
            *out = wrapper->primitive_data;
            return true;
        }
    }
    return false;
}

bool mal_value_this_number_value(MalValue value, MalValue *out) {
    if (mal_value_is_number_value(value)) {
        *out = value;
        return true;
    }
    if (mal_value_is_primitive_wrapper(value)) {
        MalPrimitiveWrapperObject *wrapper = mal_value_to_primitive_wrapper(value);
        if (wrapper->kind == MAL_PRIMITIVE_WRAPPER_NUMBER) {
            *out = wrapper->primitive_data;
            return true;
        }
    }
    return false;
}

bool mal_value_this_boolean_value(MalValue value, MalValue *out) {
    if (mal_value_is_boolean(value)) {
        *out = value;
        return true;
    }
    if (mal_value_is_primitive_wrapper(value)) {
        MalPrimitiveWrapperObject *wrapper = mal_value_to_primitive_wrapper(value);
        if (wrapper->kind == MAL_PRIMITIVE_WRAPPER_BOOLEAN) {
            *out = wrapper->primitive_data;
            return true;
        }
    }
    return false;
}

bool mal_value_is_callable(MalValue value) {
    // Script/native/bound functions all carry the CALLABLE class — one compare,
    // no dereference.
    if ((value & MAL_VALUE_CLASS_MASK) == MAL_VALUE_CALLABLE) {
        return true;
    }
    // A proxy (an OBJECT-class value) has the [[Call]] slot captured at creation.
    if (mal_value_is_proxy_object(value)) {
        return mal_proxy_target_is_callable(value);
    }
    return false;
}

MalSymbol *mal_value_to_symbol(MalValue value) {
    return (MalSymbol *) mal_value_to_heap(value);
}

MalBigInt *mal_value_to_bigint(MalValue value) {
    return (MalBigInt *) mal_value_to_heap(value);
}

MalObject *mal_value_to_object(MalValue value) {
    return (MalObject *) mal_value_to_heap(value);
}

MalFunctionObject *mal_value_to_function_object(MalValue value) {
    return (MalFunctionObject *) mal_value_to_heap(value);
}

MalNativeFunctionObject *mal_value_to_native_function_object(MalValue value) {
    return (MalNativeFunctionObject *) mal_value_to_heap(value);
}

MalBoundFunctionObject *mal_value_to_bound_function_object(MalValue value) {
    return (MalBoundFunctionObject *) mal_value_to_heap(value);
}

MalArrayObject *mal_value_to_array_object(MalValue value) {
    return (MalArrayObject *) mal_value_to_heap(value);
}

MalMapObject *mal_value_to_map_object(MalValue value) {
    return (MalMapObject *) mal_value_to_heap(value);
}

MalIteratorObject *mal_value_to_iterator_object(MalValue value) {
    return (MalIteratorObject *) mal_value_to_heap(value);
}

MalArrayBufferObject *mal_value_to_array_buffer_object(MalValue value) {
    return (MalArrayBufferObject *) mal_value_to_heap(value);
}

MalTypedArrayObject *mal_value_to_typed_array_object(MalValue value) {
    return (MalTypedArrayObject *) mal_value_to_heap(value);
}

MalDataViewObject *mal_value_to_data_view_object(MalValue value) {
    return (MalDataViewObject *) mal_value_to_heap(value);
}

MalPromiseObject *mal_value_to_promise_object(MalValue value) {
    return (MalPromiseObject *) mal_value_to_heap(value);
}

MalIteratorHelperObject *mal_value_to_iterator_helper_object(MalValue value) {
    return (MalIteratorHelperObject *) mal_value_to_heap(value);
}

// mal_value_from_string / _from_bigint / _from_object are now static inline in
// value.h (constant-foldable in the emitted native-C backend).

MalValue mal_value_from_symbol(MalSymbol *symbol) {
    return mal_value_from_heap((MalHeapHeader *) symbol);
}

MalValue mal_value_from_function_object(MalFunctionObject *function) {
    return mal_value_from_heap((MalHeapHeader *) function);
}

MalValue mal_value_from_native_function_object(MalNativeFunctionObject *function) {
    return mal_value_from_heap((MalHeapHeader *) function);
}

MalValue mal_value_from_bound_function_object(MalBoundFunctionObject *bound) {
    return mal_value_from_heap((MalHeapHeader *) bound);
}

MalValue mal_value_from_array_object(MalArrayObject *array) {
    return mal_value_from_heap((MalHeapHeader *) array);
}

MalValue mal_value_from_map_object(MalMapObject *map) {
    return mal_value_from_heap((MalHeapHeader *) map);
}

MalValue mal_value_from_iterator_object(MalIteratorObject *iterator) {
    return mal_value_from_heap((MalHeapHeader *) iterator);
}

MalValue mal_value_from_array_buffer_object(MalArrayBufferObject *buffer) {
    return mal_value_from_heap((MalHeapHeader *) buffer);
}

MalValue mal_value_from_typed_array_object(MalTypedArrayObject *array) {
    return mal_value_from_heap((MalHeapHeader *) array);
}

MalValue mal_value_from_data_view_object(MalDataViewObject *view) {
    return mal_value_from_heap((MalHeapHeader *) view);
}

MalValue mal_value_from_promise_object(MalPromiseObject *promise) {
    return mal_value_from_heap((MalHeapHeader *) promise);
}

MalValue mal_value_from_iterator_helper_object(MalIteratorHelperObject *helper) {
    return mal_value_from_heap((MalHeapHeader *) helper);
}

bool mal_value_is_truthy(MalValue value) {
    if (mal_value_is_nil(value)) {
        return false;
    }

    if (mal_value_is_boolean(value)) {
        return mal_value_to_boolean(value);
    }

    if (mal_value_is_nan(value)) {
        return false;
    }

    if (mal_value_is_f64(value)) {
        return mal_value_to_f64(value) != 0;
    }

    if (mal_value_is_int32(value)) {
        return mal_value_to_i32(value) != 0;
    }

    if (mal_value_is_string(value)) {
        return mal_string_length(mal_value_to_string(value)) != 0;
    }

    if (mal_value_is_bigint(value)) {
        return mal_bigint_value(mal_value_to_bigint(value)) != 0;
    }

    // Any object is truthy.
    return true;
}

void mal_value_debug(MalValue value) {
    if (value == MAL_VALUE_POSITIVE_INFINITY) {
        printf("Infinity");
        return;
    }

    if (value == MAL_VALUE_NEGATIVE_INFINITY) {
        printf("-Infinity");
        return;
    }

    if (mal_value_is_nan(value)) {
        printf("NaN");
        return;
    }

    if (mal_value_is_f64(value)) {
        printf("%f", mal_value_to_f64(value));
        return;
    }

    if (mal_value_is_boolean(value)) {
        auto b = mal_value_to_boolean(value);
        printf("%s", b ? "true" : "false");

        return;
    }

    if (mal_value_is_undefined(value)) {
        printf("undefined");
        return;
    }

    if (mal_value_is_null(value)) {
        printf("null");
        return;
    }

    if (mal_value_is_int32(value)) {
        printf("%d", mal_value_to_i32(value));
        return;
    }

    if (mal_value_is_string(value)) {
        MalString *string = mal_value_to_string(value);
        const c16 *code_units = mal_string_code_units(string);
        printf("\"");
        for (usize i = 0; i < mal_string_length(string); i++) {
            c16 code_unit = code_units[i];
            if (code_unit >= 0x20 && code_unit <= 0x7E) {
                printf("%c", (char) code_unit);
            } else {
                printf("\\u%04x", code_unit);
            }
        }
        printf("\"");
        return;
    }

    if (mal_value_is_bigint(value)) {
        i128 magnitude = mal_bigint_value(mal_value_to_bigint(value));
        bool negative = magnitude < 0;
        u128 mag = negative ? (~(u128) magnitude + 1) : (u128) magnitude;
        char buffer[48];
        usize length = 0;
        do {
            buffer[length++] = (char) ('0' + (i32) (mag % 10));
            mag /= 10;
        } while (mag > 0);
        if (negative) {
            printf("-");
        }
        while (length > 0) {
            printf("%c", buffer[--length]);
        }
        printf("n");
        return;
    }

    if (mal_value_is_callable(value)) {
        printf("[function]");
        return;
    }

    if (mal_value_is_array_object(value)) {
        printf("[array]");
        return;
    }

    if (mal_value_is_object(value)) {
        printf("[object]");
        return;
    }

    printf("[unknown]");
}
