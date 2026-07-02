import mysql, { type PoolOptions, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import type {
	MysqlColumn,
	MysqlPublicConfig,
	MysqlQueryResult,
	MysqlTableSummary
} from '../../../../src/lib/shared/ops-types';
import { HttpError } from '../../core/http';
import type { ConnectionsRepository } from '../connections/connections.repository';
import { limitRows, prepareSql, type MysqlSqlPolicyInput } from './mysql.policy';

type MysqlSecret = {
	password?: string;
};

export type MysqlUniqueIndex = {
	name: string;
	columns: string[];
	primary: boolean;
};

export class MysqlService {
	constructor(private readonly connections: ConnectionsRepository) {}

	async test(connectionId: string) {
		const pool = await this.pool(connectionId);
		try {
			await pool.query('SELECT 1 AS ok');
		} finally {
			await pool.end();
		}
	}

	async listTables(connectionId: string): Promise<MysqlTableSummary[]> {
		const pool = await this.pool(connectionId);
		try {
			const [rows] = await pool.query<RowDataPacket[]>('SHOW TABLE STATUS');
			return rows.map((row) => ({
				name: String(row.Name),
				rows: Number(row.Rows ?? 0),
				engine: row.Engine ? String(row.Engine) : undefined,
				updatedAt: row.Update_time ? new Date(row.Update_time).toISOString() : undefined
			}));
		} finally {
			await pool.end();
		}
	}

	async describeTable(connectionId: string, table: string): Promise<MysqlColumn[]> {
		const pool = await this.pool(connectionId);
		try {
			return await describeColumns(pool, table);
		} finally {
			await pool.end();
		}
	}

	async readRows(connectionId: string, table: string, limit = 100, offset = 0) {
		const safeLimit = Math.min(Math.max(limit, 1), 500);
		const safeOffset = Math.max(offset, 0);
		const pool = await this.pool(connectionId);
		try {
			const [rows] = await pool.query<RowDataPacket[]>(
				`SELECT * FROM ${quoteIdentifier(table)} LIMIT ? OFFSET ?`,
				[safeLimit, safeOffset]
			);
			return rows.map(normalizeRow);
		} finally {
			await pool.end();
		}
	}

	async insertRow(connectionId: string, table: string, row: Record<string, unknown>) {
		await this.assertMutationsAllowed(connectionId);
		const entries = Object.entries(row).filter(([, value]) => value !== undefined);
		if (entries.length === 0) throw new HttpError(400, 'EMPTY_ROW', 'Insert row cannot be empty');

		const columns = entries.map(([key]) => quoteIdentifier(key)).join(', ');
		const placeholders = entries.map(() => '?').join(', ');
		const values = entries.map(([, value]) => value);
		const pool = await this.pool(connectionId);
		try {
			const columnsMetadata = await describeColumns(pool, table);
			validateMutationColumns(columnsMetadata, row, new Set(), 'insert');
			const [result] = await pool.execute<ResultSetHeader>(
				`INSERT INTO ${quoteIdentifier(table)} (${columns}) VALUES (${placeholders})`,
				values as never[]
			);
			return result;
		} finally {
			await pool.end();
		}
	}

	async updateRow(
		connectionId: string,
		table: string,
		primaryKey: Record<string, unknown>,
		patch: Record<string, unknown>
	) {
		await this.assertMutationsAllowed(connectionId);
		const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
		if (entries.length === 0)
			throw new HttpError(400, 'EMPTY_PATCH', 'Update patch cannot be empty');
		const pool = await this.pool(connectionId);
		try {
			const metadata = await tableMutationMetadata(pool, table);
			const key = validateUniqueRowKey(metadata.uniqueIndexes, primaryKey);
			validateMutationColumns(metadata.columns, patch, new Set(key.columns), 'update');
			const where = buildWhere(key.values);
			await assertExactlyOneMatch(pool, table, where);
			const assignments = entries.map(([key]) => `${quoteIdentifier(key)} = ?`).join(', ');
			const [result] = await pool.execute<ResultSetHeader>(
				`UPDATE ${quoteIdentifier(table)} SET ${assignments} WHERE ${where.sql}`,
				[...entries.map(([, value]) => value), ...where.values] as never[]
			);
			assertMutationAffectedAtMostOne(result.affectedRows);
			return result;
		} finally {
			await pool.end();
		}
	}

	async deleteRow(connectionId: string, table: string, primaryKey: Record<string, unknown>) {
		await this.assertMutationsAllowed(connectionId);
		const pool = await this.pool(connectionId);
		try {
			const metadata = await tableMutationMetadata(pool, table);
			const key = validateUniqueRowKey(metadata.uniqueIndexes, primaryKey);
			const where = buildWhere(key.values);
			await assertExactlyOneMatch(pool, table, where);
			const [result] = await pool.execute<ResultSetHeader>(
				`DELETE FROM ${quoteIdentifier(table)} WHERE ${where.sql}`,
				where.values as never[]
			);
			assertMutationAffectedAtMostOne(result.affectedRows);
			return result;
		} finally {
			await pool.end();
		}
	}

	async query(
		connectionId: string,
		sql: string,
		policyInput: MysqlSqlPolicyInput = {}
	): Promise<MysqlQueryResult> {
		const prepared = prepareSql(sql, policyInput);
		if (prepared.analysis.mutation) await this.assertMutationsAllowed(connectionId);
		const started = performance.now();
		const pool = await this.pool(connectionId);
		try {
			const [rows, fields] = await pool.query({
				sql: prepared.sql,
				timeout: prepared.policy.timeoutMs
			});
			const executionMs = Math.round(performance.now() - started);
			if (Array.isArray(rows)) {
				const limited = limitRows(
					(rows as RowDataPacket[]).map(normalizeRow),
					prepared.policy.maxRows
				);
				return {
					rows: limited.rows,
					fields: fields.map((field) => field.name),
					executionMs,
					mutation: prepared.analysis.mutation,
					limited: limited.limited,
					policy: prepared.policy
				};
			}

			const result = rows as ResultSetHeader;
			return {
				rows: [],
				fields: [],
				affectedRows: result.affectedRows,
				warningStatus: result.warningStatus,
				executionMs,
				mutation: prepared.analysis.mutation,
				limited: false,
				policy: prepared.policy
			};
		} finally {
			await pool.end();
		}
	}

	private async pool(connectionId: string) {
		const preset = await this.connections.getWithSecrets(connectionId);
		if (preset.type !== 'mysql') {
			throw new HttpError(400, 'WRONG_CONNECTION_TYPE', 'Connection preset is not MySQL');
		}
		const config = preset.config as MysqlPublicConfig;
		const secrets = preset.secrets as MysqlSecret;
		const options: PoolOptions = {
			host: config.host,
			port: config.port,
			database: config.database,
			user: config.user,
			password: secrets.password,
			ssl: config.ssl ? {} : undefined,
			connectionLimit: 5,
			waitForConnections: true,
			queueLimit: 0,
			multipleStatements: false,
			connectTimeout: 10_000
		};
		return mysql.createPool(options);
	}

	private async assertMutationsAllowed(connectionId: string) {
		const preset = await this.connections.get(connectionId);
		if (preset.type !== 'mysql') {
			throw new HttpError(400, 'WRONG_CONNECTION_TYPE', 'Connection preset is not MySQL');
		}
		const config = preset.config as MysqlPublicConfig;
		if (!config.allowMutations) {
			throw new HttpError(
				403,
				'MYSQL_MUTATIONS_DISABLED',
				'MySQL mutations are disabled for this connection preset'
			);
		}
	}
}

async function describeColumns(
	pool: Awaited<ReturnType<typeof mysql.createPool>>,
	table: string
): Promise<MysqlColumn[]> {
	const [rows] = await pool.query<RowDataPacket[]>(`DESCRIBE ${quoteIdentifier(table)}`);
	return rows.map((row) => ({
		field: String(row.Field),
		type: String(row.Type),
		nullable: row.Null === 'YES',
		key: String(row.Key ?? ''),
		defaultValue: row.Default,
		extra: String(row.Extra ?? '')
	}));
}

async function tableMutationMetadata(
	pool: Awaited<ReturnType<typeof mysql.createPool>>,
	table: string
) {
	const [indexRows] = await pool.query<RowDataPacket[]>(
		[
			'SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX, NON_UNIQUE',
			'FROM INFORMATION_SCHEMA.STATISTICS',
			'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND NON_UNIQUE = 0',
			'ORDER BY INDEX_NAME, SEQ_IN_INDEX'
		].join(' '),
		[table]
	);
	return {
		columns: await describeColumns(pool, table),
		uniqueIndexes: uniqueIndexesFromRows(indexRows)
	};
}

function uniqueIndexesFromRows(rows: RowDataPacket[]): MysqlUniqueIndex[] {
	const byName = new Map<string, MysqlUniqueIndex>();
	for (const row of rows) {
		const name = String(row.INDEX_NAME);
		const index =
			byName.get(name) ??
			({
				name,
				columns: [],
				primary: name === 'PRIMARY'
			} satisfies MysqlUniqueIndex);
		index.columns.push(String(row.COLUMN_NAME));
		byName.set(name, index);
	}
	return [...byName.values()].sort((left, right) => {
		if (left.primary !== right.primary) return left.primary ? -1 : 1;
		return left.columns.length - right.columns.length;
	});
}

function quoteIdentifier(value: string) {
	if (!/^[\w$]+$/.test(value)) {
		return `\`${value.replaceAll('`', '``')}\``;
	}
	return `\`${value}\``;
}

export function validateUniqueRowKey(
	indexes: MysqlUniqueIndex[],
	primaryKey: Record<string, unknown>
) {
	const entries = Object.entries(primaryKey).filter(([, value]) => value !== undefined);
	if (entries.length === 0) {
		throw new HttpError(400, 'MISSING_PRIMARY_KEY', 'Primary key values are required');
	}
	if (entries.some(([, value]) => value === null)) {
		throw new HttpError(400, 'UNSAFE_ROW_KEY', 'Row key values cannot be null');
	}
	if (indexes.length === 0) {
		throw new HttpError(
			400,
			'MISSING_UNIQUE_KEY',
			'Row update/delete requires a primary key or unique index'
		);
	}
	const provided = new Set(entries.map(([key]) => key));
	const matched = indexes.find(
		(index) =>
			index.columns.length === provided.size &&
			index.columns.every((column) => provided.has(column))
	);
	if (!matched) {
		throw new HttpError(
			400,
			'UNSAFE_ROW_KEY',
			'Row key must exactly match a primary key or unique index'
		);
	}
	return {
		index: matched,
		columns: matched.columns,
		values: Object.fromEntries(matched.columns.map((column) => [column, primaryKey[column]]))
	};
}

export function validateMutationColumns(
	columns: MysqlColumn[],
	values: Record<string, unknown>,
	readOnlyColumns: Set<string>,
	operation: 'insert' | 'update'
) {
	const knownColumns = new Set(columns.map((column) => column.field));
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) continue;
		if (!knownColumns.has(key)) {
			throw new HttpError(400, 'UNKNOWN_COLUMN', `Unknown column: ${key}`);
		}
		if (readOnlyColumns.has(key)) {
			throw new HttpError(400, 'UNSAFE_ROW_PATCH', `Cannot ${operation} key column: ${key}`);
		}
	}
}

