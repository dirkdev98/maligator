/* oxlint-disable no-console -- The fixture reports observable foreign-call behavior. */
import * as c from "maligator:ffi/reentry";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}

const text = new TextDecoder().decode(new TextEncoder().encode("☃".repeat(4096)));
for (let i = 0; i < 4; i++) check(c.reentry_text(text) === 12288, "audited UTF8 input");
check(
	c.reentry_mutate(text) === 12288 && text === "☃".repeat(4096),
	"mutable native input stays a copy",
);
check(c.reentry_text(text) === 12288, "mutable calls preserve prepared UTF8 storage");
let getters = 0;
check(
	c.reentry_after(text, {
		get offset() {
			getters++;
			// oxlint-disable-next-line typescript/no-deprecated -- Widen prepared UTF8 storage during conversion.
			check(text.bold().length === 4103, "later getter widens the earlier string");
			return 3;
		},
	}) === 12291 && getters === 1,
	"native audit preserves input getter effects",
);
let getterThrew = false;
try {
	c.reentry_after(text, {
		get offset(): number {
			getters++;
			throw new Error("offset failed");
		},
	});
} catch (error) {
	getterThrew = error instanceof Error && error.message === "offset failed";
}
check(getterThrew && Number(getters) === 2, "getter throws preserve their writes");
check(c.reentry_i32("%d", 37) === 37, "typed variants inherit the native audit");

let state = 0;
c.reentry_listen((value) => {
	state = value;
	check("x".repeat(2048).length === 2048, "callback allocation survives collection");
});
check(c.reentry_emit(5) === 5 && state === 5, "unaudited calls preserve callback writes");
const callable = c.reentry_callable()!;
check(
	callable(6) === 6 && Number(state) === 6,
	"factory audit does not narrow its callable",
);
check(c.reentry_owned_text() === "cedar", "owned text copies before release");
check(Number(state) === 7, "release callbacks retain module writes");
c.reentry_listen(() => {
	state = 13;
	throw new Error("release failed");
});
let releaseThrew = false;
try {
	c.reentry_owned_text();
} catch (error) {
	releaseThrew = error instanceof Error && error.message === "release failed";
}
check(releaseThrew && Number(state) === 13, "release callback throws propagate");

let destroyed = 0;
c.reentry_listen(() => {
	destroyed++;
	throw new Error("cleanup failed");
});
let originalError = false;
try {
	c.reentry_bad_result();
} catch (error) {
	originalError = error instanceof RangeError;
}
check(
	originalError && destroyed === 0 && c.reentry_destroys() === 1,
	"rollback destroys C storage while its pending error suppresses callbacks",
);
check(c.reentry_live() === 0, "failed delivery releases the resource once");
c.reentry_listen(null);
console.log("foreign reentry phases passed");
