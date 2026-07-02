import { z } from 'zod';

export const agentSuggestBodySchema = z.object({
	goal: z.string().trim().min(1).max(2000),
	context: z.string().trim().max(20_000).optional()
});

export const agentOpsRunBodySchema = z.object({
	workerId: z.string().trim().min(1).max(120),
	sessionId: z.string().trim().min(1).max(120),
	goal: z.string().trim().min(1).max(2000)
});

export const agentOpsSessionBodySchema = z.object({
	name: z.string().trim().min(1).max(120).optional()
});

export const agentWorkerParamSchema = z.object({
	workerId: z.string().trim().min(1).max(120)
});

export const agentSessionParamSchema = z.object({
	workerId: z.string().trim().min(1).max(120),
	sessionId: z.string().trim().min(1).max(120)
});

export const agentJobsQuerySchema = z.object({
	status: z.enum(['suggested', 'approved', 'rejected']).optional()
});

export const agentCommandSchema = z.object({
	label: z.string().trim().min(1).max(200),
	command: z.string().trim().min(1).max(20_000),
	requiresApproval: z.boolean().default(true)
});

export const agentDecisionBodySchema = z.object({
	operatorNote: z.string().trim().max(2000).optional(),
	commands: z.array(agentCommandSchema).min(1).max(50).optional()
});

export const agentWorkerJobsQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(50).default(10)
});

export const agentWorkerHeartbeatBodySchema = z.object({
	workerId: z.string().trim().min(1).max(120),
	apiBase: z.string().trim().max(500).optional(),
	hostname: z.string().trim().max(255).optional(),
	version: z.string().trim().max(120).optional(),
	execute: z.boolean(),
	allowedCommands: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
	currentJobId: z.string().trim().max(120).optional()
});

export const agentWorkerStartBodySchema = z.object({
	workerId: z.string().trim().min(1).max(120)
});

export const agentWorkerCommandResultSchema = z.object({
	label: z.string().trim().max(200).optional(),
	command: z.string().trim().min(1).max(20_000),
	exitCode: z.number().int().nullable(),
	stdout: z.string().max(200_000).optional(),
	stderr: z.string().max(200_000).optional(),
	startedAt: z.string().datetime().optional(),
	completedAt: z.string().datetime().optional(),
	durationMs: z.number().int().min(0).optional()
});

export const agentWorkerCompleteBodySchema = z.object({
	workerId: z.string().trim().min(1).max(120),
	result: z.string().trim().max(20_000).optional(),
	commandResults: z.array(agentWorkerCommandResultSchema).max(100).optional()
});

export const agentWorkerFailBodySchema = z.object({
	workerId: z.string().trim().min(1).max(120),
	error: z.string().trim().min(1).max(20_000),
	commandResults: z.array(agentWorkerCommandResultSchema).max(100).optional()
});
