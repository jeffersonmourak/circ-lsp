# circ-lsp

A Language Server Protocol server (and VS Code / Cursor extension) for the
`.circ` digital-logic language. It is a thin TypeScript shell over the Zig
analyzer: the server owns the LSP protocol, the document store, debouncing,
and the analysis cache, and shells out to `circ-compile --analyze` (a pure
function of disk state plus the unsaved buffers it is handed) for all
parsing, resolution, and validation.

Features (v1): live diagnostics, document symbols, hover, go-to-definition,
and TextMate syntax highlighting.

## Relationship to circ-compiler

This repo contains only the editor-facing shell. The actual analysis lives
in the [`circ-compiler`](https://github.com/jeffersonmourak/circ-compiler)
repo, which exposes the `circ-compile --analyze` JSON contract (see
`circ-compiler`'s `DOCS/analyze-api.md`). The dependency is one-way: this
repo needs the `circ-compile` binary at runtime; the compiler never depends
on this repo. The TextMate grammar in `syntaxes/circ.tmLanguage.json` is a
vendored copy kept in sync with `circ-compiler`'s `site/src/utils/circ-lang.mjs`.

## Prerequisites: install the analyzer

This extension shells out to `circ-compile` (version 0.0.2 or newer). Install
it with the published installer:

```sh
# macOS / Linux
curl -fsSL https://circ-lang.org/install.sh | sh
# Windows (PowerShell)
irm https://circ-lang.org/install.ps1 | iex
```

The installer drops the binary in `~/.local/bin` (macOS / Linux) or
`%LOCALAPPDATA%\circ\bin` (Windows). Put that directory on your `PATH` (the
`circ.compilerPath` setting defaults to `circ-compile`), or point
`circ.compilerPath` at the binary's absolute path. See
https://circ-lang.org/download for archives and details.

To build from source instead, from a checkout of `circ-compiler`:

```sh
zig build circ-compile      # produces zig-out/bin/circ-compile
```

then set `circ.compilerPath` to that path or copy the binary onto your `PATH`.

If `circ-compile` is missing or older than 0.0.2, the extension shows a
one-time prompt with the install command rather than failing silently.

## Build this extension

```sh
npm install
npm run build               # compiles src/*.ts -> out/*.js
```

## Use in VS Code / Cursor

Open this folder and press F5 (Run Extension) for a sandboxed dev host, or
package and install it:

```sh
npx @vscode/vsce package -o circ-lsp.vsix
cursor --install-extension circ-lsp.vsix --force    # or: code --install-extension ...
```

Reload the editor, then open any `.circ` file.

## Use in other editors (no extension needed)

The server speaks LSP over stdio, so any editor can launch it directly:

```
node <abs path>/out/server.js --stdio
```

Pass the analyzer path via the `compilerPath` initialization option, or
rely on `circ-compile` being on `PATH`.

### Neovim (nvim-lspconfig style)

```lua
vim.lsp.start({
  name = "circ-lsp",
  cmd = { "node", "/abs/path/circ-lsp/out/server.js", "--stdio" },
  root_dir = vim.fn.getcwd(),
  init_options = { compilerPath = "circ-compile" },
})
```

### Emacs (Eglot, built in on Emacs 29+)

Eglot dispatches on major mode, so give `.circ` files one, then point Eglot
at the server:

```elisp
(define-derived-mode circ-mode prog-mode "circ"
  (setq-local comment-start "// "))
(add-to-list 'auto-mode-alist '("\\.circ\\'" . circ-mode))

(with-eval-after-load 'eglot
  (add-to-list 'eglot-server-programs
               '(circ-mode . ("node" "/abs/path/circ-lsp/out/server.js" "--stdio"
                              :initializationOptions (:compilerPath "circ-compile")))))
```

Then run `M-x eglot` in a `.circ` buffer, or add `eglot-ensure` to
`circ-mode-hook` to start it automatically.

## Contract

Request (stdin): `{ "root_path": "<abs>", "overlays": { "<abs>": "<text>" } }`
Response (stdout): `{ files, diagnostics, symbols, references }`, with
positions as 1-based byte line/col (the server converts to LSP 0-based
UTF-16). See `circ-compiler`'s `DOCS/analyze-api.md` for the authoritative
contract spec.
