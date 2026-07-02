import { z, type ZodType } from 'zod';
import { HttpError } from './http';

export function parseInput<T>(schema: ZodType<T>, value: unknown): T {
	const result = schema.safeParse(value);
	if (result.success) return result.data;

	throw new HttpError(
		400,
		'VALIDATION_ERROR',
		'Request validation failed',
		z.treeifyError(result.error)
	);
}

export const idParamSchema = z.object({
	id: z.string().min(1)
});

export const tableParamSchema = z.object({
	id: z.string().min(1),
	table: z.string().min(1)
});

export const paginationQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(500).default(100),
	offset: z.coerce.number().int().min(0).default(0)
});

export const recordSchema = z.record(z.string().min(1), z.unknown());

export const optionalString = z
	.string()
	.trim()
	.optional()
	.transform((value) => value || undefined);
