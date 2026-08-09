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
check(Temporal.Duration.from({ hours: 1 }).add({ minutes: 30 }).toString() === "PT1H30M");
check(
	Temporal.Duration.from({ hours: 1 }).subtract({ minutes: 30 }).toString() === "PT30M",
);
check(new Temporal.Duration().blank === true);

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
}

let passed = 0;
for (const value of checks) if (value) passed++;
console.log("RESULT " + passed + "/" + checks.length);
