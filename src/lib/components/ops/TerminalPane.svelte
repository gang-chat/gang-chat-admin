<script lang="ts">
	import { Eraser, Plug, PlugZap, RotateCw } from '@lucide/svelte';
	import { onDestroy, onMount } from 'svelte';
	import { base } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import type { ApiClient } from '$lib/api/client';

	let {
		api,
		workerId,
		title,
		canOperate,
		attachedTop = false
	}: {
		api: ApiClient;
		workerId?: string;
		title: string;
		canOperate: boolean;
		attachedTop?: boolean;
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
	let previousWorkerId = $state<string | undefined>();
	let hasWorkerSnapshot = $state(false);
	let localEcho = false;

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
				if (localEcho) echoTerminalInput(data);
				socket.send(JSON.stringify({ type: 'input', data }));
			}
		});
		resizeObserver = new ResizeObserver(() => {
			fit.fit();
			sendResize();
		});
		resizeObserver.observe(host);

		writeIdleMessage();
	});

	$effect(() => {
		const currentWorkerId = workerId;
		if (!hasWorkerSnapshot) {
			hasWorkerSnapshot = true;
			previousWorkerId = currentWorkerId;
			return;
		}
		if (previousWorkerId === currentWorkerId) return;
		previousWorkerId = currentWorkerId;
		disconnect();
		terminal?.clear();
		writeIdleMessage();
	});

	async function connect() {
		if (!workerId || !terminal || connecting || socket?.readyState === WebSocket.OPEN) return;
		connecting = true;
		status = 'connecting';
		statusText = 'connecting';
		fitAddon?.fit();
		terminal.write(`\r\n[${title}] connecting...\r\n`);
		try {
			const { ticket } = await api.agentWorkerTerminalTicket(workerId);
			const cols = terminal.cols || 120;
			const rows = terminal.rows || 32;
			const activeSocket = new WebSocket(workerTerminalSocketUrl(workerId, ticket, cols, rows));
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
				terminal?.write(`\r\n[error] ${payload.message ?? 'Terminal error'}\r\n`);
			}
			if (payload.type === 'status') {
				statusText = payload.status ?? statusText;
				if (payload.status === 'connected') status = 'connected';
				if (payload.status === 'connected') localEcho = payload.message === 'pipe';
				if (payload.status === 'closed') {
					status = 'closed';
					localEcho = false;
				}
			}
		});
		activeSocket.addEventListener('close', () => {
			clearHeartbeat();
			if (socket === activeSocket) socket = undefined;
			status = 'closed';
			statusText = 'closed';
			localEcho = false;
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
		localEcho = false;
		if (status !== 'idle') {
			status = 'closed';
			statusText = 'closed';
		}
	}

	function workerTerminalSocketUrl(workerId: string, ticket: string, cols: number, rows: number) {
		const url = new URL(
			`${base}/ws/agent/workers/${encodeURIComponent(workerId)}/terminal`,
			window.location.href
		);
		url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		url.searchParams.set('ticket', ticket);
		url.searchParams.set('cols', String(cols));
		url.searchParams.set('rows', String(rows));
		return url;
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

	function echoTerminalInput(data: string) {
		if (!terminal || data.startsWith('\x1b')) return;
		if (data === '\r') {
			terminal.write('\r\n');
			return;
		}
		if (data === '\x7f') {
			terminal.write('\b \b');
			return;
		}
		if (data === '\x03') {
			terminal.write('^C\r\n');
			return;
		}
		terminal.write(data);
	}

	function writeIdleMessage() {
		if (!terminal) return;
		if (!workerId) {
			status = 'idle';
			statusText = 'select worker';
			localEcho = false;
			terminal.write('Select a worker to start a terminal.\r\n');
			return;
		}
		status = 'ready';
		statusText = 'ready';
		localEcho = false;
		terminal.write('Press Connect to start a terminal.\r\n');
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
	class="flex min-h-0 flex-col overflow-hidden border border-zinc-800 bg-[#080b0f] {attachedTop
		? 'rounded-b-xl'
		: 'rounded-md'}"
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
			<Button
				variant="outline"
				size="icon-xs"
				class="h-6 w-6 border-zinc-700 bg-zinc-950 text-zinc-200 hover:bg-zinc-800 hover:text-zinc-100"
				title="Connect"
				onclick={connect}
				disabled={!workerId || !canOperate || connecting}
			>
				<Plug class="size-3" />
			</Button>
			<Button
				variant="outline"
				size="icon-xs"
				class="h-6 w-6 border-zinc-700 bg-zinc-950 text-zinc-200 hover:bg-zinc-800 hover:text-zinc-100"
				title="Reconnect"
				onclick={reconnect}
				disabled={!workerId || !canOperate}
			>
				<RotateCw class="size-3" />
			</Button>
			<Button
				variant="outline"
				size="icon-xs"
				class="h-6 w-6 border-zinc-700 bg-zinc-950 text-zinc-200 hover:bg-zinc-800 hover:text-zinc-100"
				title="Disconnect"
				onclick={disconnect}
			>
				<PlugZap class="size-3" />
			</Button>
			<Button
				variant="outline"
				size="icon-xs"
				class="h-6 w-6 border-zinc-700 bg-zinc-950 text-zinc-200 hover:bg-zinc-800 hover:text-zinc-100"
				title="Clear"
				onclick={clearTerminal}
			>
				<Eraser class="size-3" />
			</Button>
		</div>
	</header>
	<div bind:this={host} class="min-h-0 flex-1 overflow-hidden"></div>
</section>
