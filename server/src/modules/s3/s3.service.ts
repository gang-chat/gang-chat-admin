import { Readable } from 'node:stream';
import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	S3Client
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { FastifyRequest } from 'fastify';
import type {
	S3ObjectList,
	S3ObjectMetadata,
	S3PublicConfig,
	S3ReleaseSyncConfig,
	S3ReleaseSyncResult,
	S3ReleaseVersion
} from '../../../../src/lib/shared/ops-types';
import type { ReleaseSyncConfig } from '../../config/config';
import { HttpError } from '../../core/http';
import { parseInput } from '../../core/validation';
import type { ConnectionsRepository } from '../connections/connections.repository';
import { s3BucketNameSchema, s3ObjectKeySchema, s3UploadFieldsSchema } from './s3.schema';

type S3Secret = {
	accessKeyId?: string;
	secretAccessKey?: string;
	sessionToken?: string;
};

type GitHubReleaseAsset = {
	id: number;
	name: string;
	size: number;
	url: string;
	browser_download_url?: string;
	content_type?: string;
};

type GitHubRelease = {
	id: number;
	tag_name: string;
	name?: string | null;
	html_url?: string;
	published_at?: string | null;
	prerelease?: boolean;
	draft?: boolean;
	assets?: GitHubReleaseAsset[];
};

export class S3Service {
	constructor(
		private readonly connections: ConnectionsRepository,
		private readonly releaseSync: ReleaseSyncConfig | null = null
	) {}

	releaseSyncConfig(): S3ReleaseSyncConfig {
		if (!this.releaseSync) return { enabled: false };
		return {
			enabled: true,
			repository: `${this.releaseSync.owner}/${this.releaseSync.repo}`,
			repositoryUrl: this.releaseSync.repositoryUrl,
			targetPrefix: this.releaseSync.targetPrefix,
			assetPrefix: this.releaseSync.assetPrefix
		};
	}

	async listReleaseVersions(): Promise<S3ReleaseVersion[]> {
		const config = this.requireReleaseSync();
		const releases = await this.githubJson<GitHubRelease[]>(
			`/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/releases`
		);
		return releases
			.filter((release) => release.tag_name && !release.draft)
			.map((release) => ({
				id: release.id,
				tagName: release.tag_name,
				name: release.name ?? undefined,
				htmlUrl: release.html_url,
				publishedAt: release.published_at ?? undefined,
				prerelease: Boolean(release.prerelease),
				assetCount: syncableAssetCount(release.assets ?? [])
			}));
	}

	async syncRelease(
		connectionId: string,
		bucket: string,
		tagName: string
	): Promise<S3ReleaseSyncResult> {
		await this.assertWritesAllowed(connectionId);
		const config = this.requireReleaseSync();
		const safeBucket = validateBucketName(bucket);
		const safeTag = tagName.trim();
		if (!safeTag) throw new HttpError(400, 'INVALID_RELEASE_TAG', 'Release tag is required');

		const release = await this.githubJson<GitHubRelease>(
			`/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/releases/tags/${encodeURIComponent(safeTag)}`
		);
		const assets = release.assets ?? [];
		const selectedAssets = selectReleaseAssetsForSync(assets, config.assetPrefix, release.tag_name);
		if (selectedAssets.length === 0) {
			throw new HttpError(
				400,
				'GITHUB_RELEASE_HAS_NO_SUPPORTED_ASSETS',
				'Selected release has no .dmg or .exe assets'
			);
		}

		const client = await this.client(connectionId);
		const deleted = await this.clearPrefix(client, safeBucket, config.targetPrefix);
		const uploaded: S3ReleaseSyncResult['uploaded'] = [];

		for (const { asset, outputName } of selectedAssets) {
			const key = `${config.targetPrefix}${outputName}`;
			const response = await this.githubFetch(asset.url, {
				accept: 'application/octet-stream'
			});
			if (!response.body) {
				throw new HttpError(502, 'GITHUB_ASSET_DOWNLOAD_FAILED', `GitHub asset is empty: ${asset.name}`);
			}
			await new Upload({
				client,
				params: {
					Bucket: safeBucket,
					Key: key,
					Body: Readable.fromWeb(response.body as never),
					ContentType: asset.content_type || response.headers.get('content-type') || undefined,
					Metadata: {
						'github-repository': `${config.owner}/${config.repo}`,
						'github-release-tag': release.tag_name,
						'github-asset-id': String(asset.id)
					}
				}
			}).done();
			uploaded.push({
				name: outputName,
				sourceName: asset.name,
				key,
				size: asset.size,
				contentType: asset.content_type || response.headers.get('content-type') || undefined
			});
		}

		return {
			repository: `${config.owner}/${config.repo}`,
			tagName: release.tag_name,
			targetPrefix: config.targetPrefix,
			deleted,
			uploaded
		};
	}

