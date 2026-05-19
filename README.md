# Bloblang Language Server

[Bloblang](https://docs.redpanda.com/redpanda-connect/guides/bloblang/about/) language support for Visual Studio Code, powered by [bloblang-lsp](https://github.com/teyfix/bloblang-lsp).

## Features

- **Intelligent Code Completion** — Auto-complete Bloblang functions and methods with contextual awareness
  - Function completions triggered after operators like `=`, `(`, `{`, `[`, `|`, `;`
  - Method completions triggered after `.` (e.g., `this.foo.bar.`)
  - Named-argument variants for functions/methods with optional parameters
  - Visual status indicators: `[β]` beta, `[⚗]` experimental, `[⚠]` deprecated

- **Rich Hover Documentation** — Detailed Markdown documentation on hover
  - Function/method signatures with parameter types
  - Status badges and deprecation warnings
  - Inline examples with input/output tables
  - Links to official [Redpanda documentation](https://docs.redpanda.com/redpanda-connect/guides/bloblang/)

- **Real-time Diagnostics** — Live error detection and validation
  - Parse error reporting with line/character positioning
  - Custom import resolution for `import "./maps.blobl"` statements
  - Diagnostics published via LSP `textDocument/publishDiagnostics`

- **Snippet Support** — Tab-stop placeholders for rapid coding
  - Positional arguments for required parameters
  - Named arguments for optional parameters
  - Smart defaults (e.g., `0` for numbers, `[]` for arrays)

## Usage

The language server binary is downloaded automatically on first activation. No manual setup required.

To manually restart the server: open the Command Palette (`Ctrl+Shift+P`) and run **Bloblang: Restart Language Server**.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

## License

[MIT](LICENSE)

## Acknowledgments

- [Redpanda Data](https://redpanda.com/) for the excellent Bloblang language and documentation
- The [Language Server Protocol](https://microsoft.github.io/language-server-protocol/) team at Microsoft
