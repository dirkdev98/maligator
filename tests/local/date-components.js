let checks = 0;
let passed = 0;

function collectDateGarbage() {
	if (typeof $262 !== "undefined") $262.gc();
	else if (typeof gc === "function") gc();
}

function check(name, condition) {
	checks++;
	if (condition) {
		passed++;
	} else {
		console.log(`FAIL: ${name}`);
	}
}

function utcComponents(date) {
	return [
		date.getUTCFullYear(),
		date.getUTCMonth(),
		date.getUTCDate(),
		date.getUTCDay(),
		date.getUTCHours(),
		date.getUTCMinutes(),
		date.getUTCSeconds(),
		date.getUTCMilliseconds(),
	];
}

const beforeEpoch = new Date(-1);
check(
	"negative UTC components",
	utcComponents(beforeEpoch).join(",") === "1969,11,31,3,23,59,59,999",
);
check("legacy local year getter", new Date(Date.UTC(1969, 6, 1, 12)).getYear() === 69);
check("negative ISO rendering", beforeEpoch.toISOString() === "1969-12-31T23:59:59.999Z");
check(
	"negative UTC rendering",
	beforeEpoch.toUTCString() === "Wed, 31 Dec 1969 23:59:59 GMT",
);

const minimum = new Date(-8_640_000_000_000_000);
check(
	"minimum UTC components",
	utcComponents(minimum).join(",") === "-271821,3,20,2,0,0,0,0",
);
check("minimum ISO rendering", minimum.toISOString() === "-271821-04-20T00:00:00.000Z");

const maximum = new Date(8_640_000_000_000_000);
check(
	"maximum UTC components",
	utcComponents(maximum).join(",") === "275760,8,13,6,0,0,0,0",
);
check("maximum ISO rendering", maximum.toISOString() === "+275760-09-13T00:00:00.000Z");
check(
	"past TimeClip is invalid",
	Number.isNaN(new Date(8_640_000_000_000_001).getTime()),
);

const invalid = new Date(NaN);
check("invalid UTC getter", Number.isNaN(invalid.getUTCFullYear()));
check("invalid local getter", Number.isNaN(invalid.getHours()));
check("invalid legacy year getter", Number.isNaN(invalid.getYear()));
check("invalid toString", invalid.toString() === "Invalid Date");
check("invalid toDateString", invalid.toDateString() === "Invalid Date");
check("invalid toTimeString", invalid.toTimeString() === "Invalid Date");
check("invalid toUTCString", invalid.toUTCString() === "Invalid Date");
check("invalid toLocaleString", invalid.toLocaleString() === "Invalid Date");
let invalidIsoThrows = false;
try {
	invalid.toISOString();
} catch (error) {
	invalidIsoThrows = error instanceof RangeError;
}
check("invalid toISOString throws", invalidIsoThrows);

const timeSetter = new Date(Date.UTC(2000, 0, 2, 3, 4, 5, 6));
const timeSetterResult = timeSetter.setUTCSeconds(9);
check("time setter returns stored time", timeSetterResult === timeSetter.getTime());
check(
	"time setter keeps omitted fields",
	timeSetter.toISOString() === "2000-01-02T03:04:09.006Z",
);

const dateSetter = new Date(Date.UTC(2000, 5, 15, 3, 4, 5, 6));
const dateSetterResult = dateSetter.setUTCDate(20);
check("date setter returns stored time", dateSetterResult === dateSetter.getTime());
check(
	"date setter keeps omitted fields",
	dateSetter.toISOString() === "2000-06-20T03:04:05.006Z",
);

const legacyYearSetter = new Date(2000, 5, 15, 3, 4, 5, 6);
const legacyMonth = legacyYearSetter.getMonth();
const legacyDate = legacyYearSetter.getDate();
const legacyHour = legacyYearSetter.getHours();
const legacyMinute = legacyYearSetter.getMinutes();
const legacySecond = legacyYearSetter.getSeconds();
const legacyMillisecond = legacyYearSetter.getMilliseconds();
const legacyYearSetterResult = legacyYearSetter.setYear(99);
check(
	"legacy year setter returns stored time",
	legacyYearSetterResult === legacyYearSetter.getTime(),
);
check(
	"legacy year setter maps 0 through 99 and keeps omitted local fields",
	legacyYearSetter.getFullYear() === 1999 &&
		legacyYearSetter.getMonth() === legacyMonth &&
		legacyYearSetter.getDate() === legacyDate &&
		legacyYearSetter.getHours() === legacyHour &&
		legacyYearSetter.getMinutes() === legacyMinute &&
		legacyYearSetter.getSeconds() === legacySecond &&
		legacyYearSetter.getMilliseconds() === legacyMillisecond,
);

