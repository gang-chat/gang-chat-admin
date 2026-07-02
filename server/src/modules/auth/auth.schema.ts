import { z } from 'zod';

export const authRoleSchema = z.enum(['viewer', 'operator', 'admin']);

export const authLoginBodySchema = z.object({
	username: z.string().trim().min(1).max(80),
	password: z.string().min(1).max(1024)
});

export const authCreateUserBodySchema = z.object({
	username: z
		.string()
		.trim()
		.min(3)
		.max(80)
		.regex(/^[\w@.+:-]+$/),
	displayName: z.string().trim().min(1).max(120).optional(),
	role: authRoleSchema.default('viewer'),
	password: z.string().min(12).max(1024)
});

export const authUserIdParamSchema = z.object({
	id: z.string().min(1)
});

export const authChangePasswordBodySchema = z.object({
	currentPassword: z.string().min(1).max(1024),
	newPassword: z.string().min(12).max(1024),
	revokeOtherSessions: z.boolean().default(true)
});

export const authSessionIdParamSchema = z.object({
	id: z.string().min(1)
});
