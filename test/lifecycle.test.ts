import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionContext } from 'vscode';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import {
  CliExistsError,
  defaultCliDirectory,
  directoryOnPath,
  installExternalCli,
} from '../src/lib/cli';
import type { ManagedTool, ToolManager } from '../src/lib/releases';
import { createServerProcess, waitForStartup } from '../src/lib/server-process';

const commands = new Map<string, () => Promise<unknown> | unknown>();
const items: {
  text: string;
  command?: string;
  disposed: boolean;
  history: string[];
}[] = [];
const notifications: string[] = [];
const clients: MockClient[] = [];
const watchers: { disposed: boolean; dispose(): void }[] = [];
const environment = new Map<string, string>();
let configuration: Record<string, unknown>;
let documents: { languageId: string }[];
let configurationListener: (event: {
  affectsConfiguration(section: string): boolean;
}) => void;
let documentListener: (document: { languageId: string }) => void;
let startHook: (() => Promise<void>) | undefined;
let nextTool: ManagedTool;
let lastServer: { command: string; args: string[] };
let resolveHook: (signal?: AbortSignal) => Promise<ManagedTool>;
let updateHook: (options?: {
  force?: boolean;
  signal?: AbortSignal;
}) => Promise<ManagedTool | undefined>;
let resolutions = 0;
let updates = 0;
let input: string | undefined;
let confirmation: string | undefined;
let inputHook: (() => Promise<string | undefined>) | undefined;
let errorHook: (() => Promise<string | undefined>) | undefined;
let watcherFailureAt: number | undefined;
const channel = { appendLine: () => {}, show: () => {}, dispose: () => {} };
const disposable = { dispose: () => {} };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
mock.module('vscode', () => ({
  WorkspaceEdit: class {},
  StatusBarAlignment: { Right: 2 },
  ThemeColor: class {
    constructor(public id: string) {}
  },
  commands: {
    registerCommand: (
      name: string,
      handler: () => Promise<unknown> | unknown,
    ) => {
      commands.set(name, handler);
      return disposable;
    },
    executeCommand: async () => {},
  },
  workspace: {
    getConfiguration: () => ({
      get: (name: string, fallback: unknown) => configuration[name] ?? fallback,
    }),
    get textDocuments() {
      return documents;
    },
    createFileSystemWatcher: () => {
      if (watchers.length === watcherFailureAt)
        throw new Error('watcher failed');
      const watcher = {
        disposed: false,
        dispose() {
          this.disposed = true;
        },
      };
      watchers.push(watcher);
      return watcher;
    },
    onDidChangeConfiguration: (listener: typeof configurationListener) => {
      configurationListener = listener;
      return disposable;
    },
    onDidOpenTextDocument: (listener: typeof documentListener) => {
      documentListener = listener;
      return disposable;
    },
    workspaceFolders: [],
  },
  window: {
    createOutputChannel: () => channel,
    showErrorMessage: async (message: string) => {
      notifications.push(message);
      return errorHook?.();
    },
    showInformationMessage: async (message: string) => {
      notifications.push(message);
    },
    showWarningMessage: async (message: string) => {
      notifications.push(message);
      return confirmation;
    },
    showInputBox: async () => (inputHook ? inputHook() : input),
    createStatusBarItem: () => {
      let text = '';
      const history: string[] = [];
      const item = {
        get text() {
          return text;
        },
        set text(value: string) {
          text = value;
          history.push(value);
        },
        history,
        disposed: false,
        show: () => {},
        dispose: () => {
          item.disposed = true;
        },
      };
      items.push(item);
      return item;
    },
  },
}));
class MockClient {
  running = false;
  server: { command: string; args: string[] };
  stopped = false;
  disposed = false;
  private listener?: (event: { newState: number }) => void;
  constructor(
    _id: string,
    _name: string,
    _server: unknown,
    options: { progressOnInitialization?: boolean },
  ) {
    expect(options.progressOnInitialization).toBe(false);
    this.server = lastServer;
    clients.push(this);
  }
  onDidChangeState(listener: (event: { newState: number }) => void) {
    this.listener = listener;
    return disposable;
  }
  async start() {
    this.listener?.({ newState: 3 });
    await startHook?.();
    this.running = true;
    this.listener?.({ newState: 2 });
  }
  isRunning() {
    return this.running;
  }
  error() {}
  async stop() {
    this.running = false;
    this.stopped = true;
    this.listener?.({ newState: 1 });
  }
  async dispose() {
    this.disposed = true;
  }
}
mock.module('vscode-languageclient/node', () => ({
  CloseAction: { DoNotRestart: 1, Restart: 2 },
  ErrorAction: { Continue: 1, Shutdown: 2 },
  State: { Stopped: 1, Running: 2, Starting: 3 },
  TransportKind: { stdio: 0 },
  DocumentFormattingRequest: { type: 'format' },
  LanguageClient: MockClient,
}));
const extension = await import('../src/index');
function context(): ExtensionContext {
  return {
    subscriptions: [],
    extensionPath: '/unused',
    environmentVariableCollection: {
      delete: (name: string) => environment.delete(name),
      prepend: (name: string, value: string) => environment.set(name, value),
    },
  } as unknown as ExtensionContext;
}
function activate() {
  const manager: ToolManager = {
    resolve: (signal) => {
      resolutions++;
      return resolveHook(signal);
    },
    checkForUpdates: (options) => {
      updates++;
      return updateHook(options);
    },
  };
  return extension.activate(context(), manager, (tool) => {
    lastServer = { command: tool.command, args: tool.args };
    return {
      start: async () => ({}) as ChildProcess,
      terminate: async () => {},
    };
  });
}
function change(section: string) {
  configurationListener({ affectsConfiguration: (name) => name === section });
}
beforeEach(() => {
  commands.clear();
  items.length = 0;
  notifications.length = 0;
  clients.length = 0;
  watchers.length = 0;
  environment.clear();
  configuration = { 'server.path': 'bloblang-test' };
  documents = [{ languageId: 'bloblang' }];
  startHook = undefined;
  nextTool = {
    command: '/managed/v1/blobl',
    args: ['lsp'],
    version: 'v1',
    cliDirectory: '/managed/v1',
  };
  resolveHook = async () => nextTool;
  updateHook = async () => undefined;
  resolutions = 0;
  updates = 0;
  input = undefined;
  confirmation = undefined;
  inputHook = undefined;
  errorHook = undefined;
  watcherFailureAt = undefined;
});
afterEach(async () => {
  await extension.deactivate();
});

