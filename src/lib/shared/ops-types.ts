export type ConnectionType = 'mysql' | 's3' | 'ssh';

export type ConnectionStatus = 'unknown' | 'healthy' | 'failed';

export type ConnectionPreset = {
	id: string;
	name: string;
	type: ConnectionType;
	tags: string[];
	status: ConnectionStatus;
	lastCheckedAt?: string;
	lastError?: string;
	config: MysqlPublicConfig | S3PublicConfig | SshPublicConfig;
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

export type SshPublicConfig = {
	host: string;
	port: number;
	username: string;
	hostKeySha256?: string;
};

export type SshSecretConfig = {
	password?: string;
	privateKey?: string;
	passphrase?: string;
};

export type SshConnectionInput = {
	name: string;
	tags?: string[];
	type: 'ssh';
	config: SshPublicConfig & SshSecretConfig;
};

export type SshSessionStatus = 'connecting' | 'connected' | 'closing';

export type SshActiveSession = {
	id: string;
	connectionId: string;
	connectionName?: string;
	target: string;
	host?: string;
	port?: number;
	username?: string;
	startedAt: string;
	lastActiveAt: string;
	status: SshSessionStatus;
	cols: number;
	rows: number;
};

export type ConnectionInput = MysqlConnectionInput | S3ConnectionInput | SshConnectionInput;

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

export type ExpenseEntry = {
	id: string;
	month: string;
	category: string;
	vendor: string;
	amount: number;
	currency: string;
	note?: string;
	createdAt: string;
	updatedAt: string;
};

export type ExpenseInput = {
	month: string;
	category: string;
	vendor: string;
	amount: number;
	currency: string;
	note?: string;
};

export type ExpenseSummary = {
	month: string;
	total: number;
	currency: string;
	byCategory: Array<{ category: string; total: number }>;
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

export type AgentCommand = {
	label: string;
	command: string;
	requiresApproval: boolean;
};

export type AgentSuggestion = {
	id: string;
	createdAt: string;
	goal: string;
	summary: string;
	risk: 'low' | 'medium' | 'high';
	commands: AgentCommand[];
	notes: string[];
};

export type AgentJobStatus = 'suggested' | 'approved' | 'rejected';

export type AgentExecutionStatus = 'queued' | 'running' | 'completed' | 'failed';

export type AgentWorkerTerminalStatus = {
	available: boolean;
	username?: string;
	shell?: string;
	cwd?: string;
};

export type AgentWorkerStatus = {
	id: string;
	lastSeenAt: string;
	apiBase?: string;
	hostname?: string;
	version?: string;
	execute: boolean;
	allowedCommands: string[];
	currentJobId?: string;
	transport?: 'poll' | 'websocket';
	connected?: boolean;
	terminal?: AgentWorkerTerminalStatus;
};

export type AgentCommandResult = {
	label?: string;
	command: string;
	exitCode: number | null;
	stdout?: string;
	stderr?: string;
	startedAt?: string;
	completedAt?: string;
	durationMs?: number;
};

export type AgentJob = AgentSuggestion & {
	status: AgentJobStatus;
	executionStatus?: AgentExecutionStatus;
	updatedAt: string;
	approvedAt?: string;
	rejectedAt?: string;
	operatorNote?: string;
	claimedAt?: string;
	startedAt?: string;
	completedAt?: string;
	failedAt?: string;
	workerId?: string;
	result?: string;
	error?: string;
	commandResults?: AgentCommandResult[];
};

export type AgentRunEvent = {
	type: 'status' | 'text' | 'tool' | 'compact' | 'done' | 'error';
	message: string;
	at: string;
};

export type AgentOpsSession = {
	id: string;
	workerId: string;
	name: string;
	titleSource?: 'auto' | 'custom';
	createdAt: string;
	updatedAt: string;
	lastRunId?: string;
};

export type AgentOpsRun = {
	id: string;
	workerId: string;
	sessionId: string;
	createdAt: string;
	updatedAt: string;
	goal: string;
	status: 'queued' | 'running' | 'completed' | 'failed';
	result?: string;
	error?: string;
	events: AgentRunEvent[];
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
