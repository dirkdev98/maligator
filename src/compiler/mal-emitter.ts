
export const MalOps = {
	opsAdd: "mal_ops_add",
} as const;

export const MalResult = {
	$: "MalResult",

	normal: "MAL_NORMAL",
	break: "MAL_BREAK",
	continue: "MAL_CONTINUE",
	return: "MAL_RETURN",
	throw: "MAL_THROW",
};

export const MalValue = {
	$: "MalValue",

	debug: "mal_value_debug",

	from_f64: "mal_value_from_f64",
	from_f64_convert_nan: "mal_value_from_f64_convert_nan",
	to_f64: "mal_value_to_f64",
	is_f64: "mal_value_is_f64",
	is_f64_or_nan: "mal_value_is_f64_or_nan",

	new_nan: "mal_value_new_nan",
	is_nan: "mal_value_is_nan",

	new_null: "mal_value_new_null",
	is_null: "mal_value_is_null",

	new_undefined: "mal_value_new_undefined",
	is_undefined: "mal_value_is_undefined",

	is_nil: "mal_value_is_nil",

	new_boolean: "mal_value_new_boolean",
};
