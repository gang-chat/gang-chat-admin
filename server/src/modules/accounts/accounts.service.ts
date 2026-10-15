import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type {
	GangAccount,
	GangAccountCreateInput,
	GangAccountDetail,
	GangAccountList,
	GangAccountMembership,
	GangAccountStatus,
	GangAccountUpdateInput,
	GangRoomRole,
	GangRoomSummary
} from '../../../../src/lib/shared/ops-types';
import { HttpError } from '../../core/http';
import type { ConnectionsRepository } from '../connections/connections.repository';
import type { MysqlService } from '../mysql/mysql.service';
import { hashGangPassword } from './password-hash';

// Account administration writes straight to the Gang Chat database through the
// configured MySQL preset. Each write mirrors the SQL the Go server runs for the
// same action (gang-chat-server internal/auth and internal/chat), so the rows
// look exactly as if the server had written them. What it cannot do is publish
// the server's realtime events or room system messages: open clients see a
// change on their next request or refresh. The server checks session
// revocation and account status on every request, so suspensions and sign-outs
// still take effect immediately.

const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USER_UID_START = 10_000_000;
const RESERVED_SUPER_UID = 66_666_666;
const MESSAGE_SNAPSHOT_COLUMNS = [
	'sender_uid_snapshot',
	'sender_username_snapshot',
	'sender_display_name_snapshot',
	'sender_room_display_name_snapshot',
	'sender_avatar_url_snapshot',
	'sender_default_avatar_key_snapshot',
	'sender_is_superuser_snapshot',
	'sender_room_role_snapshot',
	'quote_json'
];

export type AccountListQuery = {
	q?: string;
	status?: GangAccountStatus | 'all';
	limit: number;
	offset: number;
};

type UserRow = RowDataPacket & {
	id: string;
	uid: string;
	username: string;
	email: string;
	display_name: string | null;
	status: string;
	is_superuser: number;
	email_verified: number;
	created_at: number;
	updated_at: number;
	room_count: number;
	active_sessions: number;
	last_seen_at: number | null;
};

const ACCOUNT_COLUMNS = `u.id, u.uid, u.username, u.email, u.display_name, u.status, u.is_superuser,
	u.email_verified, u.created_at, u.updated_at,
	(SELECT COUNT(*) FROM room_memberships rm WHERE rm.user_id = u.id) AS room_count,
	(SELECT COUNT(*) FROM user_sessions s
	  WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_sessions,
	(SELECT MAX(s.last_used_at) FROM user_sessions s WHERE s.user_id = u.id) AS last_seen_at`;

export class AccountsService {
	constructor(
		private readonly connections: ConnectionsRepository,
		private readonly mysql: MysqlService
	) {}

	async list(query: AccountListQuery): Promise<GangAccountList> {
		return this.read(async (pool) => {
			const where: string[] = [];
			const args: unknown[] = [];
			const q = query.q?.trim();
			if (q) {
				const like = `%${escapeLike(normalize(q))}%`;
				where.push(
					'(u.username_normalized LIKE ? OR u.email_normalized LIKE ? OR u.display_name LIKE ? OR u.uid = ? OR u.id = ?)'
				);
				args.push(like, like, `%${escapeLike(q)}%`, q, q);
			}
			if (query.status && query.status !== 'all') {
				where.push('u.status = ?');
				args.push(query.status);
			}
			const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
			const [countRows] = await pool.query<RowDataPacket[]>(
				`SELECT COUNT(*) AS total FROM users u ${whereSql}`,
				args
			);
			const [rows] = await pool.query<UserRow[]>(
				`SELECT ${ACCOUNT_COLUMNS} FROM users u ${whereSql}
				 ORDER BY u.created_at DESC, u.id LIMIT ? OFFSET ?`,
				[nowSeconds(), ...args, query.limit, query.offset]
			);
			return { total: Number(countRows[0]?.total ?? 0), items: rows.map(toAccount) };
		});
	}

	async get(id: string): Promise<GangAccountDetail> {
		return this.read(async (pool) => {
			const account = await loadAccount(pool, id);
			const [rows] = await pool.query<RowDataPacket[]>(
				`SELECT rm.room_id, r.rid, r.name, rm.role, rm.joined_at
				 FROM room_memberships rm JOIN rooms r ON r.id = rm.room_id
				 WHERE rm.user_id = ?
				 ORDER BY FIELD(rm.role, 'owner', 'admin', 'member'), rm.joined_at`,
				[id]
			);
			return { ...account, memberships: rows.map(toMembership) };
		});
	}