function buildWhere(primaryKey: Record<string, unknown>) {
	const entries = Object.entries(primaryKey).filter(([, value]) => value !== undefined);
	return {
		sql: entries.map(([key]) => `${quoteIdentifier(key)} = ?`).join(' AND '),
		values: entries.map(([, value]) => value)
	};
}

async function assertExactlyOneMatch(
	pool: Awaited<ReturnType<typeof mysql.createPool>>,
	table: string,
	where: ReturnType<typeof buildWhere>
) {
	const [rows] = await pool.execute<RowDataPacket[]>(
		`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)} WHERE ${where.sql}`,
		where.values as never[]
	);
	const count = Number(rows[0]?.count ?? 0);
	if (count !== 1) {
		throw new HttpError(
			409,
			'ROW_MATCH_NOT_EXACT',
			`Row key matched ${count} rows; expected exactly 1`
		);
	}
}

function assertMutationAffectedAtMostOne(affectedRows: number) {
	if (affectedRows > 1) {
		throw new HttpError(409, 'ROW_MUTATION_TOO_BROAD', 'Row mutation affected more than one row');
	}
}

function normalizeRow(row: RowDataPacket) {
	return Object.fromEntries(
		Object.entries(row).map(([key, value]) => [
			key,
			value instanceof Date
				? value.toISOString()
				: Buffer.isBuffer(value)
					? value.toString('base64')
					: value
		])
	);
}
