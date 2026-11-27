import { monomorphicObjects } from "./monomorphic-objects.ts";
import { noDeleteProperty } from "./no-delete-property.ts";
import { noDynamicGlobalAccess } from "./no-dynamic-global-access.ts";

/** The Oxlint JavaScript plugin; its rules are configured as `maligator/<rule>`. */
export default {
	meta: { name: "maligator" },
	rules: {
		"monomorphic-objects": monomorphicObjects,
		"no-delete-property": noDeleteProperty,
		"no-dynamic-global-access": noDynamicGlobalAccess,
	},
};
