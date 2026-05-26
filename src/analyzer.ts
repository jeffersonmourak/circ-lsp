// Thin wrapper around `circ-compile --analyze`: writes a JSON request to
// the child's stdin and parses the JSON analysis from its stdout. The Zig
// side is a pure function of (disk state + overlays); all state lives here
// in the server.

import { spawn } from "node:child_process";

export interface AnalyzeRange {
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
}

export interface AnalyzeRelated {
  file_id: number;
  range: AnalyzeRange;
  message: string;
}

export interface AnalyzeDiagnostic {
  file_id: number;
  severity: string;
  code: string;
  range: AnalyzeRange;
  message: string;
  related: AnalyzeRelated[];
}

export interface AnalyzeFile {
  file_id: number;
  path: string;
}

export interface AnalyzeSymbol {
  file_id: number;
  name: string;
  kind: string;
  width: number;
  range: AnalyzeRange;
}

export interface AnalyzeReference {
  file_id: number;
  range: AnalyzeRange;
  target_file: number;
  target_range: AnalyzeRange;
  hover: string;
}

export interface AnalyzeResult {
  files: AnalyzeFile[];
  diagnostics: AnalyzeDiagnostic[];
  symbols: AnalyzeSymbol[];
  references: AnalyzeReference[];
}

export interface AnalyzeRequest {
  root_path: string;
  overlays: Record<string, string>;
}

export function runAnalyze(compilerPath: string, request: AnalyzeRequest): Promise<AnalyzeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(compilerPath, ["--analyze"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (stdout.trim() === "") {
        reject(new Error(`circ-compile --analyze produced no output (exit ${code}): ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as AnalyzeResult);
      } catch (err) {
        reject(new Error(`failed to parse analyze output: ${(err as Error).message}`));
      }
    });
    child.stdin.write(JSON.stringify(request));
    child.stdin.end();
  });
}

export interface VersionResult {
  // Trimmed stdout from `--version` (or stderr, if stdout was empty).
  raw: string;
  exitCode: number | null;
}

// Runs `circ-compile --version` so the server can gate on the binary's
// presence and version before analyzing. Rejects only when the process
// cannot be spawned (e.g. ENOENT); a non-zero exit resolves with whatever
// output was captured so the caller decides what counts as usable.
export function runVersion(compilerPath: string): Promise<VersionResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(compilerPath, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      const raw = (stdout.trim() !== "" ? stdout : stderr).trim();
      resolve({ raw, exitCode: code });
    });
  });
}
