#include "builtin_date.h"

#include <math.h>
#include <string.h>

#include "ascii.h"
#include <time.h>

#include "builtin_intl.h"
#if MAL_TEMPORAL
#include "builtin_temporal.h"
#endif
#include "date_object.h"
#include "gc.h"
#include "heap_string.h"
#include "mal_i18n.h"
#include "intrinsics.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

/*
 * Date — ECMA-262 §21.4. The time value [[DateValue]] is milliseconds since the
 * epoch (an integral f64, or NaN). All calendar math is pure proleptic-Gregorian
 * arithmetic done here in C; the spec mandates the proleptic Gregorian calendar
 * only, so this never touches ICU4X/temporal_rs. The single data-dependent piece
 * is the local timezone offset (LocalTZA), resolved via the bundled tzdb
 * (mal_i18n_local_offset_ms).
 */

static const f64 MS_PER_SECOND = 1000.0;
static const f64 MS_PER_MINUTE = 60000.0;
static const f64 MS_PER_HOUR = 3600000.0;
static const f64 MS_PER_DAY = 86400000.0;
// The maximum magnitude of a valid time value (TimeClip): 100,000,000 days.
static const f64 MAX_TIME = 8.64e15;

static const char *const WEEKDAY_NAMES[7] = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};
static const char *const MONTH_NAMES[12] = {
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
};

// Scratch size for the toString-family renderers (date + time + " (zone-name)").
#define MAL_DATE_RENDER_BUF 256

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

/** Positive (Euclidean) modulo for f64; matches the spec's modulo on time fields. */
static f64 date_pmod(f64 a, f64 n) {
    f64 r = fmod(a, n);
    if (r < 0.0) {
        r += n;
    }
    return r;
}

// ---------------------------------------------------------------------------
// Calendar conversions (Howard Hinnant's civil<->days algorithms, in f64 so the
// whole valid Date range stays exact — |days| <= 1e8, products well under 2^53).
// ---------------------------------------------------------------------------

/** Days since 1970-01-01 for the given proleptic-Gregorian date (m in 1..12). */
static f64 date_days_from_civil(f64 y, i32 m, f64 d) {
    y -= (m <= 2) ? 1.0 : 0.0;
    // Floor-division of y by 400. (Hinnant's reference uses (y<0?y-399:y)/400 to
    // get floor from C's truncating integer division; with floor() in f64 we take
    // the floor directly - applying both double-corrects and breaks negative years.)
    f64 era = floor(y / 400.0);
    f64 yoe = y - era * 400.0;                                                       // [0, 399]
    f64 doy = floor((153.0 * (f64) ((m > 2) ? (m - 3) : (m + 9)) + 2.0) / 5.0) + (d - 1.0); // [0, 365]
    f64 doe = yoe * 365.0 + floor(yoe / 4.0) - floor(yoe / 100.0) + doy;              // [0, 146096]
    return era * 146097.0 + doe - 719468.0;
}

/** Integral civil-to-days projection for parsed ISO fields. */
static i64 date_days_from_integral_civil(i64 year, i32 month, i32 date) {
    year -= month <= 2;
    i64 era = (year >= 0 ? year : year - 399) / 400;
    i64 year_of_era = year - era * 400;
    i64 month_prime = month > 2 ? month - 3 : month + 9;
    i64 day_of_year = (153 * month_prime + 2) / 5 + date - 1;
    i64 day_of_era = year_of_era * 365 + year_of_era / 4 -
        year_of_era / 100 + day_of_year;
    return era * 146097 + day_of_era - 719468;
}

/** Decompose a day number (days since the epoch, finite) into year, 0-based month, and day. */
static void date_civil_from_days(f64 z, f64 *year_out, f64 *month_out, f64 *day_out) {
    z += 719468.0;
    // Floor-division of z by 146097 (see date_days_from_civil for why floor()
    // directly, without the truncating-division -146096 adjustment).
    f64 era = floor(z / 146097.0);
    f64 doe = z - era * 146097.0;                                                    // [0, 146096]
    f64 yoe = floor((doe - floor(doe / 1460.0) + floor(doe / 36524.0) - floor(doe / 146096.0)) / 365.0); // [0, 399]
    f64 y = yoe + era * 400.0;
    f64 doy = doe - (365.0 * yoe + floor(yoe / 4.0) - floor(yoe / 100.0));            // [0, 365]
    f64 mp = floor((5.0 * doy + 2.0) / 153.0);                                       // [0, 11]
    f64 d = doy - floor((153.0 * mp + 2.0) / 5.0) + 1.0;                             // [1, 31]
    f64 m = mp < 10.0 ? mp + 3.0 : mp - 9.0;                                         // [1, 12]
    *year_out = y + ((m <= 2.0) ? 1.0 : 0.0);
    *month_out = m - 1.0;
    *day_out = d;
}

// ---------------------------------------------------------------------------
// Spec time abstract operations (§21.4.1)
// ---------------------------------------------------------------------------

static f64 date_day(f64 t) {
    return floor(t / MS_PER_DAY);
}

static f64 date_time_within_day(f64 t) {
    return date_pmod(t, MS_PER_DAY);
}

static f64 date_hour_from_time(f64 t) {
    return date_pmod(floor(t / MS_PER_HOUR), 24.0);
}

static f64 date_min_from_time(f64 t) {
    return date_pmod(floor(t / MS_PER_MINUTE), 60.0);
}

static f64 date_sec_from_time(f64 t) {
    return date_pmod(floor(t / MS_PER_SECOND), 60.0);
}

static f64 date_ms_from_time(f64 t) {
    return date_pmod(t, MS_PER_SECOND);
}

typedef struct {
    f64 day_number;
    f64 time_within_day;
    f64 year;
    f64 month;
    f64 date;
    f64 week_day;
    f64 hour;
    f64 minute;
    f64 second;
    f64 millisecond;
} DateComponents;

typedef enum {
    DATE_COMPONENT_CIVIL = 1 << 0,
    DATE_COMPONENT_WEEK_DAY = 1 << 1,
    DATE_COMPONENT_HOUR = 1 << 2,
    DATE_COMPONENT_MINUTE = 1 << 3,
    DATE_COMPONENT_SECOND = 1 << 4,
    DATE_COMPONENT_MILLISECOND = 1 << 5,
    DATE_COMPONENT_DAY_NUMBER = 1 << 6,
    DATE_COMPONENT_TIME_WITHIN_DAY = 1 << 7,
    DATE_COMPONENT_CLOCK = DATE_COMPONENT_HOUR | DATE_COMPONENT_MINUTE |
        DATE_COMPONENT_SECOND | DATE_COMPONENT_MILLISECOND,
} DateComponentMask;

/** A clipped [[DateValue]] or its local-time projection as exact milliseconds. */
static bool date_integral_milliseconds(f64 t, i64 *out) {
    if (!isfinite(t) || fabs(t) > MAX_TIME + MS_PER_DAY) {
        return false;
    }
    i64 milliseconds = (i64) t;
    if ((f64) milliseconds != t) {
        return false;
    }
    *out = milliseconds;
    return true;
}

/** Mathematical floor(ms / MS_PER_DAY), not C's truncation toward zero. */
static i64 date_integral_day(i64 milliseconds) {
    static const i64 milliseconds_per_day = 86400000;
    i64 day = milliseconds / milliseconds_per_day;
    if (milliseconds < 0 && milliseconds % milliseconds_per_day != 0) {
        day--;
    }
    return day;
}

/** Positive millisecond offset inside a day for a signed epoch value. */
static i64 date_integral_time_within_day(i64 milliseconds) {
    static const i64 milliseconds_per_day = 86400000;
    i64 result = milliseconds % milliseconds_per_day;
    return result < 0 ? result + milliseconds_per_day : result;
}

/** Integral Hinnant civil-from-days projection for the native Date range. */
static void date_civil_from_integral_days(
    i64 day, f64 *year_out, f64 *month_out, f64 *day_out
) {
    i64 z = day + 719468;
    i64 era = (z >= 0 ? z : z - 146096) / 146097;
    i64 doe = z - era * 146097;
    i64 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    i64 year = yoe + era * 400;
    i64 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    i64 mp = (5 * doy + 2) / 153;
    i64 date = doy - (153 * mp + 2) / 5 + 1;
    i64 month = mp < 10 ? mp + 3 : mp - 9;
    *year_out = (f64) (year + (month <= 2));
    *month_out = (f64) (month - 1);
    *day_out = (f64) date;
}

/**
 * Project a finite time value into the requested calendar/time components.
 * Native Date slots and LocalTime projections are exact, bounded milliseconds;
 * project those with integer div/mod so getters avoid libm fmod/floor calls.
 * Combined consumers share both the civil conversion and one positive
 * time-within-day remainder. Fractional or unbounded Intl inputs retain the
 * f64 spec helpers.
 */