	async listRooms(q: string | undefined): Promise<GangRoomSummary[]> {
		return this.read(async (pool) => {
			const term = q?.trim();
			const [rows] = await pool.query<RowDataPacket[]>(
				`SELECT r.id, r.rid, r.name,
				        (SELECT COUNT(*) FROM room_memberships rm WHERE rm.room_id = r.id) AS member_count
				 FROM rooms r
				 ${term ? 'WHERE r.name LIKE ? OR r.rid = ? OR r.id = ?' : ''}
				 ORDER BY r.created_at DESC LIMIT 20`,
				term ? [`%${escapeLike(term)}%`, term, term] : []
			);
			return rows.map((row) => ({
				id: String(row.id),
				rid: String(row.rid),
				name: String(row.name),
				memberCount: Number(row.member_count ?? 0)
			}));
		});
	}

	/** Mirrors registration (auth.register + model.InsertUser), minus the email code. */
	async create(input: GangAccountCreateInput): Promise<GangAccountDetail> {
		const username = input.username.trim();
		const email = input.email.trim();
		const displayName = input.displayName?.trim() || username;
		assertUsername(username);
		assertEmail(email);
		assertDisplayName(displayName);
		assertPassword(input.password);
		const passwordHash = await hashGangPassword(input.password);
		const id = randomUUID();

		await this.write(async (conn) => {
			const uid = await allocateUserUid(conn);
			const now = nowSeconds();
			try {
				await conn.query(
					`INSERT INTO users (
					   id, uid, username, username_normalized, email, email_normalized, password_hash,
					   status, display_name, bio, gender, default_avatar_key, email_verified, language,
					   username_updated_at, created_at, updated_at
					 ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, '', 'secret', 'blue-3', 1, 'zh-Hans', ?, ?, ?)`,
					[
						id,
						uid,
						username,
						normalize(username),
						email,
						normalize(email),
						passwordHash,
						displayName,
						now,
						now,
						now
					]
				);
			} catch (error) {
				throw duplicateAsConflict(error, 'Username or email is already taken');
			}
		});
		return this.get(id);
	}

	/** Mirrors the superuser "force update user settings" endpoint. */
	async update(id: string, patch: GangAccountUpdateInput): Promise<GangAccountDetail> {
		const sets: string[] = [];
		const args: unknown[] = [];
		const now = nowSeconds();
		if (patch.username !== undefined) {
			const username = patch.username.trim();
			assertUsername(username);
			sets.push('username = ?', 'username_normalized = ?', 'username_updated_at = ?');
			args.push(username, normalize(username), now);
		}
		if (patch.email !== undefined) {
			const email = patch.email.trim();
			assertEmail(email);
			sets.push('email = ?', 'email_normalized = ?', 'email_verified = 0');
			args.push(email, normalize(email));
		}
		if (patch.emailVerified !== undefined) {
			sets.push('email_verified = ?');
			args.push(patch.emailVerified ? 1 : 0);
		}
		if (patch.displayName !== undefined) {
			const displayName = patch.displayName.trim();
			assertDisplayName(displayName);
			sets.push('display_name = ?');
			args.push(displayName);
		}
		if (patch.status !== undefined) {
			sets.push('status = ?');
			args.push(patch.status);
			if (patch.status === 'active') sets.push('deleted_at = NULL');
		}
		if (sets.length === 0) {
			throw new HttpError(400, 'EMPTY_PATCH', 'Change at least one account field');
		}

		await this.write(async (conn) => {
			const user = await lockUser(conn, id);
			assertNotSuperuser(user, 'The super user account is managed by the Gang Chat server');
			try {
				await conn.query(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [
					...args,
					now,
					id
				]);
			} catch (error) {
				throw duplicateAsConflict(error, 'Username or email is already taken');
			}
			if (patch.status !== undefined && patch.status !== 'active') {
				await revokeSessions(conn, id);
			}
		});
		return this.get(id);
	}

