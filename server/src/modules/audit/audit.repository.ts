import { createHmac } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { AuditEvent, AuditIntegrity } from '../../../../src/lib/shared/ops-types';
import { currentActor } from '../../core/request-context';
import { JsonStore, storePath } from '../../store/json-store';

type AuditState = {
	events: AuditEvent[];
};

export type AuditListFilter = {
	limit?: number;
	status?: AuditEvent['status'];
	action?: string;
	target?: string;
};

export class AuditRepository {
	private readonly store: JsonStore<AuditState>;

	constructor(
		dataDir: string,
		private readonly signingKey: Buffer
	) {
		this.store = new JsonStore(storePath(dataDir, 'audit'), { events: [] });
	}

	async list(filter: AuditListFilter = {}) {
		const state = await this.store.read();
		const limit = filter.limit ?? 200;
		const action = filter.action?.toLowerCase();
		const target = filter.target?.toLowerCase();
		return state.events
			.filter((event) => !filter.status || event.status === filter.status)
			.filter((event) => !action || event.action.toLowerCase().startsWith(action))
			.filter((event) => !target || event.target.toLowerCase().includes(target))
			.slice(0, limit);
	}

	async integrity(): Promise<AuditIntegrity> {
		const state = await this.store.read();
		return verifyIntegrity(this.signingKey, state.events);
	}

	async record(
		event: Omit<AuditEvent, 'id' | 'at' | 'actor' | 'previousHash' | 'hash'> & {
			actor?: string;
		}
	) {
		let entry: AuditEvent | undefined;
		const actor = event.actor ?? currentActor() ?? 'admin';
		await this.store.update((state) => {
			entry = {
				id: nanoid(),
				at: new Date().toISOString(),
				actor,
				action: event.action,
				target: event.target,
				status: event.status,
				detail: event.detail,
				previousHash: state.events[0]?.hash
			};
			entry.hash = signAuditEvent(this.signingKey, entry);
			state.events.unshift(entry);
			state.events = state.events.slice(0, 2000);
		});
		return entry!;
	}
}

function verifyIntegrity(signingKey: Buffer, events: AuditEvent[]): AuditIntegrity {
	let signed = 0;
	let unsigned = 0;

	for (let index = 0; index < events.length; index += 1) {
		const event = events[index];
		if (!event.hash) {
			unsigned += 1;
			continue;
		}
		signed += 1;
		const expectedHash = signAuditEvent(signingKey, event);
		if (event.hash !== expectedHash) {
			return integrityFailure(events, signed, unsigned, event, 'hash-mismatch');
		}
		const olderEventHash = events[index + 1]?.hash;
		if (event.previousHash !== olderEventHash) {
			return integrityFailure(events, signed, unsigned, event, 'chain-link-mismatch');
		}
	}

	return {
		valid: true,
		total: events.length,
		signed,
		unsigned,
		headHash: events[0]?.hash
	};
}

function integrityFailure(
	events: AuditEvent[],
	signed: number,
	unsigned: number,
	event: AuditEvent,
	reason: string
): AuditIntegrity {
	return {
		valid: false,
		total: events.length,
		signed,
		unsigned,
		headHash: events[0]?.hash,
		brokenAt: event.id,
		reason
	};
}

function signAuditEvent(key: Buffer, event: AuditEvent) {
	return createHmac('sha256', key)
		.update(
			JSON.stringify({
				id: event.id,
				at: event.at,
				actor: event.actor,
				action: event.action,
				target: event.target,
				status: event.status,
				detail: event.detail ?? null,
				previousHash: event.previousHash ?? null
			})
		)
		.digest('hex');
}
