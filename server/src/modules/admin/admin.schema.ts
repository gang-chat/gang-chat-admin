import { z } from 'zod';

const isoDateSchema = z.string().datetime();
const optionalIsoDateSchema = isoDateSchema.optional();
const authRoleSchema = z.enum(['viewer', 'operator', 'admin']);

const storedConnectionBaseSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	tags: z.array(z.string()),
	status: z.enum(['unknown', 'healthy', 'failed']),
	lastCheckedAt: optionalIsoDateSchema,
	lastError: z.string().optional(),
	secrets: z.string().optional(),
	createdAt: isoDateSchema,
	updatedAt: isoDateSchema
});

const storedMysqlConnectionSchema = storedConnectionBaseSchema.extend({
	type: z.literal('mysql'),
	config: z.object({
		host: z.string().min(1),
		port: z.number().int().min(1).max(65535),
		database: z.string(),
		user: z.string(),
		ssl: z.boolean(),
		allowMutations: z.boolean().default(false)
	})
});

const storedS3ConnectionSchema = storedConnectionBaseSchema.extend({
	type: z.literal('s3'),
	config: z.object({
		endpoint: z.string().min(1),
		region: z.string(),
		defaultBucket: z.string().optional(),
		forcePathStyle: z.boolean(),
		allowWrites: z.boolean().default(false)
	})
});

const storedSshConnectionSchema = storedConnectionBaseSchema.extend({
	type: z.literal('ssh'),
	config: z.object({
		host: z.string().min(1),
		port: z.number().int().min(1).max(65535),
		username: z.string(),
		hostKeySha256: z.string().optional()
	})
});

const connectionsStoreSchema = z.object({
	presets: z.array(
		z.discriminatedUnion('type', [
			storedMysqlConnectionSchema,
			storedS3ConnectionSchema,
			storedSshConnectionSchema
		])
	)
});

const auditStoreSchema = z.object({
	events: z.array(
		z.object({
			id: z.string().min(1),
			at: isoDateSchema,
			actor: z.string(),
			action: z.string().min(1),
			target: z.string(),
			status: z.enum(['ok', 'failed', 'pending']),
			detail: z.string().optional(),
			previousHash: z.string().optional(),
			hash: z.string().optional()
		})
	)
});

const expensesStoreSchema = z.object({
	entries: z.array(
		z.object({
			id: z.string().min(1),
			month: z.string().regex(/^\d{4}-\d{2}$/),
			category: z.string().min(1),
			vendor: z.string().min(1),
			amount: z.number().finite().min(0),
			currency: z.string().min(1),
			note: z.string().optional(),
			createdAt: isoDateSchema,
			updatedAt: isoDateSchema
		})
	)
});

const agentCommandResultSchema = z.object({
	label: z.string().optional(),
	command: z.string().min(1),
	exitCode: z.number().int().nullable(),
	stdout: z.string().optional(),
	stderr: z.string().optional(),
	startedAt: optionalIsoDateSchema,
	completedAt: optionalIsoDateSchema,
	durationMs: z.number().int().min(0).optional()
});

const agentStoreSchema = z.object({
	jobs: z.array(
		z.object({
			id: z.string().min(1),
			createdAt: isoDateSchema,
			updatedAt: isoDateSchema,
			status: z.enum(['suggested', 'approved', 'rejected']),
			executionStatus: z.enum(['queued', 'running', 'completed', 'failed']).optional(),
			goal: z.string(),
			summary: z.string(),
			risk: z.enum(['low', 'medium', 'high']),
			commands: z.array(
				z.object({
					label: z.string(),
					command: z.string(),
					requiresApproval: z.boolean()
				})
			),
			notes: z.array(z.string()),
			approvedAt: optionalIsoDateSchema,
			rejectedAt: optionalIsoDateSchema,
			operatorNote: z.string().optional(),
			claimedAt: optionalIsoDateSchema,
			startedAt: optionalIsoDateSchema,
			completedAt: optionalIsoDateSchema,
			failedAt: optionalIsoDateSchema,
			workerId: z.string().optional(),
			result: z.string().optional(),
			error: z.string().optional(),
			commandResults: z.array(agentCommandResultSchema).optional()
		})
	)
});

const authStoreSchema = z.object({
	users: z.array(
		z.object({
			id: z.string().min(1),
			username: z.string().min(1),
			displayName: z.string().min(1),
			role: authRoleSchema,
			disabled: z.boolean(),
			passwordHash: z.string().min(1),
			createdAt: isoDateSchema,
			updatedAt: isoDateSchema,
			lastLoginAt: optionalIsoDateSchema,
			lastFailedLoginAt: optionalIsoDateSchema,
			failedLoginCount: z.number().int().min(0).optional(),
			lockedUntil: optionalIsoDateSchema
		})
	),
	sessions: z.array(
		z.object({
			id: z.string().min(1),
			tokenHash: z.string().min(1),
			userId: z.string().min(1),
			createdAt: isoDateSchema,
			expiresAt: isoDateSchema,
			lastSeenAt: isoDateSchema,
			revokedAt: optionalIsoDateSchema
		})
	)
});

export const backupPayloadSchema = z.object({
	version: z.literal(1),
	exportedAt: z.string().datetime(),
	data: z.object({
		connections: connectionsStoreSchema,
		audit: auditStoreSchema,
		expenses: expensesStoreSchema,
		agent: agentStoreSchema.optional(),
		auth: authStoreSchema.optional()
	})
});

export const restoreBodySchema = z.object({
	confirmation: z.literal('RESTORE'),
	backup: backupPayloadSchema
});

export const restorePreviewBodySchema = z.object({
	backup: backupPayloadSchema
});