	/** Mirrors the superuser password reset: new hash, every session signed out. */
	async resetPassword(id: string, password: string) {
		assertPassword(password);
		const passwordHash = await hashGangPassword(password);
		return this.write(async (conn) => {
			const user = await lockUser(conn, id);
			assertNotSuperuser(user, 'The super user password is managed by the Gang Chat server');
			await conn.query('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
				passwordHash,
				nowSeconds(),
				id
			]);
			return { username: user.username, revokedSessions: await revokeSessions(conn, id) };
		});
	}

	async revokeAllSessions(id: string) {
		return this.write(async (conn) => {
			const user = await lockUser(conn, id);
			return { username: user.username, revokedSessions: await revokeSessions(conn, id) };
		});
	}

	/**
	 * Mirrors account deletion (auth.deleteUserAccount). Messages keep a
	 * snapshot of their sender and survive the delete only once the Go server
	 * has upgraded the schema, so this refuses to run until it has.
	 */
	async delete(id: string, confirmation: string | undefined) {
		return this.write(async (conn) => {
			const user = await lockUser(conn, id);
			assertNotSuperuser(user, 'The super user account cannot be deleted');
			if (confirmation !== user.username) {
				throw new HttpError(
					400,
					'DESTRUCTIVE_CONFIRMATION_REQUIRED',
					'Type the exact username to delete this account'
				);
			}
			await assertMessageRetentionSchema(conn);
			await conn.query(
				`UPDATE messages m
				 JOIN users u ON u.id = m.sender_user_id
				 LEFT JOIN room_memberships rm
				   ON rm.room_id = m.room_id AND rm.user_id = m.sender_user_id
				 SET m.sender_uid_snapshot = COALESCE(u.uid, ''),
				     m.sender_username_snapshot = u.username,
				     m.sender_display_name_snapshot = u.display_name,
				     m.sender_room_display_name_snapshot = rm.room_display_name,
				     m.sender_avatar_url_snapshot = u.avatar_url,
				     m.sender_default_avatar_key_snapshot = COALESCE(NULLIF(u.default_avatar_key, ''), 'blue-3'),
				     m.sender_is_superuser_snapshot = u.is_superuser,
				     m.sender_room_role_snapshot = CASE
				       WHEN u.is_superuser != 0 THEN 'superuser'
				       ELSE COALESCE(rm.role, '')
				     END
				 WHERE m.sender_username_snapshot = '' AND m.sender_user_id = ?`,
				[id]
			);
			await conn.query('UPDATE assets SET owner_user_id = NULL WHERE owner_user_id = ?', [id]);
			await conn.query('DELETE FROM users WHERE id = ?', [id]);
			return { username: user.username, uid: user.uid };
		});
	}

	/** Mirrors chat.addRoomMemberTx: the first member of an ownerless room becomes its owner. */
	async addMembership(userId: string, roomId: string, role: 'member' | 'admin') {
		return this.write(async (conn) => {
			const user = await lockUser(conn, userId);
			assertNotSuperuser(user, 'The super user can already open every room');
			const room = await lockRoom(conn, roomId);
			const [blocked] = await conn.query<RowDataPacket[]>(
				'SELECT COUNT(*) AS n FROM room_blacklist WHERE room_id = ? AND user_id = ?',
				[roomId, userId]
			);
			if (Number(blocked[0]?.n) > 0) {
				throw new HttpError(
					409,
					'ROOM_BLACKLISTED',
					`${user.username} is on this room's blacklist; unblock them in the app first`
				);
			}
			if ((await membershipRole(conn, roomId, userId)) !== undefined) {
				throw new HttpError(409, 'ALREADY_MEMBER', `${user.username} is already in this room`);
			}
			const [owners] = await conn.query<RowDataPacket[]>(
				`SELECT COUNT(*) AS n FROM room_memberships WHERE room_id = ? AND role = 'owner'`,
				[roomId]
			);
			const finalRole: GangRoomRole = Number(owners[0]?.n) === 0 ? 'owner' : role;
			const joinedAt = Date.now();
			await conn.query(
				'INSERT INTO room_memberships (room_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
				[roomId, userId, finalRole, joinedAt]
			);
			if (finalRole === 'owner') {
				await conn.query('UPDATE rooms SET created_by_user_id = ?, updated_at = ? WHERE id = ?', [
					userId,
					joinedAt,
					roomId
				]);
			}
			return { username: user.username, room: room.name, role: finalRole };
		});
	}

	/**
	 * Mirrors chat.updateMemberRole and chat.transferRoomCreator. The owner keeps
	 * the role until someone else is made owner, which demotes them to admin.
	 */
	async updateMembershipRole(userId: string, roomId: string, role: GangRoomRole) {
		return this.write(async (conn) => {
			const user = await lockUser(conn, userId);
			const room = await lockRoom(conn, roomId);
			const current = await membershipRole(conn, roomId, userId);
			if (current === undefined) {
				throw new HttpError(404, 'NOT_A_MEMBER', `${user.username} is not in this room`);
			}
			if (current === role) return { username: user.username, room: room.name, role };
			if (role === 'owner') {
				await conn.query(
					`UPDATE room_memberships SET role = 'admin'
					 WHERE room_id = ? AND role = 'owner' AND user_id != ?`,
					[roomId, userId]
				);
				await conn.query(
					`UPDATE room_memberships SET role = 'owner' WHERE room_id = ? AND user_id = ?`,
					[roomId, userId]
				);
				await conn.query('UPDATE rooms SET created_by_user_id = ?, updated_at = ? WHERE id = ?', [
					userId,
					Date.now(),
					roomId
				]);
			} else {
				assertNotOwner(current);
				await conn.query('UPDATE room_memberships SET role = ? WHERE room_id = ? AND user_id = ?', [
					role,
					roomId,
					userId
				]);
			}
			return { username: user.username, room: room.name, role };
		});
	}

	/** Mirrors chat.removeMember. */
	async removeMembership(userId: string, roomId: string) {
		return this.write(async (conn) => {
			const user = await lockUser(conn, userId);
			const room = await lockRoom(conn, roomId);
			const current = await membershipRole(conn, roomId, userId);
			if (current === undefined) {
				throw new HttpError(404, 'NOT_A_MEMBER', `${user.username} is not in this room`);
			}
			assertNotOwner(current);
			await conn.query('DELETE FROM live_participants WHERE room_id = ? AND user_id = ?', [
				roomId,
				userId
			]);
			await conn.query('DELETE FROM room_memberships WHERE room_id = ? AND user_id = ?', [
				roomId,
				userId
			]);
			return { username: user.username, room: room.name };
		});
	}

	private async connectionId() {
		const [preset] = await this.connections.list('mysql');
		if (!preset) {
			throw new HttpError(
				409,
				'ACCOUNTS_UNAVAILABLE',
				'Configure connections.mysql with the Gang Chat database to manage accounts'
			);
		}
		return preset.id;
	}

	private async read<T>(fn: (pool: Pool) => Promise<T>) {
		return this.mysql.withPool(await this.connectionId(), fn);
	}

	private async write<T>(fn: (conn: PoolConnection) => Promise<T>) {
		const connectionId = await this.connectionId();
		await this.mysql.assertMutationsAllowed(connectionId);
		return this.mysql.withPool(connectionId, async (pool) => {
			const conn = await pool.getConnection();
			try {
				await conn.beginTransaction();
				const result = await fn(conn);
				await conn.commit();
				return result;
			} catch (error) {
				await conn.rollback().catch(() => undefined);
				throw error;
			} finally {
				conn.release();
			}
		});
	}
}