static void date_project_components(f64 t, u32 mask, DateComponents *out) {
    i64 integral_milliseconds;
    bool integral = date_integral_milliseconds(t, &integral_milliseconds);
    i64 integral_day = 0;
    if (mask & (DATE_COMPONENT_CIVIL | DATE_COMPONENT_WEEK_DAY | DATE_COMPONENT_DAY_NUMBER)) {
        f64 day;
        if (integral) {
            integral_day = date_integral_day(integral_milliseconds);
            day = (f64) integral_day;
        } else {
            day = date_day(t);
        }
        if (mask & DATE_COMPONENT_DAY_NUMBER) {
            out->day_number = day;
        }
        if (mask & DATE_COMPONENT_CIVIL) {
            if (integral) {
                date_civil_from_integral_days(
                    integral_day, &out->year, &out->month, &out->date);
            } else {
                date_civil_from_days(day, &out->year, &out->month, &out->date);
            }
        }
        if (mask & DATE_COMPONENT_WEEK_DAY) {
            if (integral) {
                i64 week_day = (integral_day + 4) % 7;
                out->week_day = (f64) (week_day < 0 ? week_day + 7 : week_day);
            } else {
                out->week_day = date_pmod(day + 4.0, 7.0);
            }
        }
    }
    u32 clock_mask = mask & DATE_COMPONENT_CLOCK;
    if (integral && (clock_mask != 0 || (mask & DATE_COMPONENT_TIME_WITHIN_DAY))) {
        i64 time_within_day = date_integral_time_within_day(integral_milliseconds);
        if (mask & DATE_COMPONENT_HOUR) {
            out->hour = (f64) (time_within_day / 3600000);
        }
        if (mask & DATE_COMPONENT_MINUTE) {
            out->minute = (f64) ((time_within_day / 60000) % 60);
        }
        if (mask & DATE_COMPONENT_SECOND) {
            out->second = (f64) ((time_within_day / 1000) % 60);
        }
        if (mask & DATE_COMPONENT_MILLISECOND) {
            out->millisecond = (f64) (time_within_day % 1000);
        }
        if (mask & DATE_COMPONENT_TIME_WITHIN_DAY) {
            out->time_within_day = (f64) time_within_day;
        }
    } else {
        if (mask & DATE_COMPONENT_HOUR) out->hour = date_hour_from_time(t);
        if (mask & DATE_COMPONENT_MINUTE) out->minute = date_min_from_time(t);
        if (mask & DATE_COMPONENT_SECOND) out->second = date_sec_from_time(t);
        if (mask & DATE_COMPONENT_MILLISECOND) out->millisecond = date_ms_from_time(t);
        if (mask & DATE_COMPONENT_TIME_WITHIN_DAY) {
            out->time_within_day = date_time_within_day(t);
        }
    }
}

/** MakeTime(§21.4.1.11). */
static f64 date_make_time(f64 hour, f64 min, f64 sec, f64 ms) {
    if (!isfinite(hour) || !isfinite(min) || !isfinite(sec) || !isfinite(ms)) {
        return NAN;
    }
    f64 h = mal_ops_number_to_integer_or_infinity(hour);
    f64 m = mal_ops_number_to_integer_or_infinity(min);
    f64 s = mal_ops_number_to_integer_or_infinity(sec);
    f64 milli = mal_ops_number_to_integer_or_infinity(ms);
    return h * MS_PER_HOUR + m * MS_PER_MINUTE + s * MS_PER_SECOND + milli;
}

/** MakeDay(§21.4.1.12). */
static f64 date_make_day(f64 year, f64 month, f64 date) {
    if (!isfinite(year) || !isfinite(month) || !isfinite(date)) {
        return NAN;
    }
    f64 y = mal_ops_number_to_integer_or_infinity(year);
    f64 m = mal_ops_number_to_integer_or_infinity(month);
    f64 dt = mal_ops_number_to_integer_or_infinity(date);
    f64 ym = y + floor(m / 12.0);
    if (!isfinite(ym)) {
        return NAN;
    }
    f64 mn = m - floor(m / 12.0) * 12.0; // m modulo 12, in [0, 12)
    f64 days = date_days_from_civil(ym, (i32) mn + 1, 1.0);
    return days + dt - 1.0;
}

/** MakeDate(§21.4.1.13). */
static f64 date_make_date(f64 day, f64 time) {
    if (!isfinite(day) || !isfinite(time)) {
        return NAN;
    }
    // Keep multiplication and addition as separately rounded ECMAScript operators.
    volatile f64 date = day * MS_PER_DAY;
    return date + time;
}

/** TimeClip(§21.4.1.14). */
static f64 date_time_clip(f64 t) {
    if (!isfinite(t)) {
        return NAN;
    }
    if (fabs(t) > MAX_TIME) {
        return NAN;
    }
    f64 r = trunc(t);
    return r == 0.0 ? 0.0 : r;
}

/** MakeFullYear (the §21.4.3.4 / constructor 0..99 -> 1900+ mapping). */
static f64 date_make_full_year(f64 year) {
    if (isnan(year)) {
        return NAN;
    }
    f64 ti = mal_ops_number_to_integer_or_infinity(year);
    if (ti >= 0.0 && ti <= 99.0) {
        return 1900.0 + ti;
    }
    return ti;
}

// ---------------------------------------------------------------------------
// Local time zone (LocalTZA), resolved via the bundled tzdb (mal_i18n).
// ---------------------------------------------------------------------------

/** LocalTime(t): UTC -> local, via the system zone's offset (bundled tzdb). */
static f64 date_local_time(f64 t) {
    if (!isfinite(t) || fabs(t) > MAX_TIME) {
        return t;
    }
    return t + (f64) mal_i18n_local_offset_ms((i64) t);
}

/** UTC(t): local -> UTC. The shim resolves DST gap/overlap disambiguation. */
static f64 date_utc_from_local(f64 local) {
    // A local wall time just outside the TimeClip range can map back into it.
    if (!isfinite(local) || fabs(local) > MAX_TIME + MS_PER_DAY) {
        return local;
    }
    return (f64) mal_i18n_utc_from_local_ms((i64) local);
}

/** Current time in integral milliseconds since the epoch. */
static f64 date_now_ms(void) {
    struct timespec ts;
    timespec_get(&ts, TIME_UTC);
    return (f64) ts.tv_sec * 1000.0 + (f64) (ts.tv_nsec / 1000000L);
}

// ---------------------------------------------------------------------------
// Date.parse — the Date Time String Format (§21.4.1.18, ISO 8601 simplified).
// ---------------------------------------------------------------------------

typedef struct {
    const c16 *u;
    usize len;
    usize i;
} DateCursor;

static bool date_cursor_eof(const DateCursor *c) {
    return c->i >= c->len;
}

static c16 date_cursor_peek(const DateCursor *c) {
    return c->i < c->len ? c->u[c->i] : 0;
}

static bool date_cursor_eat(DateCursor *c, c16 ch) {
    if (c->i < c->len && c->u[c->i] == ch) {
        c->i++;
        return true;
    }
    return false;
}

/** Read exactly `count` ASCII digits into *out. */
static bool date_read_digits(DateCursor *c, i32 count, i32 *out) {
    i32 value = 0;
    for (i32 k = 0; k < count; k++) {
        if (c->i >= c->len) {
            return false;
        }
        c16 ch = c->u[c->i];
        if (ch < '0' || ch > '9') {
            return false;
        }
        value = value * 10 + (ch - '0');
        c->i++;
    }
    *out = value;
    return true;
}

