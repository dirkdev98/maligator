if (typeof ShadowRealm !== "undefined") {
	throw new Error("ShadowRealm must be absent when realms are disabled");
}

console.log("shadow-realm-disabled PASS");
