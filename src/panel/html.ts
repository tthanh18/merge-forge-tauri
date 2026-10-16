import * as vscode from 'vscode';

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

/**
 * Builds the webview HTML shell. Monaco requires `style-src 'unsafe-inline'` (it injects
 * inline styles) and `worker-src blob:` (workers are constructed via a blob trampoline
 * because `vscode-webview://` is cross-origin for `new Worker`).
 */
export function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const webviewDist = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDist, 'main.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDist, 'main.css'));
  const workerUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDist, 'editor.worker.js'));
  const nonce = getNonce();
  const csp = [
    `default-src 'none'`,
    `script-src 'nonce-${nonce}'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    // github.com/<login>.png (redirects to avatars.githubusercontent.com) serves
    // the authorship chips; everything else stays local.
    `img-src ${webview.cspSource} data: https://github.com https://avatars.githubusercontent.com`,
    `worker-src blob:`,
    `connect-src ${webview.cspSource}`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>Merge Forge</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}">
    window.__mergeForge = { workerUri: ${JSON.stringify(workerUri.toString())} };
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/** Shell for the Conflicts dialog — no Monaco, so a much tighter CSP than the editor's. */
export function getConflictsHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const webviewDist = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDist, 'conflicts.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDist, 'conflicts.css'));
  const nonce = getNonce();
  const csp = [
    `default-src 'none'`,
    `script-src 'nonce-${nonce}'`,
    `style-src ${webview.cspSource}`,
    // The codicon file-type icons load their font from the bundled TTF.
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>Conflicts</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