/** Parse the ISO 8601 Date Time String Format. Returns the time value, or NaN. */
static f64 date_parse_iso(const c16 *u, usize len) {
    DateCursor c = {u, len, 0};

    i32 year;
    i32 month = 1, date = 1, hour = 0, minute = 0, second = 0, ms = 0;
    bool has_time = false;
    bool has_tz = false;
    bool has_full_date = false;
    bool postgres_style = false;
    i64 tz_offset_ms = 0;

    // Year: a leading sign introduces the 6-digit expanded form (±YYYYYY).
    bool expanded = false;
    i32 year_sign = 1;
    if (date_cursor_peek(&c) == '+') {
        c.i++;
        expanded = true;
    } else if (date_cursor_peek(&c) == '-') {
        c.i++;
        expanded = true;
        year_sign = -1;
    }
    if (expanded) {
        i32 y6;
        if (!date_read_digits(&c, 6, &y6)) {
            return NAN;
        }
        year = year_sign * y6;
        // "-000000" denotes year 0 BCE, which the format forbids.
        if (year_sign < 0 && y6 == 0) {
            return NAN;
        }
    } else {
        i32 y4;
        if (!date_read_digits(&c, 4, &y4)) {
            return NAN;
        }
        year = y4;
    }

    // Optional -MM and -DD.
    if (date_cursor_eat(&c, '-')) {
        if (!date_read_digits(&c, 2, &month)) {
            return NAN;
        }
        if (date_cursor_eat(&c, '-')) {
            if (!date_read_digits(&c, 2, &date)) {
                return NAN;
            }
            has_full_date = true;
        }
    }

    // Node also accepts PostgreSQL's ISO-like output, which uses a space before
    // the time, variable fractional precision, and compact timezone offsets.
    if (date_cursor_peek(&c) == 'T'
        || (has_full_date && date_cursor_peek(&c) == ' ')) {
        postgres_style = date_cursor_peek(&c) == ' ';
        c.i++;
        has_time = true;
        if (!date_read_digits(&c, 2, &hour) || !date_cursor_eat(&c, ':') || !date_read_digits(&c, 2, &minute)) {
            return NAN;
        }
        if (date_cursor_eat(&c, ':')) {
            if (!date_read_digits(&c, 2, &second)) {
                return NAN;
            }
            if (date_cursor_eat(&c, '.')) {
                if (postgres_style) {
                    i32 digits = 0;
                    while (!date_cursor_eof(&c)
                           && date_cursor_peek(&c) >= '0'
                           && date_cursor_peek(&c) <= '9') {
                        if (digits < 3) ms = ms * 10 + (date_cursor_peek(&c) - '0');
                        digits++;
                        c.i++;
                    }
                    if (digits == 0) return NAN;
                    while (digits < 3) {
                        ms *= 10;
                        digits++;
                    }
                } else if (!date_read_digits(&c, 3, &ms)) {
                    return NAN;
                }
            }
        }
        if (date_cursor_eat(&c, 'Z')) {
            has_tz = true;
        } else if (date_cursor_peek(&c) == '+' || date_cursor_peek(&c) == '-') {
            i32 sign = date_cursor_peek(&c) == '-' ? -1 : 1;
            c.i++;
            i32 oh, om = 0;
            if (!date_read_digits(&c, 2, &oh)) {
                return NAN;
            }
            if (date_cursor_eat(&c, ':')) {
                if (!date_read_digits(&c, 2, &om)) return NAN;
            } else if (postgres_style && c.i + 2 <= c.len) {
                if (!date_read_digits(&c, 2, &om)) return NAN;
            } else if (!postgres_style) {
                return NAN;
            }
            if (oh > 23 || om > 59) {
                return NAN;
            }
            has_tz = true;
            tz_offset_ms = (i64) sign *
                ((i64) oh * 3600000 + (i64) om * 60000);
        }
    }

    if (!date_cursor_eof(&c)) {
        return NAN;
    }

    // Field range validation (per the grammar's stated ranges).
    if (month < 1 || month > 12 || date < 1 || date > 31 || minute > 59 || second > 59) {
        return NAN;
    }
    if (hour > 24 || (hour == 24 && (minute != 0 || second != 0 || ms != 0))) {
        return NAN;
    }

    i64 day_number = date_days_from_integral_civil(year, month, date);
    i64 time_within_day = (i64) hour * 3600000 +
        (i64) minute * 60000 + (i64) second * 1000 + ms;
    f64 t = (f64) (day_number * 86400000 + time_within_day);

    if (has_tz) {
        t -= (f64) tz_offset_ms;
    } else if (has_time) {
        // A date-time without a designator is local time; a date-only form is UTC.
        t = date_utc_from_local(t);
    }
    return t;
}

// ---------------------------------------------------------------------------
// Legacy (non-ISO) parsing. The spec leaves these forms implementation-defined
// but requires Date.parse to round-trip Date.prototype.toString and
// toUTCString. We accept those (and tolerant variants): month names, a day, a
// year (optionally signed), an HH:mm[:ss[.sss]] time, and a GMT/UTC[±HHMM] (or
// 'Z') zone, in any order; weekday names and a trailing "(...)" comment are
// ignored.
// ---------------------------------------------------------------------------

static bool date_token_eq_ci(const c16 *tok, usize len, const char *ascii) {
    return mal_ascii_units_equal_ci(tok, len, ascii);
}

/** 0-based month for a token whose first three letters name a month, else -1. */
static i32 date_month_from_name(const c16 *tok, usize len) {
    static const char *names[12] = {
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"
    };
    if (len < 3) {
        return -1;
    }
    for (i32 i = 0; i < 12; i++) {
        if (mal_ascii_units_equal_ci(tok, 3, names[i])) {
            return i;
        }
    }
    return -1;
}

static bool date_is_weekday_name(const c16 *tok, usize len) {
    static const char *names[7] = {"sun", "mon", "tue", "wed", "thu", "fri", "sat"};
    if (len < 3) {
        return false;
    }
    for (i32 i = 0; i < 7; i++) {
        if (mal_ascii_units_equal_ci(tok, 3, names[i])) {
            return true;
        }
    }
    return false;
}

static f64 date_parse_legacy(const c16 *u, usize len) {
    f64 year = NAN;
    i32 month = -1, day = -1;
    i32 hour = 0, minute = 0, second = 0, ms = 0;
    bool has_time = false, has_tz = false;
    f64 tz_offset_ms = 0.0;

    usize i = 0;
    while (i < len) {
        c16 ch = u[i];
        if (ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' || ch == ',') {
            i++;
            continue;
        }
        // A parenthesized comment (e.g. the time-zone name) is ignored.
        if (ch == '(') {
            i32 depth = 0;
            while (i < len) {
                if (u[i] == '(') {
                    depth++;
                } else if (u[i] == ')') {
                    depth--;
                    if (depth == 0) {
                        i++;
                        break;
                    }
                }
                i++;
            }
            continue;
        }
        if (mal_ascii_is_alpha(ch)) {
            usize start = i;
            while (i < len && mal_ascii_is_alpha(u[i])) {
                i++;
            }
            const c16 *tok = u + start;
            usize tlen = i - start;
            i32 mi = date_month_from_name(tok, tlen);
            if (mi >= 0 && month < 0) {
                month = mi;
                continue;
            }
            if (date_token_eq_ci(tok, tlen, "gmt") || date_token_eq_ci(tok, tlen, "utc")
                || date_token_eq_ci(tok, tlen, "ut") || date_token_eq_ci(tok, tlen, "z")) {
                has_tz = true;
                tz_offset_ms = 0.0;
                continue;
            }
            if (date_is_weekday_name(tok, tlen)) {
                continue;
            }
            return NAN;
        }
        // A sign introduces either a tz offset (after the date/time and zone are
        // established) or a negative year.
        if (ch == '+' || ch == '-') {
            i32 sign = ch == '-' ? -1 : 1;
            usize p = i + 1;
            usize dstart = p;
            while (p < len && u[p] >= '0' && u[p] <= '9') {
                p++;
            }
            usize digits = p - dstart;
            if (digits == 0) {
                return NAN;
            }
            bool offset_context = has_tz || (!isnan(year) && month >= 0 && day >= 0);
            if (offset_context) {
                // ±HH:MM or ±HHMM or ±HH offset.
                i32 oh = 0, om = 0;
                if (digits >= 3) {
                    // HHMM packed (read first len-2 as hours).
                    i32 hv = 0;
                    for (usize k = dstart; k < p - 2; k++) {
                        hv = hv * 10 + (u[k] - '0');
                    }
                    oh = hv;
                    om = (u[p - 2] - '0') * 10 + (u[p - 1] - '0');
                } else {
                    for (usize k = dstart; k < p; k++) {
                        oh = oh * 10 + (u[k] - '0');
                    }
                    if (p < len && u[p] == ':') {
                        p++;
                        usize mstart = p;
                        while (p < len && u[p] >= '0' && u[p] <= '9') {
                            p++;
                        }
                        for (usize k = mstart; k < p; k++) {
                            om = om * 10 + (u[k] - '0');
                        }
                    }
                }
                if (oh > 23 || om > 59) {
                    return NAN;
                }
                has_tz = true;
                tz_offset_ms = (f64) sign * ((f64) oh * MS_PER_HOUR + (f64) om * MS_PER_MINUTE);
                i = p;
                continue;
            }
            // Signed year.
            if (!isnan(year)) {
                return NAN;
            }
            i32 yv = 0;
            for (usize k = dstart; k < p; k++) {
                yv = yv * 10 + (u[k] - '0');
            }
            year = (f64) (sign * yv);
            i = p;
            continue;
        }
        if (ch >= '0' && ch <= '9') {
            usize start = i;
            while (i < len && u[i] >= '0' && u[i] <= '9') {
                i++;
            }
            usize digits = i - start;
            i32 value = 0;
            for (usize k = start; k < i; k++) {
                value = value * 10 + (u[k] - '0');
            }
            // A ':' marks this as the hour of an HH:mm[:ss[.sss]] time.
            if (i < len && u[i] == ':') {
                has_time = true;
                hour = value;
                i++;
                if (i >= len || u[i] < '0' || u[i] > '9') {
                    return NAN;
                }
                minute = 0;
                while (i < len && u[i] >= '0' && u[i] <= '9') {
                    minute = minute * 10 + (u[i] - '0');
                    i++;
                }
                if (i < len && u[i] == ':') {
                    i++;
                    second = 0;
                    while (i < len && u[i] >= '0' && u[i] <= '9') {
                        second = second * 10 + (u[i] - '0');
                        i++;
                    }
                    if (i < len && u[i] == '.') {
                        i++;
                        i32 frac = 0, fdigits = 0;
                        while (i < len && u[i] >= '0' && u[i] <= '9') {
                            if (fdigits < 3) {
                                frac = frac * 10 + (u[i] - '0');
                                fdigits++;
                            }
                            i++;
                        }
                        while (fdigits < 3) {
                            frac *= 10;
                            fdigits++;
                        }
                        ms = frac;
                    }
                }
                continue;
            }
            // A 4+-digit run, or a value too large to be a day, is the year.
            if (isnan(year) && (digits >= 4 || value > 31)) {
                year = (f64) value;
            } else if (day < 0) {
                day = value;
            } else if (isnan(year)) {
                year = (f64) value;
            } else {
                return NAN;
            }
            continue;
        }
        return NAN;
    }

    if (isnan(year) || month < 0 || day < 0) {
        return NAN;
    }
    if (month > 11 || day < 1 || day > 31 || minute > 59 || second > 59) {
        return NAN;
    }
    if (hour > 24 || (hour == 24 && (minute != 0 || second != 0 || ms != 0))) {
        return NAN;
    }

    f64 t = date_make_date(
        date_make_day(year, (f64) month, (f64) day),
        date_make_time((f64) hour, (f64) minute, (f64) second, (f64) ms)
    );
    if (has_tz) {
        t = t - tz_offset_ms;
    } else {
        t = date_utc_from_local(t);
    }
    return t;
}

