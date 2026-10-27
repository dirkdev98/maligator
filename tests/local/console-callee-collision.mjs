function check(actual, expected, label) {
	if (!Object.is(actual, expected)) throw new Error(label);
}
function write(value) {
	return console.log(value);
}
function writeGlobal(value) {
	return globalThis.console.log(value);
}
function writeArgument(argument) {
	return console.log(argument());
}
function dynamic(target, value) {
	return target.log(value);
}
Object.assign(globalThis, { write, writeGlobal, writeArgument, dynamic });
const collect = () => globalThis.gc?.();
const originalConsole = console;
const originalDescriptor = Object.getOwnPropertyDescriptor(console, "log");
const marker = { value: "heap".repeat(100) };
try {
	check(write("console-callee original"), undefined, "original console completion");
	console.log = function (value) {
		check(this, originalConsole, "method receiver");
		collect();
		return { value };
	};
	const result = write(marker);
	collect();
	check(result.value, marker, "arbitrary patched result survives collection");
	check(writeGlobal(marker).value, marker, "qualified console uses loaded callee");
	console.log = Math.log;
	check(write(Math.E), 1, "Math replacement uses generic dispatch");
	check(dynamic(Math, Math.E), 1, "unknown receiver can still use Math");

	const events = [];
	Object.defineProperty(console, "log", {
		configurable: true,
		get() {
			events.push("get");
			collect();
			return function (value) {
				events.push("call");
				check(this, originalConsole, "getter callee receiver");
				check(value, marker, "argument identity");
				collect();
				return marker;
			};
		},
	});
	check(
		writeArgument(() => {
			events.push("argument");
			collect();
			Object.defineProperty(console, "log", {
				configurable: true,
				writable: true,
				value: () => false,
			});
			return marker;
		}),
		marker,
		"callee snapshot precedes argument effects",
	);
	check(events.join(":"), "get:argument:call", "getter and argument ordering");
	check(write(marker), false, "next call observes replacement");
	let evaluated = false;
	Object.defineProperty(console, "log", {
		configurable: true,
		get() {
			collect();
			throw marker;
		},
	});
	try {
		writeArgument(() => {
			evaluated = true;
			return marker;
		});
		throw new Error("missing getter exception");
	} catch (error) {
		check(error, marker, "getter exception identity");
	}
	check(evaluated, false, "throwing getter prevents argument evaluation");
	globalThis.console = {
		log(value) {
			collect();
			return value;
		},
	};
	check(write(marker), marker, "global console replacement");
	check(writeGlobal(marker), marker, "qualified global console replacement");
} finally {
	globalThis.console = originalConsole;
	Object.defineProperty(console, "log", originalDescriptor);
}
console.log("console-callee-collision PASS");
