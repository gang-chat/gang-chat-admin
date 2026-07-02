import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../src/core/http';
import {
	validateMutationColumns,
	validateUniqueRowKey,
	type MysqlUniqueIndex
} from '../src/modules/mysql/mysql.service';
import type { MysqlColumn } from '../../src/lib/shared/ops-types';

const columns: MysqlColumn[] = [
	{
		field: 'id',
		type: 'int',
		nullable: false,
		key: 'PRI',
		defaultValue: null,
		extra: 'auto_increment'
	},
	{
		field: 'tenant_id',
		type: 'varchar(64)',
		nullable: false,
		key: 'UNI',
		defaultValue: null,
		extra: ''
	},
	{
		field: 'email',
		type: 'varchar(255)',
		nullable: false,
		key: 'UNI',
		defaultValue: null,
		extra: ''
	},
	{
		field: 'name',
		type: 'varchar(255)',
		nullable: true,
		key: '',
		defaultValue: null,
		extra: ''
	}
];

const indexes: MysqlUniqueIndex[] = [
	{ name: 'PRIMARY', columns: ['id'], primary: true },
	{ name: 'tenant_email', columns: ['tenant_id', 'email'], primary: false }
];

test('MySQL row key validation accepts exact primary or unique indexes', () => {
	const primary = validateUniqueRowKey(indexes, { id: 1 });
	const composite = validateUniqueRowKey(indexes, {
		tenant_id: 'gang',
		email: 'ops@example.com'
	});

	assert.equal(primary.index.name, 'PRIMARY');
	assert.deepEqual(primary.values, { id: 1 });
	assert.equal(composite.index.name, 'tenant_email');
	assert.deepEqual(composite.values, { tenant_id: 'gang', email: 'ops@example.com' });
});

test('MySQL row key validation rejects missing, partial, extra, null or non-unique keys', () => {
	const cases = [
		{},
		{ tenant_id: 'gang' },
		{ tenant_id: 'gang', email: 'ops@example.com', id: 1 },
		{ name: 'Alice' },
		{ id: null }
	];

	for (const value of cases) {
		assert.throws(
			() => validateUniqueRowKey(indexes, value),
			(error) => error instanceof HttpError
		);
	}
	assert.throws(
		() => validateUniqueRowKey([], { id: 1 }),
		(error) => error instanceof HttpError && error.code === 'MISSING_UNIQUE_KEY'
	);
});

test('MySQL mutation column validation rejects unknown and key columns', () => {
	assert.doesNotThrow(() =>
		validateMutationColumns(columns, { name: 'Alice' }, new Set(['id']), 'update')
	);
	assert.throws(
		() => validateMutationColumns(columns, { missing: true }, new Set(), 'insert'),
		(error) => error instanceof HttpError && error.code === 'UNKNOWN_COLUMN'
	);
	assert.throws(
		() => validateMutationColumns(columns, { id: 2 }, new Set(['id']), 'update'),
		(error) => error instanceof HttpError && error.code === 'UNSAFE_ROW_PATCH'
	);
});
