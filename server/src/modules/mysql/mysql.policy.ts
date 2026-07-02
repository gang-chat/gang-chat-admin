import { HttpError } from '../../core/http';

export type MysqlSqlMode = 'read-only' | 'allow-mutations';

export type MysqlSqlPolicyInput = {
	mode?: MysqlSqlMode;
	maxRows?: number;
	timeoutMs?: number;
	mutationConfirmation?: string;
};

export type MysqlSqlPolicy = {
	mode: MysqlSqlMode;
	maxRows: number;
	timeoutMs: number;
};

export type MysqlSqlAnalysis = {
	sql: string;
	firstKeyword: string;
	statementType: 'read' | 'mutation' | 'unsafe' | 'unknown';
	mutation: boolean;
};

const DEFAULT_POLICY: MysqlSqlPolicy = {
	mode: 'read-only',
	maxRows: 200,
	timeoutMs: 10_000
};

const MUTATION_KEYWORDS = new Set([
	'alter',
	'analyze',
	'call',
	'create',
	'delete',
	'drop',
	'grant',
	'insert',
	'load',
	'lock',
	'optimize',
	'replace',
	'revoke',
	'set',
	'truncate',
	'update'
]);

const READ_KEYWORDS = new Set(['desc', 'describe', 'explain', 'select', 'show', 'with']);
const UNSAFE_KEYWORDS = new Set(['begin', 'commit', 'rollback', 'savepoint', 'start', 'use']);

export function normalizeSqlPolicy(input: MysqlSqlPolicyInput = {}): MysqlSqlPolicy {
	return {
		mode: input.mode ?? DEFAULT_POLICY.mode,
		maxRows: input.maxRows ?? DEFAULT_POLICY.maxRows,
		timeoutMs: input.timeoutMs ?? DEFAULT_POLICY.timeoutMs
	};
}

export function prepareSql(sql: string, input: MysqlSqlPolicyInput = {}) {
	const trimmed = sql.trim();
	if (!trimmed) throw new HttpError(400, 'EMPTY_SQL', 'SQL cannot be empty');

	const policy = normalizeSqlPolicy(input);
	if (hasMultipleStatements(trimmed)) {
		throw new HttpError(400, 'MULTIPLE_SQL_STATEMENTS', 'Only one SQL statement is allowed');
	}

	const analysis = analyzeSql(trimmed);
	if (analysis.statementType === 'unsafe') {
		throw new HttpError(
			400,
			'UNSAFE_SQL_STATEMENT',
			'Transaction and session-control SQL is disabled'
		);
	}
	if (policy.mode === 'read-only' && analysis.statementType !== 'read') {
		throw new HttpError(400, 'READ_ONLY_SQL', 'Read-only mode only allows read SQL statements');
	}
	if (
		policy.mode === 'allow-mutations' &&
		analysis.statementType === 'mutation' &&
		input.mutationConfirmation !== 'RUN MUTATION'
	) {
		throw new HttpError(
			400,
			'DESTRUCTIVE_CONFIRMATION_REQUIRED',
			'Type RUN MUTATION to execute mutation SQL'
		);
	}

	return {
		sql: withMaxExecutionHint(trimTrailingSemicolon(trimmed), policy.timeoutMs),
		policy,
		analysis
	};
}

export function analyzeSql(sql: string): MysqlSqlAnalysis {
	const withoutComments = stripCommentsAndLiterals(sql).trimStart();
	const firstKeyword = withoutComments.match(/^[a-z_]+/i)?.[0].toLowerCase() ?? '';
	const statementType = classifyKeyword(firstKeyword);

	return {
		sql,
		firstKeyword,
		statementType,
		mutation: statementType === 'mutation'
	};
}

export function limitRows(rows: Record<string, unknown>[], maxRows: number) {
	if (rows.length <= maxRows) return { rows, limited: false };
	return { rows: rows.slice(0, maxRows), limited: true };
}

function classifyKeyword(keyword: string): MysqlSqlAnalysis['statementType'] {
	if (READ_KEYWORDS.has(keyword)) return 'read';
	if (MUTATION_KEYWORDS.has(keyword)) return 'mutation';
	if (UNSAFE_KEYWORDS.has(keyword)) return 'unsafe';
	return 'unknown';
}

