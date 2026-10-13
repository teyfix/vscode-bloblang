# Changelog

## 0.3.0

- Manage the shared `blobl` tool for the language server, static linting and
  formatting. Prepare the CLI at startup and start `blobl lsp` when a supported
  document is opened.
- Add `blobl` to new integrated terminals by default, with the
  `bloblang.cli.enabled` setting to control this behavior.
- Add **Bloblang: Check for Tool Updates** and **Bloblang: Install CLI for External
  Terminals**. External installation copies the CLI to a chosen folder, confirms
  replacement and provides PATH instructions.
- Download raw binaries through a public release manifest and verify their
  reported version before installation. Reuse installed tools offline, check for
  stable releases in the background and retain the current tool when updates fail.
- Select binaries for the extension host, including Remote SSH, WSL and dev
  containers, on Linux/macOS/Windows with amd64 and arm64 support.
- Preserve custom language server commands and arguments, and cached legacy
  servers for offline editor use.
- Resolve the nearest `.bloblangrc.json` within the selected project boundary,
  sharing configuration behavior with the CLI. Support CLI file exclusions and
  ignore files through the bundled configuration schema.
