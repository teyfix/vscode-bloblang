import { commands, type ExtensionContext, workspace } from 'vscode';
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';
import { disposeChannels, getServerChannel } from './lib/channels';
import { clientLogger } from './lib/logger';
import { downloadAsset } from './lib/releases';

let client: LanguageClient | undefined;
const logger = clientLogger('Main');

// Reusable client creation and start logic
async function startClient(context: ExtensionContext) {
  logger.debug('Starting bloblang LSP client');

  const exePath = await downloadAsset({ context });
  const args: string[] = [];

  const serverOptions: ServerOptions = {
    run: { command: exePath, args, transport: TransportKind.stdio },
    debug: { command: exePath, args, transport: TransportKind.stdio },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'bloblang' }],
    synchronize: {
      fileEvents: workspace.createFileSystemWatcher('**/.clientrc'),
    },
    outputChannel: getServerChannel(),
  };

  client = new LanguageClient(
    'bloblangLanguageServer',
    'Bloblang LSP',
    serverOptions,
    clientOptions,
  );

  await client.start();
}

// Stop and dispose the current client if it exists
async function stopClient() {
  if (client) {
    await client.stop();
    client = undefined;
  }
}

const commandRegistry = {
  'bloblang.restartServer': async (context: ExtensionContext) => {
    try {
      await stopClient();
      await startClient(context);

      logger.info('Restarted Bloblang server');
    } catch (error) {
      logger.error('Failed to restart Bloblang server: %j', error);
    }
  },
};

export async function activate(context: ExtensionContext) {
  logger.info('Starting language server...');

  for (const [name, fn] of Object.entries(commandRegistry)) {
    context.subscriptions.push(
      commands.registerCommand(name, async () =>
        fn(context).catch((err) => {
          logger.error('Failed to execute command "%s": %j', name, err);
        }),
      ),
    );
  }

  startClient(context).catch((err) => {
    logger.error('Failed to start Bloblang LSP client: %j', err);
  });
}

export async function deactivate(): Promise<void> {
  await stopClient();
  disposeChannels();
}
