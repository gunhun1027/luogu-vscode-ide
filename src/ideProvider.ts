import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { exec, spawn } from 'child_process';
import { LuoguSample } from './luoguApi';

interface ProblemInfo {
    pid: string;
    title: string;
    samples: LuoguSample[];
    timeLimit: number;
    memoryLimit: number;
}

function getLanguageConfig(): Record<string, {
    label: string;
    ext: string;
    compileCmd?: string;
    runCmd: string;
    template: string;
}> {
    const cfg = vscode.workspace.getConfiguration('luogu');
    const cppCompiler = cfg.get<string>('cppCompiler', 'g++');
    const cCompiler = cfg.get<string>('cCompiler', 'gcc');
    const pythonPath = cfg.get<string>('pythonPath', 'python');
    const cppStd = cfg.get<string>('cppStandard', 'c++14');
    const compileArgs = cfg.get<string>('compileArgs', '-O2');

    return {
        c: {
            label: 'C',
            ext: '.c',
            compileCmd: cCompiler + ' -o "{out}" "{src}" ' + compileArgs,
            runCmd: '"{out}"',
            template: '#include <stdio.h>\n\nint main() {\n    \n    return 0;\n}\n',
        },
        cpp: {
            label: 'C++',
            ext: '.cpp',
            compileCmd: cppCompiler + ' -o "{out}" "{src}" ' + compileArgs + ' -std=' + cppStd,
            runCmd: '"{out}"',
            template: '#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    \n    return 0;\n}\n',
        },
        java: {
            label: 'Java',
            ext: '.java',
            compileCmd: 'javac "{src}"',
            runCmd: 'java -cp "{dir}" Main',
            template: 'import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        Scanner sc = new Scanner(System.in);\n        \n    }\n}\n',
        },
        python3: {
            label: 'Python 3',
            ext: '.py',
            runCmd: pythonPath + ' "{src}"',
            template: 'import sys\ninput = sys.stdin.readline\n\n',
        },
        pascal: {
            label: 'Pascal',
            ext: '.pas',
            compileCmd: 'fpc -O2 "{src}"',
            runCmd: '"{out}"',
            template: 'program main;\nvar\n\nbegin\n\nend.\n',
        },
    };
}

const LANGUAGE_CONFIG = getLanguageConfig();

export class IDEProvider {
    private static _panel: vscode.WebviewPanel | undefined;
    private static _currentProblem: ProblemInfo | undefined;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public closeIDE() {
        if (IDEProvider._panel) {
            IDEProvider._panel.dispose();
            IDEProvider._panel = undefined;
        }
    }

    public openIDE(problemInfo: ProblemInfo) {
        IDEProvider._currentProblem = problemInfo;

        if (IDEProvider._panel) {
            IDEProvider._panel.reveal(vscode.ViewColumn.Two);
            IDEProvider._panel.webview.postMessage({
                type: 'loadProblem',
                problem: problemInfo,
            });
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'luoguIDE',
            `IDE - ${problemInfo.pid}`,
            vscode.ViewColumn.Two,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [this._extensionUri],
            }
        );

        panel.iconPath = new vscode.ThemeIcon('code');
        IDEProvider._panel = panel;

        panel.onDidDispose(() => {
            IDEProvider._panel = undefined;
        });

        panel.webview.html = this._getIDEHtml(panel.webview, problemInfo);

        panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'submitCode':
                    vscode.window.showInformationMessage(`提交代码 (PID: ${msg.pid}): 功能开发中...`);
                    break;
                case 'runCode':
                    await this._runCode(panel, msg.language, msg.code, msg.sampleIndex);
                    break;
                case 'runAllSamples':
                    await this._runAllSamples(panel, msg.language, msg.code);
                    break;
                case 'saveCode':
                    await this._saveCode(msg.language, msg.code, msg.pid);
                    break;
            }
        });
    }

    public runCustomSample(pid: string, input: string, output: string) {
        if (IDEProvider._panel && IDEProvider._currentProblem?.pid === pid) {
            IDEProvider._panel.reveal(vscode.ViewColumn.Two);
            IDEProvider._panel.webview.postMessage({
                type: 'runCustomSample',
                input,
                output
            });
        } else {
            vscode.window.showWarningMessage('请先进入该题目的 IDE 模式');
        }
    }

    private async _runCode(
        panel: vscode.WebviewPanel,
        language: string,
        code: string,
        sampleIndex: number
    ) {
        if (!IDEProvider._currentProblem) { return; }
        const problem = IDEProvider._currentProblem;
        const sample = problem.samples[sampleIndex];
        if (!sample) { return; }

        const config = LANGUAGE_CONFIG[language];
        if (!config) { return; }

        const tmpDir = path.join(os.tmpdir(), 'luogu-ide');
        if (!fs.existsSync(tmpDir)) { fs.mkdirSync(tmpDir, { recursive: true }); }

        const srcFile = path.join(tmpDir, `solution${config.ext}`);
        const outFile = path.join(tmpDir, language === 'java' ? 'Main' : 'solution' + (os.platform() === 'win32' ? '.exe' : ''));

        fs.writeFileSync(srcFile, code, 'utf-8');

        vscode.commands.executeCommand('luogu.setRunningState', true);

        panel.webview.postMessage({
            type: 'runStatus',
            sampleIndex,
            status: 'compiling',
            message: '编译中...',
        });

        try {
            // Compile if needed
            if (config.compileCmd) {
                const compileCmd = config.compileCmd
                    .replace(/\{src\}/g, srcFile)
                    .replace(/\{out\}/g, outFile)
                    .replace(/\{dir\}/g, tmpDir);

                await this._execCommand(compileCmd, tmpDir, problem.timeLimit * 2);
            }

            panel.webview.postMessage({
                type: 'runStatus',
                sampleIndex,
                status: 'running',
                message: '运行中...',
            });

            // Run
            const runCmd = config.runCmd
                .replace(/\{src\}/g, srcFile)
                .replace(/\{out\}/g, outFile)
                .replace(/\{dir\}/g, tmpDir);

            const startTime = Date.now();
            const result = await this._execCommandWithInput(runCmd, sample.input, tmpDir, problem.timeLimit);
            const elapsed = Date.now() - startTime;

            // Compare output
            const actualOutput = result.stdout.replace(/\r\n/g, '\n').trim();
            const expectedOutput = sample.output.replace(/\r\n/g, '\n').trim();

            let verdict = 'AC';
            let verdictColor = '#52c41a';
            if (actualOutput !== expectedOutput) {
                verdict = 'WA';
                verdictColor = '#fe4c61';
            }
            if (elapsed > problem.timeLimit) {
                verdict = 'TLE';
                verdictColor = '#3498db';
            }

            panel.webview.postMessage({
                type: 'runResult',
                sampleIndex,
                verdict,
                verdictColor,
                actualOutput: result.stdout,
                expectedOutput: sample.output,
                time: elapsed,
                stderr: result.stderr,
            });
        } catch (err: any) {
            let verdict = 'RE';
            let verdictColor = '#9d3dcf';
            let message = err.message || '运行错误';

            if (err.killed || message.includes('timeout') || message.includes('TIMEOUT')) {
                verdict = 'TLE';
                verdictColor = '#3498db';
                message = `超时 (>${IDEProvider._currentProblem.timeLimit}ms)`;
            } else if (message.includes('compile') || message.includes('error:')) {
                verdict = 'CE';
                verdictColor = '#f39c11';
            }

            panel.webview.postMessage({
                type: 'runResult',
                sampleIndex,
                verdict,
                verdictColor,
                actualOutput: '',
                expectedOutput: sample?.output || '',
                time: 0,
                stderr: message,
            });
        } finally {
            vscode.commands.executeCommand('luogu.setRunningState', false);
        }
    }

    private async _runAllSamples(
        panel: vscode.WebviewPanel,
        language: string,
        code: string
    ) {
        if (!IDEProvider._currentProblem) { return; }
        for (let i = 0; i < IDEProvider._currentProblem.samples.length; i++) {
            await this._runCode(panel, language, code, i);
        }
    }

    private async _saveCode(language: string, code: string, pid: string) {
        const config = LANGUAGE_CONFIG[language];
        if (!config) { return; }

        const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        const uri = await vscode.window.showSaveDialog({
            defaultUri: defaultUri ? vscode.Uri.joinPath(defaultUri, `${pid}${config.ext}`) : undefined,
            filters: { '源代码': [config.ext.substring(1)] },
        });
        if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(code, 'utf-8'));
            vscode.window.showInformationMessage(`代码已保存到 ${uri.fsPath}`);
        }
    }

    private _execCommand(cmd: string, cwd: string, timeout: number): Promise<{ stdout: string; stderr: string }> {
        return new Promise((resolve, reject) => {
            const isWin = os.platform() === 'win32';
            
            if (isWin) {
                // Windows: use spawn with shell for better path resolution
                const child = spawn('cmd', ['/c', cmd], {
                    cwd,
                    timeout: timeout + 5000,
                    shell: true,
                    windowsHide: true,
                });
                
                let stdout = '';
                let stderr = '';
                
                child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
                child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
                
                child.on('close', (code) => {
                    if (code !== 0) {
                        reject(new Error(`compile error:\n${stderr || '编译失败 (exit code: ' + code + ')'}`));
                    } else {
                        resolve({ stdout, stderr });
                    }
                });
                
                child.on('error', (err) => {
                    reject(new Error(`compile error:\n无法启动编译器: ${err.message}\n请确保 g++/gcc 已安装并添加到系统 PATH 中`));
                });
            } else {
                exec(cmd, { cwd, timeout }, (error, stdout, stderr) => {
                    if (error) {
                        reject(new Error(`compile error:\n${stderr || error.message}`));
                    } else {
                        resolve({ stdout, stderr });
                    }
                });
            }
        });
    }

    private _execCommandWithInput(cmd: string, input: string, cwd: string, timeout: number): Promise<{ stdout: string; stderr: string }> {
        return new Promise((resolve, reject) => {
            const isWin = os.platform() === 'win32';
            
            if (isWin) {
                // Windows: use spawn with shell
                const child = spawn('cmd', ['/c', cmd], {
                    cwd,
                    timeout: timeout + 2000,
                    shell: true,
                    windowsHide: true,
                });
                
                let stdout = '';
                let stderr = '';
                let killed = false;
                
                child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
                child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
                
                const timer = setTimeout(() => {
                    killed = true;
                    child.kill();
                }, timeout);
                
                child.on('close', (code) => {
                    clearTimeout(timer);
                    if (killed) {
                        reject(new Error('TIMEOUT'));
                    } else if (code && code !== 0) {
                        reject(new Error(stderr || `运行失败 (exit code: ${code})`));
                    } else {
                        resolve({ stdout, stderr });
                    }
                });
                
                child.on('error', (err) => {
                    clearTimeout(timer);
                    reject(new Error(`运行错误: ${err.message}`));
                });
                
                if (child.stdin) {
                    child.stdin.write(input);
                    child.stdin.end();
                }
            } else {
                const child = exec(cmd, { cwd, timeout }, (error, out, err) => {
                    if (error && error.killed) {
                        reject(new Error('TIMEOUT'));
                    } else if (error) {
                        reject(new Error(err || error.message));
                    } else {
                        resolve({ stdout: out, stderr: err });
                    }
                });
                if (child.stdin) {
                    child.stdin.write(input);
                    child.stdin.end();
                }
            }
        });
    }

    private _getIDEHtml(webview: vscode.Webview, problem: ProblemInfo): string {
        const nonce = getNonce();
        const defaultLang = vscode.workspace.getConfiguration('luogu').get<string>('defaultLanguage', 'cpp');

        const langOptions = Object.entries(LANGUAGE_CONFIG)
            .map(([key, val]) => `<option value="${key}" ${key === defaultLang ? 'selected' : ''}>${val.label}</option>`)
            .join('');

        const defaultTemplate = LANGUAGE_CONFIG[defaultLang]?.template || '';

        // Build sample tabs and panels for bottom IO area
        let sampleTabs = '';
        let samplePanels = '';
        problem.samples.forEach((s, i) => {
            sampleTabs += `<button class="io-tab ${i === 0 ? 'active' : ''}" data-idx="${i}">样例 #${i + 1}</button>`;
            samplePanels += `
            <div class="io-panel ${i === 0 ? 'active' : ''}" data-idx="${i}">
                <div class="io-grid">
                    <div class="io-col io-col-input">
                        <div class="io-label">
                            <svg class="io-label-icon" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                            输入
                        </div>
                        <button class="ide-run-btn run-sample-btn" data-idx="${i}">
                            <svg class="ide-run-icon" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                            运行
                        </button>
                        <textarea class="io-textarea input-area" id="input-${i}" spellcheck="false" placeholder="输入数据...">${escapeHtml(s.input)}</textarea>
                    </div>
                    <div class="io-resizer"></div>
                    <div class="io-col io-col-output">
                        <div class="io-label">
                            <svg class="io-label-icon" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                            输出
                        </div>
                        <div class="output-badge-container" id="result-badge-${i}"></div>
                        <textarea class="io-textarea output-area" id="output-${i}" readonly placeholder="运行结果..."></textarea>
                    </div>
                </div>
            </div>`;
        });

        return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https://cdn.jsdelivr.net; script-src ${webview.cspSource} 'unsafe-inline' https://cdn.jsdelivr.net data: blob:; font-src ${webview.cspSource} https://fonts.googleapis.com https://cdn.jsdelivr.net; img-src ${webview.cspSource} https: data:; worker-src blob: data:;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        :root {
            --bg-primary: #ffffff;
            --bg-secondary: #f5f7fa;
            --bg-tertiary: #fafbfc;
            --bg-code: #fff;
            --text-primary: #303133;
            --text-secondary: #606266;
            --text-tertiary: #909399;
            --border-color: #e4e7ed;
            --border-light: #ebeef5;
            --accent: #3498db;
            --accent-hover: #2980b9;
            --success: #27ae60;
            --success-hover: #2ecc71;
            --line-num-bg: #f0f2f5;
            --line-num-color: #909399;
            --scrollbar-thumb: #c0c4cc;
            --scrollbar-thumb-hover: #909399;
            --shadow: rgba(0,0,0,0.08);
            --code-caret: #3498db;
            --selection-bg: rgba(52,152,219,0.2);
        }
        
        [data-theme="dark"] {
            --bg-primary: #1e1e1e;
            --bg-secondary: #252526;
            --bg-tertiary: #2d2d30;
            --bg-code: #1e1e1e;
            --text-primary: #cccccc;
            --text-secondary: #a0a0a0;
            --text-tertiary: #6a6a6a;
            --border-color: #3c3c3c;
            --border-light: #333333;
            --accent: #569cd6;
            --accent-hover: #478acc;
            --success: #4ec9b0;
            --success-hover: #6ddac3;
            --line-num-bg: #1e1e1e;
            --line-num-color: #5a5a5a;
            --scrollbar-thumb: #424242;
            --scrollbar-thumb-hover: #555555;
            --shadow: rgba(0,0,0,0.3);
            --code-caret: #aeafad;
            --selection-bg: rgba(86,156,214,0.35);
        }

        * { margin:0; padding:0; box-sizing:border-box; }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            color: var(--text-primary);
            background: var(--bg-secondary);
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
            transition: background 0.3s, color 0.3s;
        }

        /* ====== IDE Toolbar (Luogu Style) ====== */
        .ide-toolbar {
            display: flex;
            align-items: center;
            padding: 0 16px;
            height: 44px;
            background: var(--bg-primary);
            border-bottom: 1px solid var(--border-color);
            flex-shrink: 0;
            gap: 8px;
        }
        .toolbar-title {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 14px;
            font-weight: 600;
            color: var(--text-primary);
            margin-right: auto;
        }
        .toolbar-title .code-icon {
            font-size: 14px;
            color: var(--text-secondary);
        }
        
        /* Settings Gear Button */
        .settings-btn {
            width: 30px; height: 30px;
            border: none;
            background: transparent;
            color: var(--text-secondary);
            cursor: pointer;
            border-radius: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s;
            position: relative;
        }
        .settings-btn:hover { background: var(--bg-tertiary); color: var(--accent); }
        
        /* Settings Dropdown */
        .settings-dropdown {
            display: none;
            position: absolute;
            top: 100%;
            left: 0;
            background: var(--bg-primary);
            border-radius: 10px;
            box-shadow: 0 6px 24px var(--shadow);
            padding: 14px 18px;
            z-index: 100;
            min-width: 220px;
            border: 1px solid var(--border-color);
        }
        .settings-dropdown.show { display: block; }
        .setting-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 7px 0;
            gap: 12px;
        }
        .setting-row:not(:last-child) { border-bottom: 1px solid var(--border-light); }
        .setting-label { font-size: 13px; color: var(--text-secondary); white-space: nowrap; }
        .setting-input {
            width: 70px;
            padding: 4px 8px;
            border: 1px solid var(--border-color);
            background: var(--bg-tertiary);
            color: var(--text-primary);
            border-radius: 5px;
            font-size: 12px;
            text-align: right;
            outline: none;
        }
        .setting-input:focus { border-color: var(--accent); }
        .setting-toggle {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 13px;
            color: var(--text-secondary);
            cursor: pointer;
        }
        .toggle-checkbox {
            appearance: none;
            -webkit-appearance: none;
            width: 32px; height: 18px;
            background: var(--border-color);
            border-radius: 9px;
            cursor: pointer;
            position: relative;
            transition: all 0.3s;
            border: none;
        }
        .toggle-checkbox::after {
            content: '';
            position: absolute;
            top: 2px; left: 2px;
            width: 14px; height: 14px;
            background: #fff;
            border-radius: 50%;
            transition: all 0.3s;
            box-shadow: 0 1px 3px rgba(0,0,0,0.3);
        }
        .toggle-checkbox:checked {
            background: var(--accent);
        }
        .toggle-checkbox:checked::after {
            left: 16px;
        }

        /* Language Selector */
        .lang-select-wrapper {
            position: relative;
        }
        .lang-select {
            padding: 5px 28px 5px 12px;
            border: 1px solid var(--border-color);
            background: var(--bg-tertiary);
            color: var(--text-primary);
            border-radius: 6px;
            font-size: 13px;
            outline: none;
            cursor: pointer;
            appearance: none;
            -webkit-appearance: none;
            padding-right: 32px;
        }
        .lang-select:focus { border-color: var(--accent); background: var(--bg-primary); }
        .lang-arrow {
            position: absolute;
            right: 10px;
            top: 50%;
            transform: translateY(-50%);
            pointer-events: none;
            color: var(--text-tertiary);
            font-size: 11px;
        }

        /* O2 Toggle */
        .o2-toggle {
            display: flex;
            align-items: center;
            gap: 5px;
            font-size: 13px;
            color: var(--text-secondary);
            cursor: pointer;
            user-select: none;
            height: 100%;
        }
        .o2-checkbox {
            appearance: none;
            -webkit-appearance: none;
            width: 17px; height: 17px;
            border: 2px solid var(--border-color);
            border-radius: 4px;
            cursor: pointer;
            position: relative;
            transition: all 0.15s;
            margin: 0;
            transform: translateY(-1px);
        }
        .o2-checkbox:checked {
            background: var(--accent);
            border-color: var(--accent);
        }
        /* O2 checkbox checkmark adjustment */
        .o2-checkbox:checked::after {
            content: '✓';
            position: absolute;
            top: 46%; left: 50%;
            transform: translate(-50%, -50%);
            color: #fff;
            font-size: 10px;
            font-weight: bold;
        }

        /* IDE Run Button - Moved to input box */
        .ide-run-btn {
            position: absolute;
            top: 6px;
            right: 12px;
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 4px 10px;
            border: 1px solid var(--success);
            border-radius: 4px;
            background: var(--bg-primary);
            color: var(--success);
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s;
            z-index: 10;
        }
        .ide-run-btn:hover {
            background: var(--bg-tertiary);
            box-shadow: 0 2px 4px var(--shadow);
        }
        .ide-run-icon { width: 14px; height: 14px; }

        /* Submit Button */
        .submit-btn {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 6px 12px;
            border: none;
            background: transparent;
            color: var(--accent);
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s;
        }
        .submit-btn:hover {
            background: var(--bg-tertiary);
            border-radius: 4px;
        }
        .submit-icon { width: 14px; height: 14px; }

        /* ====== Layout Container ====== */
        .layout-container {
            flex: 1;
            display: flex;
            flex-direction: column;
            min-height: 0;
            overflow: hidden;
        }

        /* ====== Code Editor Area (Top) ====== */
        .editor-section {
            flex: 0 0 58%;
            display: flex;
            flex-direction: column;
            min-height: 0;
            background: var(--bg-primary);
            border-bottom: 1px solid var(--border-color);
        }
        .code-editor-wrap {
            flex: 1;
            overflow: hidden;
            position: relative;
        }

        /* Resize Handle between editor and IO */
        .resize-handle {
            height: 4px;
            background: var(--border-color);
            cursor: ns-resize;
            flex-shrink: 0;
            transition: background 0.15s;
        }
        .resize-handle:hover { background: var(--accent); }

        /* ====== IO Section (Bottom) ====== */
        .io-section {
            flex: 1;
            display: flex;
            flex-direction: column;
            min-height: 0;
            background: var(--bg-primary);
            overflow: hidden;
        }
        .io-label {
            display: flex;
            align-items: center;
            gap: 4px;
            font-size: 13px;
            font-weight: 500;
            color: var(--text-secondary);
            padding: 8px 12px;
            background: var(--bg-tertiary);
            border-bottom: 1px solid var(--border-color);
        }
        .io-label-icon { width: 14px; height: 14px; }

        /* Sample Tabs */
        .sample-tabs {
            display: flex;
            padding: 0 16px;
            background: var(--bg-tertiary);
            border-bottom: 1px solid var(--border-color);
            flex-shrink: 0;
            gap: 2px;
        }
        .io-tab {
            padding: 7px 16px;
            font-size: 12px;
            border: none;
            background: transparent;
            color: var(--text-tertiary);
            cursor: pointer;
            position: relative;
            transition: all 0.15s;
            border-radius: 5px 5px 0 0;
        }
        .io-tab.active {
            color: var(--accent);
            background: var(--bg-primary);
            font-weight: 500;
        }
        .io-tab:hover:not(.active) { color: var(--text-secondary); }

        /* IO Content */
        .io-content {
            flex: 1;
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }
        .io-panel {
            display: none;
            flex: 1;
            flex-direction: column;
            min-height: 0;
        }
        .io-panel.active { display: flex; }
        .io-grid {
            flex: 1;
            display: flex;
            flex-direction: row;
            min-height: 0;
        }
        .io-col {
            display: flex;
            flex-direction: column;
            min-width: 0;
            position: relative;
        }
        .io-col-input { flex: 1; }
        .io-col-output { flex: 1; }
        .io-resizer {
            width: 4px;
            background: var(--border-color);
            cursor: col-resize;
            flex-shrink: 0;
            transition: background 0.15s;
            z-index: 10;
        }
        .io-resizer:hover { background: var(--accent); }
        .io-textarea {
            flex: 1;
            width: 100%;
            padding: 12px 14px;
            border: none;
            outline: none;
            resize: none;
            font-family: 'Cascadia Code', Consolas, monospace;
            font-size: 13px;
            line-height: 1.55;
            background: var(--bg-primary);
            color: var(--text-primary);
        }
        .io-textarea.input-area { color: var(--text-primary); }
        .io-textarea.output-area { 
            background: var(--bg-tertiary); 
            color: var(--text-secondary);
        }
        .io-textarea:focus { background: var(--bg-primary); }
        .io-textarea::placeholder { color: var(--text-tertiary); }

        /* Output Badge */
        .output-badge-container {
            position: absolute;
            top: 6px;
            right: 14px;
            display: flex;
            align-items: center;
            gap: 8px;
            z-index: 5;
            pointer-events: none;
        }
        .output-badge {
            padding: 3px 10px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 700;
            color: #fff;
            letter-spacing: 0.5px;
            box-shadow: 0 2px 4px var(--shadow);
        }
        .output-time {
            font-size: 11px;
            color: var(--text-secondary);
            background: var(--bg-primary);
            padding: 2px 6px;
            border-radius: 4px;
            box-shadow: 0 1px 2px var(--shadow);
        }
        .mini-spinner {
            width: 14px; height: 14px;
            border: 2px solid var(--border-color);
            border-top-color: var(--accent);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* Scrollbar styling */
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: var(--scrollbar-thumb-hover); }
    </style>