async function loadAccount(pool: Pool, id: string): Promise<GangAccount> {
	const [rows] = await pool.query<UserRow[]>(
		`SELECT ${ACCOUNT_COLUMNS} FROM users u WHERE u.id = ?`,
		[nowSeconds(), id]
	);
	if (!rows[0]) throw new HttpError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
	return toAccount(rows[0]);
}

async function lockUser(conn: PoolConnection, id: string) {
	const [rows] = await conn.query<RowDataPacket[]>(
		'SELECT id, uid, username, is_superuser FROM users WHERE id = ? FOR UPDATE',
		[id]
	);
	const row = rows[0];
	if (!row) throw new HttpError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
	return {
		id: String(row.id),
		uid: String(row.uid),
		username: String(row.username),
		isSuperuser: Number(row.is_superuser) !== 0
	};
}

async function lockRoom(conn: PoolConnection, id: string) {
	const [rows] = await conn.query<RowDataPacket[]>(
		'SELECT id, rid, name FROM rooms WHERE id = ? FOR UPDATE',
		[id]
	);
	if (!rows[0]) throw new HttpError(404, 'ROOM_NOT_FOUND', 'Room not found');
	return { id: String(rows[0].id), rid: String(rows[0].rid), name: String(rows[0].name) };
}

async function membershipRole(conn: PoolConnection, roomId: string, userId: string) {
	const [rows] = await conn.query<RowDataPacket[]>(
		'SELECT role FROM room_memberships WHERE room_id = ? AND user_id = ? FOR UPDATE',
		[roomId, userId]
	);
	return rows[0] ? (String(rows[0].role) as GangRoomRole) : undefined;
}

