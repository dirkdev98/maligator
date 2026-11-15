// Whole flat documents without a reviver keep typed loads throughout traversal.
// Instantiate for each encoding so the grammar and construction stay shared.
static MalValue MAL_JSON_CURSOR(value)(MalJsonParser *parser, usize depth);

static inline const MAL_JSON_UNIT *MAL_JSON_CURSOR(units)(const MalJsonParser *parser) {
    return MAL_JSON_UNITS(parser->segment);
}

static inline u32 MAL_JSON_CURSOR(next)(MalJsonParser *parser) {
    const MAL_JSON_UNIT *units = MAL_JSON_CURSOR(units)(parser);
    usize position = parser->position;
    while (position < parser->length) {
        u32 unit = units[position];
        if (unit != ' ' && unit != '\t' && unit != '\n' && unit != '\r') {
            parser->position = position;
            return unit;
        }
        position++;
    }
    parser->position = position;
    return UINT32_MAX;
}

static MalValue MAL_JSON_CURSOR(number)(MalJsonParser *parser) {
    const MAL_JSON_UNIT *units = MAL_JSON_CURSOR(units)(parser);
    usize start = parser->position;
    usize position = start;
    u8 token[64];
    usize available = parser->length - start;
    usize end = start + (available < sizeof(token) ? available : sizeof(token));
    bool negative = position < end && units[position] == '-';
    position += negative;
    usize first_digit = position;
    u64 magnitude = 0;
    if (position < end && units[position] == '0') {
        position++;
    } else {
        while (position < end && (u32) (units[position] - '0') < 10) {
            if (position - first_digit < 16) magnitude = magnitude * 10 + units[position] - '0';
            position++;
        }
    }
    usize integer_digits = position - first_digit;
    if (integer_digits == 0) return mal_json_parse_number(parser);
    bool integer = true;
    if (position < end && units[position] == '.') {
        integer = false;
        usize fraction = ++position;
        while (position < end && (u32) (units[position] - '0') < 10) position++;
        if (position == fraction) return mal_json_parse_number(parser);
    }
    if (position < end && (units[position] == 'e' || units[position] == 'E')) {
        integer = false;
        position++;
        if (position < end && (units[position] == '+' || units[position] == '-')) position++;
        usize exponent = position;
        while (position < end && (u32) (units[position] - '0') < 10) position++;
        if (position == exponent) return mal_json_parse_number(parser);
    }
    usize length = position - start;
    // Long tokens pay only a bounded prefix before the streaming number parser.
    if (position == end && end != parser->length) return mal_json_parse_number(parser);
    if (integer && integer_digits <= 15) {
        parser->position = position;
        return negative && magnitude == 0 ? MAL_VALUE_NEGATIVE_ZERO
            : mal_ops_number_value(negative ? -(f64) magnitude : (f64) magnitude);
    }
    for (usize i = 0; i < length; i++) token[i] = (u8) units[start + i];
    parser->position = position;
    return mal_ops_number_value(mal_number_parse_decimal(token, length));
}

static MalValue MAL_JSON_CURSOR(array)(MalJsonParser *parser, usize depth) {
    MalValue value = mal_value_from_array_object(mal_intrinsic_new_array(parser->vm, 0));
    MalRootSpan span;
    mal_gc_root(&span, &value, 1);
    u32 unit = MAL_JSON_CURSOR(next)(parser);
    if (unit == ']') {
        parser->position++;
        mal_gc_unroot(&span);
        return value;
    }
    while (true) {
        MalValue element = MAL_JSON_CURSOR(value)(parser, depth + 1);
        if (parser->vm->completion.kind == MAL_COMPLETION_THROW) break;
        MalRootSpan element_span;
        mal_gc_root(&element_span, &element, 1);
        MalArrayObject *array = mal_value_to_array_object(value);
        if (!mal_array_object_fresh_dense_append(array, element)) {
            mal_array_object_store(array, mal_key_index(array->length), element);
        }
        mal_gc_unroot(&element_span);
        unit = MAL_JSON_CURSOR(next)(parser);
        if (unit == ']') {
            parser->position++;
            mal_gc_unroot(&span);
            return value;
        }
        if (unit != ',') {
            mal_json_parse_error(parser);
            break;
        }
        parser->position++;
    }
    mal_gc_unroot(&span);
    return mal_value_new_undefined();
}

