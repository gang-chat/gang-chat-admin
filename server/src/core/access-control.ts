import type { FastifyRequest } from 'fastify';
import type { AuthRole } from '../../../src/lib/shared/ops-types';
import { HttpError } from './http';

const roleRank: Record<AuthRole, number> = {
	viewer: 0,
	operator: 1,
	admin: 2
};

export function requireRole(request: FastifyRequest, minimumRole: AuthRole) {
	const identity = request.opsIdentity;
	if (!identity) {
		throw new HttpError(401, 'UNAUTHORIZED', 'Missing or invalid admin token');
	}
	if (roleRank[identity.role] < roleRank[minimumRole]) {
		throw new HttpError(
			403,
			'FORBIDDEN_ROLE',
			`This action requires ${minimumRole} role or higher`,
			{ requiredRole: minimumRole, currentRole: identity.role }
		);
	}
	return identity;
}

export function canRole(role: AuthRole | undefined, minimumRole: AuthRole) {
	return Boolean(role && roleRank[role] >= roleRank[minimumRole]);
}
