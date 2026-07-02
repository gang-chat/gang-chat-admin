import { z } from 'zod';
import { optionalString } from '../../core/validation';

export const auditQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(500).default(200),
	status: z.enum(['ok', 'failed', 'pending']).optional(),
	action: optionalString,
	target: optionalString
});