test('startup and restart stay quiet and expose ready status with logs command', async () => {
  await activate();
  const item = items.at(-1);
  expect(item?.history).toContain('$(loading~spin) Bloblang');
  expect(item?.text).toBe('$(check) Bloblang');
  expect(item?.command).toBe('bloblang.showLogs');
  expect(notifications).toEqual([]);
  await commands.get('bloblang.restartServer')?.();
  expect(item?.text).toBe('$(check) Bloblang');
  expect(clients[0]?.disposed).toBe(true);
  expect(notifications).toEqual([]);
  await extension.deactivate();
  expect(item?.disposed).toBe(true);
  expect(watchers.every((watcher) => watcher.disposed)).toBe(true);
});

test('missing configured binary exposes failed status and one actionable error', async () => {
  configuration['server.path'] = '/bloblang-test/nonexistent-server';
  await activate();
  expect(items.at(-1)?.text).toBe('$(error) Bloblang');
  expect(notifications).toHaveLength(1);
  expect(notifications[0]).toContain('Bloblang:');
  expect(resolutions).toBe(0);
});

test('custom paths and args remain exact and do not prepare managed CLI', async () => {
  configuration['server.path'] = 'blobl';
  configuration['server.args'] = ['lsp', '--custom'];
  await activate();
  expect(clients[0]?.server).toEqual({
    command: 'blobl',
    args: ['lsp', '--custom'],
  });
  expect(resolutions).toBe(0);
  expect(updates).toBe(0);
  expect(environment.size).toBe(0);
});

test('startup prepares managed terminal PATH lazily without a language server', async () => {
  configuration['server.path'] = '';
  documents = [];
  await activate();
  expect(clients).toHaveLength(0);
  expect(watchers).toHaveLength(0);
  expect(environment.get('PATH')).toBe(`/managed/v1${path.delimiter}`);
  documentListener({ languageId: 'bloblang' });
  await settle();
  expect(clients[0]?.server.args).toEqual(['lsp']);
  expect(notifications).toEqual([]);
});

test('managed args are selected automatically and disabled CLI clears PATH', async () => {
  configuration['server.path'] = '';
  configuration['server.args'] = ['ignored-custom-argument'];
  await activate();
  expect(clients[0]?.server.args).toEqual(['lsp']);
  configuration['cli.enabled'] = false;
  change('bloblang.cli.enabled');
  expect(environment.size).toBe(0);
  expect(clients).toHaveLength(1);
  await extension.deactivate();
  expect(environment.size).toBe(0);
});