/** Parse a date string: ISO 8601 first, then the legacy toString/toUTCString
 * forms. Returns the (un-clipped) time value, or NaN. */
static f64 date_parse_units(const c16 *u, usize len) {
    f64 t = date_parse_iso(u, len);
    if (!isnan(t)) {
        return t;
    }
    return date_parse_legacy(u, len);
}

/** Flatten and parse a string while keeping a newly coerced/constructed cons
 * string alive across the flatten allocation. */
static f64 date_parse_string_value(MalString *string) {
    MalValue string_root = mal_value_from_string(string);
    MalRootSpan root_span;
    mal_gc_root(&root_span, &string_root, 1);
    (void) mal_string_code_units(string);
    string = mal_value_to_string(string_root);
    f64 parsed = date_parse_units(
        mal_string_code_units(string), mal_string_length(string));
    mal_gc_unroot(&root_span);
    return date_time_clip(parsed);
}

// ---------------------------------------------------------------------------
// String rendering
// ---------------------------------------------------------------------------

static const byte DATE_DIGIT_PAIRS[] =
    "00010203040506070809"
    "10111213141516171819"
    "20212223242526272829"
    "30313233343536373839"
    "40414243444546474849"
    "50515253545556575859"
    "60616263646566676869"
    "70717273747576777879"
    "80818283848586878889"
    "90919293949596979899";

static byte *date_write_two_digits(byte *buf, i32 value) {
    memcpy(buf, DATE_DIGIT_PAIRS + (usize) value * 2, 2);
    return buf + 2;
}

static byte *date_write_three_digits(byte *buf, i32 value) {
    buf[0] = (byte) ('0' + value / 100);
    memcpy(buf + 1, DATE_DIGIT_PAIRS + (usize) (value % 100) * 2, 2);
    return buf + 3;
}

/** Write an unsigned decimal integer, zero-padded to at least min_digits. */
static byte *date_write_unsigned(byte *buf, u64 value, usize min_digits) {
    usize digits = 1;
    for (u64 remaining = value; remaining >= 10; remaining /= 10) {
        digits++;
    }
    if (digits < min_digits) {
        digits = min_digits;
    }
    byte *end = buf + digits;
    byte *cursor = end;
    do {
        *--cursor = (byte) ('0' + value % 10);
        value /= 10;
    } while (value != 0);
    while (cursor != buf) {
        *--cursor = '0';
    }
    return end;
}

/** Write a signed Date year with at least four magnitude digits. */
static byte *date_write_year(byte *buf, f64 year) {
    i64 value = (i64) year;
    if (value < 0) {
        *buf++ = '-';
        value = -value;
    }
    return date_write_unsigned(buf, (u64) value, 4);
}

/** "Www Mmm DD YYYY" from projected finite components. Returns bytes written. */
static usize date_render_date_string(byte *buf, const DateComponents *components) {
    i32 wd = (i32) components->week_day;
    i32 mo = (i32) components->month;
    byte *cursor = buf;
    memcpy(cursor, WEEKDAY_NAMES[wd], 3);
    cursor += 3;
    *cursor++ = ' ';
    memcpy(cursor, MONTH_NAMES[mo], 3);
    cursor += 3;
    *cursor++ = ' ';
    cursor = date_write_two_digits(cursor, (i32) components->date);
    *cursor++ = ' ';
    cursor = date_write_year(cursor, components->year);
    return (usize) (cursor - buf);
}

/** "HH:mm:ss GMT" from projected finite components. */
static usize date_render_time_string(byte *buf, const DateComponents *components) {
    byte *cursor = date_write_two_digits(buf, (i32) components->hour);
    *cursor++ = ':';
    cursor = date_write_two_digits(cursor, (i32) components->minute);
    *cursor++ = ':';
    cursor = date_write_two_digits(cursor, (i32) components->second);
    memcpy(cursor, " GMT", 4);
    return (usize) (cursor + 4 - buf);
}

/** "+HHMM (Time Zone Name)" for a derived local offset, in at most `cap` bytes. */
static usize date_render_tz_string(byte *buf, usize cap, f64 offset) {
    i64 abs_offset = (i64) fabs(offset);
    i32 oh = (i32) (abs_offset / 3600000);
    i32 om = (i32) ((abs_offset / 60000) % 60);
    u8 name[64];
    i32 name_len = mal_i18n_local_tz_name(name, (i32) sizeof(name));
    if (name_len < 0) {
        name_len = 0;
    } else if (name_len > (i32) sizeof(name)) {
        name_len = (i32) sizeof(name);
    }
    // Every internal caller supplies MAL_DATE_RENDER_BUF minus at most 40 bytes;
    // retain a cap guard so this helper stays safe if reused independently.
    usize required = 8 + (usize) name_len;
    if (cap < required) {
        name_len = cap > 8 ? (i32) (cap - 8) : 0;
        required = 8 + (usize) name_len;
    }
    if (cap < 8) {
        return 0;
    }
    byte *cursor = buf;
    *cursor++ = offset < 0.0 ? '-' : '+';
    cursor = date_write_two_digits(cursor, oh);
    cursor = date_write_two_digits(cursor, om);
    memcpy(cursor, " (", 2);
    cursor += 2;
    memcpy(cursor, name, (usize) name_len);
    cursor += name_len;
    *cursor = ')';
    return required;
}

/** ToDateString(tv): the full Date.prototype.toString form. */
static usize date_render_full(byte *buf, f64 tv) {
    if (isnan(tv)) {
        memcpy(buf, "Invalid Date", 12);
        return 12;
    }
    f64 t = date_local_time(tv);
    DateComponents components;
    date_project_components(
        t,
        DATE_COMPONENT_CIVIL | DATE_COMPONENT_WEEK_DAY |
            DATE_COMPONENT_HOUR | DATE_COMPONENT_MINUTE | DATE_COMPONENT_SECOND,
        &components
    );
    usize n = date_render_date_string(buf, &components);
    buf[n++] = ' ';
    n += date_render_time_string(buf + n, &components);
    n += date_render_tz_string(buf + n, MAL_DATE_RENDER_BUF - n, t - tv);
    return n;
}

/** Year field for toISOString: 4 digits in [0,9999] else a signed 6-digit form. */
static usize date_render_iso_year(byte *buf, f64 year) {
    if (year >= 0.0 && year <= 9999.0) {
        return (usize) (date_write_unsigned(buf, (u64) year, 4) - buf);
    }
    byte *cursor = buf;
    if (year < 0.0) {
        *cursor++ = '-';
        year = -year;
    } else {
        *cursor++ = '+';
    }
    cursor = date_write_unsigned(cursor, (u64) year, 6);
    return (usize) (cursor - buf);
}

// ---------------------------------------------------------------------------
// Receiver brand check + result boxing
// ---------------------------------------------------------------------------

static bool date_this(MalVm *vm, MalValue this_value, MalDateObject **out) {
    if (!mal_value_is_date_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Date.prototype method called on incompatible receiver");
        return false;
    }
    *out = mal_value_to_date_object(this_value);
    return true;
}

static bool date_string_eq_ascii(const MalString *s, const char *ascii) {
    return mal_string_equals_ascii(s, ascii);
}

static MalValue date_string_value(MalVm *vm, const byte *buf, usize length) {
    return mal_value_from_string(mal_string_new_ascii(&vm->heap, buf, length));
}

