import { z } from 'zod';

export const s3BucketNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(255)
	.superRefine((value, context) => {
		if (hasControlCharacter(value)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Bucket name cannot contain control characters'
			});
		}
		if (value.includes('/')) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Bucket name cannot contain slashes'
			});
		}
	});

export const s3ObjectKeySchema = z
	.string()
	.trim()
	.min(1)
	.max(2048)
	.superRefine((value, context) => {
		if (hasControlCharacter(value)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Object key cannot contain control characters'
			});
		}
		if (value.startsWith('/')) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Object key cannot start with /'
			});
		}
		if (value.split('/').some((part) => part === '..')) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Object key cannot contain .. path segments'
			});
		}
	});

function hasControlCharacter(value: string) {
	return Array.from(value).some((char) => {
		const code = char.charCodeAt(0);
		return code < 32 || code === 127;
	});
}

function optionalHttpHeaderField(name: string, max: number) {
	return z
		.string()
		.trim()
		.max(max)
		.optional()
		.transform((value, context) => {
			if (!value) return undefined;
			if (hasControlCharacter(value)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `${name} cannot contain control characters`
				});
				return z.NEVER;
			}
			return value;
		});
}

export const s3MetadataSchema = z
	.union([z.string(), z.record(z.string(), z.unknown())])
	.optional()
	.transform((value, context) => {
		if (value === undefined) return undefined;

		let input: unknown = value;
		if (typeof value === 'string') {
			const trimmed = value.trim();
			if (!trimmed) return undefined;
			try {
				input = JSON.parse(trimmed) as unknown;
			} catch {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: 'Metadata must be valid JSON'
				});
				return z.NEVER;
			}
		}

		if (!input || typeof input !== 'object' || Array.isArray(input)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Metadata must be a JSON object'
			});
			return z.NEVER;
		}

		const entries = Object.entries(input);
		if (entries.length > 20) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Metadata cannot contain more than 20 entries'
			});
			return z.NEVER;
		}

		let totalSize = 0;
		const metadata: Record<string, string> = {};
		for (const [rawName, rawValue] of entries) {
			const name = rawName.trim();
			if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Invalid metadata key: ${rawName}`
				});
				return z.NEVER;
			}
			if (name.toLowerCase().startsWith('x-amz-meta-') || name.toLowerCase().startsWith('x-amz-')) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Metadata key must not include AWS header prefixes: ${name}`
				});
				return z.NEVER;
			}
			if (typeof rawValue !== 'string') {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Metadata value for ${name} must be a string`
				});
				return z.NEVER;
			}
			const value = rawValue.trim();
			if (value.length > 1024) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Metadata value for ${name} is too long`
				});
				return z.NEVER;
			}
			if (hasControlCharacter(value)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Metadata value for ${name} cannot contain control characters`
				});
				return z.NEVER;
			}
			totalSize += Buffer.byteLength(name) + Buffer.byteLength(value);
			if (totalSize > 8192) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: 'Metadata is too large'
				});
				return z.NEVER;
			}
			metadata[name] = value;
		}

		return Object.keys(metadata).length > 0 ? metadata : undefined;
	});

const booleanFormFieldSchema = z
	.union([z.boolean(), z.string().trim().toLowerCase()])
	.optional()
	.transform((value) => value === true || value === 'true' || value === '1' || value === 'yes');

export const s3ObjectQuerySchema = z.object({
	bucket: s3BucketNameSchema,
	prefix: z.string().trim().max(1024).default(''),
	continuationToken: z.string().trim().max(4096).optional(),
	maxKeys: z.coerce.number().int().min(1).max(1000).default(500)
});

export const s3ObjectTargetQuerySchema = z.object({
	bucket: s3BucketNameSchema,
	key: s3ObjectKeySchema
});

export const s3ObjectTargetBodySchema = s3ObjectTargetQuerySchema.extend({
	confirmation: z.string().trim().min(1).max(2048)
});

export const s3UploadFieldsSchema = z.object({
	bucket: s3BucketNameSchema,
	key: s3ObjectKeySchema,
	overwrite: booleanFormFieldSchema.default(false),
	overwriteConfirmation: z.string().trim().max(2048).optional(),
	contentType: optionalHttpHeaderField('Content-Type', 255),
	cacheControl: optionalHttpHeaderField('Cache-Control', 512),
	contentDisposition: optionalHttpHeaderField('Content-Disposition', 1024),
	metadata: s3MetadataSchema
});
