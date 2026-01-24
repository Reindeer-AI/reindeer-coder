import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { env } from '$env/dynamic/private';
import { getGitHubAppPrivateKey } from '../secrets';
import type {
	GitHubFile,
	GitHubIssueComment,
	GitHubPullRequest,
	GitHubReviewComment,
	GitHubUser,
	PRReviewContext,
} from './types';

export class GitHubClient {
	private client: Octokit | null = null;
	private initPromise: Promise<void> | null = null;

	/**
	 * Ensure the client is initialized before use.
	 * Uses lazy initialization to support async secret resolution.
	 */
	private async ensureInitialized(): Promise<Octokit> {
		if (this.client) {
			return this.client;
		}

		if (!this.initPromise) {
			this.initPromise = this.initialize();
		}

		await this.initPromise;
		if (!this.client) {
			throw new Error('GitHub client failed to initialize');
		}
		return this.client;
	}

	private async initialize(): Promise<void> {
		const appId = env.GITHUB_APP_ID;
		const installationId = env.GITHUB_INSTALLATION_ID;

		if (!appId || !installationId) {
			throw new Error('GITHUB_APP_ID and GITHUB_INSTALLATION_ID are required');
		}

		const privateKey = await getGitHubAppPrivateKey();

		this.client = new Octokit({
			authStrategy: createAppAuth,
			auth: {
				appId: parseInt(appId, 10),
				privateKey,
				installationId: parseInt(installationId, 10),
			},
		});
	}

	/**
	 * Extract project path (owner/repo) and PR number from GitHub PR URL
	 * Example: https://github.com/Reindeer-AI/reindeer-coder/pull/123
	 */
	parsePRUrl(url: string): { owner: string; repo: string; prNumber: number } | null {
		const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
		if (!match) return null;

		return {
			owner: match[1],
			repo: match[2],
			prNumber: parseInt(match[3], 10),
		};
	}

	/**
	 * Extract PR URL from terminal output or text
	 */
	extractPRUrl(text: string): string | null {
		const match = text.match(/(https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+)/);
		return match ? match[1] : null;
	}

	/**
	 * Get pull request details
	 */
	async getPullRequest(owner: string, repo: string, prNumber: number): Promise<GitHubPullRequest> {
		const client = await this.ensureInitialized();
		const { data } = await client.pulls.get({
			owner,
			repo,
			pull_number: prNumber,
		});
		return data as GitHubPullRequest;
	}

	/**
	 * Get all review comments on a pull request (inline code comments)
	 */
	async getPullRequestReviewComments(
		owner: string,
		repo: string,
		prNumber: number
	): Promise<GitHubReviewComment[]> {
		const client = await this.ensureInitialized();
		const { data } = await client.pulls.listReviewComments({
			owner,
			repo,
			pull_number: prNumber,
			per_page: 100,
		});
		return data as GitHubReviewComment[];
	}

	/**
	 * Get all issue comments on a pull request (general comments, not inline)
	 */
	async getPullRequestIssueComments(
		owner: string,
		repo: string,
		prNumber: number
	): Promise<GitHubIssueComment[]> {
		const client = await this.ensureInitialized();
		const { data } = await client.issues.listComments({
			owner,
			repo,
			issue_number: prNumber,
			per_page: 100,
		});
		return data as GitHubIssueComment[];
	}

	/**
	 * Get files changed in a pull request
	 */
	async getPullRequestFiles(owner: string, repo: string, prNumber: number): Promise<GitHubFile[]> {
		const client = await this.ensureInitialized();
		const { data } = await client.pulls.listFiles({
			owner,
			repo,
			pull_number: prNumber,
			per_page: 100,
		});
		return data as GitHubFile[];
	}

