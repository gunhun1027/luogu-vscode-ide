import * as vscode from 'vscode';
import { fetchProblemDetail } from './luoguApi';

export class BrowserProvider {
    private static _panel: vscode.WebviewPanel | undefined;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public openBrowser(url?: string) {
        const targetUrl = url || 'https://www.luogu.com.cn';

        if (BrowserProvider._panel) {
            BrowserProvider._panel.reveal(vscode.ViewColumn.One);
            BrowserProvider._panel.webview.postMessage({
                type: 'navigate',
                url: targetUrl,
            });
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'luoguBrowser',
            '洛谷',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        panel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'resources', 'luogu.svg');
        BrowserProvider._panel = panel;

        panel.onDidDispose(() => {
            BrowserProvider._panel = undefined;
        });

        panel.webview.html = this._getBrowserHtml(panel.webview, targetUrl);

        // Listen for URL change messages from the webview
        panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'urlChanged': {
                    // Detect problem page URL pattern: /problem/P1000, /problem/CF1234A, etc.
                    const match = msg.url.match(/\/problem\/([A-Za-z]+\d+[A-Za-z]?\d*)/);
                    if (match) {
                        const pid = match[1];
                        panel.title = `洛谷 - ${pid}`;
                        
                        // Ask user if they want to open IDE
                        const autoOpen = vscode.workspace.getConfiguration('luogu').get<boolean>('autoOpenIDE', true);
                        if (autoOpen) {
                            try {
                                const problem = await fetchProblemDetail(pid);
                                vscode.commands.executeCommand('luogu.openIDE', {
                                    pid: problem.pid,
                                    title: problem.title,
                                    samples: problem.samples,
                                    timeLimit: problem.limits?.time?.[0] || 1000,
                                    memoryLimit: problem.limits?.memory?.[0] || 131072,
                                });
                            } catch (err: any) {
                                vscode.window.showErrorMessage(`加载题目 ${pid} 失败: ${err.message}`);
                            }
                        }
                    } else {
                        panel.title = '洛谷';
                    }
                    break;
                }
                case 'openExternal': {
                    vscode.env.openExternal(vscode.Uri.parse(msg.url));
                    break;
                }
            }
        });
    }

    private _getBrowserHtml(webview: vscode.Webview, url: string): string {
        const nonce = getNonce();
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src https://www.luogu.com.cn https://luogu.com.cn; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family);
        }
        .browser-toolbar {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            background: var(--vscode-titleBar-activeBackground, var(--vscode-editor-background));
            border-bottom: 1px solid var(--vscode-panel-border);
            flex-shrink: 0;
        }
        .nav-btn {
            width: 28px;
            height: 28px;
            border: none;
            background: transparent;
            color: var(--vscode-foreground);
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: background 0.15s;
        }
        .nav-btn:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .nav-btn:disabled {
            opacity: 0.3;
            cursor: not-allowed;
        }
        .url-bar {
            flex: 1;
            padding: 5px 10px;
            border: 1px solid var(--vscode-input-border);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 4px;
            font-size: 12px;
            font-family: var(--vscode-editor-font-family, monospace);
            outline: none;
        }
        .url-bar:focus {
            border-color: var(--vscode-focusBorder);
        }
        .go-btn {
            padding: 5px 12px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        .go-btn:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .status-indicator {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #52c41a;
            flex-shrink: 0;
        }
        .status-indicator.loading {
            background: #f39c11;
            animation: pulse 1s ease-in-out infinite;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.3; }
        }
        .browser-frame {
            flex: 1;
            border: none;
            width: 100%;
        }
        .hint-bar {
            padding: 4px 12px;
            background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
            border-top: 1px solid var(--vscode-panel-border);
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            display: flex;
            align-items: center;
            gap: 8px;
            flex-shrink: 0;
        }
        .hint-badge {
            padding: 1px 6px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 3px;
            font-size: 10px;
        }
    </style>
</head>
<body>
    <div class="browser-toolbar">
        <button class="nav-btn" id="backBtn" title="后退">←</button>
        <button class="nav-btn" id="forwardBtn" title="前进">→</button>
        <button class="nav-btn" id="refreshBtn" title="刷新">↻</button>
        <div class="status-indicator" id="statusDot"></div>
        <input class="url-bar" id="urlBar" type="text" value="${url}" />
        <button class="go-btn" id="goBtn">前往</button>
        <button class="nav-btn" id="externalBtn" title="在浏览器中打开">↗</button>
    </div>

    <iframe class="browser-frame" id="browserFrame" src="${url}" sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"></iframe>

    <div class="hint-bar">
        <span class="hint-badge">提示</span>
        <span>浏览到题目页面时，将自动打开本地 IDE 面板</span>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const frame = document.getElementById('browserFrame');
        const urlBar = document.getElementById('urlBar');
        const statusDot = document.getElementById('statusDot');
        let currentUrl = '${url}';

        // Navigation buttons
        document.getElementById('backBtn').addEventListener('click', () => {
            try { frame.contentWindow.history.back(); } catch(e) {}
        });
        document.getElementById('forwardBtn').addEventListener('click', () => {
            try { frame.contentWindow.history.forward(); } catch(e) {}
        });
        document.getElementById('refreshBtn').addEventListener('click', () => {
            frame.src = currentUrl;
        });
        document.getElementById('externalBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'openExternal', url: currentUrl });
        });

        // URL bar navigation
        function navigateTo(url) {
            if (!url.startsWith('http')) url = 'https://' + url;
            currentUrl = url;
            urlBar.value = url;
            frame.src = url;
        }

        document.getElementById('goBtn').addEventListener('click', () => {
            navigateTo(urlBar.value.trim());
        });
        urlBar.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') navigateTo(urlBar.value.trim());
        });

        // Detect iframe URL changes
        frame.addEventListener('load', () => {
            statusDot.classList.remove('loading');
            try {
                const newUrl = frame.contentWindow.location.href;
                if (newUrl && newUrl !== 'about:blank') {
                    currentUrl = newUrl;
                    urlBar.value = newUrl;
                    vscode.postMessage({ type: 'urlChanged', url: newUrl });
                }
            } catch (e) {
                // Cross-origin, can't read URL
            }
        });

        frame.addEventListener('beforeunload', () => {
            statusDot.classList.add('loading');
        });

        // Listen for navigation commands
        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg.type === 'navigate') {
                navigateTo(msg.url);
            }
        });
    </script>
</body>
</html>`;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
