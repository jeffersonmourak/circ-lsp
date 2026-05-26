// VS Code client: launches the circ language server (out/server.js) over
// the Node IPC transport and points it at the circ-compile binary. All
// analysis logic lives in the server and the Zig analyzer; this file is
// just glue so VS Code starts and stops the server, copies the install
// command to the clipboard on request, and relaunches the server when the
// analyzer path changes.

import * as path from "node:path";
import { env, window, workspace, type ExtensionContext } from "vscode";
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

function createClient(context: ExtensionContext): LanguageClient {
  const serverModule = context.asAbsolutePath(path.join("out", "server.js"));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc },
  };

  const compilerPath = workspace
    .getConfiguration("circ")
    .get<string>("compilerPath", "circ-compile");

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "circ" }],
    initializationOptions: { compilerPath },
  };

  const next = new LanguageClient("circLsp", "circ Language Server", serverOptions, clientOptions);

  // The server has no clipboard of its own; it asks the client to copy the
  // install command when the user clicks that notification action. Safe to
  // register before start: the handler is held until the connection opens.
  next.onNotification("circ/copyToClipboard", (text: string) => {
    void env.clipboard.writeText(text).then(() => {
      void window.showInformationMessage("Copied the circ-compile install command to the clipboard.");
    });
  });

  return next;
}

export function activate(context: ExtensionContext): void {
  client = createClient(context);
  void client.start();

  // Relaunch the server when the analyzer path changes so its one-time
  // presence and version check runs again against the new binary.
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("circ.compilerPath")) void restart(context);
    }),
  );
}

async function restart(context: ExtensionContext): Promise<void> {
  if (client) {
    await client.stop();
    client = undefined;
  }
  client = createClient(context);
  await client.start();
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
