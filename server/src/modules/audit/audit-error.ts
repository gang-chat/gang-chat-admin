export function auditErrorDetail(error: unknown, fallback = 'Operation failed') {
	return error instanceof Error && error.message ? error.message : fallback;
}
