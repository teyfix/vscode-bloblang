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
  CloseAction,
  DocumentFormattingRequest,
  ErrorAction,
  type ErrorHandler,
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  State,
} from 'vscode-languageclient/node';
import {
  disposeChannels,
  getClientChannel,
  getServerChannel,
} from './lib/channels';
import {
  CliExistsError,
  defaultCliDirectory,
  directoryOnPath,
  installExternalCli,
} from './lib/cli';
import { clientLogger } from './lib/logger';
import {
  createToolManager,
  type ManagedTool,
  type ToolManager,
} from './lib/releases';
import {
  createServerProcess,
  type OwnedServerProcess,
  waitForStartup,
} from './lib/server-process';

class ManagedLanguageClient extends LanguageClient {
  startupController?: AbortController;
  override createDefaultErrorHandler(maxRestartCount?: number): ErrorHandler {
    const handler = super.createDefaultErrorHandler(maxRestartCount);
    return {
      error: (error, message, count) =>
        this.startupController?.signal.aborted
          ? { action: ErrorAction.Continue, handled: true }
          : handler.error(error, message, count),
      closed: () =>
        this.startupController?.signal.aborted
          ? { action: CloseAction.DoNotRestart, handled: true }
          : handler.closed(),
    };
  }
  override start(): Promise<void> {
    const started = super.start();
    return this.startupController
      ? waitForStartup(started, this.startupController)
      : started;
  }
  override error(message: string, data?: unknown): void {
    super.error(message, data, false);
  }
  override async stop(timeout = 3000): Promise<void> {
    // LanguageClient cannot stop while initialize is pending. The owned child
    // factory handles that case; dispose still marks this client as disposed.
    if (this.isRunning()) await super.stop(timeout);
  }
}

interface Session {
  context: ExtensionContext;
  manager: ReturnType<typeof createToolManager>;
  status: StatusBarItem;
  lifetime: AbortController;
  generation: number;
  queue: Promise<void>;
  operations: Set<Promise<unknown>>;
  client?: LanguageClient;
  spawn: typeof createServerProcess;
  serverProcess?: OwnedServerProcess;
  startupController?: AbortController;
  initializing?: boolean;
  disposables: { dispose(): unknown }[];
  preparation?: Promise<ManagedTool>;
  preparationController?: AbortController;
  updateController?: AbortController;
  updatePromise?: Promise<ManagedTool | undefined>;
  cancellation: Promise<void>;
  wantsServer: boolean;
}
let session: Session | undefined;