	/**
	 * Get comprehensive code review context for a PR
	 */
	async getPRReviewContext(
		owner: string,
		repo: string,
		prNumber: number
	): Promise<PRReviewContext> {
		const [pr, reviewComments, issueComments, files] = await Promise.all([
			this.getPullRequest(owner, repo, prNumber),
			this.getPullRequestReviewComments(owner, repo, prNumber),
			this.getPullRequestIssueComments(owner, repo, prNumber),
			this.getPullRequestFiles(owner, repo, prNumber),
		]);

		// Find pending review comments (those that haven't been addressed)
		// In GitHub, we can track this by looking at comments without replies or
		// by checking if the line they reference still exists in the latest commit
		const pendingReviewComments = reviewComments.filter((comment) => {
			// Comments that are replies are responses, not pending items
			return !comment.in_reply_to_id;
		});

		return {
			pr,
			reviewComments,
			issueComments,
			files,
			pendingReviewComments,
		};
	}

	/**
	 * Add a comment to a pull request (general comment, not inline)
	 */
	async addPRComment(owner: string, repo: string, prNumber: number, body: string): Promise<void> {
		const client = await this.ensureInitialized();
		await client.issues.createComment({
			owner,
			repo,
			issue_number: prNumber,
			body,
		});
	}

	/**
	 * Reply to a review comment
	 */
	async replyToReviewComment(
		owner: string,
		repo: string,
		prNumber: number,
		commentId: number,
		body: string
	): Promise<void> {
		const client = await this.ensureInitialized();
		await client.pulls.createReplyForReviewComment({
			owner,
			repo,
			pull_number: prNumber,
			comment_id: commentId,
			body,
		});
	}

	/**
	 * Create a review with comments
	 */
	async createReview(
		owner: string,
		repo: string,
		prNumber: number,
		body: string,
		event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' = 'COMMENT'
	): Promise<void> {
		const client = await this.ensureInitialized();
		await client.pulls.createReview({
			owner,
			repo,
			pull_number: prNumber,
			body,
			event,
		});
	}

	/**
	 * Find a user by username
	 * Returns the user if found, null otherwise
	 */
	async findUserByUsername(username: string): Promise<GitHubUser | null> {
		try {
			const client = await this.ensureInitialized();
			const { data } = await client.users.getByUsername({ username });
			return {
				id: data.id,
				login: data.login,
				name: data.name,
				email: data.email,
			};
		} catch (error) {
			console.error(`[GitHubClient] Failed to find user ${username}:`, error);
			return null;
		}
	}

	/**
	 * Search for a user by email
	 * Note: This only works if the user has made their email public
	 */
	async findUserByEmail(email: string): Promise<GitHubUser | null> {
		try {
			const client = await this.ensureInitialized();
			const { data } = await client.search.users({
				q: `${email} in:email`,
				per_page: 1,
			});

			if (data.items.length === 0) {
				return null;
			}

			// Get full user details
			const user = data.items[0];
			return await this.findUserByUsername(user.login);
		} catch (error) {
			console.error(`[GitHubClient] Failed to find user by email ${email}:`, error);
			return null;
		}
	}

	/**
	 * Request reviewers for a pull request
	 * @param owner - The repository owner
	 * @param repo - The repository name
	 * @param prNumber - The pull request number
	 * @param reviewers - Array of usernames to request as reviewers
	 */
	async requestReviewers(
		owner: string,
		repo: string,
		prNumber: number,
		reviewers: string[]
	): Promise<void> {
		try {
			const client = await this.ensureInitialized();
			await client.pulls.requestReviewers({
				owner,
				repo,
				pull_number: prNumber,
				reviewers,
			});
			console.log(`[GitHubClient] Requested reviewers ${reviewers.join(', ')} for PR #${prNumber}`);
		} catch (error) {
			console.error(`[GitHubClient] Failed to request reviewers for PR #${prNumber}:`, error);
			throw error;
		}
	}

	/**
	 * Get installation access token for git operations
	 * This is useful when you need to authenticate git commands
	 */
	async getInstallationToken(): Promise<string> {
		const appId = env.GITHUB_APP_ID;
		const installationId = env.GITHUB_INSTALLATION_ID;

		if (!appId || !installationId) {
			throw new Error('GITHUB_APP_ID and GITHUB_INSTALLATION_ID are required');
		}

		const privateKey = await getGitHubAppPrivateKey();

		const auth = createAppAuth({
			appId: parseInt(appId, 10),
			privateKey,
			installationId: parseInt(installationId, 10),
		});

		const { token } = await auth({ type: 'installation' });
		return token;
	}
}
