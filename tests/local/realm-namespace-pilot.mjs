const mode = process.env.REALM_NAMESPACE_CASE;
const saved = { Math, Number, abs: Math.abs, finite: Number.isFinite };
function classify(value) {
	return (
		(Number.isFinite(value) ? 1 : 0) +
		(Number.isInteger(value) ? 2 : 0) +
		(Number.isNaN(value) ? 4 : 0) +
		(Number.isSafeInteger(value) ? 8 : 0)
	);
}
function capturedMath(value) {
	return Math.abs(+value);
}
function capturedNumber(value) {
	return Number.isFinite(Number(value));
}
function extraArgument(value) {
	return Number.isFinite(1, value());
}
function shadow(Math, Number, value) {
	return Math.abs(value) + Number.isFinite(value);
}
const cases = {
	intact() {
		const rounds = 64;
		let checksum = 0;
		for (let index = 0; index < rounds; index++)
			checksum += classify(index - 31.5) + capturedMath(index - 31.5);
		return { rounds, checksum };
	},
	object() {
		let calls = 0;
		const value = {
			[Symbol.toPrimitive]() {
				calls++;
				throw new Error("unexpected coercion");
			},
		};
		return { mask: classify(value), calls };
	},
	mathReentry() {
		let calls = 0;
		try {
			const value = capturedMath({
				[Symbol.toPrimitive]() {
					calls++;
					Math.abs = () => 97;
					return -7;
				},
			});
			return [value, Math.abs(-2), calls];
		} finally {
			Math.abs = saved.abs;
		}
	},
	numberReentry() {
		let calls = 0;
		try {
			const value = capturedNumber({
				[Symbol.toPrimitive]() {
					calls++;
					Number.isFinite = () => "changed";
					return 7;
				},
			});
			return [value, Number.isFinite(2), calls];
		} finally {
			Number.isFinite = saved.finite;
		}
	},
	extraArgument() {
		let calls = 0;
		try {
			const value = extraArgument(() => {
				calls++;
				Number.isFinite = () => "changed";
				return 0;
			});
			return [value, Number.isFinite(2), calls];
		} finally {
			Number.isFinite = saved.finite;
		}
	},
	globalMath() {
		const before = capturedMath(-7);
		try {
			globalThis.Math = { abs: () => 97 };
			return [before, capturedMath(-7)];
		} finally {
			globalThis.Math = saved.Math;
		}
	},
	globalNumber() {
		const before = classify(7);
		try {
			globalThis.Number = {
				isFinite: () => false,
				isInteger: () => false,
				isNaN: () => true,
				isSafeInteger: () => false,
			};
			return [before, classify(7)];
		} finally {
			globalThis.Number = saved.Number;
		}
	},
	method() {
		const before = classify(7);
		try {
			Number.isFinite = () => false;
			return [before, classify(7)];
		} finally {
			Number.isFinite = saved.finite;
		}
	},
	lexical() {
		const Math = { abs: () => 13 };
		const Number = { isFinite: () => 17 };
		return Math.abs(-7) + Number.isFinite(-7);
	},
	shadow() {
		return shadow({ abs: () => 13 }, { isFinite: () => 17 }, -7);
	},
	throw() {
		const marker = {};
		let calls = 0;
		try {
			capturedMath({
				[Symbol.toPrimitive]() {
					calls++;
					throw marker;
				},
			});
		} catch (error) {
			return [error === marker, calls];
		}
		throw new Error("missing coercion throw");
	},
};
console.log(JSON.stringify(cases[mode]()));
