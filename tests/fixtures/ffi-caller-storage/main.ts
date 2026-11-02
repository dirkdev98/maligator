/* oxlint-disable no-console -- The fixture reports observable native behavior. */
import {
	CallerState,
	VariableState,
	WideState,
	variable_state_zero,
	variable_state_fill,
	variable_state_sum,
	variableStateSumAsync,
	variable_state_aligned,
	variable_state_same,
	variable_state_visit,
	variableStateVisitAsync,
	wide_state_fill,
	wide_state_sum,
	caller_state_init,
	caller_state_read,
	caller_state_same,
	caller_state_cleanup,
	caller_state_visit,
	caller_state_aligned,
	caller_state_live,
	caller_copy,
	caller_copy_aligned,
	regex_t,
	regcomp,
	regexec,
	regfree,
	REG_EXTENDED,
	REG_NOSUB,
	REG_NOMATCH,
} from "maligator:ffi/state";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}

const first = CallerState();
const second = CallerState();
check(caller_state_read(first) === -1, "caller storage starts zeroed");
check(caller_state_aligned(first) === 1, "caller storage meets C alignment");
check(caller_state_init(first, -1) === -1, "failed initialization keeps outer storage");
check(caller_state_init(first, 7) === 0, "initialization succeeds after failure");
check(caller_state_init(second, 19) === 0, "instances initialize independently");
check(caller_state_same(first) === first, "C self pointers preserve identity");
check(caller_state_same(second) === second, "each pointer has its own identity");
caller_state_visit(first, (lent) => {
	check(lent === first && caller_state_read(lent) === 7, "callback reuses caller handle");
	let refused = false;
	try {
		lent[Symbol.dispose]();
	} catch (error) {
		refused = error instanceof TypeError;
	}
	check(refused && caller_state_read(lent) === 7, "active C calls prevent disposal");
});
caller_state_cleanup(first);
check(caller_state_init(first, 23) === 0, "C cleanup leaves reusable caller storage");
check(
	caller_state_read(first) === 23 && caller_state_read(second) === 19,
	"state remains independent",
);
caller_state_cleanup(first);
caller_state_cleanup(second);
const alias = caller_state_same(first)!;
first[Symbol.dispose]();
first[Symbol.dispose]();
let closed = false;
try {
	caller_state_read(alias);
} catch (error) {
	closed = error instanceof TypeError;
}
check(closed, "disposing closes every alias");
second[Symbol.dispose]();
check(caller_state_live() === 0, "explicit C cleanup releases internal allocations");

const copied = caller_copy(11);
check(
	copied.value === 11 && caller_copy_aligned(copied) === 1,
	"copied handles meet C alignment",
);
copied[Symbol.dispose]();

for (const count of [0, 1, 63, 64, 65, 129]) {
	const variable = VariableState(BigInt(count));
	check(
		variable_state_zero(variable, BigInt(count)) === 1,
		"variable caller storage starts zeroed",
	);
	check(
		variable_state_aligned(variable) === 1,
		"variable caller storage keeps native alignment",
	);
	variable_state_fill(variable, BigInt(count), 3);
	const expected = count * 3 + (count * (count - 1)) / 2;
	check(
		variable_state_sum(variable) === expected,
		"C uses the entire requested trailing array",
	);
	check(
		(await variableStateSumAsync(variable)) === expected,
		"worker uses variable caller storage",
	);
	check(
		variable_state_same(variable) === variable,
		"variable pointer aliases keep identity",
	);
	const visit = (lent: ReturnType<typeof variable_state_same>): void => {
		check(lent === variable, "variable callback keeps canonical identity");
		let pinned = false;
		try {
			variable[Symbol.dispose]();
		} catch (error) {
			pinned = error instanceof TypeError;
		}
		check(pinned, "variable storage cannot close during a C call");
	};
	variable_state_visit(variable, visit);
	await variableStateVisitAsync(variable, visit);
	variable[Symbol.dispose]();
	let closed = false;
	try {
		variable_state_sum(variable);
	} catch (error) {
		closed = error instanceof TypeError;
	}
	check(closed, "disposed variable storage cannot reach C");
}
for (const count of [0, 1, 9, 33]) {
	using wide = WideState(BigInt(count));
	wide_state_fill(wide, BigInt(count));
	check(
		wide_state_sum(wide) ===
			BigInt(count) * 0x80000000n + BigInt((count * (count - 1)) / 2),
		"trailing counts use native element width",
	);
}
for (const invalid of [-1n, 1n << 80n, (1n << 64n) - 1n, (1n << 64n) - 5n]) {
	let rejected = false;
	try {
		VariableState(invalid);
	} catch (error) {
		rejected =
			error instanceof RangeError &&
			error.message.includes("VariableState") &&
			error.message.includes("length");
	}
	check(rejected, "variable allocation rejects count and alignment rounding overflow");
}
let multiplied = false;
try {
	WideState(1n << 62n);
} catch (error) {
	multiplied = error instanceof RangeError;
}
check(multiplied, "trailing element multiplication cannot wrap");
for (const invalid of [1, undefined, "3"]) {
	let rejected = false;
	try {
		VariableState(invalid as unknown as bigint);
	} catch (error) {
		rejected = error instanceof TypeError;
	}
	check(rejected, "trailing count conversion never coerces");
}

const expression = regex_t();
try {
	check(
		regcomp(expression, "[", REG_EXTENDED | REG_NOSUB) !== 0,
		"invalid regex initialization",
	);
	for (const pattern of ["^hello$", "^h.*o$"]) {
		check(
			regcomp(expression, pattern, REG_EXTENDED | REG_NOSUB) === 0,
			"real regex initialization",
		);
		try {
			check(regexec(expression, "hello", 0) === 0, "real regex match");
			check(regexec(expression, "goodbye", 0) === REG_NOMATCH, "real regex no match");
		} finally {
			regfree(expression);
		}
	}
} finally {
	expression[Symbol.dispose]();
}
console.log("caller storage passed");
