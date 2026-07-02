import { z } from 'zod';
import { optionalString } from '../../core/validation';

export const expenseQuerySchema = z.object({
	month: z
		.string()
		.regex(/^\d{4}-\d{2}$/)
		.optional()
});

export const expenseSummaryQuerySchema = z.object({
	month: z.string().regex(/^\d{4}-\d{2}$/)
});

export const expenseInputSchema = z.object({
	month: z.string().regex(/^\d{4}-\d{2}$/),
	category: z.string().trim().min(1).max(80),
	vendor: z.string().trim().min(1).max(160),
	amount: z.coerce.number().finite().nonnegative(),
	currency: z.string().trim().min(1).max(8).default('CNY'),
	note: optionalString
});
