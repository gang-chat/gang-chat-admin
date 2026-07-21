import test from 'node:test';
import assert from 'node:assert/strict';
import {
	isS3NotFoundError,
	selectReleaseAssetsForSync,
	validateBucketName,
	validateObjectKey
} from '../src/modules/s3/s3.service';
import {
	s3BucketNameSchema,
	s3ObjectKeySchema,
	s3ObjectQuerySchema,
	s3UploadFieldsSchema
} from '../src/modules/s3/s3.schema';

test('S3 object query schema defaults pagination controls', () => {
	const parsed = s3ObjectQuerySchema.parse({ bucket: 'logs' });

	assert.equal(parsed.bucket, 'logs');
	assert.equal(parsed.prefix, '');
	assert.equal(parsed.maxKeys, 500);
	assert.equal(parsed.continuationToken, undefined);
});

test('S3 object query schema bounds page size', () => {
	assert.equal(s3ObjectQuerySchema.safeParse({ bucket: 'logs', maxKeys: 1000 }).success, true);
	assert.equal(s3ObjectQuerySchema.safeParse({ bucket: 'logs', maxKeys: 1001 }).success, false);
	assert.equal(s3ObjectQuerySchema.safeParse({ bucket: 'logs', maxKeys: 0 }).success, false);
});

test('S3 upload field schema defaults to no-overwrite and parses explicit overwrite', () => {
	const safe = s3UploadFieldsSchema.parse({ bucket: 'logs', key: 'app.log' });
	const overwrite = s3UploadFieldsSchema.parse({
		bucket: 'logs',
		key: 'app.log',
		overwrite: 'true',
		overwriteConfirmation: 'app.log'
	});

	assert.equal(safe.overwrite, false);
	assert.equal(safe.overwriteConfirmation, undefined);
	assert.equal(overwrite.overwrite, true);
	assert.equal(overwrite.overwriteConfirmation, 'app.log');
	assert.equal(
		s3UploadFieldsSchema.parse({ bucket: 'logs', key: 'app.log', overwrite: 'false' }).overwrite,
		false
	);
});

test('S3 upload field schema accepts upload headers and custom metadata', () => {
	const parsed = s3UploadFieldsSchema.parse({
		bucket: 'logs',
		key: 'app.log',
		contentType: ' text/plain ',
		cacheControl: 'public, max-age=3600',
		contentDisposition: 'attachment; filename="app.log"',
		metadata: '{"env":"prod","owner":"ops"}'
	});

	assert.equal(parsed.contentType, 'text/plain');
	assert.equal(parsed.cacheControl, 'public, max-age=3600');
	assert.equal(parsed.contentDisposition, 'attachment; filename="app.log"');
	assert.deepEqual(parsed.metadata, { env: 'prod', owner: 'ops' });
});

test('S3 upload field schema rejects unsafe custom metadata', () => {
	const base = { bucket: 'logs', key: 'app.log' };

	assert.equal(s3UploadFieldsSchema.safeParse({ ...base, metadata: '{' }).success, false);
	assert.equal(
		s3UploadFieldsSchema.safeParse({ ...base, metadata: '{"x-amz-meta-env":"prod"}' }).success,
		false
	);
	assert.equal(
		s3UploadFieldsSchema.safeParse({ ...base, metadata: '{"bad key":"prod"}' }).success,
		false
	);
	assert.equal(s3UploadFieldsSchema.safeParse({ ...base, metadata: '{"env":1}' }).success, false);
	assert.equal(
		s3UploadFieldsSchema.safeParse({ ...base, metadata: '{"env":"prod\\u0000"}' }).success,
		false
	);
});

test('S3 bucket and object key schemas reject unsafe target names', () => {
	assert.equal(s3BucketNameSchema.safeParse('logs/prod').success, false);
	assert.equal(s3BucketNameSchema.safeParse('logs\u0000prod').success, false);
	assert.equal(s3ObjectKeySchema.safeParse('/prod/app.log').success, false);
	assert.equal(s3ObjectKeySchema.safeParse('prod/../app.log').success, false);
	assert.equal(s3ObjectKeySchema.safeParse('prod/app\u0000.log').success, false);
	assert.equal(validateBucketName(' logs '), 'logs');
	assert.equal(validateObjectKey('prod/app.log'), 'prod/app.log');
});

test('S3 not-found helper recognizes common SDK not-found shapes', () => {
	assert.equal(isS3NotFoundError({ name: 'NotFound' }), true);
	assert.equal(isS3NotFoundError({ name: 'NoSuchKey' }), true);
	assert.equal(isS3NotFoundError({ $metadata: { httpStatusCode: 404 } }), true);
	assert.equal(
		isS3NotFoundError({ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }),
		false
	);
});

test('S3 release sync selects first dmg, exe, and apk with configured names', () => {
	const selected = selectReleaseAssetsForSync(
		[
			{ name: 'app.zip' },
			{ name: 'mac-a.dmg' },
			{ name: 'mac-b.dmg' },
			{ name: 'win-a.exe' },
			{ name: 'win-b.exe' },
			{ name: 'android-a.APK' },
			{ name: 'android-b.apk' }
		],
		'GangChat',
		'v1.2.3'
	);

	assert.deepEqual(
		selected.map((item) => ({ source: item.asset.name, output: item.outputName })),
		[
			{ source: 'mac-a.dmg', output: 'GangChat_v1.2.3.dmg' },
			{ source: 'win-a.exe', output: 'GangChat_v1.2.3.exe' },
			{ source: 'android-a.APK', output: 'GangChat_v1.2.3.apk' }
		]
	);
});