test('disabled CLI skips startup network preparation without relevant documents', async () => {
  configuration['server.path'] = '';
  configuration['cli.enabled'] = false;
  documents = [];
  await activate();
  expect(resolutions).toBe(0);
  expect(environment.size).toBe(0);
});

test('legacy cached server uses no arguments and contributes no CLI PATH', async () => {
  configuration['server.path'] = '';
  nextTool = {
    command: '/legacy/server',
    args: [],
    version: 'v0.2.6',
    legacy: true,
  };
  await activate();
  expect(clients[0]?.server.args).toEqual([]);
  expect(environment.size).toBe(0);
});

test('background updates do not interrupt the active server or terminal contribution', async () => {
  configuration['server.path'] = '';
  const pending = deferred<ManagedTool | undefined>();
  updateHook = () => pending.promise;
  await activate();
  nextTool = {
    command: '/managed/v2/blobl',
    args: ['lsp'],
    version: 'v2',
    cliDirectory: '/managed/v2',
  };
  pending.resolve(nextTool);
  await settle();
  expect(clients).toHaveLength(1);
  expect(clients[0]?.stopped).toBe(false);
  expect(environment.get('PATH')).toBe(`/managed/v1${path.delimiter}`);
  updateHook = async ({ force } = {}) => (force ? nextTool : undefined);
  await commands.get('bloblang.checkToolUpdates')?.();
  expect(clients).toHaveLength(2);
  expect(clients[0]?.disposed).toBe(true);
  expect(clients[1]?.server.command).toBe('/managed/v2/blobl');
  expect(environment.get('PATH')).toBe(`/managed/v2${path.delimiter}`);
});

test('deactivation cancels an in-flight resolution and prevents late client or watchers', async () => {
  configuration['server.path'] = '';
  const entered = deferred<void>();
  let aborted = false;
  resolveHook = (signal) =>
    new Promise((_, reject) => {
      entered.resolve();
      signal?.addEventListener(
        'abort',
        () => {
          aborted = true;
          reject(new DOMException('Cancelled', 'AbortError'));
        },
        { once: true },
      );
    });
  const activation = activate();
  await entered.promise;
  await extension.deactivate();
  await activation;
  expect(aborted).toBe(true);
  expect(clients).toHaveLength(0);
  expect(watchers).toHaveLength(0);
  expect(notifications).toEqual([]);
});

test('deactivation awaits resolution even if a provider ignores cancellation, without starting it', async () => {
  configuration['server.path'] = '';
  const pending = deferred<ManagedTool>();
  resolveHook = () => pending.promise;
  const activation = activate();
  await settle();
  const shutdown = extension.deactivate();
  pending.resolve(nextTool);
  await Promise.all([activation, shutdown]);
  expect(clients).toHaveLength(0);
  expect(watchers).toHaveLength(0);
  expect(environment.size).toBe(0);
});

test('settings changes during startup are serialized and the newest args are applied', async () => {
  const pending = deferred<void>();
  startHook = () => pending.promise;
  const activation = activate();
  await settle();
  configuration['server.path'] = 'new-server';
  configuration['server.args'] = ['latest'];
  change('bloblang.server');
  configuration['server.args'] = ['newest'];
  change('bloblang.server');
  startHook = undefined;
  pending.resolve();
  await activation;
  await settle();
  expect(clients).toHaveLength(2);
  expect(clients[0]?.disposed).toBe(true);
  expect(clients[1]?.server).toEqual({
    command: 'new-server',
    args: ['newest'],
  });
  expect(notifications).toEqual([]);
});

test('a failed client is disposed together with its watchers', async () => {
  startHook = async () => {
    throw new Error('start failed');
  };
  await activate();
  expect(clients[0]?.disposed).toBe(true);
  expect(watchers.every((watcher) => watcher.disposed)).toBe(true);
  expect(notifications).toHaveLength(1);
});

test('opening a document reuses a cold terminal preparation without canceling it', async () => {
  configuration['server.path'] = '';
  documents = [];
  const pending = deferred<ManagedTool>();
  let aborted = false;
  resolveHook = (signal) => {
    signal?.addEventListener('abort', () => {
      aborted = true;
    });
    return pending.promise;
  };
  const activation = activate();
  await settle();
  documentListener({ languageId: 'bloblang' });
  await settle();
  expect(aborted).toBe(false);
  expect(resolutions).toBe(1);
  pending.resolve(nextTool);
  await activation;
  await settle();
  expect(clients).toHaveLength(1);
  expect(notifications).toEqual([]);
});