	async listObjects(
		connectionId: string,
		bucket: string,
		prefix = '',
		options: { continuationToken?: string; maxKeys?: number } = {}
	): Promise<S3ObjectList> {
		const safeBucket = validateBucketName(bucket);
		const client = await this.client(connectionId);
		const result = await client.send(
			new ListObjectsV2Command({
				Bucket: safeBucket,
				Prefix: prefix || undefined,
				Delimiter: '/',
				ContinuationToken: options.continuationToken,
				MaxKeys: options.maxKeys ?? 500
			})
		);
		return {
			bucket: safeBucket,
			prefix,
			prefixes: (result.CommonPrefixes ?? [])
				.map((item) => item.Prefix ?? '')
				.filter((item) => item && item !== prefix),
			objects: (result.Contents ?? [])
				.map((object) => ({
					key: object.Key ?? '',
					size: object.Size ?? 0,
					etag: object.ETag,
					lastModified: object.LastModified?.toISOString(),
					storageClass: object.StorageClass
				}))
				.filter((object) => object.key && object.key !== prefix),
			isTruncated: Boolean(result.IsTruncated),
			nextContinuationToken: result.NextContinuationToken
		};
	}

	async uploadObject(
		connectionId: string,
		bucket: string,
		key: string,
		body: Buffer | string | Readable,
		options: {
			overwrite?: boolean;
			overwriteConfirmation?: string;
			contentType?: string;
			cacheControl?: string;
			contentDisposition?: string;
			metadata?: Record<string, string>;
		} = {}
	) {
		await this.assertWritesAllowed(connectionId);
		const safeBucket = validateBucketName(bucket);
		const safeKey = validateObjectKey(key);
		const client = await this.client(connectionId);
		if (!options.overwrite) {
			await this.assertObjectDoesNotExist(client, safeBucket, safeKey);
		} else if (options.overwriteConfirmation !== safeKey) {
			throw new HttpError(
				400,
				'DESTRUCTIVE_CONFIRMATION_REQUIRED',
				'Type the exact object key to overwrite it'
			);
		}
		await new Upload({
			client,
			params: {
				Bucket: safeBucket,
				Key: safeKey,
				Body: body,
				ContentType: options.contentType,
				CacheControl: options.cacheControl,
				ContentDisposition: options.contentDisposition,
				Metadata: options.metadata
			}
		}).done();
	}

	async uploadMultipart(connectionId: string, request: FastifyRequest) {
		await this.assertWritesAllowed(connectionId);
		const data = await request.file();
		if (!data) throw new HttpError(400, 'MISSING_FILE', 'Upload file is required');
		const fields = data.fields as Record<string, { value?: unknown } | undefined>;
		const parsed = parseInput(s3UploadFieldsSchema, {
			bucket: fields.bucket?.value,
			key: fields.key?.value ?? data.filename,
			overwrite: fields.overwrite?.value,
			overwriteConfirmation: fields.overwriteConfirmation?.value,
			contentType: fields.contentType?.value,
			cacheControl: fields.cacheControl?.value,
			contentDisposition: fields.contentDisposition?.value,
			metadata: fields.metadata?.value
		});
		await this.uploadObject(connectionId, parsed.bucket, parsed.key, data.file, {
			overwrite: parsed.overwrite,
			overwriteConfirmation: parsed.overwriteConfirmation,
			contentType: parsed.contentType ?? data.mimetype,
			cacheControl: parsed.cacheControl,
			contentDisposition: parsed.contentDisposition,
			metadata: parsed.metadata
		});
		return {
			bucket: parsed.bucket,
			key: parsed.key,
			overwritten: parsed.overwrite,
			contentType: parsed.contentType ?? data.mimetype,
			cacheControl: parsed.cacheControl,
			contentDisposition: parsed.contentDisposition,
			metadata: parsed.metadata ?? {},
			filename: data.filename
		};
	}

