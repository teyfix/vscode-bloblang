import { format } from 'node:util';
import { getClientChannel } from './channels';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';
type LogFn = (level: LogLevel, message: string, ...args: unknown[]) => void;
type LogLevelFn = (message: string, ...args: unknown[]) => void;
type Logger = { log: LogFn } & Record<LogLevel, LogLevelFn>;

export function clientLogger(label: string): Logger {
  const log: LogFn = (level, message, ...args) => {
    getClientChannel().appendLine(
      format('%s [%s] %s', level, label, format(message, ...args)),
    );
  };
  return {
    log,
    debug: log.bind(null, 'debug'),
    info: log.bind(null, 'info'),
    warn: log.bind(null, 'warn'),
    error: log.bind(null, 'error'),
  };
}
