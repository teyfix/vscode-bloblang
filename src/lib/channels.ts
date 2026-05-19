import { type OutputChannel, window } from 'vscode';

let channels: Record<string, OutputChannel> = {};

function getChannel(name: string) {
  if (channels[name] == null) {
    channels[name] = window.createOutputChannel(name);
  }

  return channels[name];
}

export function getClientChannel(): OutputChannel {
  return getChannel('Bloblang: LSP Client');
}

export function getServerChannel(): OutputChannel {
  return getChannel('Bloblang: LSP Server');
}

export function disposeChannels() {
  for (const channel of Object.values(channels)) {
    channel.dispose();
  }

  channels = {};
}
