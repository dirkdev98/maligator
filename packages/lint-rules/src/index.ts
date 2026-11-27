import { monomorphicObjects } from "./monomorphic-objects.ts";
import { noDeleteProperty } from "./no-delete-property.ts";
import { noDynamicGlobalAccess } from "./no-dynamic-global-access.ts";
import { noFunctionSource } from "./no-function-source.ts";
import { noPrimordialMutation } from "./no-primordial-mutation.ts";
import { preferMap } from "./prefer-map.ts";
import { strictCommonjs } from "./strict-commonjs.ts";

/** The Oxlint JavaScript plugin; its rules are configured as `maligator/<rule>`. */
export default {
	meta: { name: "maligator" },
	rules: {
		"monomorphic-objects": monomorphicObjects,
		"no-delete-property": noDeleteProperty,
		"no-dynamic-global-access": noDynamicGlobalAccess,
		"no-function-source": noFunctionSource,
		"no-primordial-mutation": noPrimordialMutation,
		"prefer-map": preferMap,
		"strict-commonjs": strictCommonjs,
	},
};