async function revokeSessions(conn: PoolConnection, userId: string) {
	const [result] = await conn.query(
		'UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
		[nowSeconds(), userId]
	);
	return (result as { affectedRows?: number }).affectedRows ?? 0;
}

/** Mirrors idgen.NextUserUID, inside the caller's transaction. */
async function allocateUserUid(conn: PoolConnection) {
	const [tables] = await conn.query<RowDataPacket[]>(
		`SELECT COUNT(*) AS n FROM information_schema.TABLES
		 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'id_sequences'`
	);
	if (Number(tables[0]?.n) === 0) {
		throw new HttpError(
			409,
			'ACCOUNT_UID_SEQUENCE_MISSING',
			'The Gang Chat server has not created its id_sequences table yet; start it once, then retry'
		);
	}
	const [seedRows] = await conn.query<RowDataPacket[]>(
		`SELECT COALESCE(MAX(CAST(uid AS UNSIGNED)) + 1, ?) AS seed
		 FROM users
		 WHERE uid REGEXP '^[0-9]+$' AND CAST(uid AS UNSIGNED) >= ? AND CAST(uid AS UNSIGNED) < ?`,
		[USER_UID_START, USER_UID_START, RESERVED_SUPER_UID]
	);
	const seed = Math.max(Number(seedRows[0]?.seed ?? USER_UID_START), USER_UID_START);
	await conn.query(
		`INSERT INTO id_sequences (name, next_value) VALUES ('user_uid', ?)
		 ON DUPLICATE KEY UPDATE next_value = GREATEST(next_value, VALUES(next_value))`,
		[seed]
	);
	const [locked] = await conn.query<RowDataPacket[]>(
		`SELECT next_value FROM id_sequences WHERE name = 'user_uid' FOR UPDATE`
	);
	let candidate = Number(locked[0]?.next_value ?? seed);
	if (candidate >= RESERVED_SUPER_UID && seed < RESERVED_SUPER_UID) candidate = seed;
	else if (candidate < seed) candidate = seed;
	for (;;) {
		if (candidate === RESERVED_SUPER_UID) candidate += 1;
		const [taken] = await conn.query<RowDataPacket[]>(
			'SELECT EXISTS(SELECT 1 FROM users WHERE uid = ? LIMIT 1) AS taken',
			[String(candidate)]
		);
		if (Number(taken[0]?.taken) === 0) break;
		candidate += 1;
	}
	await conn.query(`UPDATE id_sequences SET next_value = ? WHERE name = 'user_uid'`, [
		candidate + 1
	]);
	return String(candidate);
}

/**
 * The Go server's EnsureHistoricalMessageRetentionSchema runs at its startup.
 * Deleting before it has run could cascade into message history, so check the
 * result (read-only) instead of altering the schema from here.
 */