static inline bool MAL_JSON_CURSOR(key)(
    MalJsonParser *parser, const MalShape *shape, usize index, MalKey *out
) {
    if (index >= shape->inline_count) return false;
    MalValue value = shape->props[index].key;
    const MalString *key = mal_value_to_string(value);
    if (!key->latin1 || key->storage >= MAL_STRING_STORAGE_DEPENDENT) return false;
    usize length = key->length;
    usize position = parser->position;
    const MAL_JSON_UNIT *source = MAL_JSON_CURSOR(units)(parser) + position;
    if (length + 3 > parser->length - position ||
        source[length + 1] != '"' || source[length + 2] != ':') return false;
    const u8 *bytes = key->storage == MAL_STRING_STORAGE_INLINE
        ? mal_string_inline_latin1(key) : key->latin1_units;
    for (usize i = 0; i < length; i++) {
        if (source[i + 1] != bytes[i]) return false;
    }
    parser->position += length + 3;
    *out = (MalKey) {.kind = MAL_KEY_STRING, .value = value};
    return true;
}

static MalValue MAL_JSON_CURSOR(object)(MalJsonParser *parser, usize depth) {
    MalJsonObjectMembers members;
    mal_json_object_members_init(&members);
    MalShape *matched_shape = nullptr;
    u32 unit = MAL_JSON_CURSOR(next)(parser);
    if (unit == '}') goto finish;
    while (true) {
        if (unit != '"') {
            mal_json_parse_diagnostic(parser, members.count == 0
                ? MAL_JSON_DIAGNOSTIC_FIRST_KEY : MAL_JSON_DIAGNOSTIC_KEY);
            break;
        }
        MalKey key;
        bool predicted = false;
        if (members.count == 0) {
            struct MalJsonKeyCache *cache = parser->vm->json_key_cache;
            if (cache != nullptr) {
                for (usize i = 0; i < countof(cache->shapes); i++) {
                    MalJsonShapeMemo *memo = &cache->shapes[i];
                    if (memo->shape != nullptr && memo->raw_keys &&
                        MAL_JSON_CURSOR(key)(parser, memo->shape, 0, &key)) {
                        matched_shape = memo->shape;
                        predicted = true;
                        break;
                    }
                }
            }
        } else if (matched_shape != nullptr) {
            predicted = MAL_JSON_CURSOR(key)(parser, matched_shape, members.count, &key);
        }
        if (!predicted) {
            matched_shape = nullptr;
            parser->position++;
            if (!mal_json_parse_key(parser, &key)) break;
            if (MAL_JSON_CURSOR(next)(parser) != ':') {
                mal_json_parse_error(parser);
                break;
            }
            parser->position++;
        }
        mal_json_object_members_append_key(&members, key);
        MalValue member = MAL_JSON_CURSOR(value)(parser, depth + 1);
        if (parser->vm->completion.kind == MAL_COMPLETION_THROW) break;
        members.roots[members.count * 2 - 1] = member;
        unit = MAL_JSON_CURSOR(next)(parser);
        if (unit == '}') goto finish;
        if (unit != ',') {
            mal_json_parse_error(parser);
            break;
        }
        parser->position++;
        unit = MAL_JSON_CURSOR(next)(parser);
    }
    mal_json_object_members_dispose(&members);
    return mal_value_new_undefined();

finish:
    parser->position++;
    MalValue result = mal_json_object_members_finalize(parser, &members, matched_shape);
    mal_json_object_members_dispose(&members);
    return result;
}

static MalValue MAL_JSON_CURSOR(value)(MalJsonParser *parser, usize depth) {
    u32 unit = MAL_JSON_CURSOR(next)(parser);
    if (unit == UINT32_MAX) {
        mal_json_parse_diagnostic(parser, MAL_JSON_DIAGNOSTIC_END);
        return mal_value_new_undefined();
    }
    const MAL_JSON_UNIT *units = MAL_JSON_CURSOR(units)(parser) + parser->position;
    usize available = parser->length - parser->position;
    switch (unit) {
        case '"':
            parser->position++;
            return mal_json_parse_string(parser);
        case '[':
        case '{':
            if (mal_json_use_heap_frames(parser->vm, depth)) {
                MalJsonParseNode *ignored = nullptr;
                return mal_json_parse_heap(parser, &ignored);
            }
            parser->position++;
            return unit == '[' ? MAL_JSON_CURSOR(array)(parser, depth)
                : MAL_JSON_CURSOR(object)(parser, depth);
        case 'n':
            if (available >= 4 && units[1] == 'u' && units[2] == 'l' && units[3] == 'l') {
                parser->position += 4;
                return mal_value_new_null();
            }
            break;
        case 't':
            if (available >= 4 && units[1] == 'r' && units[2] == 'u' && units[3] == 'e') {
                parser->position += 4;
                return mal_value_new_boolean(true);
            }
            break;
        case 'f':
            if (available >= 5 && units[1] == 'a' && units[2] == 'l' &&
                units[3] == 's' && units[4] == 'e') {
                parser->position += 5;
                return mal_value_new_boolean(false);
            }
            break;
    }
    return MAL_JSON_CURSOR(number)(parser);
}
