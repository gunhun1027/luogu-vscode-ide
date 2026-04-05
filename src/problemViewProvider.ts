import * as vscode from 'vscode';
import { fetchProblemDetail, getDifficultyInfo, LuoguProblemDetail } from './luoguApi';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';

const md: MarkdownIt = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
    breaks: true,
    highlight: function (str: string, lang: string): string {
        if (lang && hljs.getLanguage(lang)) {
            try {
                return '<pre class="hljs"><code>' +
                       hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
                       '</code></pre>';
            } catch (err) {
                console.error('Highlight error:', err);
            }
        }
        return '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + '</code></pre>';
    }
});

export class ProblemViewProvider {
    private static _panels: Map<string, vscode.WebviewPanel> = new Map();

    public static broadcastRunningState(running: boolean) {
        ProblemViewProvider._panels.forEach(p => {
            p.webview.postMessage({ type: 'updateRunningState', running });
        });
    }

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public async openProblem(pid: string) {
        // Exit minimal mode for all other panels and close IDE
        ProblemViewProvider._panels.forEach((p, id) => {
            if (id !== pid) {
                p.webview.postMessage({ type: 'exitMinimalMode' });
            }
        });
        vscode.commands.executeCommand('luogu.closeIDE');

        const existing = ProblemViewProvider._panels.get(pid);
        if (existing) {
            existing.reveal(vscode.ViewColumn.One);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'luoguProblem',
            `${pid}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [this._extensionUri],
            }
        );

        panel.iconPath = new vscode.ThemeIcon('book');
        ProblemViewProvider._panels.set(pid, panel);

        panel.onDidDispose(() => {
            ProblemViewProvider._panels.delete(pid);
        });

        panel.webview.html = this._getLoadingHtml(panel.webview, pid);

        try {
            const problem = await fetchProblemDetail(pid);
            panel.title = `${pid} ${problem.title}`;
            panel.webview.html = this._getProblemHtml(panel.webview, problem);

            panel.webview.onDidReceiveMessage((msg) => {
                if (msg.type === 'openIDE') {
                    vscode.commands.executeCommand('luogu.openIDE', {
                        pid: problem.pid,
                        title: problem.title,
                        samples: problem.samples,
                        timeLimit: problem.limits?.time?.[0] || 1000,
                        memoryLimit: problem.limits?.memory?.[0] || 131072,
                    });
                } else if (msg.type === 'exitIDE') {
                    vscode.commands.executeCommand('luogu.closeIDE');
                } else if (msg.type === 'copyMarkdown') {
                    const markdown = this._generateMarkdown(problem);
                    vscode.env.clipboard.writeText(markdown);
                    vscode.window.showInformationMessage('题目 Markdown 已复制到剪贴板');
                } else if (msg.type === 'runSample') {
                    vscode.commands.executeCommand('luogu.runSample', {
                        pid: problem.pid,
                        input: msg.input,
                        output: msg.output
                    });
                }
            });

            // Listen for running state changes
            vscode.window.onDidChangeActiveTextEditor(() => {
                // Optional: handle editor change
            });
            
            // We can use a global state or message to update running state
            // For now, we'll handle it via messages sent to the webview
            
        } catch (err: any) {
            panel.webview.html = this._getErrorHtml(panel.webview, pid, err.message);
        }
    }

    private _generateMarkdown(problem: LuoguProblemDetail): string {
        let md = `# ${problem.pid} ${problem.title}\n\n`;
        
        if (problem.background) {
            md += `## 题目背景\n\n${problem.background}\n\n`;
        }
        
        md += `## 题目描述\n\n${problem.description}\n\n`;
        md += `## 输入格式\n\n${problem.inputFormat}\n\n`;
        md += `## 输出格式\n\n${problem.outputFormat}\n\n`;
        
        if (problem.samples && problem.samples.length > 0) {
            md += `## 输入输出样例\n\n`;
            problem.samples.forEach((s, i) => {
                md += `### 样例输入 #${i + 1}\n\n\`\`\`\n${s.input}\n\`\`\`\n\n`;
                md += `### 样例输出 #${i + 1}\n\n\`\`\`\n${s.output}\n\`\`\`\n\n`;
            });
        }
        
        if (problem.hint) {
            md += `## 说明/提示\n\n${problem.hint}\n\n`;
        }
        
        return md;
    }

    private _getLoadingHtml(webview: vscode.Webview, pid: string): string {
        const nonce = getNonce();
        return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body { display:flex; justify-content:center; align-items:center; height:100vh;
       font-family: var(--vscode-font-family); color: var(--vscode-foreground);
       background: var(--vscode-editor-background); }
.spinner { width:30px; height:30px; border:3px solid var(--vscode-panel-border);
           border-top-color: #3498db; border-radius:50%; animation:spin 0.8s linear infinite; margin-right:12px; }
@keyframes spin { to { transform:rotate(360deg); } }
.loading { display:flex; align-items:center; font-size:16px; }
</style></head><body>
<div class="loading"><div class="spinner"></div>正在加载 ${pid}...</div>
</body></html>`;
    }

    private _getErrorHtml(webview: vscode.Webview, pid: string, message: string): string {
        return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<style>
body { display:flex; justify-content:center; align-items:center; height:100vh;
       font-family: var(--vscode-font-family); color: var(--vscode-errorForeground);
       background: var(--vscode-editor-background); flex-direction:column; gap:10px; }
</style></head><body>
<div style="font-size:20px;">❌ 加载失败</div>
<div>${pid}: ${message}</div>
</body></html>`;
    }

    private _getProblemHtml(webview: vscode.Webview, problem: LuoguProblemDetail): string {
        const nonce = getNonce();
        const diffInfo = getDifficultyInfo(problem.difficulty);
        const timeLimit = problem.limits?.time?.[0] || 1000;
        const memoryLimit = problem.limits?.memory?.[0] || 131072;
        const passRate = problem.totalSubmit > 0
            ? (problem.totalAccepted / problem.totalSubmit * 100).toFixed(1)
            : '0';

        let samplesHtml = '';
        if (problem.samples && problem.samples.length > 0) {
            problem.samples.forEach((s, i) => {
                samplesHtml += `
                <div class="sample-group">
                    <div class="sample-header">样例 #${i + 1}</div>
                    <div class="sample-pair">
                        <div class="sample-block">
                            <div class="sample-label">
                                输入
                                <div class="sample-actions">
                                    <span class="sample-action-btn run-btn" data-index="${i}">运行</span>
                                    <span class="sample-action-btn copy-sample-btn" data-target="sample-input-${i}">复制</span>
                                </div>
                            </div>
                            <pre class="sample-content" id="sample-input-${i}">${escapeHtml(s.input)}</pre>
                        </div>
                        <div class="sample-block">
                            <div class="sample-label">
                                输出
                                <div class="sample-actions">
                                    <span class="sample-action-btn copy-sample-btn" data-target="sample-output-${i}">复制</span>
                                </div>
                            </div>
                            <pre class="sample-content" id="sample-output-${i}">${escapeHtml(s.output)}</pre>
                        </div>
                    </div>
                </div>`;
            });
        }

        // 构建标签 HTML
        const tagNames: Record<number, string> = {
            1: '算法', 2: '暴力', 3: '枚举', 4: '递推', 5: '递归', 6: '贪心',
            7: '模拟', 8: '搜索', 9: '二分', 10: '分治', 11: '高精度', 12: '排序',
            13: '倍增', 14: 'RMQ', 15: '单调队列', 16: '线段树', 17: '树状数组',
            18: '并查集', 19: '哈希', 20: '堆', 21: 'Dijkstra', 22: 'SPFA',
            23: 'Floyd', 24: 'Prim', 25: 'Kruskal', 26: '拓扑排序', 27: '网络流',
            28: '二分图', 29: '匈牙利算法', 30: '数位DP', 31: '动态规划', 32: '背包',
            33: '区间DP', 34: '树形DP', 35: '状压DP', 36: '概率DP', 37: '计算几何',
            38: '字符串', 39: 'KMP', 40: 'AC自动机', 41: 'Manacher', 42: 'Trie',
            43: '后缀数组', 44: '后缀自动机', 45: '矩阵', 46: '快速幂/倍增',
            47: '组合数学', 48: '博弈论', 49: '生成函数', 50: 'FFT/NTT',
            51: '数学', 52: '数论', 53: '线性代数', 54: '群论', 55: '图论',
            56: '树的直径与最近公共祖先', 57: '欧拉路与哈密顿路', 58: '强连通分量',
            59: '双连通分量', 60: '虚树', 61: '仙人掌', 62: '点分治', 63: '边分治',
            64: '网络流24题', 65: '差分约束', 66: 'ST表', 67: '可持久化数据结构',
            68: '平衡树', 69: '整体二分', 70: '分块', 71: '后缀平衡树',
            72: '字符串哈希', 73: '最小表示法', 74: 'ACAM', 75: '线性基',
            76: '莫队', 77: '反演', 78: '杜教筛', 79: '多项式', 80: '构造',
            81: '交互题', 82: '杂项', 83: '期望', 84: 'SG函数', 85: 'Burnside引理',
            86: 'Pólya计数法', 87: 'BFS', 88: 'DFS', 89: '前缀和', 90: '离散化',
            91: '双指针', 92: '尺取法', 93: '滑动窗口', 94: '中位数', 95: '三分',
            96: '悬线法', 97: '单调栈', 98: 'CDQ分治', 99: '后缀排序', 100: 'SAM',
            101: 'LCA', 102: '最大流', 103: '费用流', 104: '上下界网络流',
            105: '最大闭合子图', 106: '最小割', 107: '最小点覆盖', 108: '入门',
            109: '普及', 110: '提高', 111: '省选', 112: 'NOI', 113: 'CTSC',
            114: 'IOI', 115: '语法基础', 116: '数据结构', 117: '函数',
            118: '递归/分治/回溯/搜索', 119: '枚举/暴力/模拟/贪心',
            120: '文件/IO/流', 121: 'STL', 122: '日期问题', 123: '高精度模板',
            124: '思维', 125: '规律', 126: '结论', 127: 'Hash', 128: '根号算法',
            129: '贪心/前缀和/二分/分治/枚举/排序/构造', 130: '动态规划/背包/记忆化搜索',
            131: '深搜/BFS/广搜', 132: '递推/递归/高精度/分治/贪心',
            133: '字符串/KMP/Trie/AC自动机', 134: '线段树/树状数组/树剖/平衡树',
            135: '最短路/Floyd/SPFA/Dijkstra', 136: '生成树/并查集/强连通分量',
            137: '数学/数论/组合数学/概率论', 138: '计算几何/凸包/半平面交',
            139: '网络流/二分图/图的连通性', 140: '其他', 141: '2020',
            142: '2021', 143: '2022', 144: '2023', 145: '2024', 146: '2025'
        };

        let tagsHtml = '';
        if (problem.tags && problem.tags.length > 0) {
            tagsHtml = '<div class="tags-list">' +
                problem.tags.map((tag: any) => {
                    const name = typeof tag === 'object' ? tag.name : (tagNames[tag as number] || `#${tag}`);
                    return `<span class="tag-item">${name}</span>`;
                }).join('') +
                '</div>';
        }

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https://cdn.jsdelivr.net; script-src ${webview.cspSource} 'unsafe-inline' https://cdn.jsdelivr.net; font-src https://fonts.googleapis.com; img-src ${webview.cspSource} https: data:;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    
    <!-- KaTeX -->
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
    
    <!-- Highlight.js CSS - Use a light theme for the light problem view -->
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css">
    
    <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            color: #333;
            background: #f5f7fa;
            line-height: 1.6;
            padding: 0;
            transition: all 0.3s ease;
        }
        
        /* Banner Header */
        .banner {
            background: linear-gradient(rgba(0,0,0,0.5), rgba(0,0,0,0.5)), url('https://cdn.luogu.com.cn/images/bg/fe/mpc/2.jpg');
            background-size: cover;
            background-position: center;
            color: #fff;
            padding: 40px 5% 20px;
            position: relative;
        }
        .banner-content {
            max-width: 1400px;
            margin: 0 auto;
            display: flex;
            justify-content: space-between;
            align-items: flex-end;
        }
        .banner-left h1 {
            font-size: 28px;
            margin-bottom: 20px;
        }
        .banner-btns {
            display: flex;
            gap: 10px;
        }
        .banner-btn {
            padding: 6px 16px;
            border-radius: 4px;
            font-size: 14px;
            cursor: pointer;
            border: none;
            color: #fff;
            font-weight: 500;
        }
        .btn-blue { background: #3498db; }
        .btn-dark { background: #34495e; }
        .btn-gray { background: #7f8c8d; }
        
        .banner-right {
            display: flex;
            gap: 20px;
            text-align: right;
        }
        .stat-item {
            display: flex;
            flex-direction: column;
        }
        .stat-label { font-size: 12px; opacity: 0.8; }
        .stat-value { font-size: 16px; font-weight: 600; }

        /* Main Layout */
        .main-container {
            max-width: 1400px;
            margin: 20px auto;
            padding: 0 5%;
            display: grid;
            grid-template-columns: 1fr 300px;
            gap: 20px;
            transition: all 0.3s ease;
        }
        
        /* Minimal Mode Styles */
        body.minimal-mode .banner {
            display: none;
        }
        body.minimal-mode .sidebar {
            display: none;
        }
        body.minimal-mode .main-container {
            grid-template-columns: 1fr;
            margin-top: 0;
            padding-top: 20px;
        }
        body.minimal-mode .main-content {
            box-shadow: none;
            border: none;
            background: transparent;
        }
        body.minimal-mode .ide-link-bar #openIDE {
            display: none;
        }
        body.minimal-mode #expandToggle {
            display: none;
        }
        
        body.expanded-mode .main-container {
            grid-template-columns: 1fr;
        }
        body.expanded-mode .sidebar {
            display: none;
        }
        
        .main-content {
            background: #fff;
            padding: 30px;
            border-radius: 4px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            transition: background 0.3s, color 0.3s;
        }
        
        /* Theme Toggle Styles */
        body.dark-mode {
            background: #1e1e1e;
            color: #d4d4d4;
        }
        body.dark-mode .main-content,
        body.dark-mode .side-card {
            background: #252526;
            color: #d4d4d4;
            box-shadow: 0 1px 3px rgba(0,0,0,0.3);
        }
        body.dark-mode .banner {
            background: linear-gradient(rgba(0,0,0,0.8), rgba(0,0,0,0.8)), url('https://cdn.luogu.com.cn/images/bg/fe/mpc/2.jpg');
        }
        body.dark-mode .section-title {
            color: #569cd6;
            border-bottom-color: #333;
        }
        body.dark-mode .section-body {
            color: #bbb;
        }
        body.dark-mode .section-body strong { color: #eee; }
        body.dark-mode .section-body code {
            background: #2d2d2d;
            color: #ce9178;
        }
        body.dark-mode .side-title {
            border-bottom-color: #333;
            color: #569cd6;
        }
        body.dark-mode .side-label {
            color: #888;
        }
        body.dark-mode .ide-link-bar {
            color: #569cd6;
        }
        body.dark-mode .sample-block {
            border-color: #333;
        }
        body.dark-mode .sample-label {
            background: #2d2d2d;
            border-bottom-color: #333;
            color: #888;
        }
        body.dark-mode .sample-action-btn {
            background: #333;
            border-color: #444;
            color: #aaa;
        }
        body.dark-mode .sample-action-btn.run-btn {
            background: #1b2d1b;
            border-color: #2d4d2d;
            color: #52c41a;
        }
        body.dark-mode .sample-action-btn.run-btn:hover {
            background: #52c41a;
            color: #fff;
        }
        body.dark-mode .sample-content {
            background: #1e1e1e;
            color: #d4d4d4;
        }
        body.dark-mode .section-body blockquote {
            background: #2d2d2d;
            color: #bbb;
            border-left-color: #569cd6;
        }
        body.dark-mode .section-body th {
            background: #2d2d2d;
            color: #eee;
        }
        body.dark-mode .section-body td, body.dark-mode .section-body th {
            border-color: #333;
        }
        body.dark-mode .katex-display {
            background: #2d2d2d;
            border-left-color: #569cd6;
        }
        
        /* Code Block Background for Light Mode */
        body:not(.dark-mode) pre.code-block,
        body:not(.dark-mode) .code-lang-label {
            background: #ffffff;
            border: 1px solid #eee;
        }
        body:not(.dark-mode) .code-lang-label {
            border-bottom: none;
            color: #666;
        }
        body:not(.dark-mode) pre.code-block {
            color: #333;
        }
        body:not(.dark-mode) .code-block .hljs {
            color: #333 !important;
        }
        
        body.dark-mode pre.code-block,
        body.dark-mode .code-lang-label {
            background: #1e1e1e;
            border: 1px solid #333;
        }
        body.dark-mode .code-lang-label {
            border-bottom: 1px solid #333;
            color: #aaa;
        }
        body.dark-mode .code-block .hljs {
            color: #d4d4d4 !important;
        }

        .sidebar {
            display: flex;
            flex-direction: column;
            gap: 20px;
        }
        .side-card {
            background: #fff;
            padding: 15px;
            border-radius: 4px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            transition: background 0.3s, color 0.3s;
        }
        .side-title {
            font-size: 15px;
            font-weight: 600;
            margin-bottom: 12px;
            padding-bottom: 8px;
            border-bottom: 1px solid #eee;
            transition: border-color 0.3s;
        }
        
        /* Tag Styles */
        .tags-list {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
        }
        .tag-item {
            display: inline-block;
            padding: 2px 10px;
            background: #f0f0f0;
            color: #666;
            border-radius: 100px;
            font-size: 12px;
            transition: all 0.2s;
        }
        body.dark-mode .tag-item {
            background: #333;
            color: #aaa;
        }
        .side-row {
            display: flex;
            justify-content: space-between;
            font-size: 14px;
            margin-bottom: 8px;
        }
        .side-label { color: #666; }
        .side-value { font-weight: 500; }
        
        /* IDE Mode Link */
        .ide-link-bar {
            display: flex;
            justify-content: flex-end;
            gap: 15px;
            font-size: 13px;
            color: #3498db;
            margin-bottom: 15px;
        }
        .ide-link {
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .ide-link:hover { text-decoration: none; opacity: 0.8; }
        
        /* Sample Actions */
        .sample-actions {
            display: flex;
            gap: 8px;
        }
        .sample-action-btn {
            cursor: pointer;
            color: #3498db;
            font-weight: 500;
            font-size: 12px;
            padding: 2px 6px;
            border-radius: 3px;
            transition: all 0.2s;
        }
        .sample-action-btn:hover {
            background: rgba(52, 152, 219, 0.1);
        }
        .sample-action-btn.disabled {
            color: #999;
            cursor: not-allowed;
            pointer-events: none;
            opacity: 0.5;
        }

        .section {
            margin-bottom: 25px;
        }
        .section-title {
            font-size: 18px;
            font-weight: 600;
            margin-bottom: 12px;
            color: #333;
        }
        .section-body {
            font-size: 14px;
            color: #444;
            line-height: 1.8;
        }
        .section-body p { margin-bottom: 10px; }
        
        /* Markdown 样式 */
        .section-body strong { font-weight: 600; color: #222; }
        .section-body em { font-style: normal; font-weight: 600; color: #444; }
        .section-body code {
            background: #f5f7fa;
            padding: 2px 6px;
            border-radius: 4px;
            font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace;
            font-size: 13px;
            color: #e74c3c;
        }
        
        /* 代码块 - highlight.js 集成 */
        .code-block-wrapper {
            margin: 14px 0;
            border-radius: 10px;
            overflow: hidden;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            position: relative;
        }
        .copy-btn {
            position: absolute;
            top: 32px;
            right: 8px;
            padding: 4px 8px;
            background: rgba(255, 255, 255, 0.1);
            color: #abb2bf;
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 4px;
            font-size: 11px;
            cursor: pointer;
            opacity: 0;
            transition: opacity 0.2s, background 0.2s;
            z-index: 10;
        }
        .code-block-wrapper:hover .copy-btn {
            opacity: 1;
        }
        .copy-btn:hover {
            background: rgba(255, 255, 255, 0.2);
            color: #fff;
        }
        body:not(.dark-mode) .copy-btn {
            background: rgba(0, 0, 0, 0.05);
            color: #666;
            border-color: rgba(0, 0, 0, 0.1);
        }
        body:not(.dark-mode) .copy-btn:hover {
            background: rgba(0, 0, 0, 0.1);
            color: #333;
        }
        .code-lang-label {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 6px 16px;
            background: #282c34;
            font-size: 11px;
            color: #abb2bf;
            text-transform: uppercase;
            letter-spacing: 1px;
            border-bottom: 1px solid #21252b;
        }
        .code-lang-name {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .code-lang-dot {
            width: 8px; height: 8px;
            border-radius: 50%;
        }
        .code-lang-dot.c { background:#519aba; }
        .code-lang-dot.cpp { background:#f34b7d; }
        .code-lang-dot.python { background:#3572A5; }
        .code-lang-dot.java { background:#b07219; }
        .code-lang-dot.pascal { background:#e3d85a; }
        .code-lang-dot.javascript { background:#f1e05a; }
        .code-lang-dot.rust { background:#dea584; }
        .code-lang-dot.go { background:#00ADD8; }
        .code-lang-dot.ruby { background:#701516; }
        .code-lang-dot.default { background:#888; }
        pre.code-block {
            padding: 18px 22px;
            background: #282c34;
            color: #abb2bf;
            font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, monospace;
            font-size: 13.5px;
            overflow-x: auto;
            white-space: pre-wrap;
            line-height: 1.65;
            margin: 0;
            tab-size: 4;
        }
        /* highlight.js 样式覆盖 */
        .code-block code {
            background: transparent !important;
            color: inherit !important;
            padding: 0 !important;
            font-family: inherit;
        }
        .code-block .hljs,
        .code-block code.hljs {
            background: transparent !important;
            color: #abb2bf !important;
            padding: 0 !important;
        }
        .section-body ul, .section-body ol {
            padding-left: 24px;
            margin: 10px 0;
        }
        .section-body li { margin: 4px 0; }
        .section-body img {
            max-width: 100%;
            border-radius: 8px;
            margin: 12px 0;
            box-shadow: 0 2px 8px rgba(0,0,0,0.05);
        }
        .section-body table {
            width: 100%;
            border-collapse: collapse;
            margin: 16px 0;
        }
        .section-body th, .section-body td {
            border: 1px solid #e8ecf1;
            padding: 10px 14px;
            text-align: left;
        }
        .section-body th {
            background: #f5f7fa;
            font-weight: 600;
        }
        body.dark-mode .section-body th {
            background: #2d2d2d;
            color: #eee;
        }
        body.dark-mode .section-body td, body.dark-mode .section-body th {
            border-color: #333;
        }
        .section-body blockquote {
            border-left: 4px solid #3498db;
            background: #f8f9fa;
            padding: 12px 18px;
            margin: 12px 0;
            border-radius: 0 8px 8px 0;
            color: #555;
        }
        .section-body a {
            color: #3498db;
            text-decoration: none;
            border-bottom: 1px solid transparent;
            transition: border-color 0.2s;
        }
        .section-body a:hover {
            border-bottom-color: #3498db;
        }
        .section-body hr {
            border: none;
            height: 2px;
            background: linear-gradient(to right, #3498db, #1abc9c);
            margin: 24px 0;
            border-radius: 2px;
        }
        .section-body h1, .section-body h2, .section-body h3, .section-body h4, .section-body h5, .section-body h6 {
            color: #2c3e50;
            margin-top: 24px;
            margin-bottom: 12px;
            font-weight: 600;
        }
        .section-body h1 { font-size: 22px; border-bottom: 2px solid #eee; padding-bottom: 8px; }
        .section-body h2 { font-size: 19px; border-bottom: 1px solid #eee; padding-bottom: 6px; }
        .section-body h3 { font-size: 17px; }
        .section-body h4 { font-size: 15px; }
        
        /* KaTeX 公式样式 */
        .katex-display {
            margin: 16px 0;
            overflow-x: auto;
            padding: 12px;
            background: #fafbfc;
            border-radius: 8px;
            border-left: 3px solid #3498db;
        }
        .katex { font-size: 1.05em; }
        
        /* Samples */
        .sample-group {
            margin-bottom: 16px;
        }
        .sample-header {
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 10px;
            color: #3498db;
        }
        .sample-pair {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 16px;
        }
        .sample-block {
            border: 1px solid #e8ecf1;
            border-radius: 8px;
            overflow: hidden;
        }
        .sample-label {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            padding: 6px 12px;
            background: #f5f7fa;
            border-bottom: 1px solid #e8ecf1;
            color: #888;
        }
        .sample-actions {
            display: flex;
            gap: 8px;
        }
        .sample-action-btn {
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 10px;
            cursor: pointer;
            background: #fff;
            border: 1px solid #e0e0e0;
            color: #666;
            transition: all 0.2s;
            text-transform: none;
            user-select: none;
        }
        .sample-action-btn:hover {
            border-color: #52c41a;
            color: #52c41a;
        }
        .sample-action-btn.run-btn {
            background: #f6ffed;
            border-color: #b7eb8f;
            color: #52c41a;
        }
        .sample-action-btn.run-btn:hover {
            background: #52c41a;
            color: #fff;
        }
        .sample-action-btn.disabled {
            opacity: 0.5;
            cursor: not-allowed;
            pointer-events: none;
            background: #f5f5f5 !important;
            border-color: #d9d9d9 !important;
            color: #bfbfbf !important;
        }
        .sample-content {
            padding: 12px 14px;
            font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace;
            font-size: 13px;
            white-space: pre-wrap;
            word-break: break-all;
            background: #fafbfc;
            margin: 0;
            line-height: 1.6;
        }
        
        @media (max-width: 768px) {
            .sample-pair { grid-template-columns: 1fr; }
            .header-meta { flex-direction: column; align-items: flex-start; }
        }
    </style>
</head>
<body>
    <div class="banner">
        <div class="banner-content">
            <div class="banner-left">
                <h1>${escapeHtml(problem.pid)} ${escapeHtml(problem.title)}</h1>
            </div>
            <div class="banner-right">
                <div class="stat-item">
                    <span class="stat-label">提交</span>
                    <span class="stat-value">${formatNumber(problem.totalSubmit)}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">通过</span>
                    <span class="stat-value">${formatNumber(problem.totalAccepted)}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">时间限制</span>
                    <span class="stat-value">${timeLimit}ms</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">内存限制</span>
                    <span class="stat-value">${(memoryLimit / 1024).toFixed(2)}MB</span>
                </div>
            </div>
        </div>
    </div>

    <div class="main-container">
        <div class="main-content">
            <div class="ide-link-bar">
                <span class="ide-link" id="themeToggle">🌓 切换主题</span>
                <span class="ide-link" id="copyMarkdown">复制 Markdown</span>
                <span class="ide-link" id="expandToggle">展开</span>
                <span class="ide-link">中文</span>
                <span class="ide-link" id="openIDE">▶ 进入 IDE 模式</span>
                <span class="ide-link" id="exitIDE" style="display:none; color:#e74c3c;">✖ 退出 IDE 模式</span>
            </div>

            ${problem.background ? `
            <div class="section">
                <div class="section-title">题目背景</div>
                <div class="section-body">${renderMarkdown(problem.background)}</div>
            </div>` : ''}

            <div class="section">
                <div class="section-title">题目描述</div>
                <div class="section-body">${renderMarkdown(problem.description)}</div>
            </div>

            <div class="section">
                <div class="section-title">输入格式</div>
                <div class="section-body">${renderMarkdown(problem.inputFormat)}</div>
            </div>

            <div class="section">
                <div class="section-title">输出格式</div>
                <div class="section-body">${renderMarkdown(problem.outputFormat)}</div>
            </div>

            ${samplesHtml ? `
            <div class="section">
                <div class="section-title">输入输出样例</div>
                ${samplesHtml}
            </div>` : ''}

            ${problem.hint ? `
            <div class="section">
                <div class="section-title">说明/提示</div>
                <div class="section-body">${renderMarkdown(problem.hint)}</div>
            </div>` : ''}
        </div>

        <div class="sidebar">
            <div class="side-card">
                <div class="side-title">题目信息</div>
                <div class="side-row">
                    <span class="side-label">题目编号</span>
                    <span class="side-value">${escapeHtml(problem.pid)}</span>
                </div>
                <div class="side-row">
                    <span class="side-label">提供者</span>
                    <span class="side-value" style="color:#9b59b6;">${escapeHtml(problem.provider?.name || '洛谷')}</span>
                </div>
                <div class="side-row">
                    <span class="side-label">难度</span>
                    <span class="side-value" style="color:${diffInfo.color}">${diffInfo.label}</span>
                </div>
                <div class="side-row">
                    <span class="side-label">历史分数</span>
                    <span class="side-value" style="color:#2ecc71;">100</span>
                </div>
            </div>

            <div class="side-card">
                <div class="side-title">标签</div>
                ${tagsHtml || '<div style="color:#999;font-size:13px;">暂无标签</div>'}
            </div>
        </div>
    </div>

    <!-- KaTeX JS -->
    <script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script>
    
    <!-- Highlight.js for code highlighting -->
    <script src="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/core.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/languages/c.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/languages/cpp.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/languages/python.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/languages/java.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/languages/pascal.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/languages/javascript.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/languages/rust.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/languages/go.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/languages/ruby.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/languages/haskell.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/languages/scala.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/languages/perl.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/languages/php.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/languages/kotlin.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/languages/csharp.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/languages/lua.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/languages/julia.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/languages/ocaml.min.js"></script>
    
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        
        // Open IDE
        document.getElementById('openIDE').addEventListener('click', () => {
            document.body.classList.add('minimal-mode');
            document.getElementById('openIDE').style.display = 'none';
            document.getElementById('exitIDE').style.display = 'inline-flex';
            vscode.postMessage({ type: 'openIDE' });
        });

        // Copy Markdown
        document.getElementById('copyMarkdown').addEventListener('click', () => {
            vscode.postMessage({ type: 'copyMarkdown' });
        });

        // Exit IDE
        document.getElementById('exitIDE').addEventListener('click', () => {
            document.body.classList.remove('minimal-mode');
            document.getElementById('openIDE').style.display = 'inline-flex';
            document.getElementById('exitIDE').style.display = 'none';
            vscode.postMessage({ type: 'exitIDE' });
        });

        // Expand/Collapse Sidebar
        document.getElementById('expandToggle').addEventListener('click', () => {
            document.body.classList.toggle('expanded-mode');
            const isExpanded = document.body.classList.contains('expanded-mode');
            document.getElementById('expandToggle').innerText = isExpanded ? '折叠' : '展开';
        });

        // Sample Actions
        document.querySelectorAll('.copy-sample-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const targetId = btn.getAttribute('data-target');
                const text = document.getElementById(targetId).innerText;
                if (navigator.clipboard) {
                    navigator.clipboard.writeText(text).then(() => {
                        const oldText = btn.innerText;
                        btn.innerText = '已复制';
                        setTimeout(() => { btn.innerText = oldText; }, 2000);
                    });
                }
            });
        });

        document.querySelectorAll('.run-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const index = parseInt(btn.getAttribute('data-index'));
                const input = document.getElementById(\`sample-input-\${index}\`).innerText;
                const output = document.getElementById(\`sample-output-\${index}\`).innerText;
                
                // Disable all run buttons
                document.querySelectorAll('.run-btn').forEach(b => b.classList.add('disabled'));
                
                vscode.postMessage({ 
                    type: 'runSample',
                    pid: '${problem.pid}',
                    input: input,
                    output: output
                });
            });
        });

        // Listen for messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'updateRunningState') {
                if (!message.running) {
                    document.querySelectorAll('.run-btn').forEach(b => b.classList.remove('disabled'));
                }
            } else if (message.type === 'exitMinimalMode') {
                document.body.classList.remove('minimal-mode');
                document.getElementById('openIDE').style.display = 'inline-flex';
                document.getElementById('exitIDE').style.display = 'none';
            }
        });

        // Theme Toggle
        document.getElementById('themeToggle').addEventListener('click', () => {
            document.body.classList.toggle('dark-mode');
            const isDark = document.body.classList.contains('dark-mode');
            // Update highlight.js theme if needed
            const hlLink = document.querySelector('link[href*="highlight.js"]');
            if (hlLink) {
                hlLink.setAttribute('href', isDark 
                    ? 'https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/atom-one-dark.min.css'
                    : 'https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css');
            }
        });

        // 代码高亮 - 包装代码块并应用 highlight.js
        function initCodeHighlight() {
            const codeBlocks = document.querySelectorAll('pre code');
            codeBlocks.forEach(function(codeEl) {
                var block = codeEl.parentNode;
                if (block.parentNode.classList.contains('code-block-wrapper')) return; // Already wrapped
                
                var langClass = Array.from(codeEl.classList).find(c => c.startsWith('language-'));
                var lang = langClass ? langClass.replace('language-', '') : 'plaintext';
                
                block.className = 'code-block';
                block.setAttribute('data-lang', lang);
                
                // 语言映射
                var langMap = {
                    'c': 'c', 'cpp': 'cpp', 'cc': 'cpp',
                    'python': 'python', 'py': 'python',
                    'java': 'java',
                    'pascal': 'pascal', 'pas': 'pascal',
                    'javascript': 'javascript', 'js': 'javascript',
                    'rust': 'rust',
                    'go': 'go',
                    'ruby': 'ruby',
                    'haskell': 'haskell', 'hs': 'haskell',
                    'scala': 'scala',
                    'perl': 'perl', 'pl': 'perl',
                    'php': 'php',
                    'kotlin': 'kotlin', 'kt': 'kotlin',
                    'csharp': 'csharp', 'cs': 'csharp',
                    'lua': 'lua',
                    'julia': 'julia', 'jl': 'julia',
                    'ocaml': 'ocaml'
                };
                var hlLang = langMap[lang.toLowerCase()] || 'plaintext';
                
                // 包装代码块
                var wrapper = document.createElement('div');
                wrapper.className = 'code-block-wrapper';
                
                // 创建语言标签
                var langLabel = document.createElement('div');
                langLabel.className = 'code-lang-label';
                var dotClass = langMap[lang.toLowerCase()] ? lang : 'default';
                langLabel.innerHTML = '<span class="code-lang-name"><span class="code-lang-dot ' + dotClass + '"></span>' + (lang || 'Code') + '</span>';
                
                block.parentNode.insertBefore(wrapper, block);
                wrapper.appendChild(langLabel);
                wrapper.appendChild(block);

                // 创建复制按钮
                var copyBtn = document.createElement('button');
                copyBtn.className = 'copy-btn';
                copyBtn.innerText = '复制';
                copyBtn.onclick = function() {
                    var text = codeEl.innerText;
                    // 使用 navigator.clipboard 兼容性更好
                    if (navigator.clipboard) {
                        navigator.clipboard.writeText(text).then(function() {
                            copyBtn.innerText = '已复制';
                            setTimeout(function() { copyBtn.innerText = '复制'; }, 2000);
                        });
                    } else {
                        // 回退方案
                        var textArea = document.createElement("textarea");
                        textArea.value = text;
                        document.body.appendChild(textArea);
                        textArea.select();
                        document.execCommand("copy");
                        document.body.removeChild(textArea);
                        copyBtn.innerText = '已复制';
                        setTimeout(function() { copyBtn.innerText = '复制'; }, 2000);
                    }
                };
                wrapper.appendChild(copyBtn);
            });
        }

        // 渲染数学公式和代码高亮
        function renderAll() {
            // 代码高亮
            initCodeHighlight();
            
            // 数学公式
            if (typeof renderMathInElement !== 'undefined') {
                renderMathInElement(document.body, {
                    delimiters: [
                        {left: '$$', right: '$$', display: true},
                        {left: '$', right: '$', display: false},
                        {left: '\\[', right: '\\]', display: true},
                        {left: '\\(', right: '\\)', display: false}
                    ],
                    throwOnError: false
                });
            }
        }
        
        document.addEventListener('DOMContentLoaded', renderAll);
        
        // 确保渲染完成（延迟执行）
        setTimeout(renderAll, 300);
        setTimeout(renderAll, 800);
    </script>
</body>
</html>`;
    }
}

function renderMarkdown(text: string | undefined | null): string {
    if (!text) { return ''; }
    
    // Pre-process math blocks to prevent markdown-it from messing them up
    // Use a unique placeholder that won't be parsed by markdown-it
    const mathBlocks: string[] = [];
    let processedText = text.replace(/\$\$([\s\S]*?)\$\$/g, (match) => {
        mathBlocks.push(match);
        return `MATHBLOCKPLACEHOLDER${mathBlocks.length - 1}X`;
    });
    
    processedText = processedText.replace(/\$([^$\n]+?)\$/g, (match) => {
        mathBlocks.push(match);
        return `MATHINLINEPLACEHOLDER${mathBlocks.length - 1}X`;
    });

    let html = md.render(processedText);
    
    // Restore math blocks
    html = html.replace(/MATHBLOCKPLACEHOLDER(\d+)X/g, (match: string, index: string) => {
        return mathBlocks[parseInt(index)];
    });
    
    html = html.replace(/MATHINLINEPLACEHOLDER(\d+)X/g, (match: string, index: string) => {
        return mathBlocks[parseInt(index)];
    });
    
    return html;
}

function escapeHtml(text: string | undefined | null): string {
    if (!text) { return ''; }
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatNumber(n: number): string {
    if (n >= 1000000) { return (n / 1000000).toFixed(2) + 'M'; }
    if (n >= 1000) { return (n / 1000).toFixed(1) + 'k'; }
    return String(n);
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
