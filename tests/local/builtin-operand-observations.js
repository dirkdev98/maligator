function check(actual, expected) {
	if (!Object.is(actual, expected))
		throw new Error("builtin operand observation mismatch");
}
const collect = globalThis.__mal_collect_garbage;

const viewObserver = function viewObserver(record) {
	for (let i = 0; i < 3; i++) if (ArrayBuffer.isView(record)) return record.x;
	return record.y;
};
function builtinUntouched(payload) {
	const record = { x: payload, y: 13 };
	const before = record.x;
	const result = viewObserver(record);
	return [before, record.x, result];
}
for (const payload of [11, "payload", { alive: true }]) {
	const result = builtinUntouched(payload);
	check(result[0], payload);
	check(result[1], payload);
	check(result[2], 13);
}

function* suspendedObservation(payload) {
	const record = { x: payload, y: 13 };
	yield record.x;
	viewObserver(record);
	return record.x;
}
for (const payload of [11, "payload", { alive: true }]) {
	const iterator = suspendedObservation(payload);
	check(iterator.next().value, payload);
	if (typeof collect === "function") collect();
	check(iterator.next().value, payload);
}

function predicateAccess(record) {
	const before = record.y;
	viewObserver(record);
	return [before, record.y];
}
let predicateReads = 0;
const predicateResult = predicateAccess({
	get y() {
		predicateReads++;
		if (typeof collect === "function") collect();
		return predicateReads;
	},
});
check(predicateResult[0], 1);
check(predicateResult[1], 3);
check(predicateReads, 3);
const predicateError = {};
try {
	predicateAccess(
		new Proxy(
			{},
			{
				get() {
					throw predicateError;
				},
			},
		),
	);
	throw new Error("missing predicate accessor error");
} catch (error) {
	check(error, predicateError);
}

const observedCallback = function observedCallback(value) {
	for (let i = 0; i < 3; i++) value += i;
	return value;
};
function observedFunctionCall() {
	return ArrayBuffer.isView(observedCallback) ? 11 : observedCallback(39);
}
check(observedFunctionCall(), 42);
Object.assign(globalThis, {
	builtinUntouched,
	suspendedObservation,
	observedFunctionCall,
});

const revokedPredicate = Proxy.revocable({}, {});
revokedPredicate.revoke();
function arrayObservation(input) {
	return Array.isArray(input);
}
try {
	arrayObservation(revokedPredicate.proxy);
	throw new Error("missing revoked predicate error");
} catch (error) {
	check(error instanceof TypeError, true);
}
try {
	Array.isArray(
		revokedPredicate.proxy,
		(() => {
			throw predicateError;
		})(),
	);
	throw new Error("missing extra argument error");
} catch (error) {
	check(error, predicateError);
}

if (Object.getOwnPropertyDescriptor(ArrayBuffer, "isView").writable) {
	const original = ArrayBuffer.isView;
	try {
		ArrayBuffer.isView = function replaced(record) {
			record.x = 99;
			if (typeof collect === "function") collect();
			return false;
		};
		const result = builtinUntouched(11);
		check(result[0], 11);
		check(result[1], 99);
		check(result[2], 13);
	} finally {
		ArrayBuffer.isView = original;
	}
}
console.log("builtin-operand-observations PASS");
