/** Clone Meriyah's plain AST leaves without a dependency on host globals. */
export function cloneParserData<Value>(value: Value): Value {
	if (Array.isArray(value)) {
		const source = value as Array<unknown>;
		const clone = new Array<unknown>(source.length);
		for (let index = 0; index < source.length; index++)
			clone[index] = cloneParserData(source[index]);
		return clone as Value;
	}
	if (value === null || typeof value !== "object") return value;
	const clone: Record<string, unknown> = {};
	for (const key of Object.keys(value)) {
		clone[key] = cloneParserData((value as Record<string, unknown>)[key]);
	}
	return clone as Value;
}
