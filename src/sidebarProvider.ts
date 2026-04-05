import * as vscode from 'vscode';
import { fetchProblemList, getDifficultyInfo, LuoguProblemListItem } from './luoguApi';

export class SidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'luogu-problem-list';
    private _view?: vscode.WebviewView;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'loadProblems': {
                    await this._loadProblems(data.page || 1, data.problemType || 'P', data.keyword || '');
                    break;
                }
                case 'openProblem': {
                    vscode.commands.executeCommand('luogu.openProblem', data.pid);
                    break;
                }
            }
        });
    }

    public refresh() {
        if (this._view) {
            this._view.webview.postMessage({ type: 'refresh' });
        }
    }

    private async _loadProblems(page: number, type: string, keyword: string) {
        if (!this._view) { return; }
        
        try {
            this._view.webview.postMessage({ type: 'loading' });
            const result = await fetchProblemList(page, type, keyword);
            const problems = result.problems.result.map((p: LuoguProblemListItem) => ({
                pid: p.pid,
                title: p.title,
                difficulty: p.difficulty,
                difficultyInfo: getDifficultyInfo(p.difficulty),
                totalSubmit: p.totalSubmit,
                totalAccepted: p.totalAccepted,
            }));
            const totalPages = Math.ceil(result.problems.count / result.problems.perPage);
            this._view.webview.postMessage({
                type: 'problemsLoaded',
                problems,
                currentPage: page,
                totalPages,
                totalCount: result.problems.count,
            });
        } catch (err: any) {
            this._view.webview.postMessage({
                type: 'error',
                message: err.message || '加载失败',
            });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
            padding: 0;
        }
        .search-area {
            padding: 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
            position: sticky;
            top: 0;
            background: var(--vscode-sideBar-background);
            z-index: 10;
        }
        .search-row {
            display: flex;
            gap: 6px;
            margin-bottom: 8px;
        }
        .search-input {
            flex: 1;
            padding: 5px 8px;
            border: 1px solid var(--vscode-input-border);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 3px;
            font-size: 12px;
            outline: none;
        }
        .search-input:focus {
            border-color: var(--vscode-focusBorder);
        }
        .search-btn {
            padding: 5px 10px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 12px;
            white-space: nowrap;
        }
        .search-btn:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .type-tabs {
            display: flex;
            gap: 2px;
            flex-wrap: wrap;
        }
        .type-tab {
            padding: 3px 8px;
            font-size: 11px;
            border: 1px solid var(--vscode-panel-border);
            background: transparent;
            color: var(--vscode-foreground);
            border-radius: 3px;
            cursor: pointer;
        }
        .type-tab.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-color: var(--vscode-button-background);
        }
        .type-tab:hover:not(.active) {
            background: var(--vscode-list-hoverBackground);
        }
        .problem-list {
            list-style: none;
        }
        .problem-item {
            display: flex;
            align-items: center;
            padding: 8px 10px;
            cursor: pointer;
            border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.1));
            gap: 8px;
            transition: background 0.15s;
        }
        .problem-item:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .problem-pid {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            min-width: 50px;
            font-family: var(--vscode-editor-font-family, monospace);
        }
        .problem-title {
            flex: 1;
            font-size: 13px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .problem-diff {
            font-size: 10px;
            padding: 1px 6px;
            border-radius: 3px;
            color: #fff;
            white-space: nowrap;
        }
        .pagination {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 4px;
            padding: 10px;
            border-top: 1px solid var(--vscode-panel-border);
            position: sticky;
            bottom: 0;
            background: var(--vscode-sideBar-background);
        }
        .page-btn {
            padding: 4px 8px;
            font-size: 11px;
            background: transparent;
            color: var(--vscode-foreground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 3px;
            cursor: pointer;
        }
        .page-btn:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .page-btn:disabled {
            opacity: 0.4;
            cursor: not-allowed;
        }
        .page-info {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        .loading, .error-msg {
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 30px;
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
        }
        .error-msg { color: var(--vscode-errorForeground); }
        .stats {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            padding: 4px 10px;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        .spinner {
            width: 20px;
            height: 20px;
            border: 2px solid var(--vscode-panel-border);
            border-top-color: var(--vscode-button-background);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            margin-right: 8px;
        }
    </style>
</head>
<body>
    <div class="search-area">
        <div class="search-row">
            <input class="search-input" id="keyword" type="text" placeholder="搜索题号或题目名称..." />
            <button class="search-btn" id="searchBtn">搜索</button>
        </div>
        <div class="type-tabs" id="typeTabs">
            <button class="type-tab active" data-type="P">洛谷</button>
            <button class="type-tab" data-type="CF">CF</button>
            <button class="type-tab" data-type="SP">SPOJ</button>
            <button class="type-tab" data-type="AT">AT</button>
            <button class="type-tab" data-type="UVA">UVa</button>
        </div>
    </div>
    <div id="content">
        <div class="loading"><div class="spinner"></div>加载中...</div>
    </div>
    <div class="pagination" id="pagination" style="display:none;">
        <button class="page-btn" id="prevBtn" disabled>&lt;</button>
        <span class="page-info" id="pageInfo">1 / 1</span>
        <button class="page-btn" id="nextBtn">&gt;</button>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let currentPage = 1;
        let totalPages = 1;
        let currentType = 'P';
        let currentKeyword = '';

        // Init
        loadProblems();

        // Event handlers
        document.getElementById('searchBtn').addEventListener('click', () => {
            currentKeyword = document.getElementById('keyword').value.trim();
            currentPage = 1;
            loadProblems();
        });

        document.getElementById('keyword').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                currentKeyword = e.target.value.trim();
                currentPage = 1;
                loadProblems();
            }
        });

        document.getElementById('typeTabs').addEventListener('click', (e) => {
            if (e.target.classList.contains('type-tab')) {
                document.querySelectorAll('.type-tab').forEach(t => t.classList.remove('active'));
                e.target.classList.add('active');
                currentType = e.target.dataset.type;
                currentPage = 1;
                loadProblems();
            }
        });

        document.getElementById('prevBtn').addEventListener('click', () => {
            if (currentPage > 1) { currentPage--; loadProblems(); }
        });
        document.getElementById('nextBtn').addEventListener('click', () => {
            if (currentPage < totalPages) { currentPage++; loadProblems(); }
        });

        function loadProblems() {
            vscode.postMessage({
                type: 'loadProblems',
                page: currentPage,
                problemType: currentType,
                keyword: currentKeyword,
            });
        }

        window.addEventListener('message', (event) => {
            const msg = event.data;
            switch (msg.type) {
                case 'loading':
                    document.getElementById('content').innerHTML =
                        '<div class="loading"><div class="spinner"></div>加载中...</div>';
                    document.getElementById('pagination').style.display = 'none';
                    break;
                case 'problemsLoaded':
                    renderProblems(msg.problems, msg.currentPage, msg.totalPages, msg.totalCount);
                    break;
                case 'error':
                    document.getElementById('content').innerHTML =
                        '<div class="error-msg">❌ ' + msg.message + '</div>';
                    break;
                case 'refresh':
                    loadProblems();
                    break;
            }
        });

        function renderProblems(problems, page, pages, total) {
            currentPage = page;
            totalPages = pages;

            let html = '<div class="stats">共 ' + total + ' 题，第 ' + page + '/' + pages + ' 页</div>';
            html += '<ul class="problem-list">';
            for (const p of problems) {
                const passRate = p.totalSubmit > 0
                    ? Math.round((p.totalAccepted / p.totalSubmit) * 100) + '%'
                    : '-';
                html += '<li class="problem-item" data-pid="' + p.pid + '">'
                    + '<span class="problem-pid">' + p.pid + '</span>'
                    + '<span class="problem-title">' + escapeHtml(p.title) + '</span>'
                    + '<span class="problem-diff" style="background:' + p.difficultyInfo.color + '">'
                    + p.difficultyInfo.label + '</span>'
                    + '</li>';
            }
            html += '</ul>';

            document.getElementById('content').innerHTML = html;

            // Pagination
            const pag = document.getElementById('pagination');
            pag.style.display = 'flex';
            document.getElementById('pageInfo').textContent = page + ' / ' + pages;
            document.getElementById('prevBtn').disabled = page <= 1;
            document.getElementById('nextBtn').disabled = page >= pages;

            // Click handlers
            document.querySelectorAll('.problem-item').forEach(item => {
                item.addEventListener('click', () => {
                    vscode.postMessage({ type: 'openProblem', pid: item.dataset.pid });
                });
            });
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
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
