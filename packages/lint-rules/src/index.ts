import { monomorphicObjects } from "./monomorphic-objects.ts";
import { noDeleteProperty } from "./no-delete-property.ts";

/** The Oxlint JavaScript plugin; its rules are configured as `maligator/<rule>`. */
export default {
	meta: { name: "maligator" },
	rules: {
		"monomorphic-objects": monomorphicObjects,
		"no-delete-property": noDeleteProperty,
	},
};
