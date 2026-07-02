import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { requireRole } from '../../core/access-control';
import { ok, requireConfirmation } from '../../core/http';
import { idParamSchema, parseInput } from '../../core/validation';
import type { AuditRepository } from '../audit/audit.repository';
import { auditErrorDetail } from '../audit/audit-error';
import {
	s3ObjectQuerySchema,
	s3ObjectTargetBodySchema,
	s3ObjectTargetQuerySchema
} from './s3.schema';
import type { S3Service } from './s3.service';

export async function registerS3Routes(
	app: FastifyInstance,
	deps: { s3: S3Service; audit: AuditRepository }
) {
	app.get('/api/s3/:id/buckets', async (request) => {
		const { id } = parseInput(idParamSchema, request.params);
		return ok(await deps.s3.listBuckets(id));
	});

	app.get('/api/s3/:id/objects', async (request) => {
		const { id } = parseInput(idParamSchema, request.params);
		const query = parseInput(s3ObjectQuerySchema, request.query);
		return ok(
			await deps.s3.listObjects(id, query.bucket, query.prefix, {
				continuationToken: query.continuationToken,
				maxKeys: query.maxKeys
			})
		);
	});

	app.get('/api/s3/:id/objects/head', async (request) => {
		const { id } = parseInput(idParamSchema, request.params);
		let target = id;
		try {
			const query = parseInput(s3ObjectTargetQuerySchema, request.query);
			target = `${query.bucket}:${query.key}`;
			const metadata = await deps.s3.headObject(id, query.bucket, query.key);
			await deps.audit.record({
				action: 's3.head',
				target,
				status: 'ok'
			});
			return ok(metadata);
		} catch (error) {
			await deps.audit.record({
				action: 's3.head',
				target,
				status: 'failed',
				detail: auditErrorDetail(error, 'S3 head failed')
			});
			throw error;
		}
	});

	app.post('/api/s3/:id/objects', async (request) => {
		requireRole(request, 'operator');
		const { id } = parseInput(idParamSchema, request.params);
		try {
			const uploaded = await deps.s3.uploadMultipart(id, request);
			await deps.audit.record({
				action: 's3.upload',
				target: `${uploaded.bucket}:${uploaded.key}`,
				status: 'ok'
			});
			return ok(uploaded);
		} catch (error) {
			await deps.audit.record({
				action: 's3.upload',
				target: id,
				status: 'failed',
				detail: auditErrorDetail(error, 'S3 upload failed')
			});
			throw error;
		}
	});

	app.get('/api/s3/:id/objects/download', async (request, reply) => {
		const { id } = parseInput(idParamSchema, request.params);
		let target = id;
		try {
			const query = parseInput(s3ObjectTargetQuerySchema, request.query);
			target = `${query.bucket}:${query.key}`;
			const result = await deps.s3.downloadObject(id, query.bucket, query.key);
			reply.header('content-type', result.ContentType ?? 'application/octet-stream');
			reply.header(
				'content-disposition',
				`attachment; filename="${encodeURIComponent(query.key || 'object')}"`
			);
			await deps.audit.record({
				action: 's3.download',
				target,
				status: 'ok'
			});
			const body = result.Body as unknown;
			return reply.send(body instanceof Readable ? body : Readable.from(body as Uint8Array));
		} catch (error) {
			await deps.audit.record({
				action: 's3.download',
				target,
				status: 'failed',
				detail: auditErrorDetail(error, 'S3 download failed')
			});
			throw error;
		}
	});

	app.delete('/api/s3/:id/objects', async (request) => {
		requireRole(request, 'operator');
		const { id } = parseInput(idParamSchema, request.params);
		let target = id;
		try {
			const body = parseInput(s3ObjectTargetBodySchema, request.body);
			requireConfirmation(body.confirmation, body.key, 'Type the exact object key to delete it');
			target = `${body.bucket}:${body.key}`;
			await deps.s3.deleteObject(id, body.bucket, body.key);
			await deps.audit.record({
				action: 's3.delete',
				target,
				status: 'ok'
			});
			return ok({ deleted: true });
		} catch (error) {
			await deps.audit.record({
				action: 's3.delete',
				target,
				status: 'failed',
				detail: auditErrorDetail(error, 'S3 delete failed')
			});
			throw error;
		}
	});
}
