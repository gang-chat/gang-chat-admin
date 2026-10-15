export type ConnectionType = 'mysql' | 's3';

export type ConnectionStatus = 'unknown' | 'healthy' | 'failed';

export type ConnectionPreset = {
	id: string;
	name: string;
	type: ConnectionType;
	tags: string[];
	status: ConnectionStatus;
	lastCheckedAt?: string;
	lastError?: string;
	config: MysqlPublicConfig | S3PublicConfig;
	createdAt: string;
	updatedAt: string;
};

export type MysqlPublicConfig = {
	host: string;
	port: number;
	database: string;
	user: string;
	ssl: boolean;
	allowMutations?: boolean;
};

export type MysqlSecretConfig = {
	password?: string;
};

export type MysqlConnectionInput = {
	name: string;
	tags?: string[];
	type: 'mysql';
	config: MysqlPublicConfig & MysqlSecretConfig;
};

export type S3PublicConfig = {
	endpoint: string;
	region: string;
	defaultBucket?: string;
	forcePathStyle: boolean;
	allowWrites?: boolean;
};

export type S3SecretConfig = {
	accessKeyId?: string;
	secretAccessKey?: string;
	sessionToken?: string;
};

export type S3ConnectionInput = {
	name: string;
	tags?: string[];
	type: 's3';
	config: S3PublicConfig & S3SecretConfig;
};

export type ConnectionInput = MysqlConnectionInput | S3ConnectionInput;

export type MysqlColumn = {
	field: string;
	type: string;
	nullable: boolean;
	key: string;
	defaultValue: unknown;
	extra: string;
};

export type MysqlTableSummary = {
	name: string;
	rows?: number;
	engine?: string;
	updatedAt?: string;
};

export type MysqlSqlMode = 'read-only' | 'allow-mutations';

export type MysqlSqlPolicy = {
	mode: MysqlSqlMode;
	maxRows: number;
	timeoutMs: number;
	mutationConfirmation?: string;
};

export type MysqlQueryResult = {
	rows: Record<string, unknown>[];
	fields: string[];
	affectedRows?: number;
	warningStatus?: number;
	executionMs: number;
	mutation: boolean;
	limited: boolean;
	policy: MysqlSqlPolicy;
};

export type S3ObjectSummary = {
	key: string;
	size: number;
	etag?: string;
	lastModified?: string;
	storageClass?: string;
};

export type S3ObjectMetadata = S3ObjectSummary & {
	bucket: string;
	contentType?: string;
	contentEncoding?: string;
	cacheControl?: string;
	contentDisposition?: string;
	versionId?: string;
	metadata: Record<string, string>;
};

export type S3ObjectList = {
	bucket: string;
	prefix: string;
	prefixes: string[];
	objects: S3ObjectSummary[];
	isTruncated: boolean;
	nextContinuationToken?: string;
};

export type S3ReleaseSyncConfig = {
	enabled: boolean;
	repository?: string;
	repositoryUrl?: string;
	targetPrefix?: string;
	assetPrefix?: string;
};

export type S3ReleaseVersion = {
	id: number;
	tagName: string;
	name?: string;
	htmlUrl?: string;
	publishedAt?: string;
	prerelease: boolean;
	assetCount: number;
};

export type S3ReleaseSyncUploadedObject = {
	name: string;
	sourceName: string;
	key: string;
	size: number;
	contentType?: string;
};

export type S3ReleaseSyncResult = {
	repository: string;
	tagName: string;
	targetPrefix: string;
	deleted: number;
	uploaded: S3ReleaseSyncUploadedObject[];
};

export type GangAccountStatus = 'active' | 'suspended' | 'deleted';

/** Room roles in the Gang Chat database; `owner` is the room creator. */
export type GangRoomRole = 'owner' | 'admin' | 'member';

export type GangAccount = {
	id: string;
	uid: string;
	username: string;
	email: string;
	displayName?: string;
	status: GangAccountStatus;
	isSuperuser: boolean;
	emailVerified: boolean;
	roomCount: number;
	activeSessionCount: number;
	lastSeenAt?: string;
	createdAt: string;
	updatedAt: string;
};

export type GangAccountMembership = {
	roomId: string;
	rid: string;
	roomName: string;
	role: GangRoomRole;
	joinedAt: string;
};

export type GangAccountDetail = GangAccount & {
	memberships: GangAccountMembership[];
};

export type GangAccountList = {
	total: number;
	items: GangAccount[];
};

export type GangRoomSummary = {
	id: string;
	rid: string;
	name: string;
	memberCount: number;
};

export type GangAccountCreateInput = {
	username: string;
	email: string;
	password: string;
	displayName?: string;
};

export type GangAccountUpdateInput = {
	username?: string;
	email?: string;
	displayName?: string;
	emailVerified?: boolean;
	status?: 'active' | 'suspended';
};

export type AuditStatus = 'ok' | 'failed' | 'pending';

export type AuditEvent = {
	id: string;
	at: string;
	actor: string;
	action: string;
	target: string;
	status: AuditStatus;
	detail?: string;
	previousHash?: string;
	hash?: string;
};

export type AuditIntegrity = {
	valid: boolean;
	total: number;
	signed: number;
	unsigned: number;
	headHash?: string;
	brokenAt?: string;
	reason?: string;
};

export type ApiEnvelope<T> = {
	data: T;
};

export type AuthRole = 'viewer' | 'operator' | 'admin';

export type AuthUser = {
	id: string;
	username: string;
	displayName: string;
	role: AuthRole;
	disabled: boolean;
	createdAt: string;
	updatedAt: string;
	lastLoginAt?: string;
	lastFailedLoginAt?: string;
	failedLoginCount?: number;
	lockedUntil?: string;
};

export type AuthLoginResult = {
	token: string;
	expiresAt: string;
	idleExpiresAt: string;
	user: AuthUser;
};

export type AuthSession = {
	id: string;
	userId: string;
	username: string;
	createdAt: string;
	expiresAt: string;
	idleExpiresAt: string;
	lastSeenAt: string;
	revokedAt?: string;
	current: boolean;
};

export type ApiError = {
	error: {
		code: string;
		message: string;
		details?: unknown;
	};
};