function current(s: Session): boolean {
  return session === s && !s.lifetime.signal.aborted;
}
/** VS Code dialogs cannot be dismissed programmatically; ignore their result on shutdown. */
function cancellableUI<T>(
  s: Session,
  promise: Thenable<T>,
): Promise<T | undefined> {
  if (!current(s)) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const abort = () => resolve(undefined);
    s.lifetime.signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => s.lifetime.signal.removeEventListener('abort', abort))
      .catch(() => {});
  });
}
function configuredPath(): string {
  return workspace
    .getConfiguration('bloblang')
    .get<string>('server.path', '')
    .trim();
}
function cliEnabled(): boolean {
  return workspace
    .getConfiguration('bloblang')
    .get<boolean>('cli.enabled', true);
}
function showStatus(
  s: Session,
  state: 'starting' | 'ready' | 'failed',
  reason?: string,
): void {
  if (!current(s)) return;
  const icon =
    state === 'starting'
      ? 'loading~spin'
      : state === 'ready'
        ? 'check'
        : 'error';
  s.status.text = `$(${icon}) Bloblang`;
  s.status.tooltip = `${reason ?? `Bloblang language server ${state}`}\nClick to show language server logs.`;
  s.status.backgroundColor =
    state === 'failed'
      ? new ThemeColor('statusBarItem.errorBackground')
      : undefined;
  s.status.show();
}
function updateTerminalPath(s: Session, tool?: ManagedTool): void {
  if (!current(s)) return;
  const environment = s.context.environmentVariableCollection;
  environment.delete('PATH');
  if (cliEnabled() && !configuredPath() && tool?.cliDirectory) {
    environment.prepend('PATH', `${tool.cliDirectory}${path.delimiter}`);
  }
}
function track<T>(s: Session, promise: Promise<T>): Promise<T> {
  s.operations.add(promise);
  void promise.finally(() => s.operations.delete(promise)).catch(() => {});
  return promise;
}
function cancelPreparation(s: Session): void {
  const pending = [s.preparation, s.updatePromise].filter(
    (promise) => promise !== undefined,
  );
  s.cancellation = Promise.allSettled([s.cancellation, ...pending]).then(
    () => {},
  );
  s.preparationController?.abort();
  s.preparationController = undefined;
  s.preparation = undefined;
  s.updateController?.abort();
  s.updateController = undefined;
  s.updatePromise = undefined;
}
function prepareManaged(s: Session): Promise<ManagedTool> {
  if (s.preparation) return s.preparation;
  const controller = new AbortController();
  s.preparationController = controller;
  const promise = track(s, s.manager.resolve(controller.signal));
  s.preparation = promise;
  void promise
    .finally(() => {
      if (s.preparation === promise) {
        s.preparation = undefined;
        s.preparationController = undefined;
      }
    })
    .catch(() => {});
  return promise;
}
function checkInBackground(s: Session): void {
  if (!current(s) || configuredPath() || s.updateController) return;
  const controller = new AbortController();
  s.updateController = controller;
  const promise = track(
    s,
    s.manager.checkForUpdates({ signal: controller.signal }),
  );
  s.updatePromise = promise;
  void promise
    .catch((error) => {
      if (current(s) && !controller.signal.aborted)
        clientLogger('Main').warn(
          'Tool update check failed: %s',
          String(error),
        );
    })
    .finally(() => {
      if (s.updateController === controller) {
        s.updateController = undefined;
        s.updatePromise = undefined;
      }
    });
}
async function prepareTerminals(s: Session): Promise<void> {
  updateTerminalPath(s);
  if (!current(s) || configuredPath() || !cliEnabled()) return;
  try {
    const tool = await prepareManaged(s);
    if (!current(s)) return;
    updateTerminalPath(s, tool);
    checkInBackground(s);
  } catch (error) {
    if (
      current(s) &&
      !s.preparationController?.signal.aborted &&
      (error as Error)?.name !== 'AbortError'
    ) {
      // Startup CLI preparation is quiet; explicit commands and LSP startup report failures.
      clientLogger('Main').warn('CLI preparation failed: %s', String(error));
    }
  }
}
async function serverTool(s: Session): Promise<ManagedTool> {
  const configured = configuredPath();
  if (!configured) return prepareManaged(s);
  const expanded = configured
    .replaceAll('${userHome}', os.homedir())
    .replaceAll(
      '${workspaceFolder}',
      workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
    );
  const command =
    !expanded.includes('/') && !expanded.includes('\\')
      ? expanded
      : path.isAbsolute(expanded)
        ? expanded
        : path.resolve(
            workspace.workspaceFolders?.[0]?.uri.fsPath ??
              s.context.extensionPath,
            expanded,
          );
  if (expanded.includes('/') || expanded.includes('\\'))
    await access(
      command,
      process.platform === 'win32' ? constants.F_OK : constants.X_OK,
    );
  return {
    command,
    args: workspace
      .getConfiguration('bloblang')
      .get<string[]>('server.args', []),
    version: 'configured',
  };
}
async function stopClient(s: Session): Promise<void> {
  const old = s.client;
  const serverProcess = s.serverProcess;
  const controller = s.startupController;
  s.startupController = undefined;
  s.initializing = false;
  s.client = undefined;
  s.serverProcess = undefined;
  try {
    if (old) {
      try {
        await old.stop(3000);
      } finally {
        await old.dispose();
      }
    }
  } finally {
    controller?.abort();
    await serverProcess?.terminate();
    for (const disposable of s.disposables) disposable.dispose();
    s.disposables = [];
  }
}
async function startClient(s: Session, generation: number): Promise<void> {
  const tool = await serverTool(s);
  if (!current(s) || generation !== s.generation) return;
  updateTerminalPath(s, tool);
  const controller = new AbortController();
  s.startupController = controller;
  s.initializing = true;
  const serverProcess = s.spawn(
    tool,
    controller.signal,
    workspace.workspaceFolders?.[0]?.uri.fsPath,
  );
  s.serverProcess = serverProcess;
  const serverOptions: ServerOptions = () => serverProcess.start();
  const fileEvents: ReturnType<typeof workspace.createFileSystemWatcher>[] = [];
  s.disposables = [];
  let next: ManagedLanguageClient | undefined;
  try {
    for (const pattern of [
      '**/*.{json,yaml,yml,blobl,bloblang}',
      '**/.bloblangrc.json',
    ]) {
      const watcher = workspace.createFileSystemWatcher(pattern);
      fileEvents.push(watcher);
      s.disposables.push(watcher);
    }
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
      initializationFailedHandler: () => false,
    };
    next = new ManagedLanguageClient(
      'bloblang',
      'Bloblang',
      serverOptions,
      clientOptions,
    );
    next.startupController = controller;
    s.client = next;
    const startedClient = next;
    s.disposables.push(
      next.onDidChangeState(({ newState }) => {
        if (
          !current(s) ||
          s.client !== startedClient ||
          generation !== s.generation
        )
          return;
        if (newState === State.Starting) {
          s.initializing = true;
          showStatus(s, 'starting');
        }
        if (newState === State.Running) {
          s.initializing = false;
          showStatus(s, 'ready');
        }
        if (newState === State.Stopped)
          showStatus(s, 'failed', 'Bloblang language server stopped');
      }),
    );
    clientLogger('Main').info('Starting %s', tool.command);
    try {
      await next.start();
    } finally {
      if (s.startupController === controller) s.initializing = false;
    }
    if (!current(s) || generation !== s.generation) {
      await stopClient(s);
      return;
    }
    if (!configuredPath()) checkInBackground(s);
  } catch (error) {
    await stopClient(s).catch((cleanupError) =>
      clientLogger('Main').warn(
        'Client cleanup failed: %s',
        String(cleanupError),
      ),
    );
    throw error;
  }
}
async function reportFailure(s: Session, error: unknown): Promise<void> {
  if (!current(s) || (error as Error)?.name === 'AbortError') return;
  const message = error instanceof Error ? error.message : String(error);
  clientLogger('Main').error('%s', message);
  const action = await cancellableUI(
    s,
    window.showErrorMessage(`Bloblang: ${message}`, 'Show Logs', 'Settings'),
  );
  if (!current(s)) return;
  if (action === 'Show Logs') getClientChannel().show();
  if (action === 'Settings')
    await commands.executeCommand(
      'workbench.action.openSettings',
      'bloblang.server.path',
    );
}
function restart(s: Session, cancelResolution = true): Promise<void> {
  s.wantsServer = true;
  const generation = ++s.generation;
  if (s.initializing) s.startupController?.abort();
  if (cancelResolution) cancelPreparation(s);
  const queued = s.queue
    .catch(() => {})
    .then(async () => {
      if (!current(s) || generation !== s.generation) return;
      showStatus(s, 'starting');
      try {
        await stopClient(s);
        await s.cancellation;
        if (!current(s) || generation !== s.generation) return;
        await startClient(s, generation);
      } catch (error) {
        if (
          !current(s) ||
          generation !== s.generation ||
          (error as Error)?.name === 'AbortError'
        )
          return;
        const message = error instanceof Error ? error.message : String(error);
        showStatus(s, 'failed', message);
        getServerChannel().appendLine(`Startup failed: ${message}`);
        await reportFailure(s, error);
      }
    });
  s.queue = queued;
  return queued;
}
function relevantDocument(language: string): boolean {
  return (
    language === 'bloblang' ||
    (language === 'yaml' &&
      workspace.getConfiguration('bloblang').get<boolean>('yaml.enabled', true))
  );
}
async function explicitUpdate(s: Session): Promise<void> {
  try {
    const updated = await s.manager.checkForUpdates({
      signal: s.lifetime.signal,
      force: true,
    });
    if (!current(s)) return;
    if (updated && !configuredPath()) {
      if (s.wantsServer) await restart(s);
      else updateTerminalPath(s, updated);
    }
    if (current(s))
      await cancellableUI(
        s,
        window.showInformationMessage(
          updated
            ? `Bloblang tool ${updated.version} installed${configuredPath() ? '; configured language server is unchanged' : ''}.`
            : 'Bloblang tool is up to date.',
        ),
      );
  } catch (error) {
    await reportFailure(s, error);
  }
}
async function installCli(s: Session): Promise<void> {
  try {
    let tool = await prepareManaged(s);
    if (!current(s)) return;
    if (!tool.cliDirectory || tool.legacy) {
      tool =
        (await s.manager.checkForUpdates({
          signal: s.lifetime.signal,
          force: true,
        })) ?? (await prepareManaged(s));
      if (!current(s)) return;
      if (!tool.cliDirectory || tool.legacy)
        throw new Error(
          'The cached legacy server has no CLI. A release containing blobl is required.',
        );
    }
    const directory = await cancellableUI(
      s,
      window.showInputBox({
        title: 'Install Bloblang CLI for External Terminals',
        prompt:
          'Installation folder on the extension host. Shell profiles and PATH are not changed.',
        value: defaultCliDirectory(),
        ignoreFocusOut: true,
        validateInput: (value) =>
          path.isAbsolute(value.trim())
            ? undefined
            : 'Choose an absolute installation folder.',
      }),
    );
    if (!directory || !current(s)) return;
    let result: Awaited<ReturnType<typeof installExternalCli>>;
    try {
      result = await installExternalCli(tool.command, directory.trim(), {
        signal: s.lifetime.signal,
      });
    } catch (error) {
      if (!(error instanceof CliExistsError)) throw error;
      const action = await cancellableUI(
        s,
        window.showWarningMessage(
          `Replace the existing file at ${error.target}?`,
          { modal: true },
          'Replace',
        ),
      );
      if (action !== 'Replace' || !current(s)) return;
      result = await installExternalCli(tool.command, directory.trim(), {
        overwrite: true,
        signal: s.lifetime.signal,
      });
    }
    if (!current(s)) return;
    const instruction = directoryOnPath(directory.trim())
      ? 'Open a new terminal to use blobl.'
      : `Add ${directory.trim()} to your shell PATH, then open a new terminal to use blobl.`;
    await cancellableUI(
      s,
      window.showInformationMessage(
        `Bloblang CLI ${result.unchanged ? 'already installed' : 'installed'} at ${result.target}. ${instruction}`,
      ),
    );
  } catch (error) {
    await reportFailure(s, error);
  }
}

