// circ language server.
//
// State lives here (document store, debounce, per-root analysis cache,
// position lookup); the Zig analyzer is invoked per change as a pure
// function. Positions from the analyzer are 1-based byte line/col; LSP
// positions are 0-based, so every range is shifted by one on the way out.
// For ASCII .circ identifiers a byte column equals the UTF-16 column.

import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  DiagnosticSeverity,
  SymbolKind,
  MarkupKind,
  Range,
  Position,
  Location,
  type InitializeParams,
  type InitializeResult,
  type Diagnostic,
  type DocumentSymbol,
  type Hover,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as path from "node:path";
import { runAnalyze, runVersion, type AnalyzeResult, type AnalyzeRange, type VersionResult } from "./analyzer";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let compilerPath = "circ-compile";
let workspaceRoot = process.cwd();

interface CacheEntry {
  result: AnalyzeResult;
  fileIdToUri: Map<number, string>;
}

// Per-root analysis cache. Hover/definition/symbols are answered from it
// without re-invoking the analyzer until the next change.
const cache = new Map<string, CacheEntry>();
const debounceTimers = new Map<string, NodeJS.Timeout>();
const DEBOUNCE_MS = 200;

connection.onInitialize((params: InitializeParams): InitializeResult => {
  if (params.workspaceFolders && params.workspaceFolders.length > 0) {
    workspaceRoot = fileURLToPath(params.workspaceFolders[0].uri);
  } else if (params.rootUri) {
    workspaceRoot = fileURLToPath(params.rootUri);
  }
  const opts = params.initializationOptions as { compilerPath?: string } | undefined;
  if (opts && typeof opts.compilerPath === "string") {
    compilerPath = opts.compilerPath;
  }
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      documentSymbolProvider: true,
      hoverProvider: true,
      definitionProvider: true,
    },
  };
});

function resolveCompiler(): string {
  if (path.isAbsolute(compilerPath)) return compilerPath;
  // A bare command name (no directory part) is left for the OS to resolve on
  // PATH; a path with a directory part is taken relative to the workspace root.
  if (path.dirname(compilerPath) === ".") return compilerPath;
  return path.join(workspaceRoot, compilerPath);
}

// ---- analyzer gate (presence + version) ----
//
// The server will not analyze until it has confirmed a runnable circ-compile
// of a supported version. The version probe runs once per resolved path
// (memoized), and a single notification per path nudges the user to install
// or update, rather than silently failing or spamming the analyzer on every
// keystroke. Changing circ.compilerPath re-resolves and re-arms the check.

const MIN_VERSION: [number, number, number] = [0, 0, 2];
const MIN_VERSION_STR = MIN_VERSION.join(".");
const DOWNLOAD_URL = "https://circ-lang.org/download";

type GateKind = "ok" | "missing" | "outdated";
interface GateResult {
  kind: GateKind;
  found?: string;
}

let gatePromise: Promise<GateResult> | undefined;
let gateForPath: string | undefined;
let promptShownForPath: string | undefined;

