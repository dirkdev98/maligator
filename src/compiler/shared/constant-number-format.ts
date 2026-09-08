interface Decimal {
	readonly digits: string;
	readonly point: number;
}

const BASE = 10_000_000;

function limbsFromInteger(value: number): Array<number> {
	const low = value % BASE;
	const high = Math.floor(value / BASE);
	return high === 0
		? [low]
		: high < BASE
			? [low, high]
			: [low, high % BASE, Math.floor(high / BASE)];
}

function multiply(limbs: Array<number>, factor: number): void {
	let carry = 0;
	for (let index = 0; index < limbs.length; index++) {
		const product = limbs[index]! * factor + carry;
		limbs[index] = product % BASE;
		carry = Math.floor(product / BASE);
	}
	while (carry !== 0) {
		limbs.push(carry % BASE);
		carry = Math.floor(carry / BASE);
	}
}

function addUnit(limbs: Array<number>, unit: -1 | 1): void {
	for (let index = 0; index < limbs.length; index++) {
		const sum = limbs[index]! + unit;
		limbs[index] = sum < 0 ? BASE - 1 : sum === BASE ? 0 : sum;
		if (sum >= 0 && sum < BASE) return;
	}
	if (unit === 1) limbs.push(1);
}

function expand(limbs: Array<number>, exponent: number): Decimal {
	let remaining = Math.abs(exponent);
	const factor = exponent < 0 ? 5 : 2;
	const chunk = exponent < 0 ? 10 : 23;
	const power = exponent < 0 ? 9765625 : 8388608;
	while (remaining >= chunk) {
		multiply(limbs, power);
		remaining -= chunk;
	}
	while (remaining-- > 0) multiply(limbs, factor);
	while (limbs.length > 1 && limbs.at(-1) === 0) limbs.pop();
	let digits = String(limbs.at(-1)!);
	for (let index = limbs.length - 2; index >= 0; index--)
		digits += String(limbs[index]!).padStart(7, "0");
	return { digits, point: digits.length + Math.min(exponent, 0) };
}

function compare(left: Decimal, right: Decimal): number {
	if (left.point !== right.point) return left.point < right.point ? -1 : 1;
	for (
		let index = 0;
		index < Math.max(left.digits.length, right.digits.length);
		index++
	) {
		const a = index < left.digits.length ? left.digits.charCodeAt(index) : 48;
		const b = index < right.digits.length ? right.digits.charCodeAt(index) : 48;
		if (a !== b) return a < b ? -1 : 1;
	}
	return 0;
}

function increment(digits: string): string {
	for (let index = digits.length - 1; index >= 0; index--) {
		if (digits[index] !== "9")
			return (
				digits.slice(0, index) +
				String.fromCharCode(digits.charCodeAt(index) + 1) +
				"0".repeat(digits.length - index - 1)
			);
	}
	return `1${"0".repeat(digits.length)}`;
}

function round(decimal: Decimal, count: number, even = false): Decimal {
	let digits = decimal.digits.slice(0, count).padEnd(count, "0");
	const next = decimal.digits.charCodeAt(count);
	const tied =
		even &&
		next === 53 &&
		[...decimal.digits.slice(count + 1)].every((digit) => digit === "0");
	if (next > 53 || (next === 53 && (!tied || (digits.charCodeAt(count - 1) & 1) !== 0)))
		digits = increment(digits);
	return digits.length > count
		? { digits: digits.slice(0, count), point: decimal.point + 1 }
		: { digits, point: decimal.point };
}

function scientific(decimal: Decimal): string {
	const exponent = decimal.point - 1;
	return `${
		decimal.digits[0] + (decimal.digits.length > 1 ? `.${decimal.digits.slice(1)}` : "")
	}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent))}`;
}

function plain(decimal: Decimal): string {
	return decimal.point <= 0
		? `0.${"0".repeat(-decimal.point)}${decimal.digits}`
		: decimal.point >= decimal.digits.length
			? decimal.digits + "0".repeat(decimal.point - decimal.digits.length)
			: `${decimal.digits.slice(0, decimal.point)}.${decimal.digits.slice(
					decimal.point,
				)}`;
}

