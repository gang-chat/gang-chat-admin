export const AI_ADMIN_WORKER_VERSION = '0.1.0';

export type AiAdminWorkerInitConfig = {
	baseUrl: string;
	apiKey: string;
	model: string;
	contextWindow: number;
	compactAt: number;
};

export type AiAdminWorkerPrompt = {
	runId: string;
	sessionId: string;
	goal: string;
};

export type AiAdminWorkerTerminalInfo = {
	available: boolean;
	username?: string;
	shell?: string;
	cwd?: string;
};

export type AiAdminAdminMessage =
	| {
			type: 'init_config';
			config: AiAdminWorkerInitConfig;
	  }
	| {
			type: 'prompt';
			prompt: AiAdminWorkerPrompt;
	  }
	| {
			type: 'terminal_open';
			terminalId: string;
			cols: number;
			rows: number;
	  }
	| {
			type: 'terminal_input';
			terminalId: string;
			data: string;
	  }
	| {
			type: 'terminal_resize';
			terminalId: string;
			cols: number;
			rows: number;
	  }
	| {
			type: 'terminal_close';
			terminalId: string;
	  };

export type AiAdminWorkerHelloMessage = {
	type: 'hello';
	workerId: string;
	version: string;
	apiBase?: string;
	hostname?: string;
	execute?: boolean;
	allowedCommands?: string[];
	terminal?: AiAdminWorkerTerminalInfo;
};

export type AiAdminWorkerRunEvent =
	| {
			type: 'run_started';
			runId: string;
	  }
	| {
			type: 'text_delta';
			runId: string;
			text: string;
	  }
	| {
			type: 'tool_call';
			runId: string;
			message: string;
	  }
	| {
			type: 'tool_result';
			runId: string;
			message: string;
	  }
	| {
			type: 'context_compacted';
			runId: string;
			message: string;
	  }
	| {
			type: 'run_completed';
			runId: string;
			result?: string;
	  }
	| {
			type: 'run_failed';
			runId: string;
			error: string;
	  };

export type AiAdminWorkerTerminalEvent =
	| {
			type: 'terminal_output';
			terminalId: string;
			data: string;
	  }
	| {
			type: 'terminal_status';
			terminalId: string;
			status: 'connected' | 'closed';
			message?: string;
	  }
	| {
			type: 'terminal_error';
			terminalId: string;
			message: string;
	  };

export type AiAdminWorkerMessage =
	AiAdminWorkerHelloMessage | AiAdminWorkerRunEvent | AiAdminWorkerTerminalEvent;
