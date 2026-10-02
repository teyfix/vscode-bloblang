# Bloblang for VS Code

Bloblang highlighting, diagnostics, formatting, completion, hover, definitions,
and references, powered by [bloblang-lsp](https://github.com/teyfix/bloblang-lsp).
The packaged extension includes the server; activation does not download anything.
If another extension also provides Bloblang, disable one provider to avoid duplicate
language servers. This extension includes its own grammars and needs no Benthos
extension.

Open a `.blobl` or `.bloblang` file. Bloblang is also highlighted inside YAML
`mapping`, `request_map`, `result_map`, `args_mapping`, `fields_mapping`, `check`,
and test `bloblang` values, including literal/folded blocks and quoted/plain
scalars. `${! ... }` interpolation is highlighted in YAML strings. Embedded YAML
also receives server diagnostics, hover, completion, navigation and formatting
with positions mapped to the original document.

With a CUE extension providing the host grammar, CUE mapping strings (ordinary,
raw and multiline) and interpolation receive highlighting. CUE language server
features continue to belong to the CUE extension.

## Commands and settings

- **Bloblang: Restart Language Server** restarts using the current settings.
- **Bloblang: Show Language Server Logs** opens server output.
- **Bloblang: Format Embedded Mappings** formats Bloblang in the active YAML file
  while preserving the surrounding YAML. Your default YAML formatter stays usable.
- Use **Format Document** in Bloblang files.

`bloblang.server.path` overrides the bundled binary with a path or PATH command.
It supports `${workspaceFolder}` and `${userHome}`; relative paths are resolved
from the first workspace folder. `bloblang.server.args` supplies server arguments.
`bloblang.yaml.enabled` controls YAML server features (highlighting is always
available). `bloblang.trace.server` enables protocol logging. Lifecycle messages
stay in the output channels. A quiet status bar indicator shows starting, ready,
or failed; click it to open server logs. Initialization shows no notification.
Startup failures offer logs and settings.

## Sample input and metadata

For `mapping.blobl`, create the sibling `mapping.sample.json` or
`mapping.sample.yaml` to get runtime previews and type guidance:

```json
{"$bloblang":{"input":{"name":"Ada"},"meta":{"topic":"people"}}}
```

```yaml
$bloblang:
  input:
    name: Ada
  meta:
    topic: people
```

Metadata is optional. The file envelope is required. Supply an optional `root`
inside `$bloblang` to preview mappings that update an existing output (for example,
a `result_map`), while `input` stays the separate value read through `this`.
`#!root` and `#!root_from` can override that initial output. Missing automatic samples
produce an informational suggestion to add a sample; static language features
still work. Multiple matching sibling sample files produce a diagnostic so sample
selection is unambiguous. Invalid sample files or directives disable preview,
while static diagnostics, documentation and navigation remain available. Changes, creation and deletion of sample files refresh the server.

Leading directives override the sample input or metadata:

```bloblang
#!input {"name":"Ada"}
#!meta {"topic":"people"}
root.name = this.name.uppercase()
root.topic = meta("topic")
```

Use `#!sample {"input":{"name":"Ada"},"meta":{"topic":"people"}}` to provide
the entire sample inline. `#!input_from`, `#!meta_from`, and `#!sample_from`
load JSON/YAML files relative to the mapping file; these files require the
`$bloblang` envelope. A missing explicitly referenced file is an error at the
directive. Multiline arguments use comment continuation lines:

```bloblang
#!sample |
#| input:
#|   name: Ada
#| meta:
#|   topic: people
root = this
```

Sample hover shows the original input `this` and selected expression values.
Hovering the assignment target `root` shows the input at the first assignment,
then the prior output before later assignments. Reading `root` on the right hand
side evaluates the actual output state, which may be unavailable before its first
assignment. Assignment end hints show the resulting output.
Evaluation uses complete preceding statements, preserving named maps, imports,
variables, and message metadata. Completion can use a known sample value's type;
without a sample, ordinary documentation and completion remain available.

## Build and package

Install [Bun](https://bun.sh), Go matching the sibling server's `go.mod`, and a C
compiler for its current Tree-sitter binding. Keep `bloblang-lsp` and `tree-sitter-bloblang` beside this repo. The server uses
the local grammar module through its Go module replacement:

```sh
bun install --frozen-lockfile
bun run check
bun run package
code --install-extension vscode-bloblang-linux-x64-0.1.0.vsix
```

The package contains `dist/extension.js`, language grammars/configuration, and
`bin/<platform>-<arch>/bloblang-lsp`. JavaScript dependencies are bundled. Packaging
rebuilds the current sibling server (including its generated C parser) and targets
the host platform. For another server
checkout set `BLOBLANG_LSP_REPO`; to package an already built binary set
`BLOBLANG_LSP_BINARY`. Cross packaging requires a binary already built for the destination platform:

```sh
VSCE_TARGET=linux-arm64 BLOBLANG_LSP_BINARY=/path/to/arm64/bloblang-lsp bun run package
```

The build places that binary under the correct runtime platform folder and writes
the matching VSIX platform manifest. Linux glibc and musl builds are separate targets.

Development can use `bloblang.server.path` pointing to the sibling server binary.
Run `bun run build:watch`, then launch an Extension Development Host. Grammar tests
use checked-in host grammar fixtures and run without other projects or editor
extensions. `bun run build:smoke` builds `dist/smoke.cjs`, an extension host test
module; run it with an isolated VS Code profile and extensions directory to check
activation, sampled hover, completion, formatting, YAML mapping, diagnostics, and
restart without interference from other Bloblang extensions.

## License

[MIT](LICENSE)
