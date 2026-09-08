export interface StringCollationPlan {
	readonly locale: string;
	readonly options: number;
}

// These bits are the flat runtime collation ABI, independent of host ICU data.
export function isStringCollationPlan(value: unknown): value is StringCollationPlan {
	if (value === null || typeof value !== "object") return false;
	if (
		!("locale" in value) ||
		typeof value.locale !== "string" ||
		value.locale.length > 128
	)
		return false;
	for (let index = 0; index < value.locale.length; index++)
		if (value.locale.charCodeAt(index) > 127) return false;
	return (
		"options" in value &&
		typeof value.options === "number" &&
		Number.isInteger(value.options) &&
		value.options >= 0 &&
		value.options < 48 &&
		(value.options & 3) <= 2 &&
		((value.options & 4) === 0 || (value.options & 3) === 0)
	);
}