export async function activate(
  context: ExtensionContext,
  manager: ToolManager = createToolManager(context),
  spawn: typeof createServerProcess = createServerProcess,
): Promise<void> {
  const status = window.createStatusBarItem(
    'bloblang.server',
    StatusBarAlignment.Right,
    10,
  );
  const s: Session = {
    context,
    manager,
    spawn,
    status,
    lifetime: new AbortController(),
    generation: 0,
    queue: Promise.resolve(),
    operations: new Set(),
    disposables: [],
    wantsServer: false,
    cancellation: Promise.resolve(),
  };
  session = s;
  status.name = 'Bloblang language server';
  status.command = 'bloblang.showLogs';
  context.subscriptions.push(
    status,
    commands.registerCommand('bloblang.restartServer', () => restart(s)),
    commands.registerCommand('bloblang.showLogs', () =>
      getServerChannel().show(),
    ),
    commands.registerCommand('bloblang.checkToolUpdates', () =>
      track(s, explicitUpdate(s)),
    ),
    commands.registerCommand('bloblang.installCli', () =>
      track(s, installCli(s)),
    ),
    commands.registerCommand('bloblang.formatEmbeddedMappings', async () => {
      const editor = window.activeTextEditor;
      if (
        !editor ||
        editor.document.languageId !== 'yaml' ||
        !s.client?.isRunning()
      )
        return;
      try {
        const edits = await s.client.sendRequest(
          DocumentFormattingRequest.type,
          {
            textDocument: { uri: editor.document.uri.toString() },
            options: {
              tabSize: Number(editor.options.tabSize) || 2,
              insertSpaces: editor.options.insertSpaces === true,
            },
          },
        );
        if (edits?.length) {
          const edit = new WorkspaceEdit();
          edit.set(
            editor.document.uri,
            await s.client.protocol2CodeConverter.asTextEdits(edits),
          );
          await workspace.applyEdit(edit);
        }
      } catch (error) {
        await reportFailure(s, error);
      }
    }),
    workspace.onDidOpenTextDocument((document) => {
      if (current(s) && !s.wantsServer && relevantDocument(document.languageId))
        void restart(s, false);
    }),
    workspace.onDidChangeConfiguration((event) => {
      if (!current(s)) return;
      if (
        event.affectsConfiguration('bloblang.server') ||
        event.affectsConfiguration('bloblang.yaml.enabled')
      ) {
        cancelPreparation(s);
        updateTerminalPath(s);
        if (
          s.wantsServer ||
          workspace.textDocuments.some((document) =>
            relevantDocument(document.languageId),
          )
        )
          void restart(s);
        else void track(s, prepareTerminals(s));
      } else if (event.affectsConfiguration('bloblang.cli.enabled')) {
        if (!cliEnabled()) updateTerminalPath(s);
        else void track(s, prepareTerminals(s));
      }
    }),
  );
  // Clear persisted contributions from earlier settings before doing any I/O.
  updateTerminalPath(s);
  if (
    workspace.textDocuments.some((document) =>
      relevantDocument(document.languageId),
    )
  )
    await restart(s);
  else await track(s, prepareTerminals(s));
}

export async function deactivate(): Promise<void> {
  const s = session;
  if (!s) return;
  s.lifetime.abort();
  if (s.initializing) s.startupController?.abort();
  ++s.generation;
  cancelPreparation(s);
  s.context.environmentVariableCollection.delete('PATH');
  await s.queue.catch(() => {});
  await Promise.allSettled([...s.operations]);
  await stopClient(s);
  s.status.dispose();
  if (session === s) session = undefined;
  disposeChannels();
}
