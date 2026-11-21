Install the CLI, initialize a project, and run its entry point. The npm launcher needs Node.js 20 or newer. The installed native CLI and the executables it produces do not need Node.js.

Prebuilt packages cover macOS and glibc-based Linux on arm64 and x64. Windows is not supported yet.

## Install the CLI

```shell
npm install --global @maligator/cli@alpha
maligator --version
mkdir hello-maligator
cd hello-maligator
maligator init
```

`init` creates a build config and uses the first entry it finds in `src/index.ts`, `src/main.ts`, `index.ts`, or `main.ts`. If it finds none, it writes a starter to `src/index.ts`. It keeps existing entry files and build configs.

`init` adds `"type": "module"` to `package.json` when the field is missing and adds `@maligator/cli` to the TypeScript config's `compilerOptions.types`. It creates either file if needed. Use a project-local CLI installation to resolve the package declarations in your editor.

For a project-local installation, use `npm install --save-dev @maligator/cli@alpha` and prefix the commands below with `npx`.

## Run an entry point

```shell
maligator run src/index.ts
```

The starter prints `Hello, Maligator`. Edit `src/index.ts` to change it. You can also run `maligator run` to use the entry from the build config. `run` builds a portable development image and executes it in a fresh VM. Ordinary profiles with Intl disabled use the runtime embedded in the distributed CLI and need no local C or Rust toolchain.

Run commands from this directory. Entries and config paths resolve from the working directory; Maligator does not look for configuration in parent directories.

## Build a native executable

```shell
maligator doctor --verbose
maligator build --production
```

`doctor` checks the native toolchain. If it reports missing components, install those before using `build`; [Set up native builds](/guides/native-toolchain) lists the requirements per host. A successful build prints the executable path; launch that path directly.

If `run` reports a missing entry, check `entry` in `maligator.build.ts` or pass it explicitly: `maligator run src/index.ts`.

Continue with [Develop an application](/guides/development), or use the [CLI reference](/api/cli) to look up a command.