static bool date_to_number(MalVm *vm, MalValue value, f64 *out) {
    if (mal_ops_is_number(value)) {
        *out = mal_ops_number_as_f64(value);
        return true;
    }
    return mal_vm_to_number(vm, value, out);
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

static MalValue date_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) callee;

    // Called as a plain function: return ToString(now), ignoring any arguments.
    if (mal_value_is_undefined(new_target)) {
        byte buf[160];
        usize n = date_render_full(buf, date_now_ms());
        return date_string_value(vm, buf, n);
    }

    f64 date_value;
    if (arg_count == 0) {
        // Current time is already an integral millisecond well inside TimeClip.
        date_value = date_now_ms();
    } else if (arg_count == 1) {
        MalValue value = args[0];
        if (mal_value_is_date_object(value)) {
            // [[DateValue]] is always already TimeClipped (or NaN).
            date_value = mal_value_to_date_object(value)->date_value;
        } else if (mal_ops_is_number(value)) {
            date_value = date_time_clip(mal_ops_number_as_f64(value));
        } else {
            MalValue primitive;
            if (!mal_vm_to_primitive(vm, value, MAL_TO_PRIMITIVE_DEFAULT, &primitive)) {
                return mal_value_new_undefined();
            }
            if (mal_value_is_string(primitive)) {
                date_value = date_parse_string_value(mal_value_to_string(primitive));
            } else {
                f64 number;
                if (!date_to_number(vm, primitive, &number)) {
                    return mal_value_new_undefined();
                }
                date_value = date_time_clip(number);
            }
        }
    } else {
        // year, month, [date=1], [hours=0], [minutes=0], [seconds=0], [ms=0] in local time.
        f64 comps[7] = {0, 0, 1, 0, 0, 0, 0};
        i32 need = arg_count < 7 ? arg_count : 7;
        for (i32 i = 0; i < need; i++) {
            if (!date_to_number(vm, args[i], &comps[i])) {
                return mal_value_new_undefined();
            }
        }
        f64 year = date_make_full_year(comps[0]);
        f64 final_date = date_make_date(
            date_make_day(year, comps[1], comps[2]),
            date_make_time(comps[3], comps[4], comps[5], comps[6])
        );
        date_value = date_time_clip(date_utc_from_local(final_date));
    }

    MalValue prototype_root = mal_value_new_undefined();
    MalRootSpan root_span;
    mal_gc_root(&root_span, &prototype_root, 1);
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, new_target, MAL_INTRINSIC_DATE_PROTOTYPE, &prototype)) {
        mal_gc_unroot(&root_span);
        return mal_value_new_undefined();
    }
    prototype_root = mal_value_from_object(prototype);
    MalValue result = mal_value_from_date_object(mal_date_object_new(
        &vm->heap, mal_value_to_object(prototype_root), date_value));
    mal_gc_unroot(&root_span);
    return result;
}

// ---------------------------------------------------------------------------
// Statics
// ---------------------------------------------------------------------------

MalValue mal_builtin_date_now_known(void) {
    return mal_ops_number_value(date_now_ms());
}

MalValue mal_builtin_date_parse_known(MalVm *vm, const MalValue *args, i32 arg_count) {
    MalString *string;
    if (!mal_vm_to_string(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &string)) {
        return mal_value_new_undefined();
    }
    return mal_ops_number_value(date_parse_string_value(string));
}

MalValue mal_builtin_date_utc_known(MalVm *vm, const MalValue *args, i32 arg_count) {
    f64 comps[7] = {0, 0, 1, 0, 0, 0, 0};
    f64 year;
    if (!date_to_number(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &year)) {
        return mal_value_new_undefined();
    }
    i32 need = arg_count < 7 ? arg_count : 7;
    for (i32 i = 1; i < need; i++) {
        if (!date_to_number(vm, args[i], &comps[i])) {
            return mal_value_new_undefined();
        }
    }
    f64 full_year = date_make_full_year(year);
    f64 t = date_make_date(
        date_make_day(full_year, comps[1], comps[2]),
        date_make_time(comps[3], comps[4], comps[5], comps[6])
    );
    return mal_ops_number_value(date_time_clip(t));
}

static MalValue date_now(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    return mal_builtin_date_now_known();
}

static MalValue date_parse(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    return mal_builtin_date_parse_known(vm, args, arg_count);
}

static MalValue date_utc(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    return mal_builtin_date_utc_known(vm, args, arg_count);
}

// ---------------------------------------------------------------------------
// Prototype getters
// ---------------------------------------------------------------------------

typedef enum {
    DATE_FIELD_FULL_YEAR,
    DATE_FIELD_MONTH,
    DATE_FIELD_DATE,
    DATE_FIELD_DAY,
    DATE_FIELD_HOURS,
    DATE_FIELD_MINUTES,
    DATE_FIELD_SECONDS,
    DATE_FIELD_MS,
} DateField;

static MalValue date_get_field(MalVm *vm, MalValue this_value, bool utc, DateField field) {
    MalDateObject *date;
    if (!date_this(vm, this_value, &date)) {
        return mal_value_new_undefined();
    }
    f64 tv = date->date_value;
    if (isnan(tv)) {
        return mal_value_new_nan();
    }
    f64 t = utc ? tv : date_local_time(tv);
    u32 mask;
    switch (field) {
        case DATE_FIELD_FULL_YEAR:
        case DATE_FIELD_MONTH:
        case DATE_FIELD_DATE: mask = DATE_COMPONENT_CIVIL; break;
        case DATE_FIELD_DAY: mask = DATE_COMPONENT_WEEK_DAY; break;
        case DATE_FIELD_HOURS: mask = DATE_COMPONENT_HOUR; break;
        case DATE_FIELD_MINUTES: mask = DATE_COMPONENT_MINUTE; break;
        case DATE_FIELD_SECONDS: mask = DATE_COMPONENT_SECOND; break;
        default: mask = DATE_COMPONENT_MILLISECOND; break;
    }
    DateComponents components;
    date_project_components(t, mask, &components);
    f64 value;
    switch (field) {
        case DATE_FIELD_FULL_YEAR: value = components.year; break;
        case DATE_FIELD_MONTH: value = components.month; break;
        case DATE_FIELD_DATE: value = components.date; break;
        case DATE_FIELD_DAY: value = components.week_day; break;
        case DATE_FIELD_HOURS: value = components.hour; break;
        case DATE_FIELD_MINUTES: value = components.minute; break;
        case DATE_FIELD_SECONDS: value = components.second; break;
        default: value = components.millisecond; break;
    }
    return mal_ops_number_value(value);
}

#define DATE_GETTER(fn_name, utc_flag, field_id)                                                                  \
    static MalValue fn_name(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) { \
        (void) args;                                                                                              \
        (void) arg_count;                                                                                         \
        (void) nt;                                                                                                \
        (void) cl;                                                                                                \
        return date_get_field(vm, this_value, utc_flag, field_id);                                                \
    }

DATE_GETTER(date_proto_get_full_year, false, DATE_FIELD_FULL_YEAR)
DATE_GETTER(date_proto_get_utc_full_year, true, DATE_FIELD_FULL_YEAR)
DATE_GETTER(date_proto_get_month, false, DATE_FIELD_MONTH)
DATE_GETTER(date_proto_get_utc_month, true, DATE_FIELD_MONTH)
DATE_GETTER(date_proto_get_date, false, DATE_FIELD_DATE)
DATE_GETTER(date_proto_get_utc_date, true, DATE_FIELD_DATE)
DATE_GETTER(date_proto_get_day, false, DATE_FIELD_DAY)
DATE_GETTER(date_proto_get_utc_day, true, DATE_FIELD_DAY)
DATE_GETTER(date_proto_get_hours, false, DATE_FIELD_HOURS)
DATE_GETTER(date_proto_get_utc_hours, true, DATE_FIELD_HOURS)
DATE_GETTER(date_proto_get_minutes, false, DATE_FIELD_MINUTES)
DATE_GETTER(date_proto_get_utc_minutes, true, DATE_FIELD_MINUTES)
DATE_GETTER(date_proto_get_seconds, false, DATE_FIELD_SECONDS)
DATE_GETTER(date_proto_get_utc_seconds, true, DATE_FIELD_SECONDS)
DATE_GETTER(date_proto_get_milliseconds, false, DATE_FIELD_MS)
DATE_GETTER(date_proto_get_utc_milliseconds, true, DATE_FIELD_MS)

static MalValue date_proto_get_year(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) args;
    (void) arg_count;
    (void) nt;
    (void) cl;
    MalDateObject *date;
    if (!date_this(vm, this_value, &date)) {
        return mal_value_new_undefined();
    }
    if (isnan(date->date_value)) {
        return mal_value_new_nan();
    }
    DateComponents components;
    date_project_components(
        date_local_time(date->date_value), DATE_COMPONENT_CIVIL, &components);
    return mal_ops_number_value(components.year - 1900.0);
}