function hasMultipleStatements(sql: string) {
	const semicolons = findStatementSemicolons(sql);
	return semicolons.some((index) => hasSqlContent(sql.slice(index + 1)));
}

function hasSqlContent(fragment: string) {
	return stripCommentsAndLiterals(fragment).replaceAll(';', '').trim().length > 0;
}

function trimTrailingSemicolon(sql: string) {
	let next = sql.trim();
	while (next.endsWith(';')) next = next.slice(0, -1).trimEnd();
	return next;
}

function withMaxExecutionHint(sql: string, timeoutMs: number) {
	if (/^\s*select\b/i.test(sql)) {
		return sql.replace(
			/^\s*select\b/i,
			(match) => `${match} /*+ MAX_EXECUTION_TIME(${timeoutMs}) */`
		);
	}
	return sql;
}

function findStatementSemicolons(sql: string) {
	const semicolons: number[] = [];
	let state: 'normal' | 'single' | 'double' | 'backtick' | 'line-comment' | 'block-comment' =
		'normal';

	for (let index = 0; index < sql.length; index += 1) {
		const char = sql[index];
		const next = sql[index + 1];

		if (state === 'line-comment') {
			if (char === '\n') state = 'normal';
			continue;
		}
		if (state === 'block-comment') {
			if (char === '*' && next === '/') {
				index += 1;
				state = 'normal';
			}
			continue;
		}
		if (state === 'single') {
			if (char === '\\') index += 1;
			else if (char === "'") state = 'normal';
			continue;
		}
		if (state === 'double') {
			if (char === '\\') index += 1;
			else if (char === '"') state = 'normal';
			continue;
		}
		if (state === 'backtick') {
			if (char === '`') state = 'normal';
			continue;
		}

		if (char === '-' && next === '-') {
			state = 'line-comment';
			index += 1;
		} else if (char === '#') {
			state = 'line-comment';
		} else if (char === '/' && next === '*') {
			state = 'block-comment';
			index += 1;
		} else if (char === "'") {
			state = 'single';
		} else if (char === '"') {
			state = 'double';
		} else if (char === '`') {
			state = 'backtick';
		} else if (char === ';') {
			semicolons.push(index);
		}
	}

	return semicolons;
}

function stripCommentsAndLiterals(sql: string) {
	let output = '';
	let state: 'normal' | 'single' | 'double' | 'backtick' | 'line-comment' | 'block-comment' =
		'normal';

	for (let index = 0; index < sql.length; index += 1) {
		const char = sql[index];
		const next = sql[index + 1];

		if (state === 'line-comment') {
			if (char === '\n') {
				output += '\n';
				state = 'normal';
			} else {
				output += ' ';
			}
			continue;
		}
		if (state === 'block-comment') {
			if (char === '*' && next === '/') {
				output += '  ';
				index += 1;
				state = 'normal';
			} else {
				output += char === '\n' ? '\n' : ' ';
			}
			continue;
		}
		if (state === 'single') {
			if (char === '\\') {
				output += '  ';
				index += 1;
			} else if (char === "'") {
				output += ' ';
				state = 'normal';
			} else {
				output += char === '\n' ? '\n' : ' ';
			}
			continue;
		}
		if (state === 'double') {
			if (char === '\\') {
				output += '  ';
				index += 1;
			} else if (char === '"') {
				output += ' ';
				state = 'normal';
			} else {
				output += char === '\n' ? '\n' : ' ';
			}
			continue;
		}
		if (state === 'backtick') {
			if (char === '`') {
				output += ' ';
				state = 'normal';
			} else {
				output += char === '\n' ? '\n' : ' ';
			}
			continue;
		}

		if (char === '-' && next === '-') {
			output += '  ';
			state = 'line-comment';
			index += 1;
		} else if (char === '#') {
			output += ' ';
			state = 'line-comment';
		} else if (char === '/' && next === '*') {
			output += '  ';
			state = 'block-comment';
			index += 1;
		} else if (char === "'") {
			output += ' ';
			state = 'single';
		} else if (char === '"') {
			output += ' ';
			state = 'double';
		} else if (char === '`') {
			output += ' ';
			state = 'backtick';
		} else {
			output += char;
		}
	}

	return output;
}
