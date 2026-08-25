const checks = [];
const check = (value) => checks.push(!!value);

check(typeof Temporal === "object");
check(Object.keys(Temporal).length === 0);
check(Object.prototype.toString.call(Temporal) === "[object Temporal]");

const duration = new Temporal.Duration(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
check(duration.years === 1);
check(duration.months === 2);
check(duration.weeks === 3);
check(duration.days === 4);
check(duration.hours === 5);
check(duration.minutes === 6);
check(duration.seconds === 7);
check(duration.milliseconds === 8);
check(duration.microseconds === 9);
check(duration.nanoseconds === 10);
check(duration.sign === 1);
check(duration.blank === false);
check(Object.prototype.toString.call(duration) === "[object Temporal.Duration]");

const parsed = Temporal.Duration.from("P1DT2H3M4.005006007S");
check(parsed.toString() === "P1DT2H3M4.005006007S");
check(parsed.toJSON() === parsed.toString());
check(parsed.toLocaleString() === parsed.toString());
check(parsed.negated().abs().toString() === parsed.toString());
const largeDuration = new Temporal.Duration(
	1000000000,
	1000000000,
	1000000000,
	1000000000,
	1000000000,
	1000000000,
	1000000000,
	1000000000,
	1000000000,
	1000000000,
);
const largeDurationString = largeDuration.toString();
check(
	largeDurationString.length > 64 &&
		Temporal.Duration.from(largeDurationString).toString() === largeDurationString,
);
check(Temporal.Duration.from({ hours: 1 }).add({ minutes: 30 }).toString() === "PT1H30M");
check(
	Temporal.Duration.from({ hours: 1 }).subtract({ minutes: 30 }).toString() === "PT30M",
);
check(new Temporal.Duration().blank === true);

const time = new Temporal.PlainTime(12, 34, 56, 987, 654, 321);
check(time.toString() === "12:34:56.987654321");
check(time.toString({ smallestUnit: "millisecond" }) === "12:34:56.987");
check(time.add({ minutes: 30 }).toString() === "13:04:56.987654321");
check(time.subtract({ hours: 13 }).toString() === "23:34:56.987654321");
check(time.with({ minute: 10 }).minute === 10);
check(Temporal.PlainTime.from("23:59:58.123456789").nanosecond === 789);
check(Temporal.PlainTime.compare("01:00", "02:00") === -1);
check(time.until("13:34:56.987654321").hours === 1);
check(time.round({ smallestUnit: "minute" }).toString() === "12:35:00");

const instant = Temporal.Instant.from("1969-12-31T23:59:59.123456789Z");
check(instant.epochNanoseconds === -876543211n);
check(instant.epochMilliseconds === -877);
check(instant.toString() === "1969-12-31T23:59:59.123456789Z");
check(instant.add({ seconds: 1 }).toString() === "1970-01-01T00:00:00.123456789Z");
check(Temporal.Instant.compare(instant, "1970-01-01T00:00:00Z") === -1);
check(instant.until("1970-01-01T00:00:00.123456789Z").seconds === 1);

const date = Temporal.PlainDate.from("2024-02-29");
check(date.calendarId === "iso8601");
check(date.dayOfYear === 60);
check(date.inLeapYear === true);
check(date.add({ years: 1 }).toString() === "2025-02-28");
check(date.until("2024-03-02").days === 2);
const gregorianDate = Temporal.PlainDate.from({
	year: 2024,
	month: 8,
	day: 25,
	calendar: "gregory",
});
check(
	gregorianDate.calendarId === "gregory" &&
		gregorianDate.monthCode === "M08" &&
		gregorianDate.era === "ce",
);

const dateTime = Temporal.PlainDateTime.from("2024-02-29T23:59:58.123456789");
check(dateTime.toPlainDate().equals(date));
check(dateTime.toPlainTime().nanosecond === 789);
check(dateTime.add({ seconds: 2 }).toString() === "2024-03-01T00:00:00.123456789");
check(dateTime.withPlainTime("12:30").toString() === "2024-02-29T12:30:00");

const yearMonth = Temporal.PlainYearMonth.from("2024-02");
check(yearMonth.daysInMonth === 29);
check(yearMonth.add({ months: 1 }).toString() === "2024-03");
check(yearMonth.until("2025-04").months === 2);
check(yearMonth.until("2025-04").years === 1);
const monthDay = Temporal.PlainMonthDay.from("02-29");
check(monthDay.toPlainDate({ year: 2024 }).equals(date));

const zoned = new Temporal.ZonedDateTime(0n, "UTC");
check(zoned.toString() === "1970-01-01T00:00:00+00:00[UTC]");
check(zoned.epochNanoseconds === 0n);
check(zoned.timeZoneId === "UTC");
check(zoned.toInstant().epochNanoseconds === 0n);
check(zoned.toPlainDateTime().toString() === "1970-01-01T00:00:00");
check(zoned.add({ days: 1 }).day === 2);
check(instant.toZonedDateTimeISO("UTC").toInstant().equals(instant));
check(Temporal.ZonedDateTime.from("2024-02-29T12:30+01:00[+01:00]").hour === 12);
check(Temporal.Duration.compare(duration, duration) === 0);
check(Temporal.PlainTime.compare(time, time) === 0 && time.equals(time));
check(Temporal.PlainDate.compare(date, date) === 0 && date.equals(date));
check(
	Temporal.PlainDateTime.compare(dateTime, dateTime) === 0 && dateTime.equals(dateTime),
);
check(
	Temporal.PlainYearMonth.compare(yearMonth, yearMonth) === 0 &&
		yearMonth.equals(yearMonth),
);
check(monthDay.equals(monthDay));
check(Temporal.Instant.compare(instant, instant) === 0 && instant.equals(instant));
check(Temporal.ZonedDateTime.compare(zoned, zoned) === 0 && zoned.equals(zoned));
const oneSecond = new Temporal.Duration(0, 0, 0, 0, 0, 0, 1);
check(Temporal.Duration.from("PT2S").add(oneSecond).seconds === 3);
check(time.add(oneSecond).second === 57);
check(dateTime.add(oneSecond).second === 59);
check(instant.add(oneSecond).epochNanoseconds === 123456789n);
check(zoned.add(oneSecond).second === 1);
check(date.add(new Temporal.Duration(0, 0, 0, 1)).day === 1);
check(yearMonth.add(new Temporal.Duration(0, 1)).month === 3);
check(typeof Temporal.Now.instant().epochNanoseconds === "bigint");
check(
	typeof Temporal.Now.timeZoneId() === "string" && Temporal.Now.timeZoneId().length > 0,
);
check(Temporal.Now.zonedDateTimeISO("UTC").timeZoneId === "UTC");
check(Temporal.Now.zonedDateTimeISO().timeZoneId === Temporal.Now.timeZoneId());

const order = [];
const bag = {};
for (const name of [
	"days",
	"hours",
	"microseconds",
	"milliseconds",
	"minutes",
	"months",
	"nanoseconds",
	"seconds",
	"weeks",
	"years",
]) {
	Object.defineProperty(bag, name, {
		get() {
			order.push(name);
			return 1;
		},
	});
}
Temporal.Duration.from(bag);
check(
	order.join(",") ===
		"days,hours,microseconds,milliseconds,minutes,months,nanoseconds,seconds,weeks,years",
);

let threw = false;
try {
	Temporal.Duration();
} catch (error) {
	threw = error instanceof TypeError;
}
check(threw);
threw = false;
try {
	Temporal.Duration.prototype.years;
} catch (error) {
	threw = error instanceof TypeError;
}
check(threw);
threw = false;
try {
	duration.valueOf();
} catch (error) {
	threw = error instanceof TypeError;
}
check(threw);

for (let i = 0; i < 200; i++) {
	Temporal.Duration.from("PT1.000000001S").negated().abs();
	Temporal.PlainTime.from("12:34:56.987654321").add({ nanoseconds: i });
	Temporal.Instant.fromEpochNanoseconds(BigInt(i)).add({ nanoseconds: 1 });
	Temporal.PlainDate.from("2024-02-29").add({ days: i % 7 });
	Temporal.PlainDateTime.from("2024-02-29T12:34:56.987654321").toPlainTime();
	Temporal.PlainYearMonth.from("2024-02").add({ months: i % 12 });
	Temporal.PlainMonthDay.from("02-29").toPlainDate({ year: 2024 });
	Temporal.ZonedDateTime.from("2024-02-29T12:34:56.987654321+00:00[UTC]").toInstant();
}

let passed = 0;
for (const value of checks) if (value) passed++;
console.log("RESULT " + passed + "/" + checks.length);
