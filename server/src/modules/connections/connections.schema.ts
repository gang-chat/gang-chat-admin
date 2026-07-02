import { z } from 'zod';
import { optionalString } from '../../core/validation';

const baseConnectionSchema = z.object({
	name: z.string().trim().min(1).max(120),
	tags: z.array(z.string().trim().min(1).max(40)).default([])
});

export const connectionTypeQuerySchema = z.object({
	type: z.enum(['mysql', 's3', 'ssh']).optional()
});

export const connectionInputSchema = z.discriminatedUnion('type', [
	baseConnectionSchema.extend({
		type: z.literal('mysql'),
		config: z.object({
			host: z.string().trim().min(1).max(255),
			port: z.coerce.number().int().min(1).max(65535).default(3306),
			database: z.string().trim().min(1).max(128),
			user: z.string().trim().min(1).max(128),
			password: optionalString,
			ssl: z.coerce.boolean().default(false),
			allowMutations: z.coerce.boolean().default(false)
		})
	}),
	baseConnectionSchema.extend({
		type: z.literal('s3'),
		config: z.object({
			endpoint: z.string().trim().max(255).default(''),
			region: z.string().trim().min(1).max(80),
			defaultBucket: optionalString,
			forcePathStyle: z.coerce.boolean().default(true),
			allowWrites: z.coerce.boolean().default(false),
			accessKeyId: optionalString,
			secretAccessKey: optionalString,
			sessionToken: optionalString
		})
	}),
	baseConnectionSchema.extend({
		type: z.literal('ssh'),
		config: z.object({
			host: z.string().trim().min(1).max(255),
			port: z.coerce.number().int().min(1).max(65535).default(22),
			username: z.string().trim().min(1).max(128),
			hostKeySha256: optionalString,
			password: optionalString,
			privateKey: optionalString,
			passphrase: optionalString
		})
	})
]);
