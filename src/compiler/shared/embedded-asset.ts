/** The host installer that builds `maligator:assets` handles. */
export const EMBED_INSTALLER = "mal_host_install_maligator_assets";

/** The files a declaration embeds, which a built executable needs to find them. */
export interface EmbeddedAsset {
	readonly kind: "file" | "directory";
	/** Absolute path of the file or directory. */
	readonly path: string;
	readonly include?: ReadonlyArray<string>;
	readonly exclude?: ReadonlyArray<string>;
	readonly dot?: true;
	/** Identifies the embedded copy independently of producer options. */
	readonly name: string;
}

/** The part of a declaration a built executable keeps: no producer commands. */
export function embeddedAsset(declaration: EmbeddedAsset): EmbeddedAsset {
	return {
		kind: declaration.kind,
		path: declaration.path,
		...(declaration.include === undefined ? {} : { include: declaration.include }),
		...(declaration.exclude === undefined ? {} : { exclude: declaration.exclude }),
		...(declaration.dot === true ? { dot: true as const } : {}),
		name: declaration.name,
	};
}