static MalValue date_proto_get_time(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) args;
    (void) arg_count;
    (void) nt;
    (void) cl;
    MalDateObject *date;
    if (!date_this(vm, this_value, &date)) {
        return mal_value_new_undefined();
    }
    return mal_ops_number_value(date->date_value);
}

static MalValue date_proto_get_timezone_offset(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) args;
    (void) arg_count;
    (void) nt;
    (void) cl;
    MalDateObject *date;
    if (!date_this(vm, this_value, &date)) {
        return mal_value_new_undefined();
    }
    f64 tv = date->date_value;
    if (isnan(tv)) {
        return mal_value_new_nan();
    }
    return mal_ops_number_value((tv - date_local_time(tv)) / MS_PER_MINUTE);
}

// ---------------------------------------------------------------------------
// Prototype setters
// ---------------------------------------------------------------------------

static MalValue date_set_result(MalDateObject *date, f64 value) {
    date->date_value = value;
    return mal_ops_number_value(value);
}

static MalValue date_proto_set_time(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) nt;
    (void) cl;
    MalDateObject *date;
    if (!date_this(vm, this_value, &date)) {
        return mal_value_new_undefined();
    }
    f64 time;
    if (!date_to_number(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &time)) {
        return mal_value_new_undefined();
    }
    return date_set_result(date, date_time_clip(time));
}

/**
 * Shared body for the time-field setters. `first` is the index of the required
 * field (0=hours, 1=minutes, 2=seconds, 3=milliseconds); the required field is
 * always converted (undefined -> NaN), trailing optional fields default from the
 * current time when absent.
 */
static MalValue date_set_time_fields(MalVm *vm, MalValue this_value, bool utc, const MalValue *args, i32 arg_count, i32 first) {
    MalDateObject *date;
    if (!date_this(vm, this_value, &date)) {
        return mal_value_new_undefined();
    }
    // Spec reads [[DateValue]] BEFORE coercing the arguments, so a valueOf hook
    // mutating this Date during ToNumber does not change the value the result is
    // computed from (Date.prototype.setHours et al., steps "Let t be ...").
    f64 tv = date->date_value;
    f64 vals[4] = {0, 0, 0, 0};
    bool present[4] = {false, false, false, false};

    if (!date_to_number(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &vals[first])) {
        return mal_value_new_undefined();
    }
    present[first] = true;
    i32 fields = 4 - first;
    for (i32 i = 1; i < fields; i++) {
        if (i < arg_count) {
            if (!date_to_number(vm, args[i], &vals[first + i])) {
                return mal_value_new_undefined();
            }
            present[first + i] = true;
        }
    }

    // "If t is NaN, return NaN." - return without writing [[DateValue]] (which a
    // valueOf hook may already have changed).
    if (isnan(tv)) {
        return mal_ops_number_value(NAN);
    }
    f64 t = utc ? tv : date_local_time(tv);
    u32 mask = DATE_COMPONENT_DAY_NUMBER;
    if (!present[0]) mask |= DATE_COMPONENT_HOUR;
    if (!present[1]) mask |= DATE_COMPONENT_MINUTE;
    if (!present[2]) mask |= DATE_COMPONENT_SECOND;
    if (!present[3]) mask |= DATE_COMPONENT_MILLISECOND;
    DateComponents components;
    date_project_components(t, mask, &components);
    f64 h = present[0] ? vals[0] : components.hour;
    f64 m = present[1] ? vals[1] : components.minute;
    f64 s = present[2] ? vals[2] : components.second;
    f64 milli = present[3] ? vals[3] : components.millisecond;
    f64 new_date = date_make_date(
        components.day_number, date_make_time(h, m, s, milli));
    return date_set_result(date, date_time_clip(utc ? new_date : date_utc_from_local(new_date)));
}

/**
 * Shared body for the date-field setters. `first` is the index of the required
 * field (0=year, 1=month, 2=date). `reset_nan` resets an invalid receiver to t=+0
 * (only setFullYear/setUTCFullYear do).
 */
static MalValue date_set_date_fields(MalVm *vm, MalValue this_value, bool utc, const MalValue *args, i32 arg_count, i32 first, bool reset_nan, bool make_full_year) {
    MalDateObject *date;
    if (!date_this(vm, this_value, &date)) {
        return mal_value_new_undefined();
    }
    // Read [[DateValue]] before coercing arguments (see date_set_time_fields).
    f64 tv = date->date_value;
    f64 vals[3] = {0, 0, 0};
    bool present[3] = {false, false, false};

    if (!date_to_number(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &vals[first])) {
        return mal_value_new_undefined();
    }
    present[first] = true;
    i32 fields = 3 - first;
    for (i32 i = 1; i < fields; i++) {
        if (i < arg_count) {
            if (!date_to_number(vm, args[i], &vals[first + i])) {
                return mal_value_new_undefined();
            }
            present[first + i] = true;
        }
    }
    if (make_full_year) {
        vals[first] = date_make_full_year(vals[first]);
    }

    f64 t;
    if (reset_nan) {
        // setFullYear/setUTCFullYear: an invalid receiver resets t to +0 instead
        // of returning NaN, so they always produce a valid date.
        t = isnan(tv) ? 0.0 : (utc ? tv : date_local_time(tv));
    } else {
        // "If t is NaN, return NaN." - without writing [[DateValue]].
        if (isnan(tv)) {
            return mal_ops_number_value(NAN);
        }
        t = utc ? tv : date_local_time(tv);
    }
    u32 mask = DATE_COMPONENT_TIME_WITHIN_DAY;
    if (!present[0] || !present[1] || !present[2]) {
        mask |= DATE_COMPONENT_CIVIL;
    }
    DateComponents components;
    date_project_components(t, mask, &components);
    f64 year = present[0] ? vals[0] : components.year;
    f64 month = present[1] ? vals[1] : components.month;
    f64 day = present[2] ? vals[2] : components.date;
    f64 new_date = date_make_date(
        date_make_day(year, month, day), components.time_within_day);
    return date_set_result(date, date_time_clip(utc ? new_date : date_utc_from_local(new_date)));
}

#define DATE_TIME_SETTER(fn_name, utc_flag, first_field)                                                          \
    static MalValue fn_name(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) { \
        (void) nt;                                                                                                \
        (void) cl;                                                                                                \
        return date_set_time_fields(vm, this_value, utc_flag, args, arg_count, first_field);                      \
    }

#define DATE_DATE_SETTER(fn_name, utc_flag, first_field, reset, make_full)                                        \
    static MalValue fn_name(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) { \
        (void) nt;                                                                                                \
        (void) cl;                                                                                                \
        return date_set_date_fields(vm, this_value, utc_flag, args, arg_count, first_field, reset, make_full);    \
    }

DATE_TIME_SETTER(date_proto_set_milliseconds, false, 3)
DATE_TIME_SETTER(date_proto_set_utc_milliseconds, true, 3)
DATE_TIME_SETTER(date_proto_set_seconds, false, 2)
DATE_TIME_SETTER(date_proto_set_utc_seconds, true, 2)
DATE_TIME_SETTER(date_proto_set_minutes, false, 1)
DATE_TIME_SETTER(date_proto_set_utc_minutes, true, 1)
DATE_TIME_SETTER(date_proto_set_hours, false, 0)
DATE_TIME_SETTER(date_proto_set_utc_hours, true, 0)

DATE_DATE_SETTER(date_proto_set_date, false, 2, false, false)
DATE_DATE_SETTER(date_proto_set_utc_date, true, 2, false, false)
DATE_DATE_SETTER(date_proto_set_month, false, 1, false, false)
DATE_DATE_SETTER(date_proto_set_utc_month, true, 1, false, false)
DATE_DATE_SETTER(date_proto_set_full_year, false, 0, true, false)
DATE_DATE_SETTER(date_proto_set_utc_full_year, true, 0, true, false)
DATE_DATE_SETTER(date_proto_set_year, false, 0, true, true)

// ---------------------------------------------------------------------------
// Prototype string conversions
// ---------------------------------------------------------------------------

static MalValue date_proto_to_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) args;
    (void) arg_count;
    (void) nt;
    (void) cl;
    MalDateObject *date;
    if (!date_this(vm, this_value, &date)) {
        return mal_value_new_undefined();
    }
    if (isnan(date->date_value)) {
        return mal_value_from_string(mal_intrinsic_ascii(vm, "Invalid Date"));
    }
    byte buf[MAL_DATE_RENDER_BUF];
    usize n = date_render_full(buf, date->date_value);
    return date_string_value(vm, buf, n);
}

