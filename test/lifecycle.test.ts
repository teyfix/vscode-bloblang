import { expect, mock, test } from 'bun:test';
import type { ExtensionContext } from 'vscode';

const commands = new Map<string, () => Promise<void> | void>();
const items: {
  text: string;
  command?: string;
  disposed: boolean;
  history: string[];
}[] = [];
const notifications: string[] = [];
let configuredPath = 'bloblang-test';
const channel = { appendLine: () => {}, show: () => {}, dispose: () => {} };
const disposable = { dispose: () => {} };
mock.module('vscode', () => ({
  WorkspaceEdit: class {},
  StatusBarAlignment: { Right: 2 },
  ThemeColor: class {
    constructor(public id: string) {}
  },
  commands: {
    registerCommand: (name: string, handler: () => Promise<void> | void) => {
      commands.set(name, handler);
      return disposable;
    },
    executeCommand: async () => {},
  },
  workspace: {
    getConfiguration: () => ({
      get: (name: string, fallback: unknown) =>
        name === 'server.path' ? configuredPath : fallback,
    }),
    createFileSystemWatcher: () => disposable,
    onDidChangeConfiguration: () => disposable,
    workspaceFolders: [],
  },
  window: {
    createOutputChannel: () => channel,
    showErrorMessage: async (message: string) => {
      notifications.push(message);
    },
    showInformationMessage: async (message: string) => {
      notifications.push(message);
    },
    showWarningMessage: async (message: string) => {
      notifications.push(message);
    },
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
mock.module('vscode-languageclient/node', () => ({
  State: { Stopped: 1, Running: 2, Starting: 3 },
  TransportKind: { stdio: 0 },
  DocumentFormattingRequest: { type: 'format' },
  LanguageClient: class {
    private listener?: (event: { newState: number }) => void;
    constructor(
      _id: string,
      _name: string,
      _server: unknown,
      options: { progressOnInitialization?: boolean },
    ) {
      expect(options.progressOnInitialization).toBe(false);
    }
    onDidChangeState(listener: (event: { newState: number }) => void) {
      this.listener = listener;
      return disposable;
    }
    async start() {
      this.listener?.({ newState: 3 });
      this.listener?.({ newState: 2 });
    }
    async stop() {
      this.listener?.({ newState: 1 });
    }
  },
}));
const extension = await import('../src/index');
const context = {
  subscriptions: [],
  extensionPath: '/unused',
  asAbsolutePath: (value: string) => value,
} as unknown as ExtensionContext;

test('startup and restart stay quiet and expose ready status with logs command', async () => {
  await extension.activate(context);
  const item = items.at(-1);
  expect(item?.history).toContain('$(loading~spin) Bloblang');
  expect(item?.text).toBe('$(check) Bloblang');
  expect(item?.command).toBe('bloblang.showLogs');
  expect(notifications).toEqual([]);
  await commands.get('bloblang.restartServer')?.();
  expect(item?.text).toBe('$(check) Bloblang');
  expect(notifications).toEqual([]);
  await extension.deactivate();
  expect(item?.disposed).toBe(true);
});

test('a missing configured binary exposes failed status and one actionable error', async () => {
  configuredPath = '/bloblang-test/nonexistent-server';
  await extension.activate(context);
  expect(items.at(-1)?.text).toBe('$(error) Bloblang');
  expect(notifications).toHaveLength(1);
  expect(notifications[0]).toContain('Bloblang:');
  await extension.deactivate();
});