const invalidLegacyYearSetter = new Date(NaN);
invalidLegacyYearSetter.setYear(2001);
check(
	"legacy year setter defaults an invalid receiver from local epoch fields",
	invalidLegacyYearSetter.getFullYear() === 2001 &&
		invalidLegacyYearSetter.getMonth() === 0 &&
		invalidLegacyYearSetter.getDate() === 1 &&
		invalidLegacyYearSetter.getHours() === 0,
);

check(
	"UTC/GMT function identity",
	Date.prototype.toUTCString === Date.prototype.toGMTString,
);

function renderedOffset(minutesWest) {
	const minutesEast = -minutesWest;
	const sign = minutesEast < 0 ? "-" : "+";
	const absolute = Math.abs(minutesEast);
	return `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}${String(absolute % 60).padStart(2, "0")}`;
}

function localSnapshot(name, value) {
	const date = new Date(value);
	const full = date.toString();
	const datePart = date.toDateString();
	const timePart = date.toTimeString();
	const offset = date.getTimezoneOffset();
	check(`${name} local full composition`, full === `${datePart} ${timePart}`);
	check(
		`${name} local rendered offset`,
		timePart.includes(`GMT${renderedOffset(offset)}`),
	);
	return offset;
}

const winterOffset = localSnapshot("winter", Date.UTC(2024, 0, 15, 12, 34, 56, 789));
const summerOffset = localSnapshot("summer", Date.UTC(2024, 6, 15, 12, 34, 56, 789));

let foldMillisecondCompatible = true;
let foldMinuteCompatible = true;
let gapHourCompatible = true;
if (winterOffset === -60 && summerOffset === -120) {
	const foldEarlierMilliseconds = new Date(Date.UTC(2024, 9, 27, 0, 30, 0, 456));
	const foldLaterMilliseconds = new Date(Date.UTC(2024, 9, 27, 1, 30, 0, 456));
	foldMillisecondCompatible =
		foldEarlierMilliseconds.setMilliseconds(123) ===
			Date.UTC(2024, 9, 27, 0, 30, 0, 123) &&
		foldLaterMilliseconds.setMilliseconds(123) === Date.UTC(2024, 9, 27, 0, 30, 0, 123);

	const foldEarlierMinutes = new Date(Date.UTC(2024, 9, 27, 0, 30, 0, 456));
	const foldLaterMinutes = new Date(Date.UTC(2024, 9, 27, 1, 30, 0, 456));
	foldMinuteCompatible =
		foldEarlierMinutes.setMinutes(45, 6, 789) === Date.UTC(2024, 9, 27, 0, 45, 6, 789) &&
		foldLaterMinutes.setMinutes(45, 6, 789) === Date.UTC(2024, 9, 27, 0, 45, 6, 789);

	const gap = new Date(Date.UTC(2024, 2, 31, 0, 30, 0, 456));
	gapHourCompatible =
		gap.setHours(2, 30, 6, 789) === Date.UTC(2024, 2, 31, 1, 30, 6, 789);
}
check(
	"local millisecond setter selects earlier repeated time from either fold instant",
	foldMillisecondCompatible,
);
check(
	"local minute setter selects earlier repeated time from either fold instant",
	foldMinuteCompatible,
);
check("local hour setter advances through a missing time", gapHourCompatible);

const localeSample = new Date(Date.UTC(2024, 0, 15, 12, 34, 56));
check(
	"default locale date-time plan",
	localeSample.toLocaleString() === localeSample.toLocaleString([], undefined),
);
check(
	"default locale date plan",
	localeSample.toLocaleDateString() === localeSample.toLocaleDateString([], undefined),
);
check(
	"default locale time plan",
	localeSample.toLocaleTimeString() === localeSample.toLocaleTimeString([], undefined),
);

