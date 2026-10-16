import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

/** The one shared "Merge Forge" output channel — diagnostics and webview warnings. */
export function getOutputChannel(): vscode.OutputChannel {
  channel ??= vscode.window.createOutputChannel('Merge Forge');
  return channel;
}
