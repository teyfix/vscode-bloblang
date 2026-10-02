import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  commands,
  type ExtensionContext,
  StatusBarAlignment,
  type StatusBarItem,
  ThemeColor,
  WorkspaceEdit,
  window,
  workspace,
} from 'vscode';
import {
  DocumentFormattingRequest,
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  State,
  TransportKind,
} from 'vscode-languageclient/node';
import {
  disposeChannels,
  getClientChannel,
  getServerChannel,
} from './lib/channels';
import { clientLogger } from './lib/logger';
import { downloadLatestServer } from './lib/releases';

let client: LanguageClient | undefined;
let watchers: ReturnType<typeof workspace.createFileSystemWatcher>[] = [];
let restarting: Promise<void> | undefined;
let status: StatusBarItem | undefined;

function showStatus(
  state: 'starting' | 'ready' | 'failed',
  reason?: string,
): void {
  if (!status) return;
  const icon =
    state === 'starting'
      ? 'loading~spin'
      : state === 'ready'
        ? 'check'
        : 'error';
  status.text = `$(${icon}) Bloblang`;
  status.tooltip = `${reason ?? `Bloblang language server ${state}`}\nClick to show language server logs.`;
  status.backgroundColor =
    state === 'failed'
      ? new ThemeColor('statusBarItem.errorBackground')
      : undefined;
  status.show();
}

async function serverCommand(context: ExtensionContext): Promise<string> {
  const configured = workspace
    .getConfiguration('bloblang')
    .get<string>('server.path', '')
    .trim();
  if (configured) {
    const expanded = configured
      .replaceAll('${userHome}', os.homedir())
      .replaceAll(
        '${workspaceFolder}',
        workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
      );
    // A bare command is intentionally resolved through PATH by the child process.
    if (!expanded.includes('/') && !expanded.includes('\\')) return expanded;
    const command = path.isAbsolute(expanded)
      ? expanded
      : path.resolve(
          workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.extensionPath,
          expanded,
        );
    await access(
      command,
      process.platform === 'win32' ? constants.F_OK : constants.X_OK,
    );
    return command;
  }
  return downloadLatestServer(context.globalStorageUri.fsPath);
}

async function stopClient(): Promise<void> {
  const current = client;
  client = undefined;
  try {
    if (current) await current.stop(3000);
  } finally {
    for (const watcher of watchers) watcher.dispose();
    watchers = [];
  }
}

async function startClient(context: ExtensionContext): Promise<void> {
  const logger = clientLogger('Main');
  const command = await serverCommand(context);
  const args = workspace
    .getConfiguration('bloblang')
    .get<string[]>('server.args', []);
  const serverOptions: ServerOptions = {
    command,
    args,
    transport: TransportKind.stdio,
  };
  const fileEvents = [
    workspace.createFileSystemWatcher('**/*.{json,yaml,yml,blobl,bloblang}'),
    workspace.createFileSystemWatcher('**/.bloblangrc.json'),
  ];
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'bloblang' },
      { scheme: 'untitled', language: 'bloblang' },
      ...(workspace
        .getConfiguration('bloblang')
        .get<boolean>('yaml.enabled', true)
        ? [{ scheme: 'file', language: 'yaml' }]
        : []),
    ],
    synchronize: { fileEvents },
    outputChannel: getServerChannel(),
    traceOutputChannel: getClientChannel(),
    progressOnInitialization: false,
  };
  const next = new LanguageClient(
    'bloblang',
    'Bloblang',
    serverOptions,
    clientOptions,
  );
  client = next;
  watchers = fileEvents;
  next.onDidChangeState(({ newState }) => {
    logger.debug('Server state: %s', newState);
    if (client !== next) return;
    if (newState === State.Starting) showStatus('starting');
    if (newState === State.Running) showStatus('ready');
    if (newState === State.Stopped)
      showStatus('failed', 'Bloblang language server stopped');
  });
  try {
    logger.info('Starting %s', command);
    await next.start();
  } catch (error) {
    for (const watcher of fileEvents) watcher.dispose();
    watchers = [];
    client = undefined;
    throw error;
  }
}

async function reportFailure(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  clientLogger('Main').error('%s', message);
  const action = await window.showErrorMessage(
    `Bloblang: ${message}`,
    'Show Logs',
    'Settings',
  );
  if (action === 'Show Logs') getClientChannel().show();
  if (action === 'Settings')
    await commands.executeCommand(
      'workbench.action.openSettings',
      'bloblang.server.path',
    );
}

async function restart(context: ExtensionContext): Promise<void> {
  if (restarting) return restarting;
  restarting = (async () => {
    showStatus('starting');
    await stopClient();
    await startClient(context);
  })();
  try {
    await restarting;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showStatus('failed', message);
    getServerChannel().appendLine(`Startup failed: ${message}`);
    throw error;
  } finally {
    restarting = undefined;
  }
}

export async function activate(context: ExtensionContext): Promise<void> {
  status = window.createStatusBarItem(
    'bloblang.server',
    StatusBarAlignment.Right,
    10,
  );
  status.name = 'Bloblang language server';
  status.command = 'bloblang.showLogs';
  context.subscriptions.push(
    status,
    commands.registerCommand('bloblang.restartServer', () =>
      restart(context).catch(reportFailure),
    ),
    commands.registerCommand('bloblang.showLogs', () =>
      getServerChannel().show(),
    ),
    commands.registerCommand('bloblang.formatEmbeddedMappings', async () => {
      const editor = window.activeTextEditor;
      if (
        !editor ||
        editor.document.languageId !== 'yaml' ||
        !client?.isRunning()
      )
        return;
      try {
        const edits = await client.sendRequest(DocumentFormattingRequest.type, {
          textDocument: { uri: editor.document.uri.toString() },
          options: {
            tabSize: Number(editor.options.tabSize) || 2,
            insertSpaces: editor.options.insertSpaces === true,
          },
        });
        if (edits?.length) {
          const edit = new WorkspaceEdit();
          edit.set(
            editor.document.uri,
            await client.protocol2CodeConverter.asTextEdits(edits),
          );
          await workspace.applyEdit(edit);
        }
      } catch (error) {
        await reportFailure(error);
      }
    }),
    workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('bloblang.server') ||
        event.affectsConfiguration('bloblang.yaml.enabled')
      ) {
        void restart(context).catch(reportFailure);
      }
    }),
  );
  await restart(context).catch(reportFailure);
}

export async function deactivate(): Promise<void> {
  await stopClient();
  status?.dispose();
  status = undefined;
  disposeChannels();
}
