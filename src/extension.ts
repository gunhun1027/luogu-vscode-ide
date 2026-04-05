import * as vscode from 'vscode';
import { SidebarProvider } from './sidebarProvider';
import { ProblemViewProvider } from './problemViewProvider';
import { IDEProvider } from './ideProvider';
import { BrowserProvider } from './browserProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('洛谷 IDE 插件已激活');

    // Create providers
    const sidebarProvider = new SidebarProvider(context.extensionUri);
    const problemViewProvider = new ProblemViewProvider(context.extensionUri);
    const ideProvider = new IDEProvider(context.extensionUri);
    const browserProvider = new BrowserProvider(context.extensionUri);

    // Register sidebar webview
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            SidebarProvider.viewType,
            sidebarProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('luogu.openProblem', (pid: string) => {
            problemViewProvider.openProblem(pid);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('luogu.runSample', (data: any) => {
            ideProvider.runCustomSample(data.pid, data.input, data.output);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('luogu.setRunningState', (running: boolean) => {
            ProblemViewProvider.broadcastRunningState(running);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('luogu.openIDE', (problemInfo: any) => {
            ideProvider.openIDE(problemInfo);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('luogu.closeIDE', () => {
            ideProvider.closeIDE();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('luogu.refreshProblemList', () => {
            sidebarProvider.refresh();
        })
    );

    // New: open Luogu website browser
    context.subscriptions.push(
        vscode.commands.registerCommand('luogu.openBrowser', (url?: string) => {
            browserProvider.openBrowser(url);
        })
    );

    // New: open settings
    context.subscriptions.push(
        vscode.commands.registerCommand('luogu.openSettings', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', '@ext:luogu-ide.luogu-vscode-ide');
        })
    );
}

export function deactivate() {
    console.log('洛谷 IDE 插件已停用');
}