test('switching from a cold managed startup to a custom server cancels and applies latest settings', async () => {
  configuration['server.path'] = '';
  const entered = deferred<void>();
  resolveHook = (signal) =>
    new Promise((_, reject) => {
      entered.resolve();
      signal?.addEventListener(
        'abort',
        () => reject(new DOMException('Cancelled', 'AbortError')),
        { once: true },
      );
    });
  const activation = activate();
  await entered.promise;
  configuration['server.path'] = 'custom';
  configuration['server.args'] = ['exact'];
  change('bloblang.server');
  await activation;
  await settle();
  expect(clients).toHaveLength(1);
  expect(clients[0]?.server).toEqual({ command: 'custom', args: ['exact'] });
  expect(environment.size).toBe(0);
  expect(notifications).toEqual([]);
});

test('partial watcher creation failure disposes the watcher already created', async () => {
  watcherFailureAt = 1;
  await activate();
  expect(watchers).toHaveLength(1);
  expect(watchers[0]?.disposed).toBe(true);
  expect(clients).toHaveLength(0);
  expect(notifications).toHaveLength(1);
});

test('shutdown settles pending CLI dialogs and stops the active server without user input', async () => {
  await activate();
  const pending = deferred<string | undefined>();
  inputHook = () => pending.promise;
  const installation = commands.get('bloblang.installCli')?.();
  await settle();
  await extension.deactivate();
  await installation;
  expect(clients[0]?.stopped).toBe(true);
  expect(clients[0]?.disposed).toBe(true);
  pending.resolve('/should-not-install');
  await settle();
  expect(notifications).toEqual([]);
});

test('shutdown settles pending startup error dialogs without user input', async () => {
  configuration['server.path'] = '/bloblang-test/nonexistent-server';
  const pending = deferred<string | undefined>();
  errorHook = () => pending.promise;
  const activation = activate();
  // Filesystem access failure needs an event-loop turn before its UI prompt.
  while (notifications.length === 0)
    await new Promise((resolve) => setTimeout(resolve, 1));
  await extension.deactivate();
  await activation;
  pending.resolve('Settings');
  await settle();
  expect(clients).toHaveLength(0);
});

test('shutdown cancels a language client stalled in initialize without waiting for it', async () => {
  const pending = deferred<void>();
  startHook = () => pending.promise;
  const activation = activate();
  await settle();
  expect(clients).toHaveLength(1);
  await extension.deactivate();
  await activation;
  expect(clients[0]?.disposed).toBe(true);
  expect(watchers.every((watcher) => watcher.disposed)).toBe(true);
  expect(notifications).toEqual([]);
  pending.resolve();
  await settle();
  expect(clients).toHaveLength(1);
});

test('owned child is killed when initialization is canceled, including a child ignoring SIGTERM', async () => {
  const controller = new AbortController();
  const owned = createServerProcess(
    {
      command: process.execPath,
      args: [
        '-e',
        'process.on("SIGTERM", () => {}); process.stdin.resume(); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);',
      ],
      version: 'fixture',
    },
    controller.signal,
  );
  const child = await owned.start();
  if (!child.stdout || !child.stdin) throw new Error('Missing stdio');
  await new Promise((resolve) => child.stdout?.once('data', resolve));
  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );
  connection.listen();
  const initializing = connection
    .sendRequest('initialize', { capabilities: {} })
    .then(() => {});
  const startup = waitForStartup(initializing, controller);
  controller.abort();
  await expect(startup).rejects.toThrow();
  await owned.terminate();
  connection.dispose();
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});

test('initialization timeout kills the owned child and does not add command arguments', async () => {
  const controller = new AbortController();
  const script =
    'process.stdout.write(JSON.stringify(process.argv.slice(1)) + "\\n"); process.stdin.resume(); setInterval(() => {}, 1000);';
  const owned = createServerProcess(
    {
      command: process.execPath,
      args: ['-e', script, 'lsp'],
      version: 'fixture',
    },
    controller.signal,
  );
  const child = await owned.start();
  const output = new Promise<string>((resolve) =>
    child.stdout?.once('data', (data) => resolve(String(data))),
  );
  expect((await output).trim()).toBe('["lsp"]');
  await expect(
    waitForStartup(new Promise(() => {}), controller, 10),
  ).rejects.toThrow('initialization timed out');
  await owned.terminate();
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});

