import { z } from 'zod';
import { recordSchema } from '../../core/validation';

export const insertRowBodySchema = z.object({
	row: recordSchema
});

export const updateRowBodySchema = z.object({
	primaryKey: recordSchema,
	patch: recordSchema
});

export const deleteRowBodySchema = z.object({
	primaryKey: recordSchema,
	confirmation: z.string().trim().min(1).max(200)
});

export const sqlQueryBodySchema = z.object({
	sql: z.string().trim().min(1).max(200_000),
	mode: z.enum(['read-only', 'allow-mutations']).default('read-only'),
	maxRows: z.coerce.number().int().min(1).max(1_000).default(200),
	timeoutMs: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
	mutationConfirmation: z.string().trim().max(80).optional()
});
