export default {
	outputName: "native-cli-web-driver",
	// The native suite prepares this runtime flavour before starting its checks.
	engine: { primordials: "mutable", eval: false, realms: true },
};