async function assertMessageRetentionSchema(conn: PoolConnection) {
	const [columns] = await conn.query<RowDataPacket[]>(
		`SELECT COLUMN_NAME FROM information_schema.COLUMNS
		 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'messages' AND COLUMN_NAME IN (?)`,
		[MESSAGE_SNAPSHOT_COLUMNS]
	);
	const [senderKeys] = await conn.query<RowDataPacket[]>(
		`SELECT COUNT(*) AS n FROM information_schema.KEY_COLUMN_USAGE
		 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'messages'
		   AND COLUMN_NAME = 'sender_user_id' AND REFERENCED_TABLE_NAME = 'users'`
	);
	const [ownerColumn] = await conn.query<RowDataPacket[]>(
		`SELECT IS_NULLABLE FROM information_schema.COLUMNS
		 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'assets' AND COLUMN_NAME = 'owner_user_id'`
	);
	const [ownerKeys] = await conn.query<RowDataPacket[]>(
		`SELECT COUNT(*) AS n FROM information_schema.KEY_COLUMN_USAGE k
		 JOIN information_schema.REFERENTIAL_CONSTRAINTS r
		   ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
		  AND r.TABLE_NAME = k.TABLE_NAME
		  AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
		 WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = 'assets'
		   AND k.COLUMN_NAME = 'owner_user_id' AND k.REFERENCED_TABLE_NAME = 'users'
		   AND r.DELETE_RULE != 'SET NULL'`
	);
	const ready =
		columns.length === MESSAGE_SNAPSHOT_COLUMNS.length &&
		Number(senderKeys[0]?.n) === 0 &&
		String(ownerColumn[0]?.IS_NULLABLE ?? '').toUpperCase() === 'YES' &&
		Number(ownerKeys[0]?.n) === 0;
	if (!ready) {
		throw new HttpError(
			409,
			'ACCOUNT_DELETE_UNSAFE',
			'Deleting now could erase message history: start the current Gang Chat server once so it upgrades the schema, then retry'
		);
	}
}

function toAccount(row: UserRow): GangAccount {
	return {
		id: String(row.id),
		uid: String(row.uid),
		username: String(row.username),
		email: String(row.email),
		displayName: row.display_name ?? undefined,
		status: String(row.status) as GangAccountStatus,
		isSuperuser: Number(row.is_superuser) !== 0,
		emailVerified: Number(row.email_verified) !== 0,
		roomCount: Number(row.room_count ?? 0),
		activeSessionCount: Number(row.active_sessions ?? 0),
		lastSeenAt: row.last_seen_at ? toIso(row.last_seen_at) : undefined,
		createdAt: toIso(row.created_at),
		updatedAt: toIso(row.updated_at)
	};
}

function toMembership(row: RowDataPacket): GangAccountMembership {
	return {
		roomId: String(row.room_id),
		rid: String(row.rid),
		roomName: String(row.name),
		role: String(row.role) as GangRoomRole,
		joinedAt: toIso(row.joined_at)
	};
}

// users and user_sessions store Unix seconds; rooms and memberships store milliseconds.
function toIso(value: unknown) {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return '';
	return new Date(n < 100_000_000_000 ? n * 1000 : n).toISOString();
}

function nowSeconds() {
	return Math.floor(Date.now() / 1000);
}

// model.Normalize lowercases ASCII letters only.
function normalize(value: string) {
	return value.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

function escapeLike(value: string) {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function assertUsername(username: string) {
	if (!USERNAME_PATTERN.test(username)) {
		throw new HttpError(
			400,
			'VALIDATION_ERROR',
			'Username must be 3-32 letters, digits, underscores or hyphens'
		);
	}
}

function assertEmail(email: string) {
	if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
		throw new HttpError(400, 'VALIDATION_ERROR', 'Enter a valid email address');
	}
}

function assertDisplayName(displayName: string) {
	const length = [...displayName].length;
	if (length < 1 || length > 32) {
		throw new HttpError(400, 'VALIDATION_ERROR', 'Display name must be 1-32 characters');
	}
}

function assertPassword(password: string) {
	if (password.length < 8 || password.length > 256) {
		throw new HttpError(400, 'VALIDATION_ERROR', 'Password must be 8-256 characters');
	}
}

function assertNotSuperuser(user: { isSuperuser: boolean }, message: string) {
	if (user.isSuperuser) throw new HttpError(403, 'SUPERUSER_READ_ONLY', message);
}

function assertNotOwner(role: GangRoomRole) {
	if (role === 'owner') {
		throw new HttpError(
			409,
			'OWNER_ROLE_LOCKED',
			'Make another member the owner first; the current owner then becomes an admin'
		);
	}
}

function duplicateAsConflict(error: unknown, message: string) {
	if ((error as { errno?: number }).errno === 1062) {
		return new HttpError(409, 'ACCOUNT_CONFLICT', message);
	}
	return error;
}