function parseVersion(raw: string): [number, number, number] | null {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareVersion(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

async function checkAnalyzer(resolved: string): Promise<GateResult> {
  let res: VersionResult;
  try {
    res = await runVersion(resolved);
  } catch (err) {
    connection.console.warn(`circ-compile is not runnable at "${resolved}": ${(err as Error).message}`);
    return { kind: "missing" };
  }
  if (res.exitCode !== 0) {
    connection.console.warn(`circ-compile --version exited with ${res.exitCode}: ${res.raw}`);
    return { kind: "missing" };
  }
  const parsed = parseVersion(res.raw);
  if (!parsed) return { kind: "outdated", found: res.raw };
  if (compareVersion(parsed, MIN_VERSION) < 0) return { kind: "outdated", found: parsed.join(".") };
  connection.console.info(`circ-compile ${parsed.join(".")} detected at "${resolved}"`);
  return { kind: "ok" };
}

// Memoized per resolved path. Re-resolving to a different path (e.g. after the
// user edits circ.compilerPath) discards the old result and re-arms the prompt.
function ensureAnalyzerReady(): Promise<GateResult> {
  const resolved = resolveCompiler();
  if (!gatePromise || gateForPath !== resolved) {
    gateForPath = resolved;
    promptShownForPath = undefined;
    gatePromise = checkAnalyzer(resolved);
  }
  return gatePromise;
}

async function showAnalyzerPrompt(gate: GateResult): Promise<void> {
  // One notification per resolved path; subsequent edits stay quiet.
  if (promptShownForPath === gateForPath) return;
  promptShownForPath = gateForPath;

  const installCmd =
    process.platform === "win32"
      ? "irm https://circ-lang.org/install.ps1 | iex"
      : "curl -fsSL https://circ-lang.org/install.sh | sh";

  const message =
    gate.kind === "missing"
      ? `circ-compile was not found at "${gateForPath}". Install the circ analyzer to enable diagnostics and navigation. Run: ${installCmd}`
      : `circ-compile ${gate.found ? `reported "${gate.found}"` : "did not report a usable version"}, but circ-lsp needs ${MIN_VERSION_STR} or newer. Update it by running: ${installCmd}`;

  // Inline objects let TypeScript infer the action-item type; the chosen one
  // is returned (or undefined if the user dismisses the notification).
  const copy = { title: "Copy install command" };
  const open = { title: "Open download page" };
  const choice = await connection.window.showWarningMessage(message, copy, open);
  if (choice?.title === copy.title) {
    // The server has no clipboard; the VS Code client performs the copy.
    connection.sendNotification("circ/copyToClipboard", installCmd);
  } else if (choice?.title === open.title) {
    try {
      await connection.window.showDocument({ uri: DOWNLOAD_URL, external: true });
    } catch (err) {
      connection.console.warn(`circ: opening the download page failed: ${(err as Error).message}`);
    }
  }
}

function buildOverlays(): Record<string, string> {
  const overlays: Record<string, string> = {};
  for (const doc of documents.all()) {
    if (doc.uri.endsWith(".circ")) {
      overlays[fileURLToPath(doc.uri)] = doc.getText();
    }
  }
  return overlays;
}

function toLspRange(r: AnalyzeRange): Range {
  return Range.create(
    Position.create(Math.max(0, r.start_line - 1), Math.max(0, r.start_col - 1)),
    Position.create(Math.max(0, r.end_line - 1), Math.max(0, r.end_col - 1)),
  );
}

// 1-based byte position inside a half-open [start, end) analyzer range.
function rangeContains(r: AnalyzeRange, pos: Position): boolean {
  const line = pos.line + 1;
  const col = pos.character + 1;
  const afterStart = line > r.start_line || (line === r.start_line && col >= r.start_col);
  const beforeEnd = line < r.end_line || (line === r.end_line && col < r.end_col);
  return afterStart && beforeEnd;
}

async function analyzeDocument(uri: string): Promise<void> {
  const doc = documents.get(uri);
  if (!doc) return;

  // Gate every analysis on a confirmed, compatible circ-compile. On failure
  // surface the install/update prompt once and bail before spawning analyze.
  const gate = await ensureAnalyzerReady();
  if (gate.kind !== "ok") {
    void showAnalyzerPrompt(gate);
    return;
  }

  const rootPath = fileURLToPath(uri);
  const overlays = buildOverlays();
  overlays[rootPath] = doc.getText();

  let result: AnalyzeResult;
  try {
    result = await runAnalyze(resolveCompiler(), { root_path: rootPath, overlays });
  } catch (err) {
    connection.console.error(`circ analyze failed: ${(err as Error).message}`);
    return;
  }

  const fileIdToUri = new Map<number, string>();
  for (const f of result.files) {
    if (!f.path.startsWith("<builtin>")) {
      fileIdToUri.set(f.file_id, pathToFileURL(f.path).toString());
    }
  }
  cache.set(uri, { result, fileIdToUri });

  const byFile = new Map<number, Diagnostic[]>();
  for (const d of result.diagnostics) {
    const diag: Diagnostic = {
      severity: d.severity === "error" ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
      range: toLspRange(d.range),
      message: d.message,
      code: d.code,
      source: "circ",
    };
    if (d.related && d.related.length > 0) {
      diag.relatedInformation = d.related.map((rel) => ({
        location: { uri: fileIdToUri.get(rel.file_id) ?? uri, range: toLspRange(rel.range) },
        message: rel.message,
      }));
    }
    const list = byFile.get(d.file_id);
    if (list) list.push(diag);
    else byFile.set(d.file_id, [diag]);
  }

  // Publish for every non-builtin file in this analysis, clearing any that
  // are now clean.
  for (const [fid, fileUri] of fileIdToUri) {
    connection.sendDiagnostics({ uri: fileUri, diagnostics: byFile.get(fid) ?? [] });
  }
}

function scheduleAnalyze(uri: string): void {
  const existing = debounceTimers.get(uri);
  if (existing) clearTimeout(existing);
  debounceTimers.set(
    uri,
    setTimeout(() => {
      debounceTimers.delete(uri);
      void analyzeDocument(uri);
    }, DEBOUNCE_MS),
  );
}

// ---- position lookup over the cache (Tier 1) ----

function uriToFileId(entry: CacheEntry, uri: string): number | undefined {
  for (const [fid, u] of entry.fileIdToUri) {
    if (u === uri) return fid;
  }
  return undefined;
}

function findCacheForUri(uri: string): { entry: CacheEntry; fileId: number } | undefined {
  const own = cache.get(uri);
  if (own) {
    const fid = uriToFileId(own, uri);
    if (fid !== undefined) return { entry: own, fileId: fid };
  }
  for (const entry of cache.values()) {
    const fid = uriToFileId(entry, uri);
    if (fid !== undefined) return { entry, fileId: fid };
  }
  return undefined;
}

connection.onHover((params): Hover | null => {
  const found = findCacheForUri(params.textDocument.uri);
  if (!found) return null;
  const { entry, fileId } = found;
  for (const ref of entry.result.references) {
    if (ref.file_id === fileId && rangeContains(ref.range, params.position)) {
      return { contents: { kind: MarkupKind.Markdown, value: "```circ\n" + ref.hover + "\n```" } };
    }
  }
  for (const sym of entry.result.symbols) {
    if (sym.file_id === fileId && rangeContains(sym.range, params.position)) {
      const w = sym.width > 1 ? `[${sym.width}]` : "";
      return { contents: { kind: MarkupKind.Markdown, value: "```circ\n" + `${sym.kind}${w} ${sym.name}` + "\n```" } };
    }
  }
  return null;
});

connection.onDefinition((params): Location | null => {
  const found = findCacheForUri(params.textDocument.uri);
  if (!found) return null;
  const { entry, fileId } = found;
  for (const ref of entry.result.references) {
    if (ref.file_id === fileId && rangeContains(ref.range, params.position)) {
      const targetUri = entry.fileIdToUri.get(ref.target_file);
      if (targetUri) return Location.create(targetUri, toLspRange(ref.target_range));
    }
  }
  return null;
});

connection.onDocumentSymbol((params): DocumentSymbol[] => {
  const found = findCacheForUri(params.textDocument.uri);
  if (!found) return [];
  const { entry, fileId } = found;
  const out: DocumentSymbol[] = [];
  for (const sym of entry.result.symbols) {
    if (sym.file_id !== fileId) continue;
    const range = toLspRange(sym.range);
    out.push({
      name: sym.name,
      detail: sym.width > 1 ? `${sym.kind}[${sym.width}]` : sym.kind,
      kind: sym.kind === "input" || sym.kind === "output" ? SymbolKind.Variable : SymbolKind.Function,
      range,
      selectionRange: range,
    });
  }
  return out;
});

documents.onDidOpen((e) => scheduleAnalyze(e.document.uri));
documents.onDidChangeContent((e) => scheduleAnalyze(e.document.uri));
documents.onDidClose((e) => {
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
  cache.delete(e.document.uri);
});

documents.listen(connection);
connection.listen();