let dateStaticExtraCount = 0;
function dateStaticExtra(value) {
	dateStaticExtraCount++;
	return value;
}

function directDateNow() {
	return Date.now(dateStaticExtra(101));
}

function directDateParse(value) {
	return Date.parse(value, dateStaticExtra(102));
}

function directDateUTC(year, month, date, hours, minutes, seconds, milliseconds) {
	return Date.UTC(
		year,
		month,
		date,
		hours,
		minutes,
		seconds,
		milliseconds,
		dateStaticExtra(103),
	);
}

let beforeStaticExtras = dateStaticExtraCount;
const firstNow = directDateNow();
const secondNow = directDateNow();
check(
	"Date.now direct call and extra evaluation",
	Number.isInteger(firstNow) &&
		Number.isInteger(secondNow) &&
		secondNow >= firstNow &&
		dateStaticExtraCount === beforeStaticExtras + 2,
);

beforeStaticExtras = dateStaticExtraCount;
check(
	"Date.parse direct call and extra evaluation",
	directDateParse("2001-02-03T04:05:06.007Z") === 981173106007 &&
		dateStaticExtraCount === beforeStaticExtras + 1,
);
check("Date.parse missing argument", Number.isNaN(Date.parse()));

beforeStaticExtras = dateStaticExtraCount;
check(
	"Date.UTC direct call and extra evaluation",
	directDateUTC(2001, 1, 3, 4, 5, 6, 7) === 981173106007 &&
		dateStaticExtraCount === beforeStaticExtras + 1,
);
check("Date.UTC omitted defaults", Date.UTC(2001, 1) === 980985600000);

const parseOrder = [];
const orderedParse = Date.parse(
	{
		toString() {
			parseOrder.push("coerce");
			return "2001-02-03T04:05:06.007Z";
		},
	},
	(parseOrder.push("extra"), 0),
);
check(
	"Date.parse argument evaluation before coercion",
	orderedParse === 981173106007 && parseOrder.join(",") === "extra,coerce",
);

const utcOrder = [];
function orderedUtcArgument(name, value) {
	utcOrder.push(`eval-${name}`);
	return {
		valueOf() {
			utcOrder.push(`coerce-${name}`);
			return value;
		},
	};
}
const orderedUtc = Date.UTC(
	orderedUtcArgument("year", 2001),
	orderedUtcArgument("month", 1),
	orderedUtcArgument("date", 3),
	orderedUtcArgument("hours", 4),
	orderedUtcArgument("minutes", 5),
	orderedUtcArgument("seconds", 6),
	orderedUtcArgument("milliseconds", 7),
	(utcOrder.push("eval-extra"), 0),
);
check(
	"Date.UTC evaluates arguments then coerces left to right",
	orderedUtc === 981173106007 &&
		utcOrder.join(",") ===
			"eval-year,eval-month,eval-date,eval-hours,eval-minutes,eval-seconds,eval-milliseconds,eval-extra,coerce-year,coerce-month,coerce-date,coerce-hours,coerce-minutes,coerce-seconds,coerce-milliseconds",
);

const gcParsed = Date.parse({
	payload: { text: "2001-02-03T04:05:06.007Z" },
	toString() {
		collectDateGarbage();
		return this.payload.text;
	},
});
check(
	"Date.parse direct arguments stay rooted across coercion GC",
	gcParsed === 981173106007,
);

function freshConsDateInput() {
	return {
		prefix: "2001-02-03T04:05:",
		suffix: "06.007Z",
		toString() {
			const text = this.prefix + this.suffix;
			collectDateGarbage();
			return text;
		},
	};
}

const gcConstructedFromCons = new Date(freshConsDateInput());
check(
	"Date constructor roots fresh cons string across parse flatten",
	gcConstructedFromCons.getTime() === 981173106007,
);
check(
	"Date.parse roots fresh cons string across parse flatten",
	Date.parse(freshConsDateInput()) === 981173106007,
);

