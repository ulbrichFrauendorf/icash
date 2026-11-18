import { contextBridge, ipcRenderer } from 'electron';
import { channels, type Api, type IpcResult } from '../../shared/api';

const bridge = Object.fromEntries(Object.values(channels).map((channel) => [
  channel, async (input?: unknown) => ipcRenderer.invoke('icash:' + channel, input) as Promise<IpcResult<unknown>>,
]));
contextBridge.exposeInMainWorld('icash', bridge);

export type Bridge = {
  [K in keyof Api]: (...args: Parameters<Api[K]>) => Promise<IpcResult<Awaited<ReturnType<Api[K]>>>>;
};