static MalValue date_proto_to_date_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) args;
    (void) arg_count;
    (void) nt;
    (void) cl;
    MalDateObject *date;
    if (!date_this(vm, this_value, &date)) {
        return mal_value_new_undefined();
    }
    if (isnan(date->date_value)) {
        return mal_value_from_string(mal_intrinsic_ascii(vm, "Invalid Date"));
    }
    DateComponents components;
    date_project_components(
        date_local_time(date->date_value),
        DATE_COMPONENT_CIVIL | DATE_COMPONENT_WEEK_DAY,
        &components
    );
    byte buf[64];
    usize n = date_render_date_string(buf, &components);
    return date_string_value(vm, buf, n);
}

static MalValue date_proto_to_time_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) args;
    (void) arg_count;
    (void) nt;
    (void) cl;
    MalDateObject *date;
    if (!date_this(vm, this_value, &date)) {
        return mal_value_new_undefined();
    }
    f64 tv = date->date_value;
    if (isnan(tv)) {
        return mal_value_from_string(mal_intrinsic_ascii(vm, "Invalid Date"));
    }
    f64 local = date_local_time(tv);
    DateComponents components;
    date_project_components(
        local,
        DATE_COMPONENT_HOUR | DATE_COMPONENT_MINUTE | DATE_COMPONENT_SECOND,
        &components
    );
    byte buf[MAL_DATE_RENDER_BUF];
    usize n = date_render_time_string(buf, &components);
    n += date_render_tz_string(buf + n, MAL_DATE_RENDER_BUF - n, local - tv);
    return date_string_value(vm, buf, n);
}

static MalValue date_proto_to_utc_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) args;
    (void) arg_count;
    (void) nt;
    (void) cl;
    MalDateObject *date;
    if (!date_this(vm, this_value, &date)) {
        return mal_value_new_undefined();
    }
    f64 t = date->date_value;
    if (isnan(t)) {
        return mal_value_from_string(mal_intrinsic_ascii(vm, "Invalid Date"));
    }
    DateComponents components;
    date_project_components(
        t,
        DATE_COMPONENT_CIVIL | DATE_COMPONENT_WEEK_DAY |
            DATE_COMPONENT_HOUR | DATE_COMPONENT_MINUTE | DATE_COMPONENT_SECOND,
        &components
    );
    i32 wd = (i32) components.week_day;
    i32 mo = (i32) components.month;
    byte buf[64];
    byte *cursor = buf;
    memcpy(cursor, WEEKDAY_NAMES[wd], 3);
    cursor += 3;
    memcpy(cursor, ", ", 2);
    cursor += 2;
    cursor = date_write_two_digits(cursor, (i32) components.date);
    *cursor++ = ' ';
    memcpy(cursor, MONTH_NAMES[mo], 3);
    cursor += 3;
    *cursor++ = ' ';
    cursor = date_write_year(cursor, components.year);
    *cursor++ = ' ';
    cursor += date_render_time_string(cursor, &components);
    return date_string_value(vm, buf, (usize) (cursor - buf));
}

static MalValue date_proto_to_iso_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) args;
    (void) arg_count;
    (void) nt;
    (void) cl;
    MalDateObject *date;
    if (!date_this(vm, this_value, &date)) {
        return mal_value_new_undefined();
    }
    f64 t = date->date_value;
    if (!isfinite(t)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid time value");
        return mal_value_new_undefined();
    }
    DateComponents components;
    date_project_components(t, DATE_COMPONENT_CIVIL | DATE_COMPONENT_CLOCK, &components);
    byte buf[48];
    byte *cursor = buf + date_render_iso_year(buf, components.year);
    *cursor++ = '-';
    cursor = date_write_two_digits(cursor, (i32) components.month + 1);
    *cursor++ = '-';
    cursor = date_write_two_digits(cursor, (i32) components.date);
    *cursor++ = 'T';
    cursor = date_write_two_digits(cursor, (i32) components.hour);
    *cursor++ = ':';
    cursor = date_write_two_digits(cursor, (i32) components.minute);
    *cursor++ = ':';
    cursor = date_write_two_digits(cursor, (i32) components.second);
    *cursor++ = '.';
    cursor = date_write_three_digits(cursor, (i32) components.millisecond);
    *cursor++ = 'Z';
    return date_string_value(vm, buf, (usize) (cursor - buf));
}

#if MAL_TEMPORAL
static MalValue date_proto_to_temporal_instant(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    MalDateObject *date;
    if (!date_this(vm, this_value, &date)) {
        return mal_value_new_undefined();
    }
    if (!isfinite(date->date_value)) {
        mal_vm_throw_error(
            vm,
            MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "Invalid time value"
        );
        return mal_value_new_undefined();
    }
    return mal_builtin_temporal_instant_from_epoch_milliseconds(
        vm,
        date->date_value
    );
}
#endif

static MalValue date_proto_to_json(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) args;
    (void) arg_count;
    (void) nt;
    (void) cl;
    // tv = ? ToPrimitive(this, number); a non-finite Number serializes as null.
    MalValue tv;
    if (!mal_vm_to_primitive(vm, this_value, MAL_TO_PRIMITIVE_NUMBER, &tv)) {
        return mal_value_new_undefined();
    }
    if (mal_ops_is_number(tv) && !isfinite(mal_ops_number_as_f64(tv))) {
        return mal_value_new_null();
    }
    MalValue method;
    if (!mal_vm_get_property(vm, this_value, mal_intrinsic_string_key(vm, "toISOString"), &method)) {
        return mal_value_new_undefined();
    }
    if (!mal_value_is_callable(method)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "toISOString is not callable");
        return mal_value_new_undefined();
    }
    MalCompletion result = mal_vm_call_value(vm, method, this_value, nullptr, 0);
    if (result.kind != MAL_COMPLETION_NORMAL) {
        return mal_value_new_undefined();
    }
    return result.value;
}

static MalValue date_proto_to_primitive(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) nt;
    (void) cl;
    if (!mal_value_is_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Date.prototype[Symbol.toPrimitive] called on non-object");
        return mal_value_new_undefined();
    }
    if (arg_count < 1 || !mal_value_is_string(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "invalid hint");
        return mal_value_new_undefined();
    }

    MalString *hint = mal_value_to_string(args[0]);
    const byte *methods[2];
    if (date_string_eq_ascii(hint, "string") || date_string_eq_ascii(hint, "default")) {
        methods[0] = (const byte *) "toString";
        methods[1] = (const byte *) "valueOf";
    } else if (date_string_eq_ascii(hint, "number")) {
        methods[0] = (const byte *) "valueOf";
        methods[1] = (const byte *) "toString";
    } else {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "invalid hint");
        return mal_value_new_undefined();
    }

    // OrdinaryToPrimitive(this, hint): try each method in order, accept the first
    // that yields a primitive.
    for (i32 i = 0; i < 2; i++) {
        MalValue method;
        if (!mal_vm_get_property(vm, this_value, mal_intrinsic_string_key(vm, methods[i]), &method)) {
            return mal_value_new_undefined();
        }
        if (mal_value_is_callable(method)) {
            MalCompletion result = mal_vm_call_value(vm, method, this_value, nullptr, 0);
            if (result.kind != MAL_COMPLETION_NORMAL) {
                return mal_value_new_undefined();
            }
            if (!mal_value_is_object(result.value)) {
                return result.value;
            }
        }
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert object to primitive value");
    return mal_value_new_undefined();
}

// ---------------------------------------------------------------------------
// toLocale* — delegate to Intl.DateTimeFormat
// ---------------------------------------------------------------------------

static MalValue date_proto_to_locale(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, i32 which) {
    MalDateObject *date;
    if (!date_this(vm, this_value, &date)) {
        return mal_value_new_undefined();
    }
    MalValue locales = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalValue options = arg_count >= 2 ? args[1] : mal_value_new_undefined();
    return mal_intl_date_to_locale_string(vm, date->date_value, locales, options, which);
}

static MalValue date_proto_to_locale_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) nt;
    (void) cl;
    return date_proto_to_locale(vm, this_value, args, arg_count, 0);
}

static MalValue date_proto_to_locale_date_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) nt;
    (void) cl;
    return date_proto_to_locale(vm, this_value, args, arg_count, 1);
}

static MalValue date_proto_to_locale_time_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) nt;
    (void) cl;
    return date_proto_to_locale(vm, this_value, args, arg_count, 2);
}

// ---------------------------------------------------------------------------
// Helpers exposed to Intl.DateTimeFormat (builtin_intl.c)
// ---------------------------------------------------------------------------

f64 mal_date_now_ms(void) {
    return date_now_ms();
}

bool mal_date_to_local_components(f64 time_value, i32 *year, i32 *month, i32 *day, i32 *hour, i32 *minute, i32 *second) {
    if (!isfinite(time_value)) {
        return false;
    }
    f64 local = date_local_time(time_value);
    DateComponents components;
    date_project_components(
        local,
        DATE_COMPONENT_CIVIL | DATE_COMPONENT_HOUR |
            DATE_COMPONENT_MINUTE | DATE_COMPONENT_SECOND,
        &components
    );
    *year = (i32) components.year;
    *month = (i32) components.month + 1;
    *day = (i32) components.date;
    *hour = (i32) components.hour;
    *minute = (i32) components.minute;
    *second = (i32) components.second;
    return true;
}

