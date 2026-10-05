Install the CLI, create an entry point, and run it from your project root. The npm launcher needs Node.js 20 or newer. The installed native CLI and the executables it produces do not need Node.js.

The current prebuilt package targets Apple Silicon macOS. Check the [package release instructions](https://github.com/dirkdev98/maligator/tree/main/npm/cli) for other targets and source builds.

## Install the CLI

```shell
npm install --global @maligator/cli@alpha
maligator --version
mkdir hello-maligator
cd hello-maligator
npm init --yes
npm pkg set type=module
maligator init
```

`init` creates `maligator.build.ts` without overwriting a config that already exists. It looks for `src/index.ts`, `src/main.ts`, `index.ts`, then `main.ts`. If none exists, it also creates `src/index.ts`.

`"type": "module"` enables imports, exports, and top-level `await` in `.js` and `.ts` files. Keep it when following these guides, or use `.mjs` and `.mts` for individual ES modules.

For a project-local installation, use `npm install --save-dev @maligator/cli@alpha` and prefix the commands below with `npx`.

## Run an entry point

Replace the starter with:

{{example:hello.ts}}

Save it as `src/index.ts`, then run:

```shell
maligator run
```

Your application prints `Hello, Maligator`. `run` builds a portable development image and executes it in a fresh VM. Ordinary profiles with Intl disabled use the runtime embedded in the distributed CLI; they do not require a local C or Rust toolchain.

Run commands from this directory. Entries, config paths, and asset paths resolve from the working directory; Maligator does not look for configuration in parent directories.

## Build a native executable

```shell
maligator doctor --verbose
maligator build --production
```

`doctor` checks the native toolchain. If it reports missing components, install those before using `build`. A successful build prints the executable path; launch that path directly. Native builds require a C/C++ compiler and Rust toolchain. Cross-builds also require the matching target tools.

If `run` reports a missing entry, check `entry` in `maligator.build.ts` or pass it explicitly: `maligator run src/index.ts`.

Continue with [Develop an application](/guides/development), or use the [CLI reference](/api/cli) to look up a command.
