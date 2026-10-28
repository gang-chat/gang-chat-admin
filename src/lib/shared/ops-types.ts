// Shapes the Go server's /api/v1/admin endpoints return. Releases keep the
// public endpoint's snake_case; everything else is camelCase.

export type AdminOverview = {
	database: { path: string; sizeBytes: number };
	storage: { configured: boolean; endpoint: string; bucket: string };
	releaseSync: S3ReleaseSyncConfig;
};

export type AdminSession = {
	username: string;
	expiresAt: string;
};

export type AdminLoginResult = {
	token: string;
	session: AdminSession;
};

export type DbColumn = {
	field: string;
	type: string;
	nullable: boolean;
	key: string;
	defaultValue: unknown;
	extra: string;
};

export type DbTableSummary = {
	name: string;
	rows: number;
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
	/** The release row the sync created or pointed at the new files. */
	release?: AppRelease;
};

export type AppReleaseDownloads = {
	windows: string;
	macos: string;
	android: string;
};

/** A client version the homepage and the in-app update check show. */
export type AppRelease = {
	version: string;
	title: string;
	notes: string;
	/** YYYY-MM-DD, or empty. */
	release_date: string;
	published: boolean;
	/** Clients older than this are told they must update; empty means the release itself. */
	minimum_supported_version: string;
	downloads: AppReleaseDownloads;
	/** Unix milliseconds. */
	created_at: number;
	updated_at: number;
};

export type AppReleaseInput = Partial<
	Omit<AppRelease, 'downloads' | 'created_at' | 'updated_at'> & {
		downloads: Partial<AppReleaseDownloads>;
	}
>;

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

export type ApiEnvelope<T> = {
	data: T;
};

export type ApiError = {
	error: {
		code: string;
		message: string;
		details?: unknown;
	};
};