</head>
<body>
    <!-- IDE Toolbar -->
    <div class="ide-toolbar">
        <span class="toolbar-title">
            <span class="code-icon">&lt;/&gt;</span> 代码
        </span>

        <!-- Theme Toggle -->
        <button class="settings-btn" id="themeToggleBtn" title="切换主题">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
        </button>

        <!-- Settings -->
        <div style="position:relative;">
            <button class="settings-btn" id="settingsBtn" title="设置">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
            </button>
            <div class="settings-dropdown" id="settingsDropdown">
                <div class="setting-row">
                    <span class="setting-label">字体大小</span>
                    <input type="number" class="setting-input" id="settingFontSize" value="14" min="10" max="24"> px
                </div>
                <div class="setting-row">
                    <span class="setting-label">Tab 大小</span>
                    <input type="number" class="setting-input" id="settingTabSize" value="4" min="2" max="8"> 空格
                </div>
                <label class="setting-row setting-toggle">
                    自动补全
                    <input type="checkbox" class="toggle-checkbox" id="settingAutoTab" checked>
                </label>
            </div>
        </div>

        <!-- Language Selector -->
        <div class="lang-select-wrapper">
            <select class="lang-select" id="langSelect">${langOptions}</select>
            <span class="lang-arrow">▼</span>
        </div>

        <!-- O2 Optimization -->
        <label class="o2-toggle">
            <input type="checkbox" class="o2-checkbox" id="o2Check" checked>
            O2
        </label>

        <!-- Submit Button -->
        <button class="submit-btn" id="submitBtn">
            <svg class="submit-icon" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
            提交
        </button>
    </div>

    <!-- Main Layout -->
    <div class="layout-container" id="layoutContainer">

        <!-- Code Editor (Top) -->
        <div class="editor-section" id="editorSection">
            <div class="code-editor-wrap" id="editorContainer"></div>
        </div>

        <!-- Resize Handle -->
        <div class="resize-handle" id="resizeHandle"></div>

        <!-- IO Section (Bottom) -->
        <div class="io-section">
            <!-- Sample Tabs -->
            ${problem.samples.length > 1 ? `<div class="sample-tabs">${sampleTabs}</div>` : ''}

            <!-- IO Content -->
            <div class="io-content">
                ${samplePanels}
            </div>
        </div>
    </div>

    <!-- Monaco Editor -->
    <script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs/loader.js"></script>
    <div id="initialCode" style="display:none;">${escapeHtml(defaultTemplate)}</div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const langSelect = document.getElementById('langSelect');
        const templates = ${JSON.stringify(Object.fromEntries(Object.entries(LANGUAGE_CONFIG).map(([k, v]) => [k, v.template])))};
        const totalSamples = ${problem.samples.length};
        let editor;

        // ===== Monaco Editor Setup =====
        require.config({ paths: { 'vs': 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' }});
        
        window.MonacoEnvironment = {
            getWorkerUrl: function(workerId, label) {
                return \`data:text/javascript;charset=utf-8,\${encodeURIComponent(\`
                    self.MonacoEnvironment = {
                        baseUrl: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/'
                    };
                    importScripts('https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs/base/worker/workerMain.js');\`
                )}\`;
            }
        };

        require(['vs/editor/editor.main'], function() {
            var monacoLangMap = { c: 'c', cpp: 'cpp', cc: 'cpp', python: 'python', python3: 'python', py: 'python',
                java: 'java', pascal: 'pascal', pas: 'pascal', javascript: 'javascript', js: 'javascript' };
            
            var lang = monacoLangMap[langSelect.value] || 'plaintext';
            var initialCode = document.getElementById('initialCode').textContent;

            editor = monaco.editor.create(document.getElementById('editorContainer'), {
                value: initialCode,
                language: lang,
                theme: 'vs', // Light theme by default
                automaticLayout: true,
                minimap: { enabled: false },
                fontSize: parseInt(document.getElementById('settingFontSize').value) || 14,
                tabSize: parseInt(document.getElementById('settingTabSize').value) || 4,
                scrollBeyondLastLine: false,
                roundedSelection: false,
                padding: { top: 16 },
                suggestOnTriggerCharacters: true,
                quickSuggestions: { other: true, comments: false, strings: false },
                wordBasedSuggestions: 'currentDocument'
            });

            // Register basic C++ snippets for autocomplete
            monaco.languages.registerCompletionItemProvider('cpp', {
                provideCompletionItems: function(model, position) {
                    var word = model.getWordUntilPosition(position);
                    var range = {
                        startLineNumber: position.lineNumber,
                        endLineNumber: position.lineNumber,
                        startColumn: word.startColumn,
                        endColumn: word.endColumn
                    };
                    var suggestions = [
                        { label: 'cin', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'cin >> ', range: range },
                        { label: 'cout', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'cout << ', range: range },
                        { label: 'endl', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'endl', range: range },
                        { label: '#include <bits/stdc++.h>', kind: monaco.languages.CompletionItemKind.Snippet, insertText: '#include <bits/stdc++.h>\\n', range: range },
                        { label: '#include <iostream>', kind: monaco.languages.CompletionItemKind.Snippet, insertText: '#include <iostream>\\n', range: range },
                        { label: 'using namespace std;', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'using namespace std;\\n', range: range },
                        { label: 'for', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'for (int \${1:i} = 0; \${1:i} < \${2:n}; \${1:i}++) {\\n\\t$0\\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range: range },
                        { label: 'main', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'int main() {\\n\\t$0\\n\\treturn 0;\\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range: range },
                        { label: 'vector', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'vector<\${1:int}> \${2:v};', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range: range },
                        { label: 'sort', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'sort(\${1:v}.begin(), \${1:v}.end());', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range: range },
                        { label: 'scanf', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'scanf("\${1:%d}", &\${2:n});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range: range },
                        { label: 'printf', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'printf("\${1:%d}\\n", \${2:n});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range: range },
                        { label: 'while', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'while (\${1:condition}) {\\n\\t$0\\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range: range },
                        { label: 'if', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'if (\${1:condition}) {\\n\\t$0\\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range: range },
                        { label: 'else', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'else {\\n\\t$0\\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range: range },
                        { label: 'struct', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'struct \${1:Node} {\\n\\t$0\\n};', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range: range },
                        { label: 'map', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'map<\${1:int}, \${2:int}> \${3:mp};', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range: range },
                        { label: 'set', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'set<\${1:int}> \${2:s};', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range: range },
                        { label: 'priority_queue', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'priority_queue<\${1:int}> \${2:pq};', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range: range }
                    ];
                    return { suggestions: suggestions };
                }
            });

            // Python snippets
            monaco.languages.registerCompletionItemProvider('python', {
                provideCompletionItems: function(model, position) {
                    var word = model.getWordUntilPosition(position);
                    var range = {
                        startLineNumber: position.lineNumber,
                        endLineNumber: position.lineNumber,
                        startColumn: word.startColumn,
                        endColumn: word.endColumn
                    };
                    var suggestions = [
                        { label: 'print', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'print(\${0})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range: range },
                        { label: 'input', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'input()', range: range },
                        { label: 'for', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'for \${1:i} in range(\${2:n}):\\n\\t$0', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range: range },
                        { label: 'if', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'if \${1:condition}:\\n\\t$0', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range: range },
                        { label: 'else', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'else:\\n\\t$0', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range: range },
                        { label: 'def', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'def \${1:func_name}(\${2:params}):\\n\\t$0', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range: range },
                        { label: 'class', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'class \${1:ClassName}:\\n\\tdef __init__(self\${2:, params}):\\n\\t\\t$0', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range: range },
                        { label: 'list', kind: monaco.languages.CompletionItemKind.Snippet, insertText: '[\${1:0} for \${2:i} in range(\${3:n})]', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range: range }
                    ];
                    return { suggestions: suggestions };
                }
            });

            // Ctrl+Enter to run
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, function() {
                doRun();
            });

            // Ctrl+S to save
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, function() {
                vscode.postMessage({ type: 'saveCode', language: langSelect.value, code: editor.getValue(), pid: '${problem.pid}' });
            });

            // Language Change
            langSelect.addEventListener('change', function() {
                var currentCode = editor.getValue().trim();
                var isTemplate = Object.values(templates).some(function(t) { return t.trim() === currentCode; });
                
                var newLang = monacoLangMap[this.value] || 'plaintext';
                monaco.editor.setModelLanguage(editor.getModel(), newLang);

                if (!currentCode || isTemplate) {
                    editor.setValue(templates[this.value] || '');
                }
            });

            // Submit Button
            document.getElementById('submitBtn').addEventListener('click', function() {
                if (!editor) return;
                vscode.postMessage({
                    type: 'submitCode',
                    language: langSelect.value,
                    code: editor.getValue(),
                    pid: '${problem.pid}'
                });
            });

            // Settings change handlers
            document.getElementById('settingFontSize').addEventListener('change', function() {
                editor.updateOptions({ fontSize: parseInt(this.value) });
                document.querySelectorAll('.io-textarea').forEach(function(ta) {
                    ta.style.fontSize = Math.max(11, parseInt(this.value) - 2) + 'px';
                }.bind(this));
            });
            document.getElementById('settingTabSize').addEventListener('change', function() {
                editor.updateOptions({ tabSize: parseInt(this.value) });
            });
            // Theme Toggle
            document.getElementById('themeToggleBtn').addEventListener('click', function() {
                var currentTheme = document.documentElement.getAttribute('data-theme');
                var newTheme = currentTheme === 'light' ? 'dark' : 'light';
                document.documentElement.setAttribute('data-theme', newTheme);
                monaco.editor.setTheme(newTheme === 'dark' ? 'vs-dark' : 'vs');
            });
        });

        // ===== Settings Dropdown - Don't Auto-Close =====
        document.getElementById('settingsBtn').addEventListener('click', function(e) {
            e.stopPropagation();
            var dd = document.getElementById('settingsDropdown');
            dd.classList.toggle('show');
            // Don't close on outside click
        });

        // Settings change handlers - don't close dropdown
        // (FontSize and TabSize handled in Monaco setup)

        // ===== Language Change =====
        // (Handled in Monaco setup)

        // ===== Tab Key Support =====
        var autoTabEnabled = true;
        document.getElementById('settingAutoTab').addEventListener('change', function() { autoTabEnabled = this.checked; });
        
        // ===== Enter Key Auto-Indent =====
        // (Handled natively by Monaco)

        // ===== Autocomplete System =====
        // (Handled natively by Monaco)

        // ===== Sample Tabs =====
        document.querySelectorAll('.io-tab').forEach(function(tab) {
            tab.addEventListener('click', function() {
                document.querySelectorAll('.io-tab').forEach(function(t) { t.classList.remove('active'); });
                document.querySelectorAll('.io-panel').forEach(function(p) { p.classList.remove('active'); });
                tab.classList.add('active');
                document.querySelector('.io-panel[data-idx="' + tab.dataset.idx + '"]').classList.add('active');
            });
        });

        // ===== Run Button =====
        function getCurrentSampleIndex() {
            if (totalSamples <= 1) return 0;
            var panel = document.querySelector('.io-panel.active');
            return panel ? parseInt(panel.dataset.idx) : 0;
        }

        var isRunning = false;
        function doRun(e) {
            if (!editor || isRunning) return;
            isRunning = true;
            
            var idx = getCurrentSampleIndex();
            // If triggered by a specific button, use its index
            if (e && e.currentTarget && e.currentTarget.dataset.idx !== undefined) {
                idx = parseInt(e.currentTarget.dataset.idx);
            }

            var btn = document.querySelector('.run-sample-btn[data-idx="' + idx + '"]');
            if (btn) {
                btn.innerHTML = '<div class="mini-spinner" style="border-top-color:#52c41a;"></div> 运行中...';
                btn.style.opacity = '0.8';
                btn.style.cursor = 'not-allowed';
            }
            
            var badge = document.getElementById('result-badge-' + idx);
            if (badge) badge.innerHTML = '';
            
            vscode.postMessage({
                type: 'runCode',
                language: langSelect.value,
                code: editor.getValue(),
                sampleIndex: idx,
            });
        }

        document.querySelectorAll('.run-sample-btn').forEach(function(btn) {
            btn.addEventListener('click', doRun);
        });

        // (Ctrl+Enter and Ctrl+S handled in Monaco setup)

        // ===== Listen for Results - Output to output box =====
        window.addEventListener('message', function(event) {
            var msg = event.data;
            switch (msg.type) {
                case 'runStatus': {
                    // Handled in doRun
                    break;
                }
                case 'runResult': {
                    isRunning = false;
                    var btn = document.querySelector('.run-sample-btn[data-idx="' + msg.sampleIndex + '"]');
                    if (btn) {
                        btn.innerHTML = '<svg class="ide-run-icon" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> 运行';
                        btn.style.opacity = '1';
                        btn.style.cursor = 'pointer';
                    }
                    
                    // Build output text for the output box
                    var outputText = '';
                    if (msg.actualOutput) {
                        outputText = msg.actualOutput;
                    }
                    if (msg.stderr) {
                        outputText += (outputText ? '\\n' : '') + '[错误] ' + msg.stderr;
                    }

                    // Write to output textarea
                    var outputArea = document.querySelector('#output-' + msg.sampleIndex);
                    if (outputArea) { outputArea.value = outputText; }

                    // Also show verdict badge in result area
                    var badgeContainer = document.getElementById('result-badge-' + msg.sampleIndex);
                    if (badgeContainer) {
                        var html = '';
                        if (msg.verdictColor) {
                            html += '<span class="output-badge" style="background:' + msg.verdictColor + ';">' + msg.verdict + '</span>';
                            if (msg.time > 0) { 
                                html += '<span class="output-time">' + msg.time + 'ms' + (msg.memory ? ' / ' + msg.memory + 'KB' : '') + '</span>'; 
                            }
                        }
                        badgeContainer.innerHTML = html;
                    }

                    // Update tab color
                    var tab = document.querySelector('.io-tab[data-idx="' + msg.sampleIndex + '"]');
                    if (tab) { tab.style.color = msg.verdictColor; tab.style.fontWeight = 'bold'; }
                    break;
                }
                case 'runCustomSample': {
                    var idx = getCurrentSampleIndex();
                    var inputArea = document.getElementById('input-' + idx);
                    if (inputArea) {
                        inputArea.value = msg.input;
                        var outputArea = document.getElementById('output-' + idx);
                        if (outputArea) outputArea.value = '';
                        doRun({ currentTarget: { dataset: { idx: idx } } });
                    }
                    break;
                }
                case 'loadProblem': location.reload(); break;
            }
        });

        function escapeHtml(text) {
            var d = document.createElement('div');
            d.textContent = text;
            return d.innerHTML;
        }

        // ===== Resize Handle =====
        var resizeHandle = document.getElementById('resizeHandle');
        var isResizing = false;

        resizeHandle.addEventListener('mousedown', function(e) {
            isResizing = true;
            document.body.style.cursor = 'ns-resize';
            e.preventDefault();
        });

        document.addEventListener('mousemove', function(e) {
            if (!isResizing) return;
            var rect = document.getElementById('layoutContainer').getBoundingClientRect();
            var h = e.clientY - rect.top - 44;
            if (h > 150 && h < rect.height - 120) {
                document.getElementById('editorSection').style.flex = '0 0 ' + (h / rect.height * 100).toFixed(1) + '%';
            }
        });

        document.addEventListener('mouseup', function() {
            if (isResizing) { 
                isResizing = false; 
                document.body.style.cursor = ''; 
                if (editor) editor.layout();
            }
        });

        // (IO Side Toggle removed as it's a split view)
        // ===== IO Resizer =====
        var ioResizers = document.querySelectorAll('.io-resizer');
        var currentResizer = null;
        var currentInputCol = null;
        var currentOutputCol = null;
        var isIOResizing = false;

        ioResizers.forEach(function(resizer) {
            resizer.addEventListener('mousedown', function(e) {
                isIOResizing = true;
                currentResizer = resizer;
                currentInputCol = resizer.previousElementSibling;
                currentOutputCol = resizer.nextElementSibling;
                document.body.style.cursor = 'col-resize';
                e.preventDefault();
            });
        });

        document.addEventListener('mousemove', function(e) {
            if (isIOResizing && currentInputCol && currentOutputCol) {
                var container = currentInputCol.parentElement;
                var containerRect = container.getBoundingClientRect();
                var newWidth = e.clientX - containerRect.left;
                var percentage = (newWidth / containerRect.width) * 100;
                if (percentage > 10 && percentage < 90) {
                    currentInputCol.style.flex = '0 0 ' + percentage + '%';
                    currentOutputCol.style.flex = '1';
                }
            }
        });

        document.addEventListener('mouseup', function() {
            if (isIOResizing) {
                isIOResizing = false;
                currentResizer = null;
                currentInputCol = null;
                currentOutputCol = null;
                document.body.style.cursor = '';
            }
        });
    </script>
</body>
</html>`;
    }
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

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