MalValue mal_date_fallback_locale_string(MalVm *vm, f64 time_value, i32 which) {
    if (!isfinite(time_value)) {
        return mal_value_from_string(mal_intrinsic_ascii(vm, "Invalid Date"));
    }
    u32 mask = which == 1
        ? DATE_COMPONENT_CIVIL
        : which == 2
            ? DATE_COMPONENT_HOUR | DATE_COMPONENT_MINUTE | DATE_COMPONENT_SECOND
            : DATE_COMPONENT_CIVIL | DATE_COMPONENT_HOUR |
                DATE_COMPONENT_MINUTE | DATE_COMPONENT_SECOND;
    DateComponents components;
    date_project_components(date_local_time(time_value), mask, &components);

    byte buf[40];
    byte *cursor = buf;
    if (which != 2) {
        i64 year = (i64) components.year;
        if (year < 0) {
            *cursor++ = '-';
            cursor = date_write_unsigned(cursor, (u64) -year, 3);
        } else {
            cursor = date_write_unsigned(cursor, (u64) year, 4);
        }
        *cursor++ = '-';
        cursor = date_write_two_digits(cursor, (i32) components.month + 1);
        *cursor++ = '-';
        cursor = date_write_two_digits(cursor, (i32) components.date);
    }
    if (which == 0) {
        *cursor++ = ' ';
    }
    if (which != 1) {
        cursor = date_write_two_digits(cursor, (i32) components.hour);
        *cursor++ = ':';
        cursor = date_write_two_digits(cursor, (i32) components.minute);
        *cursor++ = ':';
        cursor = date_write_two_digits(cursor, (i32) components.second);
    }
    return date_string_value(vm, buf, (usize) (cursor - buf));
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

void mal_builtin_date_install(MalVm *vm) {
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);

    // Date.prototype is an ordinary object (NOT a Date), so its methods throw on
    // the bare prototype receiver.
    MalObject *prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "Date"), 7, date_constructor
    );
    MalObject *constructor_object = (MalObject *) constructor;

    vm->intrinsics[MAL_INTRINSIC_DATE_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_DATE_PROTOTYPE] = mal_value_from_object(prototype);

    // Date.prototype is { writable: false, enumerable: false, configurable: false }.
    mal_intrinsic_define_data(vm, constructor_object, "prototype", vm->intrinsics[MAL_INTRINSIC_DATE_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_DATE_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    mal_intrinsic_define_method_n(vm, constructor_object, "now", 0, date_now);
    mal_intrinsic_define_method_n(vm, constructor_object, "parse", 1, date_parse);
    mal_intrinsic_define_method_n(vm, constructor_object, "UTC", 7, date_utc);

    mal_intrinsic_define_method_n(vm, prototype, "getTime", 0, date_proto_get_time);
    mal_intrinsic_define_method_n(vm, prototype, "valueOf", 0, date_proto_get_time);
    mal_intrinsic_define_method_n(vm, prototype, "getTimezoneOffset", 0, date_proto_get_timezone_offset);

    mal_intrinsic_define_method_n(vm, prototype, "getFullYear", 0, date_proto_get_full_year);
    mal_intrinsic_define_method_n(vm, prototype, "getYear", 0, date_proto_get_year);
    mal_intrinsic_define_method_n(vm, prototype, "getUTCFullYear", 0, date_proto_get_utc_full_year);
    mal_intrinsic_define_method_n(vm, prototype, "getMonth", 0, date_proto_get_month);
    mal_intrinsic_define_method_n(vm, prototype, "getUTCMonth", 0, date_proto_get_utc_month);
    mal_intrinsic_define_method_n(vm, prototype, "getDate", 0, date_proto_get_date);
    mal_intrinsic_define_method_n(vm, prototype, "getUTCDate", 0, date_proto_get_utc_date);
    mal_intrinsic_define_method_n(vm, prototype, "getDay", 0, date_proto_get_day);
    mal_intrinsic_define_method_n(vm, prototype, "getUTCDay", 0, date_proto_get_utc_day);
    mal_intrinsic_define_method_n(vm, prototype, "getHours", 0, date_proto_get_hours);
    mal_intrinsic_define_method_n(vm, prototype, "getUTCHours", 0, date_proto_get_utc_hours);
    mal_intrinsic_define_method_n(vm, prototype, "getMinutes", 0, date_proto_get_minutes);
    mal_intrinsic_define_method_n(vm, prototype, "getUTCMinutes", 0, date_proto_get_utc_minutes);
    mal_intrinsic_define_method_n(vm, prototype, "getSeconds", 0, date_proto_get_seconds);
    mal_intrinsic_define_method_n(vm, prototype, "getUTCSeconds", 0, date_proto_get_utc_seconds);
    mal_intrinsic_define_method_n(vm, prototype, "getMilliseconds", 0, date_proto_get_milliseconds);
    mal_intrinsic_define_method_n(vm, prototype, "getUTCMilliseconds", 0, date_proto_get_utc_milliseconds);

    mal_intrinsic_define_method_n(vm, prototype, "setTime", 1, date_proto_set_time);
    mal_intrinsic_define_method_n(vm, prototype, "setMilliseconds", 1, date_proto_set_milliseconds);
    mal_intrinsic_define_method_n(vm, prototype, "setUTCMilliseconds", 1, date_proto_set_utc_milliseconds);
    mal_intrinsic_define_method_n(vm, prototype, "setSeconds", 2, date_proto_set_seconds);
    mal_intrinsic_define_method_n(vm, prototype, "setUTCSeconds", 2, date_proto_set_utc_seconds);
    mal_intrinsic_define_method_n(vm, prototype, "setMinutes", 3, date_proto_set_minutes);
    mal_intrinsic_define_method_n(vm, prototype, "setUTCMinutes", 3, date_proto_set_utc_minutes);
    mal_intrinsic_define_method_n(vm, prototype, "setHours", 4, date_proto_set_hours);
    mal_intrinsic_define_method_n(vm, prototype, "setUTCHours", 4, date_proto_set_utc_hours);
    mal_intrinsic_define_method_n(vm, prototype, "setDate", 1, date_proto_set_date);
    mal_intrinsic_define_method_n(vm, prototype, "setUTCDate", 1, date_proto_set_utc_date);
    mal_intrinsic_define_method_n(vm, prototype, "setMonth", 2, date_proto_set_month);
    mal_intrinsic_define_method_n(vm, prototype, "setUTCMonth", 2, date_proto_set_utc_month);
    mal_intrinsic_define_method_n(vm, prototype, "setFullYear", 3, date_proto_set_full_year);
    mal_intrinsic_define_method_n(vm, prototype, "setUTCFullYear", 3, date_proto_set_utc_full_year);
    mal_intrinsic_define_method_n(vm, prototype, "setYear", 1, date_proto_set_year);

    mal_intrinsic_define_method_n(vm, prototype, "toString", 0, date_proto_to_string);
    mal_intrinsic_define_method_n(vm, prototype, "toDateString", 0, date_proto_to_date_string);
    mal_intrinsic_define_method_n(vm, prototype, "toTimeString", 0, date_proto_to_time_string);
    MalValue to_utc_string = mal_intrinsic_define_method_n(
        vm, prototype, "toUTCString", 0, date_proto_to_utc_string);
    // Annex B requires the very same function object, not a callback-equivalent clone.
    mal_intrinsic_define_data(
        vm, prototype, "toGMTString", to_utc_string,
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_method_n(vm, prototype, "toISOString", 0, date_proto_to_iso_string);
#if MAL_TEMPORAL
    mal_intrinsic_define_method_n(
        vm,
        prototype,
        "toTemporalInstant",
        0,
        date_proto_to_temporal_instant
    );
#endif
    mal_intrinsic_define_method_n(vm, prototype, "toJSON", 1, date_proto_to_json);

    // toLocaleString / toLocaleDateString / toLocaleTimeString delegate to
    // Intl.DateTimeFormat.
    mal_intrinsic_define_method_n(vm, prototype, "toLocaleString", 0, date_proto_to_locale_string);
    mal_intrinsic_define_method_n(vm, prototype, "toLocaleDateString", 0, date_proto_to_locale_date_string);
    mal_intrinsic_define_method_n(vm, prototype, "toLocaleTimeString", 0, date_proto_to_locale_time_string);

    // Date.prototype[@@toPrimitive] is { writable: false, configurable: true }.
    MalNativeFunctionObject *to_primitive = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "[Symbol.toPrimitive]"), 1, date_proto_to_primitive
    );
    MalPropertyDesc to_primitive_desc = mal_intrinsic_data_desc(
        mal_value_from_native_function_object(to_primitive), MAL_PROPERTY_CONFIGURABLE
    );
    mal_object_define_own(prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_PRIMITIVE), &to_primitive_desc);
}

#include "generated/known_native_builtin_date_c.inc"
