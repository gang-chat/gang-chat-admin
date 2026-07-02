import type { Readable } from 'node:stream';
import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	S3Client
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { FastifyRequest } from 'fastify';
import type { S3ObjectList, S3ObjectMetadata, S3PublicConfig } from '../../../../src/lib/shared/ops-types';
import { HttpError } from '../../core/http';
import { parseInput } from '../../core/validation';
import type { ConnectionsRepository } from '../connections/connections.repository';
import { s3BucketNameSchema, s3ObjectKeySchema, s3UploadFieldsSchema } from './s3.schema';

type S3Secret = {
	accessKeyId?: string;
	secretAccessKey?: string;
	sessionToken?: string;
};

export class S3Service {
	constructor(private readonly connections: ConnectionsRepository) {}

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
