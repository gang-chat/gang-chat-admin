import { z } from 'zod';

export const accountIdParamSchema = z.object({
	id: z.string().trim().min(1).max(128)
});

export const membershipParamSchema = accountIdParamSchema.extend({
	roomId: z.string().trim().min(1).max(128)
});

export const accountListQuerySchema = z.object({
	q: z.string().trim().max(320).optional(),
	status: z.enum(['all', 'active', 'suspended', 'deleted']).default('all'),
	limit: z.coerce.number().int().min(1).max(200).default(50),
	offset: z.coerce.number().int().min(0).default(0)
});

export const roomSearchQuerySchema = z.object({
	q: z.string().trim().max(128).optional()
});

export const accountCreateSchema = z.object({
	username: z.string().max(64),
	email: z.string().max(320),
	password: z.string().max(256),
	displayName: z.string().max(128).optional()
});

export const accountUpdateSchema = z.object({
	username: z.string().max(64).optional(),
	email: z.string().max(320).optional(),
	displayName: z.string().max(128).optional(),
	emailVerified: z.boolean().optional(),
	status: z.enum(['active', 'suspended']).optional()
});

export const passwordResetSchema = z.object({
	password: z.string().max(256)
});

export const membershipCreateSchema = z.object({
	roomId: z.string().trim().min(1).max(128),
	role: z.enum(['member', 'admin']).default('member')
});

export const membershipUpdateSchema = z.object({
	role: z.enum(['member', 'admin', 'owner'])
});
