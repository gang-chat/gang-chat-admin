import test from 'node:test';
import assert from 'node:assert/strict';
import {
	isS3NotFoundError,
	appcastPointsAtKey,
	latestYmlPointsAtFile,
	releaseKeyIsCleared,
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

test('S3 release sync uploads the Sparkle appcast last under its fixed name', () => {
	const selected = selectReleaseAssetsForSync(
		[
			{ name: 'appcast.xml' },
			{ name: 'GangChat_v1.2.3.dmg' },
			{ name: 'GangChat_v1.2.3.exe' },
			{ name: 'GangChat_v1.2.3.apk' }
		],
		'GangChat',
		'v1.2.3'
	);

	assert.deepEqual(
		selected.map((item) => item.outputName),
		['GangChat_v1.2.3.dmg', 'GangChat_v1.2.3.exe', 'GangChat_v1.2.3.apk', 'appcast.xml']
	);
});

test('S3 release sync publishes the Electron update feeds after the installers', () => {
	const selected = selectReleaseAssetsForSync(
		[
			{ name: 'appcast.xml' },
			{ name: 'GangChat-1.2.3-windows.zip' },
			{ name: 'GangChat_v1.2.3.apk' },
			{ name: 'GangChat_v1.2.3.dmg' },
			{ name: 'GangChat_v1.2.3.exe' },
			{ name: 'GangChat_v1.2.3.exe.blockmap' },
			{ name: 'latest.yml' }
		],
		'GangChat',
		'v1.2.3'
	);

	assert.deepEqual(
		selected.map((item) => ({ source: item.asset.name, output: item.outputName })),
		[
			{ source: 'GangChat_v1.2.3.apk', output: 'GangChat_v1.2.3.apk' },
			{ source: 'GangChat_v1.2.3.dmg', output: 'GangChat_v1.2.3.dmg' },
			{ source: 'GangChat_v1.2.3.exe', output: 'GangChat_v1.2.3.exe' },
			{ source: 'GangChat_v1.2.3.exe.blockmap', output: 'GangChat_v1.2.3.exe.blockmap' },
			{ source: 'appcast.xml', output: 'appcast.xml' },
			{ source: 'latest.yml', output: 'latest.yml' }
		]
	);
});

test('S3 release sync renames the blockmap with its installer', () => {
	const selected = selectReleaseAssetsForSync(
		[{ name: 'Setup.exe' }, { name: 'Other.exe.blockmap' }, { name: 'setup.exe.blockmap' }],
		'GangChat',
		'v1.2.3'
	);

	assert.deepEqual(
		selected.map((item) => ({ source: item.asset.name, output: item.outputName })),
		[
			{ source: 'Setup.exe', output: 'GangChat_v1.2.3.exe' },
			{ source: 'setup.exe.blockmap', output: 'GangChat_v1.2.3.exe.blockmap' }
		]
	);
});

test('latest.yml check requires every file to be the synced installer', () => {
	const latestYml = (name: string) => `version: 1.2.3
files:
  - url: ${name}
    sha512: abc==
    size: 101713257
path: ${name}
sha512: abc==
releaseDate: '2026-10-16T19:21:39.078Z'
`;

	assert.equal(
		latestYmlPointsAtFile(latestYml('GangChat_v1.2.3.exe'), 'GangChat_v1.2.3.exe'),
		true
	);
	assert.equal(
		latestYmlPointsAtFile(latestYml("'GangChat_v1.2.3.exe'"), 'GangChat_v1.2.3.exe'),
		true
	);
	assert.equal(
		latestYmlPointsAtFile(latestYml('GangChat_v1.2.2.exe'), 'GangChat_v1.2.3.exe'),
		false
	);
	assert.equal(latestYmlPointsAtFile('version: 1.2.3\n', 'GangChat_v1.2.3.exe'), false);
});

test('S3 release sync keeps earlier blockmaps for differential updates', () => {
	assert.equal(releaseKeyIsCleared('releases/GangChat_v1.2.2.exe'), true);
	assert.equal(releaseKeyIsCleared('releases/latest.yml'), true);
	assert.equal(releaseKeyIsCleared('releases/GangChat_v1.2.2.exe.blockmap'), false);
});

test('Sparkle appcast check requires every enclosure to download the synced DMG', () => {
	const appcast = (url: string) =>
		`<rss><channel><item><enclosure url="${url}" sparkle:edSignature="x" length="1"/></item></channel></rss>`;
	const key = 'releases/GangChat_v1.2.3.dmg';

	assert.equal(
		appcastPointsAtKey(
			appcast('https://os.ky-z.com:9000/gang-chat/releases/GangChat_v1.2.3.dmg'),
			key
		),
		true
	);
	assert.equal(
		appcastPointsAtKey(
			appcast('https://os.ky-z.com:9000/gang-chat/releases/GangChat_v1.2.2.dmg'),
			key
		),
		false
	);
	assert.equal(appcastPointsAtKey('<rss><channel/></rss>', key), false);
	assert.equal(appcastPointsAtKey(appcast('not a url'), key), false);
});