	async downloadObject(connectionId: string, bucket: string, key: string) {
		const safeBucket = validateBucketName(bucket);
		const safeKey = validateObjectKey(key);
		const client = await this.client(connectionId);
		return client.send(new GetObjectCommand({ Bucket: safeBucket, Key: safeKey }));
	}

	async headObject(connectionId: string, bucket: string, key: string): Promise<S3ObjectMetadata> {
		const safeBucket = validateBucketName(bucket);
		const safeKey = validateObjectKey(key);
		const client = await this.client(connectionId);
		const result = await client.send(new HeadObjectCommand({ Bucket: safeBucket, Key: safeKey }));
		return {
			bucket: safeBucket,
			key: safeKey,
			size: Number(result.ContentLength ?? 0),
			etag: result.ETag,
			lastModified: result.LastModified?.toISOString(),
			storageClass: result.StorageClass,
			contentType: result.ContentType,
			contentEncoding: result.ContentEncoding,
			cacheControl: result.CacheControl,
			contentDisposition: result.ContentDisposition,
			versionId: result.VersionId,
			metadata: Object.fromEntries(
				Object.entries(result.Metadata ?? {}).map(([name, value]) => [name, String(value)])
			)
		};
	}

	async deleteObject(connectionId: string, bucket: string, key: string) {
		await this.assertWritesAllowed(connectionId);
		const safeBucket = validateBucketName(bucket);
		const safeKey = validateObjectKey(key);
		const client = await this.client(connectionId);
		await client.send(new DeleteObjectCommand({ Bucket: safeBucket, Key: safeKey }));
	}

	async test(connectionId: string) {
		const preset = await this.connections.get(connectionId);
		if (preset.type !== 's3') {
			throw new HttpError(400, 'WRONG_CONNECTION_TYPE', 'Connection preset is not S3');
		}
		const config = preset.config as S3PublicConfig;
		if (!config.defaultBucket) {
			throw new HttpError(400, 'S3_BUCKET_NOT_CONFIGURED', 'S3 default bucket is not configured');
		}
		await this.listObjects(connectionId, config.defaultBucket, '', { maxKeys: 1 });
	}

	async assertWritesAllowed(connectionId: string) {
		const preset = await this.connections.get(connectionId);
		if (preset.type !== 's3') {
			throw new HttpError(400, 'WRONG_CONNECTION_TYPE', 'Connection preset is not S3');
		}
		const config = preset.config as S3PublicConfig;
		if (!config.allowWrites) {
			throw new HttpError(
				403,
				'S3_WRITES_DISABLED',
				'S3 writes are disabled for this connection preset'
			);
		}
	}

	private async client(connectionId: string) {
		const preset = await this.connections.getWithSecrets(connectionId);
		if (preset.type !== 's3') {
			throw new HttpError(400, 'WRONG_CONNECTION_TYPE', 'Connection preset is not S3');
		}
		const config = preset.config as S3PublicConfig;
		const secrets = preset.secrets as S3Secret;
		return new S3Client({
			region: config.region || 'auto',
			endpoint: config.endpoint || undefined,
			forcePathStyle: config.forcePathStyle,
			credentials:
				secrets.accessKeyId && secrets.secretAccessKey
					? {
							accessKeyId: secrets.accessKeyId,
							secretAccessKey: secrets.secretAccessKey,
							sessionToken: secrets.sessionToken
						}
					: undefined
		});
	}

	private async assertObjectDoesNotExist(client: S3Client, bucket: string, key: string) {
		try {
			await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
		} catch (error) {
			if (isS3NotFoundError(error)) return;
			throw error;
		}
		throw new HttpError(409, 'S3_OBJECT_ALREADY_EXISTS', 'Object already exists');
	}

