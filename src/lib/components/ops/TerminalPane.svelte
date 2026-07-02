<script lang="ts">
	import { Eraser, Plug, PlugZap, RotateCw } from '@lucide/svelte';
	import { onDestroy, onMount } from 'svelte';
	import type { ApiClient } from '$lib/api/client';

	let {
		api,
		connectionId,
		wsBase,
		title,
		canOperate
	}: {
		api: ApiClient;
		connectionId?: string;
		wsBase: string;
		title: string;
		canOperate: boolean;
	} = $props();

	type TerminalStatus = 'idle' | 'ready' | 'connecting' | 'connected' | 'closed' | 'error';
	type TerminalLike = {
		dispose: () => void;
		write: (value: string) => void;
		clear: () => void;
		focus: () => void;
		onData: (fn: (value: string) => void) => { dispose: () => void };
		cols: number;
		rows: number;
	};

	let host: HTMLDivElement;
	let status = $state<TerminalStatus>('idle');
	let statusText = $state('idle');
	let connecting = $state(false);
	let socket: WebSocket | undefined;
	let terminal: TerminalLike | undefined;
	let fitAddon: { fit: () => void } | undefined;
	let resizeObserver: ResizeObserver | undefined;
	let dataSubscription: { dispose: () => void } | undefined;
	let heartbeat: ReturnType<typeof setInterval> | undefined;

	onMount(async () => {
		const [{ Terminal }, { FitAddon }] = await Promise.all([
			import('@xterm/xterm'),
			import('@xterm/addon-fit')
		]);
		const term = new Terminal({
			cursorBlink: true,
			fontFamily: 'JetBrains Mono, Consolas, monospace',
			fontSize: 12,
			scrollback: 10_000,
			theme: {
				background: '#080b0f',
				foreground: '#d7dde7',
				cursor: '#48cae4',
				selectionBackground: '#264653'
			}
		}) as TerminalLike & {
			loadAddon: (addon: unknown) => void;
			open: (element: HTMLElement) => void;
		};
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(host);
		fit.fit();

		terminal = term;
		fitAddon = fit;
		dataSubscription = term.onData((data) => {
			if (socket?.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify({ type: 'input', data }));
			}
		});
		resizeObserver = new ResizeObserver(() => {
			fit.fit();
			sendResize();
		});
		resizeObserver.observe(host);

		if (!connectionId) {
			status = 'idle';
			statusText = 'select preset';
			term.write('Select an SSH preset to start a session.\r\n');
			return;
		}

		status = 'ready';
		statusText = 'ready';
		term.write('Press Connect to start a session.\r\n');
	});

	async function connect() {
		if (!connectionId || !terminal || connecting || socket?.readyState === WebSocket.OPEN) return;
		connecting = true;
		status = 'connecting';
		statusText = 'connecting';
		fitAddon?.fit();
		terminal.write(`\r\n[${title}] connecting...\r\n`);
		try {
			const { ticket } = await api.sshTicket(connectionId);
			const cols = terminal.cols || 120;
			const rows = terminal.rows || 32;
			const activeSocket = new WebSocket(
				`${wsBase}/ws/ssh/${connectionId}?ticket=${ticket}&cols=${cols}&rows=${rows}`
			);
			socket = activeSocket;
			wireSocket(activeSocket);
		} catch (error) {
			status = 'error';
			statusText = 'ticket failed';
			terminal.write(`\r\n[error] ${error instanceof Error ? error.message : 'Ticket failed'}\r\n`);
		} finally {
			connecting = false;
		}
	}

	function wireSocket(activeSocket: WebSocket) {
		activeSocket.addEventListener('open', () => {
			status = 'connected';
			statusText = 'connected';
			terminal?.write(`\r\n[${title}] connected\r\n`);
			sendResize();
			heartbeat = setInterval(() => {
				if (activeSocket.readyState === WebSocket.OPEN) {
					activeSocket.send(JSON.stringify({ type: 'ping' }));
				}
			}, 20_000);
		});
		activeSocket.addEventListener('message', (event) => {
			const payload = parseSocketPayload(event.data);
			if (!payload) return;
			if (payload.type === 'data' && payload.data) terminal?.write(payload.data);
			if (payload.type === 'error') {
				status = 'error';
				statusText = 'error';
				terminal?.write(`\r\n[error] ${payload.message ?? 'SSH error'}\r\n`);
			}
			if (payload.type === 'status') {
				statusText = payload.status ?? statusText;
				if (payload.status === 'connected') status = 'connected';
				if (payload.status === 'closed') status = 'closed';
			}
		});
		activeSocket.addEventListener('close', () => {
			clearHeartbeat();
			if (socket === activeSocket) socket = undefined;
			status = 'closed';
			statusText = 'closed';
			terminal?.write('\r\n[session closed]\r\n');
		});
		activeSocket.addEventListener('error', () => {
			status = 'error';
			statusText = 'socket error';
			terminal?.write('\r\n[error] socket error\r\n');
		});
	}

	function disconnect() {
		clearHeartbeat();
		socket?.close(1000, 'Closed by operator');
		socket = undefined;
		if (status !== 'idle') {
			status = 'closed';
			statusText = 'closed';
		}
	}

	async function reconnect() {
		disconnect();
		await connect();
	}

	function clearTerminal() {
		terminal?.clear();
		terminal?.focus();
	}

	function sendResize() {
		if (!terminal || socket?.readyState !== WebSocket.OPEN) return;
		socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
	}

	function clearHeartbeat() {
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = undefined;
	}

	function parseSocketPayload(value: unknown) {
		try {
			return JSON.parse(String(value)) as {
				type: string;
				data?: string;
				message?: string;
				status?: string;
			};
		} catch {
			return undefined;
		}
	}

	onDestroy(() => {
		resizeObserver?.disconnect();
		dataSubscription?.dispose();
		clearHeartbeat();
		socket?.close();
		terminal?.dispose();
	});
