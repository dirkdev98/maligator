// Portions derived from Node.js src/node_dotenv.cc (MIT); see THIRD_PARTY_NOTICES.md.
#include "node_dotenv.h"

#if MAL_NODE

#include "gc.h"
#include "heap_string.h"
#include "object.h"
#include "object_ops.h"
#include "text_buffer.h"

static bool dotenv_space(c16 unit) {
    return unit == ' ' || unit == '\t';
}

bool mal_node_dotenv_parse(MalVm *vm, MalString *content, MalValue target, bool keep_existing) {
    MalValue roots[] = {
        mal_value_from_string(content), target, mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalString *source = content;
    const c16 *units = mal_string_code_units(source);
    usize length = mal_string_length(source);
    usize cursor = 0;
    while (cursor < length) {
        usize line_end = cursor;
        while (line_end < length && units[line_end] != '\n'
               && units[line_end] != '\r') {
            line_end++;
        }
        usize start = cursor;
        while (start < line_end && dotenv_space(units[start])) start++;
        if (start < line_end && units[start] != '#') {
            if (line_end - start >= 7
                && units[start] == 'e' && units[start + 1] == 'x'
                && units[start + 2] == 'p' && units[start + 3] == 'o'
                && units[start + 4] == 'r' && units[start + 5] == 't'
                && dotenv_space(units[start + 6])) {
                start += 7;
                while (start < line_end && dotenv_space(units[start])) start++;
            }
            usize equals = start;
            while (equals < line_end && units[equals] != '=') equals++;
            usize key_end = equals;
            while (key_end > start && dotenv_space(units[key_end - 1])) key_end--;
            if (equals < line_end && key_end > start) {
                usize value_start = equals + 1;
                while (value_start < line_end && dotenv_space(units[value_start])) {
                    value_start++;
                }
                usize value_end = line_end;
                bool expand_newlines = false;
                if (value_start < line_end
                    && (units[value_start] == '\'' || units[value_start] == '"' || units[value_start] == '`')) {
                    c16 quote = units[value_start];
                    usize close = value_start + 1;
                    while (close < length && units[close] != quote) close++;
                    if (close < length) {
                        // Quoted values may span lines; the rest of the closing line is ignored.
                        expand_newlines = quote == '"';
                        value_start++;
                        value_end = close;
                        line_end = close;
                        while (line_end < length && units[line_end] != '\n' && units[line_end] != '\r') line_end++;
                    }
                }
                if (value_end == line_end) {
                    for (usize i = value_start; i < value_end; i++) {
                        if (units[i] == '#') {
                            value_end = i;
                            break;
                        }
                    }
                    while (value_end > value_start
                           && dotenv_space(units[value_end - 1])) {
                        value_end--;
                    }
                }
                roots[2] = mal_value_from_string(mal_string_new_slice(
                    &vm->heap, source, start, key_end - start));
                if (expand_newlines) {
                    MalTextBuffer text = {0};
                    for (usize i = value_start; i < value_end; i++) {
                        if (units[i] == '\\' && i + 1 < value_end && units[i + 1] == 'n') {
                            mal_text_buffer_push(&text, '\n');
                            i++;
                        } else {
                            mal_text_buffer_push(&text, units[i]);
                        }
                    }
                    roots[3] = mal_value_from_string(mal_text_buffer_finish(&vm->heap, &text));
                } else {
                    roots[3] = mal_value_from_string(mal_string_new_slice(
                        &vm->heap, source, value_start, value_end - value_start));
                }
                MalKey key = mal_key_from_value(roots[2]);
                if (!keep_existing || !mal_object_get_own(mal_value_to_object(roots[1]), key).present) {
                    mal_object_set(mal_value_to_object(roots[1]), key, roots[3]);
                }
            }
        }
        cursor = line_end;
        if (cursor < length && units[cursor] == '\r') cursor++;
        if (cursor < length && units[cursor] == '\n') cursor++;
    }
    mal_gc_unroot(&root);
    return vm->completion.kind != MAL_COMPLETION_THROW;
}

#endif /* MAL_NODE */
