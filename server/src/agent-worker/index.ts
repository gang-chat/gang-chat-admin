import os from 'node:os';
import { AgentWorkerClient } from './client';
import { loadAgentWorkerConfig } from './config';
import { runAgentJob } from './runner';

const env = await loadAgentWorkerConfig();
const client = new AgentWorkerClient(env.apiBase, env.token);
let stopping = false;

process.on('SIGINT', () => {
	stopping = true;
});
process.on('SIGTERM', () => {
	stopping = true;
});

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processNextJob() {
	await heartbeat();
	const jobs = await client.listJobs(1);
	const job = jobs[0];
	if (!job) return false;

	let started = job;
	try {
		started = await client.startJob(job.id, env.workerId);
		await heartbeat(started.id);
		const outcome = await runAgentJob(started, {
			execute: env.execute,
			commandTimeoutMs: env.commandTimeoutMs,
			maxOutputBytes: env.maxOutputBytes,
			policy: {
				allowedCommands: env.allowedCommands,
				workingDirectory: env.workingDirectory
			}
		});
		if (outcome.success) {
			await client.completeJob(started.id, {
				workerId: env.workerId,
				result: outcome.result,
				commandResults: outcome.commandResults
			});
			console.info(`completed agent job ${started.id}`);
		} else {
			await client.failJob(started.id, {
				workerId: env.workerId,
				error: outcome.result,
				commandResults: outcome.commandResults
			});
			console.error(`failed agent job ${started.id}: ${outcome.result}`);
		}
		await heartbeat();
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`agent job ${started.id} failed: ${message}`);
		if (started.executionStatus === 'running') {
			await client.failJob(started.id, {
				workerId: env.workerId,
				error: message
			});
		}
		await heartbeat();
		return true;
	}
}

async function heartbeat(currentJobId?: string) {
	await client.heartbeat({
		workerId: env.workerId,
		apiBase: env.apiBase,
		hostname: os.hostname(),
		version: undefined,
		execute: env.execute,
		allowedCommands: env.allowedCommands,
		currentJobId
	});
}

async function main() {
	console.info(
		`agent worker ${env.workerId} polling ${env.apiBase}; execute=${env.execute ? 'true' : 'false'}; allowed=${env.allowedCommands.join(',') || 'none'}`
	);

	do {
		try {
			const processed = await processNextJob();
			if (!processed) await sleep(env.pollMs);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`agent worker loop error: ${message}`);
			await sleep(env.pollMs);
		}
	} while (!stopping && !env.once);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