</script>

<section
	class="flex min-h-0 flex-col overflow-hidden rounded-md border border-zinc-800 bg-[#080b0f]"
>
	<header class="flex h-9 items-center justify-between border-b border-zinc-800 bg-zinc-950 px-3">
		<div class="truncate text-xs font-medium text-zinc-200">{title}</div>
		<div class="flex items-center gap-2">
			<span
				class="rounded px-2 py-0.5 text-[11px] uppercase tracking-wide {status === 'connected'
					? 'bg-emerald-950 text-emerald-300'
					: status === 'error'
						? 'bg-red-950 text-red-300'
						: status === 'connecting'
							? 'bg-amber-950 text-amber-300'
							: 'bg-zinc-900 text-zinc-400'}"
			>
				{statusText}
			</span>
			<button
				class="terminal-button"
				title="Connect"
				onclick={connect}
				disabled={!connectionId || !canOperate || connecting}
			>
				<Plug class="size-3" />
			</button>
			<button
				class="terminal-button"
				title="Reconnect"
				onclick={reconnect}
				disabled={!connectionId || !canOperate}
			>
				<RotateCw class="size-3" />
			</button>
			<button class="terminal-button" title="Disconnect" onclick={disconnect}>
				<PlugZap class="size-3" />
			</button>
			<button class="terminal-button" title="Clear" onclick={clearTerminal}>
				<Eraser class="size-3" />
			</button>
		</div>
	</header>
	<div bind:this={host} class="min-h-0 flex-1 overflow-hidden"></div>
</section>

<style>
	.terminal-button {
		display: inline-flex;
		height: 1.35rem;
		width: 1.35rem;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
		border: 1px solid rgb(39 39 42);
		color: rgb(212 212 216);
	}

	.terminal-button:hover {
		background: rgb(39 39 42);
	}

	.terminal-button:disabled {
		cursor: not-allowed;
		opacity: 0.4;
	}
</style>
