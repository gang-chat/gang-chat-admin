import { HttpError } from '../../core/http';

export const PASSWORD_MIN_LENGTH = 14;
export const PASSWORD_POLICY_DESCRIPTION =
	'Password must be at least 14 characters and include lowercase, uppercase, number and symbol characters.';

const COMMON_FRAGMENTS = ['password', 'admin', 'changeme', 'letmein', 'welcome', 'qwerty'];

export function passwordPolicyIssues(password: string, username?: string) {
	const issues: string[] = [];
	if (password.length < PASSWORD_MIN_LENGTH) {
		issues.push(`Use at least ${PASSWORD_MIN_LENGTH} characters`);
	}
	if (!/[a-z]/.test(password)) issues.push('Add a lowercase letter');
	if (!/[A-Z]/.test(password)) issues.push('Add an uppercase letter');
	if (!/\d/.test(password)) issues.push('Add a number');
	if (!/[^A-Za-z0-9]/.test(password)) issues.push('Add a symbol');

	const normalizedPassword = password.toLowerCase();
	const normalizedUsername = username?.trim().toLowerCase();
	if (normalizedUsername && normalizedUsername.length >= 3) {
		const compactPassword = normalizedPassword.replace(/[^a-z0-9]/g, '');
		const compactUsername = normalizedUsername.replace(/[^a-z0-9]/g, '');
		if (
			normalizedPassword.includes(normalizedUsername) ||
			(compactUsername.length >= 3 && compactPassword.includes(compactUsername))
		) {
			issues.push('Do not include the username');
		}
	}

	for (const fragment of COMMON_FRAGMENTS) {
		if (normalizedPassword.includes(fragment)) {
			issues.push(`Avoid common password fragment: ${fragment}`);
		}
	}

	return issues;
}

export function assertPasswordPolicy(password: string, username?: string) {
	const issues = passwordPolicyIssues(password, username);
	if (issues.length > 0) {
		throw new HttpError(400, 'PASSWORD_POLICY_VIOLATION', PASSWORD_POLICY_DESCRIPTION, {
			issues
		});
	}
}
