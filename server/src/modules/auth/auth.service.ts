import { randomBytes, scrypt, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { nanoid } from 'nanoid';
import type {
	AuthLoginResult,
	AuthRole,
	AuthSession,
	AuthUser
} from '../../../../src/lib/shared/ops-types';
import { HttpError } from '../../core/http';
import { JsonStore, storePath } from '../../store/json-store';
import { assertPasswordPolicy } from './password-policy';

const scryptAsync = promisify(scrypt);
const SCRYPT_KEY_LENGTH = 64;
const SESSION_TOKEN_BYTES = 32;

type StoredUser = AuthUser & {
	passwordHash: string;
};

type StoredSession = {
	id: string;
	tokenHash: string;
	userId: string;
	createdAt: string;
	expiresAt: string;
	lastSeenAt: string;
	revokedAt?: string;
};

type AuthState = {
	users: StoredUser[];
	sessions: StoredSession[];
};

export type AuthIdentity = {
	userId?: string;
	actor: string;
	authMethod: 'session';
	role: AuthRole;
};

export class AuthService {
	private readonly store: JsonStore<AuthState>;

	constructor(
		dataDir: string,
		private readonly secretKey: Buffer,
		private readonly sessionTtlMs: number,
		private readonly sessionIdleTimeoutMs: number,
		private readonly options: {
			username?: string;
			password?: string;
			maxFailedLogins: number;
			lockoutMs: number;
		}
	) {
		this.store = new JsonStore(storePath(dataDir, 'auth'), { users: [], sessions: [] });
	}

	async initialize() {
		if (!this.options.username || !this.options.password) return;
		await this.store.update(async (state) => {
			const now = new Date().toISOString();
			const username = normalizeUsername(this.options.username!);
			const existing = state.users.find((user) => user.username === username);
			if (existing) {
				existing.displayName = this.options.username!;
				existing.role = 'admin';
				existing.disabled = false;
				existing.passwordHash = await hashPassword(this.options.password!);
				existing.updatedAt = now;
				return;
			}
			state.users.push({
				id: nanoid(),
				username,
				displayName: this.options.username!,
				role: 'admin',
				disabled: false,
				passwordHash: await hashPassword(this.options.password!),
				createdAt: now,
				updatedAt: now
			});
		});
	}

	async login(username: string, password: string): Promise<AuthLoginResult> {
		const normalized = normalizeUsername(username);
		let result: AuthLoginResult | undefined;
		let failure: HttpError | undefined;
		await this.store.update(async (state) => {
			pruneExpiredSessions(state, this.sessionIdleTimeoutMs);
			const user = state.users.find((item) => item.username === normalized);
			if (!user || user.disabled) {
				failure = invalidCredentials();
				return;
			}
			if (isUserLocked(user)) {
				failure = invalidCredentials();
				return;
			}
			if (!(await verifyPassword(password, user.passwordHash))) {
				registerFailedLogin(user, this.options.maxFailedLogins, this.options.lockoutMs);
				failure = invalidCredentials();
				return;
			}
			const now = new Date();
			const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
			const session: StoredSession = {
				id: nanoid(),
				tokenHash: this.hashToken(token),
				userId: user.id,
				createdAt: now.toISOString(),
				expiresAt: new Date(now.getTime() + this.sessionTtlMs).toISOString(),
				lastSeenAt: now.toISOString()
			};
			user.lastLoginAt = now.toISOString();
			user.failedLoginCount = 0;
			delete user.lockedUntil;
			user.updatedAt = now.toISOString();
			state.sessions.unshift(session);
			state.sessions = state.sessions.slice(0, 500);
			result = {
				token,
				expiresAt: session.expiresAt,
				idleExpiresAt: idleExpiresAt(session, this.sessionIdleTimeoutMs),
				user: redactUser(user)
			};
		});
		if (failure) throw failure;
		return result!;
	}

	async validateToken(token: string | undefined): Promise<AuthIdentity | undefined> {
		if (!token) return undefined;
		const tokenHash = this.hashToken(token);
		let identity: AuthIdentity | undefined;
		await this.store.update((state) => {
			pruneExpiredSessions(state, this.sessionIdleTimeoutMs);
			const session = state.sessions.find(
				(item) => item.tokenHash === tokenHash && !item.revokedAt
			);
			if (!session) return;
			const user = state.users.find((item) => item.id === session.userId);
			if (!user || user.disabled) return;
			session.lastSeenAt = new Date().toISOString();
			identity = {
				userId: user.id,
				actor: user.displayName || user.username,
				authMethod: 'session',
				role: user.role
			};
		});
		return identity;
	}

	async logout(token: string | undefined) {
		if (!token) return false;
		const tokenHash = this.hashToken(token);
		let revoked = false;
		await this.store.update((state) => {
			const session = state.sessions.find(
				(item) => item.tokenHash === tokenHash && !item.revokedAt
			);
			if (!session) return;
			session.revokedAt = new Date().toISOString();
			revoked = true;
		});
		return revoked;
	}

	async me(token: string | undefined) {
		const { user, session } = await this.requireSession(token);
		return {
			user: redactUser(user),
			expiresAt: session.expiresAt,
			idleExpiresAt: idleExpiresAt(session, this.sessionIdleTimeoutMs),
			authMethod: 'session' as const
		};
	}

	async listSessions(token: string | undefined): Promise<AuthSession[]> {
		const tokenHash = this.hashToken(requireToken(token));
		let sessions: AuthSession[] = [];
		await this.store.update((state) => {
			pruneExpiredSessions(state, this.sessionIdleTimeoutMs);
			const currentSession = state.sessions.find(
				(item) => item.tokenHash === tokenHash && !item.revokedAt
			);
			if (!currentSession || isSessionExpired(currentSession, this.sessionIdleTimeoutMs)) {
				throw new HttpError(401, 'UNAUTHORIZED', 'Missing or invalid session token');
			}
			const user = state.users.find((item) => item.id === currentSession.userId);
			if (!user || user.disabled) {
				throw new HttpError(401, 'UNAUTHORIZED', 'Missing or invalid session token');
			}
			currentSession.lastSeenAt = new Date().toISOString();
			sessions = state.sessions
				.filter((session) => session.userId === user.id)
				.map((session) =>
					redactSession(session, user, session.tokenHash === tokenHash, this.sessionIdleTimeoutMs)
				);
		});
		return sessions;
	}

	async revokeSession(token: string | undefined, sessionId: string) {
		const tokenHash = this.hashToken(requireToken(token));
		let revoked: AuthSession | undefined;
		await this.store.update((state) => {
			pruneExpiredSessions(state, this.sessionIdleTimeoutMs);
			const currentSession = state.sessions.find(
				(item) => item.tokenHash === tokenHash && !item.revokedAt
			);
			if (!currentSession)
				throw new HttpError(401, 'UNAUTHORIZED', 'Missing or invalid session token');
			const user = state.users.find((item) => item.id === currentSession.userId);
			if (!user || user.disabled) {
				throw new HttpError(401, 'UNAUTHORIZED', 'Missing or invalid session token');
			}
			const target = state.sessions.find(
				(item) => item.id === sessionId && item.userId === user.id
			);
			if (!target) throw new HttpError(404, 'AUTH_SESSION_NOT_FOUND', 'Session not found');
			if (!target.revokedAt) target.revokedAt = new Date().toISOString();
			revoked = redactSession(
				target,
				user,
				target.tokenHash === tokenHash,
				this.sessionIdleTimeoutMs
			);
		});
		return revoked!;
	}

	async changePassword(
		token: string | undefined,
		currentPassword: string,
		newPassword: string,
		revokeOtherSessions: boolean
	) {
		const tokenHash = this.hashToken(requireToken(token));
		let updated: AuthUser | undefined;
		await this.store.update(async (state) => {
			pruneExpiredSessions(state, this.sessionIdleTimeoutMs);
			const session = state.sessions.find(
				(item) => item.tokenHash === tokenHash && !item.revokedAt
			);
			if (!session) throw new HttpError(401, 'UNAUTHORIZED', 'Missing or invalid session token');
			const user = state.users.find((item) => item.id === session.userId);
			if (!user || user.disabled) {
				throw new HttpError(401, 'UNAUTHORIZED', 'Missing or invalid session token');
			}
			if (!(await verifyPassword(currentPassword, user.passwordHash))) {
				throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid current password');
			}
			assertPasswordPolicy(newPassword, user.username);
			user.passwordHash = await hashPassword(newPassword);
			user.updatedAt = new Date().toISOString();
			if (revokeOtherSessions) {
				for (const other of state.sessions.filter(
					(item) => item.userId === user.id && item.tokenHash !== tokenHash && !item.revokedAt
				)) {
					other.revokedAt = user.updatedAt;
				}
			}
			session.lastSeenAt = user.updatedAt;
			updated = redactUser(user);
		});
		return updated!;
	}

	async listUsers() {
		const state = await this.store.read();
		return state.users.map(redactUser);
	}

	async createUser(input: {
		username: string;
		displayName?: string;
		role: AuthRole;
		password: string;
	}) {
		const username = normalizeUsername(input.username);
		assertPasswordPolicy(input.password, username);
		let created: AuthUser | undefined;
		await this.store.update(async (state) => {
			if (state.users.some((item) => item.username === username)) {
				throw new HttpError(409, 'AUTH_USER_EXISTS', 'User already exists');
			}
			const now = new Date().toISOString();
			const user: StoredUser = {
				id: nanoid(),
				username,
				displayName: input.displayName?.trim() || input.username.trim(),
				role: input.role,
				disabled: false,
				passwordHash: await hashPassword(input.password),
				createdAt: now,
				updatedAt: now
			};
			state.users.unshift(user);
			created = redactUser(user);
		});
		return created!;
	}

	async disableUser(id: string) {
		await this.store.update((state) => {
			const user = state.users.find((item) => item.id === id);
			if (!user) throw new HttpError(404, 'AUTH_USER_NOT_FOUND', 'User not found');
			user.disabled = true;
			user.updatedAt = new Date().toISOString();
			for (const session of state.sessions.filter(
				(item) => item.userId === id && !item.revokedAt
			)) {
				session.revokedAt = user.updatedAt;
			}
		});
	}

	private hashToken(token: string) {
		return createHmac('sha256', this.secretKey).update(token).digest('hex');
	}

	private async requireSession(token: string | undefined) {
		const tokenHash = this.hashToken(requireToken(token));
		const state = await this.store.read();
		const session = state.sessions.find((item) => item.tokenHash === tokenHash && !item.revokedAt);
		if (!session || isSessionExpired(session, this.sessionIdleTimeoutMs)) {
			throw new HttpError(401, 'UNAUTHORIZED', 'Missing or invalid session token');
		}
		const user = state.users.find((item) => item.id === session.userId);
		if (!user || user.disabled) {
			throw new HttpError(401, 'UNAUTHORIZED', 'Missing or invalid session token');
		}
		return { user, session };
	}
}

function normalizeUsername(username: string) {
	return username.trim().toLowerCase();
}

function redactUser(user: StoredUser): AuthUser {
	return {
		id: user.id,
		username: user.username,
		displayName: user.displayName,
		role: user.role,
		disabled: user.disabled,
		createdAt: user.createdAt,
		updatedAt: user.updatedAt,
		lastLoginAt: user.lastLoginAt,
		lastFailedLoginAt: user.lastFailedLoginAt,
		failedLoginCount: user.failedLoginCount,
		lockedUntil: user.lockedUntil
	};
}

function redactSession(
	session: StoredSession,
	user: StoredUser,
	current: boolean,
	sessionIdleTimeoutMs: number
): AuthSession {
	return {
		id: session.id,
		userId: user.id,
		username: user.username,
		createdAt: session.createdAt,
		expiresAt: session.expiresAt,
		idleExpiresAt: idleExpiresAt(session, sessionIdleTimeoutMs),
		lastSeenAt: session.lastSeenAt,
		revokedAt: session.revokedAt,
		current
	};
}

function requireToken(token: string | undefined) {
	if (!token) throw new HttpError(401, 'UNAUTHORIZED', 'Missing or invalid session token');
	return token;
}

function invalidCredentials() {
	return new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid username or password');
}

function isUserLocked(user: StoredUser) {
	return Boolean(user.lockedUntil && Date.parse(user.lockedUntil) > Date.now());
}

function registerFailedLogin(user: StoredUser, maxFailedLogins: number, lockoutMs: number) {
	const now = Date.now();
	user.failedLoginCount = (user.failedLoginCount ?? 0) + 1;
	user.lastFailedLoginAt = new Date(now).toISOString();
	if (user.failedLoginCount >= maxFailedLogins) {
		user.lockedUntil = new Date(now + lockoutMs).toISOString();
	}
	user.updatedAt = new Date(now).toISOString();
}

async function hashPassword(password: string) {
	const salt = randomBytes(16).toString('base64url');
	const derived = (await scryptAsync(password, salt, SCRYPT_KEY_LENGTH)) as Buffer;
	return `scrypt$${salt}$${derived.toString('base64url')}`;
}

async function verifyPassword(password: string, stored: string) {
	const [scheme, salt, expected] = stored.split('$');
	if (scheme !== 'scrypt' || !salt || !expected) return false;
	const derived = (await scryptAsync(password, salt, SCRYPT_KEY_LENGTH)) as Buffer;
	const expectedBuffer = Buffer.from(expected, 'base64url');
	return expectedBuffer.length === derived.length && timingSafeEqual(expectedBuffer, derived);
}

function idleExpiresAt(session: StoredSession, sessionIdleTimeoutMs: number) {
	return new Date(Date.parse(session.lastSeenAt) + sessionIdleTimeoutMs).toISOString();
}

function isSessionExpired(session: StoredSession, sessionIdleTimeoutMs: number) {
	const now = Date.now();
	return (
		Date.parse(session.expiresAt) <= now ||
		Date.parse(session.lastSeenAt) + sessionIdleTimeoutMs <= now
	);
}

function pruneExpiredSessions(state: AuthState, sessionIdleTimeoutMs: number) {
	state.sessions = state.sessions.filter(
		(session) => session.revokedAt || !isSessionExpired(session, sessionIdleTimeoutMs)
	);
}
