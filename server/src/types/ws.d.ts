declare module 'ws' {
	import { EventEmitter } from 'node:events';

	export type RawData = Buffer | ArrayBuffer | Buffer[];

	export default class WebSocket extends EventEmitter {
		static readonly CONNECTING: 0;
		static readonly OPEN: 1;
		static readonly CLOSING: 2;
		static readonly CLOSED: 3;

		readonly CONNECTING: 0;
		readonly OPEN: 1;
		readonly CLOSING: 2;
		readonly CLOSED: 3;

		readyState: 0 | 1 | 2 | 3;

		constructor(address: string | URL, protocols?: string | string[]);

		send(data: string | Buffer | ArrayBuffer): void;
		close(code?: number, reason?: string | Buffer): void;

		on(event: 'open', listener: () => void): this;
		on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this;
		on(event: 'error', listener: (error: Error) => void): this;
		on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
		on(event: string, listener: (...args: unknown[]) => void): this;

		once(event: 'open', listener: () => void): this;
		once(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this;
		once(event: 'error', listener: (error: Error) => void): this;
		once(event: 'close', listener: (code: number, reason: Buffer) => void): this;
		once(event: string, listener: (...args: unknown[]) => void): this;

		off(event: 'open', listener: () => void): this;
		off(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this;
		off(event: 'error', listener: (error: Error) => void): this;
		off(event: 'close', listener: (code: number, reason: Buffer) => void): this;
		off(event: string, listener: (...args: unknown[]) => void): this;
	}
}