test('owned child completes a normal stdio initialize and shuts down cleanly', async () => {
  const controller = new AbortController();
  const script =
    'const {createMessageConnection,StreamMessageReader,StreamMessageWriter}=require("vscode-jsonrpc/node");const connection=createMessageConnection(new StreamMessageReader(process.stdin),new StreamMessageWriter(process.stdout));connection.onRequest("initialize",()=>({capabilities:{}}));connection.listen();';
  const owned = createServerProcess(
    { command: process.execPath, args: ['-e', script], version: 'fixture' },
    controller.signal,
  );
  const child = await owned.start();
  if (!child.stdout || !child.stdin) throw new Error('Missing stdio');
  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );
  connection.listen();
  const response = connection.sendRequest<{ capabilities: object }>(
    'initialize',
    { capabilities: {} },
  );
  await waitForStartup(
    response.then(() => {}),
    controller,
    1000,
  );
  expect(await response).toEqual({ capabilities: {} });
  expect(controller.signal.aborted).toBe(false);
  await owned.terminate();
  connection.dispose();
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});

test('owned child retires a previous live process before a crash-recovery transport starts', async () => {
  const controller = new AbortController();
  const owned = createServerProcess(
    {
      command: process.execPath,
      args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000);'],
      version: 'fixture',
    },
    controller.signal,
  );
  const first = await owned.start();
  const second = await owned.start();
  expect(first.pid).not.toBe(second.pid);
  expect(first.exitCode !== null || first.signalCode !== null).toBe(true);
  await owned.terminate();
  expect(second.exitCode !== null || second.signalCode !== null).toBe(true);
});

test('owned child spawn failure is handled and cleanup settles', async () => {
  const controller = new AbortController();
  const owned = createServerProcess(
    {
      command: path.join(os.tmpdir(), 'bloblang-no-such-executable'),
      args: [],
      version: 'fixture',
    },
    controller.signal,
  );
  await expect(owned.start()).rejects.toThrow();
  await owned.terminate();
});

test('external CLI install preserves files until overwrite approval and copies atomically', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bloblang-cli-test-'));
  try {
    const source = path.join(root, 'source');
    const directory = path.join(root, 'bin');
    await writeFile(source, 'managed-tool');
    await chmod(source, 0o700);
    const first = await installExternalCli(source, directory);
    expect(await readFile(first.target, 'utf8')).toBe('managed-tool');
    if (process.platform !== 'win32')
      expect((await lstat(first.target)).mode & 0o777).toBe(0o755);
    expect((await installExternalCli(source, directory)).unchanged).toBe(true);
    await writeFile(source, 'new-tool');
    await expect(installExternalCli(source, directory)).rejects.toBeInstanceOf(
      CliExistsError,
    );
    expect(await readFile(first.target, 'utf8')).toBe('managed-tool');
    await installExternalCli(source, directory, { overwrite: true });
    expect(await readFile(first.target, 'utf8')).toBe('new-tool');
    expect(await readdir(directory)).toEqual([
      process.platform === 'win32' ? 'blobl.exe' : 'blobl',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('external CLI helper rejects unsafe targets and cancellation without modifying files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bloblang-cli-test-'));
  try {
    const source = path.join(root, 'source');
    await writeFile(source, 'tool');
    await expect(installExternalCli(source, 'relative')).rejects.toThrow(
      'absolute',
    );
    const name = process.platform === 'win32' ? 'blobl.exe' : 'blobl';
    if (process.platform === 'win32') await mkdir(path.join(root, name));
    else await symlink(source, path.join(root, name));
    await expect(
      installExternalCli(source, root, { overwrite: true }),
    ).rejects.toThrow('non-regular');
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      installExternalCli(source, path.join(root, 'new'), {
        signal: aborted.signal,
      }),
    ).rejects.toThrow();
    expect((await readdir(root)).sort()).toEqual([
      process.platform === 'win32' ? 'blobl.exe' : 'blobl',
      'source',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('default install folder and PATH inspection respect extension host Windows and Unix conventions', () => {
  expect(defaultCliDirectory('linux', '/home/example')).toBe(
    '/home/example/.local/bin',
  );
  expect(defaultCliDirectory('win32', 'C:\\Users\\example', 'C:\\Local')).toBe(
    'C:\\Local\\Bloblang\\bin',
  );
  expect(
    directoryOnPath('/home/example/bin', '/usr/bin:/home/example/bin', 'linux'),
  ).toBe(true);
  expect(
    directoryOnPath(
      'C:\\Local\\Bloblang\\bin',
      'c:\\local\\bloblang\\bin;C:\\Windows',
      'win32',
    ),
  ).toBe(true);
  expect(directoryOnPath('/missing', '/usr/bin', 'linux')).toBe(false);
});