function DateNewTarget() {}
const gcNewTarget = new Proxy(DateNewTarget, {
	get(target, key, receiver) {
		if (key === "prototype") {
			const prototype = { datePrototypeMarker: 911 };
			collectDateGarbage();
			return prototype;
		}
		return Reflect.get(target, key, receiver);
	},
});
const gcCustomPrototypeDate = Reflect.construct(Date, [0], gcNewTarget);
check(
	"Date constructor roots fresh custom prototype across allocation",
	Object.getPrototypeOf(gcCustomPrototypeDate).datePrototypeMarker === 911 &&
		Date.prototype.getTime.call(gcCustomPrototypeDate) === 0,
);

function gcUtcArgument(name, value, collect) {
	return {
		payload: { name, value },
		valueOf() {
			if (collect) collectDateGarbage();
			return this.payload.name === name ? this.payload.value : NaN;
		},
	};
}
const gcUtc = Date.UTC(
	gcUtcArgument("year", 2001, true),
	gcUtcArgument("month", 1, false),
	gcUtcArgument("date", 3, false),
	gcUtcArgument("hours", 4, false),
	gcUtcArgument("minutes", 5, false),
	gcUtcArgument("seconds", 6, false),
	gcUtcArgument("milliseconds", 7, false),
);
check("Date.UTC direct arguments stay rooted across coercion GC", gcUtc === 981173106007);

function replaceTemporarily(object, name, replacement, callback) {
	const descriptor = Object.getOwnPropertyDescriptor(object, name);
	let installed = false;
	try {
		installed = Reflect.defineProperty(object, name, {
			value: replacement,
			writable: true,
			enumerable: descriptor.enumerable,
			configurable: true,
		});
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
	}
	if (!installed) return false;
	try {
		callback();
	} finally {
		Reflect.defineProperty(object, name, descriptor);
	}
	return true;
}

beforeStaticExtras = dateStaticExtraCount;
const mutableNow = replaceTemporarily(
	Date,
	"now",
	function (marker) {
		return marker === 101 ? 701 : -1;
	},
	() => {
		check(
			"mutable Date.now fallback",
			directDateNow() === 701 && dateStaticExtraCount === beforeStaticExtras + 1,
		);
	},
);
if (!mutableNow) {
	check(
		"locked Date.now identity",
		Number.isInteger(directDateNow()) && dateStaticExtraCount === beforeStaticExtras + 1,
	);
}

beforeStaticExtras = dateStaticExtraCount;
const mutableParse = replaceTemporarily(
	Date,
	"parse",
	function (value, marker) {
		return value === "replacement" && marker === 102 ? 702 : -1;
	},
	() => {
		check(
			"mutable Date.parse fallback",
			directDateParse("replacement") === 702 &&
				dateStaticExtraCount === beforeStaticExtras + 1,
		);
	},
);
if (!mutableParse) {
	check(
		"locked Date.parse identity",
		Number.isNaN(directDateParse("replacement")) &&
			dateStaticExtraCount === beforeStaticExtras + 1,
	);
}

beforeStaticExtras = dateStaticExtraCount;
const mutableUtc = replaceTemporarily(
	Date,
	"UTC",
	function (year, month, date, hours, minutes, seconds, milliseconds, marker) {
		return year === 1 &&
			month === 2 &&
			date === 3 &&
			hours === 4 &&
			minutes === 5 &&
			seconds === 6 &&
			milliseconds === 7 &&
			marker === 103
			? 703
			: -1;
	},
	() => {
		check(
			"mutable Date.UTC fallback",
			directDateUTC(1, 2, 3, 4, 5, 6, 7) === 703 &&
				dateStaticExtraCount === beforeStaticExtras + 1,
		);
	},
);
if (!mutableUtc) {
	check(
		"locked Date.UTC identity",
		directDateUTC(1, 2, 3, 4, 5, 6, 7) === -2172167693993 &&
			dateStaticExtraCount === beforeStaticExtras + 1,
	);
}

console.log(`ZONE ${winterOffset}/${summerOffset}`);
console.log(`STATIC ${mutableNow && mutableParse && mutableUtc ? "mutable" : "locked"}`);
console.log(`RESULT ${passed}/${checks}`);
