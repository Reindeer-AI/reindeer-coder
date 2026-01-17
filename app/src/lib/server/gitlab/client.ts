import { Gitlab } from '@gitbeaker/rest';
import { env } from '$env/dynamic/private';
import { getGitLabToken } from '../secrets';
import type {
	GitLabDiff,
	GitLabDiscussion,
	GitLabMergeRequest,
	GitLabMRNote,
	GitLabUser,
	MRReviewContext,
} from './types';

export class GitLabClient {
	private client: InstanceType<typeof Gitlab> | null = null;
	private initPromise: Promise<void> | null = null;

	/**
	 * Ensure the client is initialized before use.
	 * Uses lazy initialization to support async secret resolution.
	 */
	private async ensureInitialized(): Promise<InstanceType<typeof Gitlab>> {
		if (this.client) {
			return this.client;
		}

		if (!this.initPromise) {
			this.initPromise = this.initialize();
		}

		await this.initPromise;
		if (!this.client) {
			throw new Error('GitLab client failed to initialize');
		}
		return this.client;
	}

	private async initialize(): Promise<void> {
		const token = await getGitLabToken();
		const host = env.GITLAB_API_URL;

		this.client = new Gitlab({
			token,
			host,
		});
	}

	/**
	 * Extract project path and MR IID from GitLab MR URL
	 * Example: https://gitlab.com/reindeerai/reindeer-ts/-/merge_requests/123
	 */
	parseMRUrl(url: string): { projectPath: string; mrIid: number } | null {
		const match = url.match(/gitlab\.com\/([^/]+\/[^/]+)\/-\/merge_requests\/(\d+)/);
		if (!match) return null;

		return {
			projectPath: match[1],
			mrIid: parseInt(match[2], 10),
		};
	}

	/**
	 * Extract MR URL from terminal output or GitLab URLs
	 */
	extractMRUrl(text: string): string | null {
		const match = text.match(/(https:\/\/gitlab\.com\/[^/]+\/[^/]+\/-\/merge_requests\/\d+)/);
		return match ? match[1] : null;
	}

	/**
	 * Get merge request details
	 */
	async getMergeRequest(projectPath: string, mrIid: number): Promise<GitLabMergeRequest> {
		const client = await this.ensureInitialized();
		const mr = await client.MergeRequests.show(projectPath, mrIid);
		return mr as GitLabMergeRequest;
	}

	/**
	 * Get all notes (comments) on a merge request
	 * Includes both top-level comments and inline code review comments
	 */
	async getMergeRequestNotes(projectPath: string, mrIid: number): Promise<GitLabMRNote[]> {
		const client = await this.ensureInitialized();
		const response = await client.MergeRequestNotes.all(projectPath, mrIid, {
			perPage: 100,
			showExpanded: true,
		});
		// The API returns a paginated response, extract the data array
		const notes = Array.isArray(response)
			? response
			: (response as unknown as { data?: GitLabMRNote[] }).data || [];
		return notes as unknown as GitLabMRNote[];
	}

	/**
	 * Get diffs for a merge request
	 */
	async getMergeRequestDiffs(projectPath: string, mrIid: number): Promise<GitLabDiff[]> {
		const client = await this.ensureInitialized();
		const diffs = await client.MergeRequests.allDiffs(projectPath, mrIid);
		return diffs as GitLabDiff[];
	}

	/**
	 * Get comprehensive code review context for an MR
	 */
	async getMRReviewContext(projectPath: string, mrIid: number): Promise<MRReviewContext> {
		const [mr, notes, diffs] = await Promise.all([
			this.getMergeRequest(projectPath, mrIid),
			this.getMergeRequestNotes(projectPath, mrIid),
			this.getMergeRequestDiffs(projectPath, mrIid),
		]);

		// Filter out system notes and get only human comments
		const humanNotes = notes.filter((note) => !note.system);

		// Find unresolved threads
		const unresolvedThreads = humanNotes.filter((note) => note.resolvable && !note.resolved);

		return {
			mr,
			notes: humanNotes,
			diffs,
			unresolvedThreads,
		};
	}

	/**
	 * Add a comment to a merge request
	 */
	async addMRComment(projectPath: string, mrIid: number, body: string): Promise<void> {
		const client = await this.ensureInitialized();
		await client.MergeRequestNotes.create(projectPath, mrIid, body);
	}

	/**
	 * Resolve a discussion thread
	 */
	async resolveThread(projectPath: string, mrIid: number, discussionId: string): Promise<void> {
		const client = await this.ensureInitialized();
		await client.MergeRequestDiscussions.resolve(projectPath, mrIid, discussionId, true);
	}

	/**
	 * Reply to a specific discussion note
	 */
	async replyToNote(
		projectPath: string,
		mrIid: number,
		noteId: number,
		body: string
	): Promise<void> {
		const client = await this.ensureInitialized();

		// Get the note to find its discussion ID
		const notes = await this.getMergeRequestNotes(projectPath, mrIid);
		const note = notes.find((n) => n.id === noteId);

		if (!note) {
			throw new Error(`Note ${noteId} not found`);
		}

		// Find the discussion by looking for notes that belong to it
		const discussions = (await client.MergeRequestDiscussions.all(
			projectPath,
			mrIid
		)) as unknown as GitLabDiscussion[];
		const discussion = discussions.find((d) => d.notes.some((n) => n.id === noteId));

		if (!discussion) {
			throw new Error(`Discussion for note ${noteId} not found`);
		}

		await client.MergeRequestDiscussions.addNote(projectPath, mrIid, discussion.id, noteId, body);
	}

	/**
	 * Find a user by email address
	 * Returns the user ID if found, null otherwise
	 */
	async findUserByEmail(email: string): Promise<number | null> {
		try {
			const client = await this.ensureInitialized();
			// Use all() with search parameter to find users by email
			const users = (await client.Users.all({ search: email })) as GitLabUser[];

			// Search returns an array, find exact match on email
			const matchingUser = users.find((u) => u.email?.toLowerCase() === email.toLowerCase());

			return matchingUser?.id || null;
		} catch (error) {
			console.error(`[GitLabClient] Failed to find user by email ${email}:`, error);
			return null;
		}
	}

	/**
	 * Assign a reviewer to a merge request
	 * @param projectPath - The project path (e.g., "reindeerai/reindeer-ts")
	 * @param mrIid - The merge request IID
	 * @param reviewerIds - Array of user IDs to assign as reviewers
	 */
	async assignReviewers(projectPath: string, mrIid: number, reviewerIds: number[]): Promise<void> {
		try {
			const client = await this.ensureInitialized();
			await client.MergeRequests.edit(projectPath, mrIid, {
				reviewerIds: reviewerIds,
			});
			console.log(`[GitLabClient] Assigned reviewers ${reviewerIds.join(', ')} to MR !${mrIid}`);
		} catch (error) {
			console.error(`[GitLabClient] Failed to assign reviewers to MR !${mrIid}:`, error);
			throw error;
		}
	}
}