	private requireReleaseSync() {
		if (!this.releaseSync) {
			throw new HttpError(
				404,
				'RELEASE_SYNC_NOT_CONFIGURED',
				'Configure releaseSync.repositoryUrl and releaseSync.targetPrefix in config.json'
			);
		}
		return this.releaseSync;
	}

	private async clearPrefix(client: S3Client, bucket: string, prefix: string) {
		if (!prefix.trim()) {
			throw new HttpError(400, 'INVALID_RELEASE_PREFIX', 'Release sync prefix cannot be empty');
		}
		const keys: string[] = [];
		let continuationToken: string | undefined;
		do {
			const result = await client.send(
				new ListObjectsV2Command({
					Bucket: bucket,
					Prefix: prefix,
					ContinuationToken: continuationToken,
					MaxKeys: 1000
				})
			);
			for (const object of result.Contents ?? []) {
				if (object.Key) keys.push(object.Key);
			}
			continuationToken = result.NextContinuationToken;
		} while (continuationToken);

		for (const key of keys) {
			await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
		}
		return keys.length;
	}

	private async githubJson<T>(path: string): Promise<T> {
		const response = await this.githubFetch(path, {
			accept: 'application/vnd.github+json'
		});
		return (await response.json()) as T;
	}

	private async githubFetch(pathOrUrl: string, options: { accept: string }) {
		const config = this.requireReleaseSync();
		const url = pathOrUrl.startsWith('http') ? pathOrUrl : `https://api.github.com${pathOrUrl}`;
		const headers: Record<string, string> = {
			accept: options.accept,
			'user-agent': 'gang-chat-admin'
		};
		if (config.githubToken) headers.authorization = `Bearer ${config.githubToken}`;
		const response = await fetch(url, { headers });
		if (!response.ok) {
			throw new HttpError(
				response.status >= 500 ? 502 : response.status,
				'GITHUB_RELEASE_REQUEST_FAILED',
				`GitHub request failed: ${response.status} ${response.statusText}`
			);
		}
		return response;
	}
}

function syncableAssetCount(assets: GitHubReleaseAsset[]) {
	return selectReleaseAssetsForSync(assets, 'x').length;
}

export function selectReleaseAssetsForSync<T extends { name: string }>(
	assets: T[],
	assetPrefix: string,
	tagName?: string
) {
	const selected: Array<{ asset: T; outputName: string }> = [];
	let hasDmg = false;
	let hasExe = false;

	for (const asset of assets) {
		const name = asset.name.trim().toLowerCase();
		if (!hasDmg && name.endsWith('.dmg')) {
			selected.push({ asset, outputName: versionedAssetName(assetPrefix, tagName, '.dmg') });
			hasDmg = true;
			continue;
		}
		if (!hasExe && name.endsWith('.exe')) {
			selected.push({ asset, outputName: versionedAssetName(assetPrefix, tagName, '.exe') });
			hasExe = true;
		}
		if (hasDmg && hasExe) break;
	}

	return selected;
}

function versionedAssetName(assetPrefix: string, tagName: string | undefined, extension: '.dmg' | '.exe') {
	const safePrefix = validateObjectKey(assetPrefix);
	const version = tagName?.trim() ? `_${safeVersionTag(tagName)}` : '';
	return validateObjectKey(`${safePrefix}${version}${extension}`);
}

function safeVersionTag(tagName: string) {
	const safe = tagName.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
	return safe || 'release';
}

export function validateBucketName(bucket: string) {
	const parsed = s3BucketNameSchema.safeParse(bucket);
	if (!parsed.success) throw new HttpError(400, 'INVALID_S3_BUCKET', 'Invalid S3 bucket name');
	return parsed.data;
}

export function validateObjectKey(key: string) {
	const parsed = s3ObjectKeySchema.safeParse(key);
	if (!parsed.success) throw new HttpError(400, 'INVALID_S3_OBJECT_KEY', 'Invalid S3 object key');
	return parsed.data;
}

export function isS3NotFoundError(error: unknown) {
	const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
	return (
		err.name === 'NotFound' || err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404
	);
}
