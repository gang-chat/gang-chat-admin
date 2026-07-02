import { nanoid } from 'nanoid';
import type {
	ExpenseEntry,
	ExpenseInput,
	ExpenseSummary
} from '../../../../src/lib/shared/ops-types';
import { HttpError } from '../../core/http';
import { JsonStore, storePath } from '../../store/json-store';

type ExpenseState = {
	entries: ExpenseEntry[];
};

export class ExpensesRepository {
	private readonly store: JsonStore<ExpenseState>;

	constructor(dataDir: string) {
		this.store = new JsonStore(storePath(dataDir, 'expenses'), { entries: [] });
	}

	async list(month?: string) {
		const state = await this.store.read();
		return state.entries
			.filter((entry) => !month || entry.month === month)
			.sort((a, b) => b.month.localeCompare(a.month) || b.createdAt.localeCompare(a.createdAt));
	}

	async create(input: ExpenseInput) {
		const now = new Date().toISOString();
		const entry: ExpenseEntry = {
			id: nanoid(),
			...normalizeInput(input),
			createdAt: now,
			updatedAt: now
		};
		await this.store.update((state) => {
			state.entries.unshift(entry);
		});
		return entry;
	}

	async update(id: string, input: ExpenseInput) {
		let entry: ExpenseEntry | undefined;
		await this.store.update((state) => {
			const index = state.entries.findIndex((item) => item.id === id);
			if (index === -1) throw new HttpError(404, 'EXPENSE_NOT_FOUND', 'Expense entry not found');
			entry = {
				...state.entries[index],
				...normalizeInput(input),
				updatedAt: new Date().toISOString()
			};
			state.entries[index] = entry;
		});
		return entry!;
	}

	async remove(id: string) {
		await this.store.update((state) => {
			const before = state.entries.length;
			state.entries = state.entries.filter((item) => item.id !== id);
			if (state.entries.length === before) {
				throw new HttpError(404, 'EXPENSE_NOT_FOUND', 'Expense entry not found');
			}
		});
	}

	async summary(month: string): Promise<ExpenseSummary> {
		const entries = await this.list(month);
		const currency = entries[0]?.currency ?? 'CNY';
		const byCategory = new Map<string, number>();
		let total = 0;
		for (const entry of entries) {
			total += entry.amount;
			byCategory.set(entry.category, (byCategory.get(entry.category) ?? 0) + entry.amount);
		}

		return {
			month,
			total,
			currency,
			byCategory: Array.from(byCategory.entries()).map(([category, categoryTotal]) => ({
				category,
				total: categoryTotal
			}))
		};
	}
}

function normalizeInput(input: ExpenseInput): ExpenseInput {
	if (!/^\d{4}-\d{2}$/.test(input.month)) {
		throw new HttpError(400, 'INVALID_MONTH', 'Month must use YYYY-MM format');
	}
	if (!Number.isFinite(input.amount) || input.amount < 0) {
		throw new HttpError(400, 'INVALID_AMOUNT', 'Amount must be a non-negative number');
	}
	return {
		month: input.month,
		category: input.category.trim(),
		vendor: input.vendor.trim(),
		amount: Number(input.amount),
		currency: input.currency.trim().toUpperCase() || 'CNY',
		note: input.note?.trim() || undefined
	};
}
