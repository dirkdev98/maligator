#include "./date_object.h"

void mal_date_object_init(MalHeap *heap, MalDateObject *date, MalObject *prototype, f64 date_value) {
    mal_object_init(heap, &date->object, MAL_HEAP_DATE_OBJECT, prototype);
    date->date_value = date_value;
}

MalDateObject *mal_date_object_new(MalHeap *heap, MalObject *prototype, f64 date_value) {
    MalDateObject *date = mal_heap_alloc(heap, sizeof(MalDateObject), MAL_HEAP_DATE_OBJECT);
    mal_date_object_init(heap, date, prototype, date_value);
    return date;
}
