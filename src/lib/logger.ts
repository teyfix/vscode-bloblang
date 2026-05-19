import path from 'node:path';
import { format } from 'node:util';
import { window } from 'vscode';
import { getClientChannel } from './channels';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';
type LogFn = (level: LogLevel, message: string, ...args: unknown[]) => void;
type LogLevelFn = (message: string, ...args: unknown[]) => void;

type Logger = { log: LogFn } & Record<LogLevel, LogLevelFn>;

const AppName = 'Bloblang';

export function clientLogger(label: string): Logger {
  const channel = getClientChannel();
  const log: LogFn = (level: LogLevel, tpl: string, ...args) => {
    const line = () => format(`%s [%s] ${tpl}`, level, label, ...args);
    const message = () =>
      format(
        `%s – ${tpl}`,
        AppName,
        ...args.map((arg) => {
          if (typeof arg !== 'string') {
            return arg;
          }

          if (path.isAbsolute(arg)) {
            return path.basename(arg);
          }

          return arg;
        }),
      );

    const handleAction = (action: string | undefined) => {
      if (action == null) {
        return;
      }

      switch (action) {
        case 'Show Logs':
          channel.show();
          return;
      }
    };

    channel.appendLine(line());

    if (level === 'info') {
      window.showInformationMessage(message(), 'Dismiss').then(handleAction);
    }

    if (level === 'warn') {
      window.showWarningMessage(message(), 'Open Logs').then(handleAction);
    }

    if (level === 'error') {
      channel.show();
      window.showErrorMessage(message(), 'Open Logs').then(handleAction);
    }
  };

  return {
    log,
    debug: log.bind(null, 'debug'),
    info: log.bind(null, 'info'),
    warn: log.bind(null, 'warn'),
    error: log.bind(null, 'error'),
  };
}
