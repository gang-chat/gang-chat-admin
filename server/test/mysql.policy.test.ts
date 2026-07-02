import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSql, limitRows, prepareSql } from '../src/modules/mysql/mysql.policy';
import { HttpError } from '../src/core/http';

test('SQL policy defaults to read-only and adds select timeout hints', () => {
	const prepared = prepareSql('SELECT * FROM users;', {});

	assert.equal(prepared.policy.mode, 'read-only');
	assert.equal(prepared.policy.maxRows, 200);
	assert.equal(prepared.policy.timeoutMs, 10_000);
	assert.equal(prepared.analysis.mutation, false);
	assert.match(prepared.sql, /^SELECT \/\*\+ MAX_EXECUTION_TIME\(10000\) \*\/ \* FROM users$/);
});

test('SQL policy rejects mutations unless explicitly allowed', () => {
	assert.throws(
		() => prepareSql('DELETE FROM users WHERE id = 1', { mode: 'read-only' }),
		(error) => error instanceof HttpError && error.code === 'READ_ONLY_SQL'
	);

	assert.throws(
		() => prepareSql('DELETE FROM users WHERE id = 1', { mode: 'allow-mutations' }),
		(error) => error instanceof HttpError && error.code === 'DESTRUCTIVE_CONFIRMATION_REQUIRED'
	);

	const prepared = prepareSql('DELETE FROM users WHERE id = 1', {
		mode: 'allow-mutations',
		mutationConfirmation: 'RUN MUTATION'
	});
	assert.equal(prepared.analysis.mutation, true);
	assert.equal(prepared.sql, 'DELETE FROM users WHERE id = 1');
});

test('SQL policy rejects multiple statements while ignoring strings and comments', () => {
	assert.doesNotThrow(() => prepareSql("SELECT ';' AS semicolon; -- trailing comment", {}));
	assert.doesNotThrow(() => prepareSql('SELECT 1 /* ; inside comment */;', {}));
	assert.throws(
		() => prepareSql('SELECT 1; SELECT 2', {}),
		(error) => error instanceof HttpError && error.code === 'MULTIPLE_SQL_STATEMENTS'
	);
});

test('SQL analysis classifies common statement groups', () => {
	assert.equal(analyzeSql('/* leading */ SHOW TABLES').statementType, 'read');
	assert.equal(analyzeSql('UPDATE users SET name = "x"').statementType, 'mutation');
	assert.equal(analyzeSql('BEGIN').statementType, 'unsafe');
	assert.equal(analyzeSql('KILL 1').statementType, 'unknown');
});

test('SQL result limiting caps returned rows without mutating the source array', () => {
	const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
	const limited = limitRows(rows, 2);

	assert.equal(limited.limited, true);
	assert.deepEqual(limited.rows, [{ id: 1 }, { id: 2 }]);
	assert.equal(rows.length, 3);
});