/** Uses exact decimal expansion and binary64 rounding intervals, including ties to even. */
export function formatConstantNumber(
	value: number,
	method: "toString" | "toFixed" | "toExponential" | "toPrecision",
	precision?: number,
): string | undefined {
	if (
		precision !== undefined &&
		(precision % 1 !== 0 ||
			precision < (method === "toPrecision" ? 1 : 0) ||
			precision > 100)
	)
		return undefined;
	if (value !== value) return "NaN";
	if (value === Infinity) return "Infinity";
	if (value === -Infinity) return "-Infinity";
	const sign = value < 0 ? "-" : "";
	if (value === 0) {
		const digits = method === "toPrecision" ? (precision ?? 1) - 1 : (precision ?? 0);
		return `0${
			digits > 0 ? `.${"0".repeat(digits)}` : ""
		}${method === "toExponential" ? "e+0" : ""}`;
	}
	const bits = new DataView(new ArrayBuffer(8));
	bits.setFloat64(0, Math.abs(value), true);
	const low = bits.getUint32(0, true),
		high = bits.getUint32(4, true);
	const rawExponent = high >>> 20;
	const mantissa =
		(high & 0xfffff) * 4294967296 + low + (rawExponent === 0 ? 0 : 4503599627370496);
	const exponent = rawExponent === 0 ? -1074 : rawExponent - 1075;
	const exact = expand(limbsFromInteger(mantissa), exponent);
	if (method === "toFixed" && Math.abs(value) < 1e21) {
		const places = precision ?? 0,
			count = exact.point + places;
		let digits =
			count < 0
				? "0"
				: count === 0
					? exact.digits.charCodeAt(0) >= 53
						? "1"
						: "0"
					: exact.digits.slice(0, count).padEnd(count, "0");
		if (count > 0 && exact.digits.charCodeAt(count) >= 53) digits = increment(digits);
		digits = digits.padStart(places + 1, "0");
		return (
			sign +
			(places === 0 ? digits : `${digits.slice(0, -places)}.${digits.slice(-places)}`)
		);
	}
	if (
		precision !== undefined &&
		(method === "toPrecision" || method === "toExponential")
	) {
		const rounded = round(exact, method === "toPrecision" ? precision : precision + 1);
		return (
			sign +
			(method === "toExponential" || rounded.point - 1 < -6 || rounded.point > precision
				? scientific(rounded)
				: plain(rounded))
		);
	}
	const lowerMantissa = limbsFromInteger(mantissa),
		upperMantissa = limbsFromInteger(mantissa);
	const narrowLower = (high & 0xfffff) === 0 && low === 0 && rawExponent > 1;
	multiply(lowerMantissa, narrowLower ? 4 : 2);
	addUnit(lowerMantissa, -1);
	multiply(upperMantissa, 2);
	addUnit(upperMantissa, 1);
	const lower = expand(lowerMantissa, exponent - (narrowLower ? 2 : 1));
	const upper = expand(upperMantissa, exponent - 1);
	const inclusive = (low & 1) === 0;
	const inside = (candidate: Decimal) => {
		const a = compare(candidate, lower),
			b = compare(candidate, upper);
		return (a > 0 || (inclusive && a === 0)) && (b < 0 || (inclusive && b === 0));
	};
	for (let count = 1; count <= 17; count++) {
		let candidate = round(exact, count, true);
		if (!inside(candidate)) {
			const floor = {
				digits: exact.digits.slice(0, count).padEnd(count, "0"),
				point: exact.point,
			};
			if (inside(floor)) candidate = floor;
			else {
				const digits = increment(floor.digits);
				const ceil = { digits, point: exact.point + digits.length - count };
				if (!inside(ceil)) continue;
				candidate = ceil;
			}
		}
		let end = candidate.digits.length;
		while (end > 1 && candidate.digits[end - 1] === "0") end--;
		candidate = { digits: candidate.digits.slice(0, end), point: candidate.point };
		return (
			sign +
			(method === "toExponential" || candidate.point <= -6 || candidate.point > 21
				? scientific(candidate)
				: plain(candidate))
		);
	}
	return undefined;
}
