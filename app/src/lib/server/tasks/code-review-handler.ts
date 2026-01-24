import { configService } from '../config-service';
import { getTaskById, updateTaskMRMetadata } from '../db';
import { GitHubClient } from '../github/client';
import type { GitHubReviewComment, PRReviewContext } from '../github/types';
import { GitLabClient } from '../gitlab/client';
import type { GitLabMRNote, MRReviewContext } from '../gitlab/types';

type GitHost = 'github' | 'gitlab';

/**
 * Detect git host from URL
 */
function detectGitHost(url: string): GitHost {
	if (url.includes('github.com')) {
		return 'github';
	}
	return 'gitlab';
}

export class CodeReviewHandler {
	private gitlabClient: GitLabClient;
	private githubClient: GitHubClient;

	constructor() {
		this.gitlabClient = new GitLabClient();
		this.githubClient = new GitHubClient();
	}

	/**
	 * Format GitLab code review context into a comprehensive instruction for the agent
	 */
	formatGitLabCodeReviewInstruction(context: MRReviewContext, taskDescription: string): string {
		let instruction = `# Code Review Feedback\n\n`;
		instruction += `You previously implemented this task and created a merge request. `;
		instruction += `The human reviewer has provided feedback that needs to be addressed.\n\n`;

		instruction += `## Original Task\n\n${taskDescription}\n\n`;

		instruction += `## Merge Request Information\n\n`;
		instruction += `- **Title**: ${context.mr.title}\n`;
		instruction += `- **URL**: ${context.mr.web_url}\n`;
		instruction += `- **Branch**: ${context.mr.source_branch} → ${context.mr.target_branch}\n`;
		instruction += `- **Status**: ${context.mr.state}\n`;
		if (context.mr.description) {
			instruction += `- **Description**: ${context.mr.description}\n`;
		}
		instruction += `\n`;

		// Group notes by type: general comments vs inline code comments
		const generalComments = context.notes.filter((note) => !note.position);
		const inlineComments = context.notes.filter((note) => note.position);

		// General comments
		if (generalComments.length > 0) {
			instruction += `## General Review Comments\n\n`;
			generalComments.forEach((note, idx) => {
				const author = note.author.name || note.author.username;
				const resolved = note.resolvable ? (note.resolved ? ' ✅ RESOLVED' : ' ⚠️ UNRESOLVED') : '';
				instruction += `### Comment ${idx + 1} by ${author}${resolved}\n\n`;
				instruction += `${note.body}\n\n`;
			});
		}

		// Inline code comments with context
		if (inlineComments.length > 0) {
			instruction += `## Inline Code Review Comments\n\n`;
			instruction += `These comments reference specific lines in the code changes:\n\n`;

			// Group by file
			const byFile = new Map<string, GitLabMRNote[]>();
			inlineComments.forEach((note) => {
				if (!note.position) return;
				const path = note.position.new_path || note.position.old_path;
				if (!byFile.has(path)) {
					byFile.set(path, []);
				}
				byFile.get(path)?.push(note);
			});

			// Format by file
			byFile.forEach((notes, filepath) => {
				instruction += `### File: \`${filepath}\`\n\n`;
				notes.forEach((note) => {
					const author = note.author.name || note.author.username;
					const resolved = note.resolvable
						? note.resolved
							? ' ✅ RESOLVED'
							: ' ⚠️ UNRESOLVED'
						: '';
					const lineInfo = note.position?.new_line
						? `Line ${note.position.new_line}`
						: note.position?.old_line
							? `Line ${note.position.old_line} (deleted)`
							: 'Unknown line';

					instruction += `**${lineInfo}** - ${author}${resolved}:\n`;
					instruction += `${note.body}\n\n`;
				});
			});
		}

		// Highlight unresolved threads
		if (context.unresolvedThreads.length > 0) {
			instruction += `## ⚠️ Unresolved Issues (${context.unresolvedThreads.length})\n\n`;
			instruction += `The following comments must be addressed:\n\n`;
			context.unresolvedThreads.forEach((note, idx) => {
				const author = note.author.name || note.author.username;
				const location = note.position
					? `in \`${note.position.new_path || note.position.old_path}\``
					: 'general';
				instruction += `${idx + 1}. **${author}** (${location}): ${note.body}\n`;
			});
			instruction += `\n`;
		}

		instruction += `## Instructions\n\n`;
		instruction += `1. Review all the feedback above carefully\n`;
		instruction += `2. Address each comment by making the necessary code changes\n`;
		instruction += `3. Test your changes to ensure they work correctly\n`;
		instruction += `4. Update the merge request with your changes (git push to the same branch)\n`;
		instruction += `5. After pushing, add a comment to the MR summarizing what you fixed\n\n`;
		instruction += `Focus on addressing the unresolved threads first. `;
		instruction += `Be thorough and ensure all feedback is properly addressed.\n`;

		return instruction;
	}

	/**
	 * Format GitHub code review context into a comprehensive instruction for the agent
	 */
	formatGitHubCodeReviewInstruction(context: PRReviewContext, taskDescription: string): string {
		let instruction = `# Code Review Feedback\n\n`;
		instruction += `You previously implemented this task and created a pull request. `;
		instruction += `The human reviewer has provided feedback that needs to be addressed.\n\n`;

		instruction += `## Original Task\n\n${taskDescription}\n\n`;

		instruction += `## Pull Request Information\n\n`;
		instruction += `- **Title**: ${context.pr.title}\n`;
		instruction += `- **URL**: ${context.pr.html_url}\n`;
		instruction += `- **Branch**: ${context.pr.head.ref} → ${context.pr.base.ref}\n`;
		instruction += `- **Status**: ${context.pr.state}${context.pr.merged ? ' (merged)' : ''}\n`;
		if (context.pr.body) {
			instruction += `- **Description**: ${context.pr.body}\n`;
		}
		instruction += `\n`;

		// Issue comments (general comments)
		if (context.issueComments.length > 0) {
			instruction += `## General Review Comments\n\n`;
			context.issueComments.forEach((comment, idx) => {
				const author = comment.user?.login || 'Unknown';
				instruction += `### Comment ${idx + 1} by ${author}\n\n`;
				instruction += `${comment.body}\n\n`;
			});
		}

		// Review comments (inline code comments)
		if (context.reviewComments.length > 0) {
			instruction += `## Inline Code Review Comments\n\n`;
			instruction += `These comments reference specific lines in the code changes:\n\n`;

			// Group by file
			const byFile = new Map<string, GitHubReviewComment[]>();
			context.reviewComments.forEach((comment) => {
				const path = comment.path;
				if (!byFile.has(path)) {
					byFile.set(path, []);
				}
				byFile.get(path)?.push(comment);
			});

			// Format by file
			byFile.forEach((comments, filepath) => {
				instruction += `### File: \`${filepath}\`\n\n`;
				comments.forEach((comment) => {
					const author = comment.user?.login || 'Unknown';
					const lineInfo = comment.line
						? `Line ${comment.line}`
						: comment.original_line
							? `Line ${comment.original_line}`
							: 'Unknown line';
					const isReply = comment.in_reply_to_id ? ' (reply)' : '';

					instruction += `**${lineInfo}** - ${author}${isReply}:\n`;
					instruction += `${comment.body}\n\n`;
				});
			});
		}

		// Highlight pending review comments (not replied to)
		if (context.pendingReviewComments.length > 0) {
			instruction += `## ⚠️ Pending Review Comments (${context.pendingReviewComments.length})\n\n`;
			instruction += `The following comments need to be addressed:\n\n`;
			context.pendingReviewComments.forEach((comment, idx) => {
				const author = comment.user?.login || 'Unknown';
				instruction += `${idx + 1}. **${author}** (in \`${comment.path}\`): ${comment.body}\n`;
			});
			instruction += `\n`;
		}

		instruction += `## Instructions\n\n`;
		instruction += `1. Review all the feedback above carefully\n`;
		instruction += `2. Address each comment by making the necessary code changes\n`;
		instruction += `3. Test your changes to ensure they work correctly\n`;
		instruction += `4. Update the pull request with your changes (git push to the same branch)\n`;
		instruction += `5. After pushing, reply to review comments or add a summary comment to the PR\n\n`;
		instruction += `Focus on addressing the pending review comments first. `;
		instruction += `Be thorough and ensure all feedback is properly addressed.\n`;

		return instruction;
	}

	/**
	 * Extract MR/PR URL from terminal output after implementation
	 */
	async detectAndStoreMRInfo(taskId: string, terminalOutput: string): Promise<void> {
		// Try GitHub first, then GitLab
		const githubUrl = this.githubClient.extractPRUrl(terminalOutput);
		const gitlabUrl = this.gitlabClient.extractMRUrl(terminalOutput);

		const url = githubUrl || gitlabUrl;

		if (!url) {
			console.log(`[CodeReviewHandler] No MR/PR URL found in terminal output for task ${taskId}`);
			return;
		}

		const host = detectGitHost(url);

		if (host === 'github') {
			await this.detectAndStoreGitHubPRInfo(taskId, url);
		} else {
			await this.detectAndStoreGitLabMRInfo(taskId, url);
		}
	}

	/**
	 * Store GitHub PR info
	 */
	private async detectAndStoreGitHubPRInfo(taskId: string, prUrl: string): Promise<void> {
		const parsed = this.githubClient.parsePRUrl(prUrl);
		if (!parsed) {
			console.log(`[CodeReviewHandler] Could not parse GitHub PR URL: ${prUrl}`);
			return;
		}

		try {
			const pr = await this.githubClient.getPullRequest(parsed.owner, parsed.repo, parsed.prNumber);

			await updateTaskMRMetadata(taskId, {
				mr_iid: parsed.prNumber,
				mr_url: prUrl,
				project_id: `${parsed.owner}/${parsed.repo}`,
				last_review_sha: pr.head.sha,
			});

			console.log(`[CodeReviewHandler] Stored GitHub PR info for task ${taskId}: ${prUrl}`);

			// Assign the ticket creator as a reviewer
			await this.assignTicketCreatorAsGitHubReviewer(
				taskId,
				parsed.owner,
				parsed.repo,
				parsed.prNumber
			);
		} catch (error) {
			console.error(
				`[CodeReviewHandler] Failed to fetch GitHub PR details for task ${taskId}:`,
				error
			);
		}
	}

	/**
	 * Store GitLab MR info
	 */
	private async detectAndStoreGitLabMRInfo(taskId: string, mrUrl: string): Promise<void> {
		const parsed = this.gitlabClient.parseMRUrl(mrUrl);
		if (!parsed) {
			console.log(`[CodeReviewHandler] Could not parse GitLab MR URL: ${mrUrl}`);
			return;
		}

		try {
			const mr = await this.gitlabClient.getMergeRequest(parsed.projectPath, parsed.mrIid);

			await updateTaskMRMetadata(taskId, {
				mr_iid: parsed.mrIid,
				mr_url: mrUrl,
				project_id: parsed.projectPath,
				last_review_sha: mr.sha,
			});

			console.log(`[CodeReviewHandler] Stored GitLab MR info for task ${taskId}: ${mrUrl}`);

			// Assign the ticket creator as a reviewer
			await this.assignTicketCreatorAsGitLabReviewer(taskId, parsed.projectPath, parsed.mrIid);
		} catch (error) {
			console.error(
				`[CodeReviewHandler] Failed to fetch GitLab MR details for task ${taskId}:`,
				error
			);
		}
	}

	/**
	 * Assign the Linear ticket creator as a reviewer to the GitHub PR
	 */
	private async assignTicketCreatorAsGitHubReviewer(
		taskId: string,
		owner: string,
		repo: string,
		prNumber: number
	): Promise<void> {
		try {
			// Get the task to access the user email
			const task = await getTaskById(taskId);
			if (!task) {
				console.log(`[CodeReviewHandler] Task ${taskId} not found, cannot assign reviewer`);
				return;
			}

			// Skip if user email is unknown or the default agent email
			const agentFallbackEmail = await configService.get(
				'email.fallback_address',
				'agent@example.com'
			);
			if (
				!task.user_email ||
				task.user_email === 'unknown' ||
				task.user_email === agentFallbackEmail
			) {
				console.log(
					`[CodeReviewHandler] No valid user email for task ${taskId}, skipping reviewer assignment`
				);
				return;
			}

			console.log(`[CodeReviewHandler] Looking up GitHub user for email: ${task.user_email}`);

			// Find the GitHub user by email
			const user = await this.githubClient.findUserByEmail(task.user_email);
			if (!user) {
				console.log(
					`[CodeReviewHandler] Could not find GitHub user with email ${task.user_email}, skipping reviewer assignment`
				);
				return;
			}

			console.log(
				`[CodeReviewHandler] Found GitHub user ${user.login} for ${task.user_email}, requesting review on PR #${prNumber}`
			);

			// Request review from the user
			await this.githubClient.requestReviewers(owner, repo, prNumber, [user.login]);

			console.log(
				`[CodeReviewHandler] Successfully requested review from ${task.user_email} (${user.login}) on PR #${prNumber}`
			);
		} catch (error) {
			// Log but don't throw - reviewer assignment is a nice-to-have, not critical
			console.error(
				`[CodeReviewHandler] Failed to assign GitHub reviewer for task ${taskId}:`,
				error
			);
		}
	}

	/**
	 * Assign the Linear ticket creator as a reviewer to the GitLab merge request
	 */
	private async assignTicketCreatorAsGitLabReviewer(
		taskId: string,
		projectPath: string,
		mrIid: number
	): Promise<void> {
		try {
			// Get the task to access the user email
			const task = await getTaskById(taskId);
			if (!task) {
				console.log(`[CodeReviewHandler] Task ${taskId} not found, cannot assign reviewer`);
				return;
			}

			// Skip if user email is unknown or the default agent email
			const agentFallbackEmail = await configService.get(
				'email.fallback_address',
				'agent@example.com'
			);
			if (
				!task.user_email ||
				task.user_email === 'unknown' ||
				task.user_email === agentFallbackEmail
			) {
				console.log(
					`[CodeReviewHandler] No valid user email for task ${taskId}, skipping reviewer assignment`
				);
				return;
			}

			console.log(`[CodeReviewHandler] Looking up GitLab user for email: ${task.user_email}`);

			// Find the GitLab user by email
			const userId = await this.gitlabClient.findUserByEmail(task.user_email);
			if (!userId) {
				console.log(
					`[CodeReviewHandler] Could not find GitLab user with email ${task.user_email}, skipping reviewer assignment`
				);
				return;
			}

			console.log(
				`[CodeReviewHandler] Found GitLab user ID ${userId} for ${task.user_email}, assigning as reviewer to MR !${mrIid}`
			);

			// Assign the user as a reviewer
			await this.gitlabClient.assignReviewers(projectPath, mrIid, [userId]);

			console.log(
				`[CodeReviewHandler] Successfully assigned ${task.user_email} (ID: ${userId}) as reviewer to MR !${mrIid}`
			);
		} catch (error) {
			// Log but don't throw - reviewer assignment is a nice-to-have, not critical
			console.error(
				`[CodeReviewHandler] Failed to assign GitLab reviewer for task ${taskId}:`,
				error
			);
		}
	}

	/**
	 * Get comprehensive code review instruction for a task
	 */
	async getCodeReviewInstruction(
		taskId: string,
		taskDescription: string,
		mrPrUrl: string
	): Promise<string> {
		const host = detectGitHost(mrPrUrl);

		if (host === 'github') {
			return this.getGitHubCodeReviewInstruction(taskId, taskDescription, mrPrUrl);
		} else {
			return this.getGitLabCodeReviewInstruction(taskId, taskDescription, mrPrUrl);
		}
	}

	/**
	 * Get GitHub code review instruction
	 */
	private async getGitHubCodeReviewInstruction(
		taskId: string,
		taskDescription: string,
		prUrl: string
	): Promise<string> {
		const parsed = this.githubClient.parsePRUrl(prUrl);

		if (!parsed) {
			throw new Error(`Invalid GitHub PR URL: ${prUrl}`);
		}

		const context = await this.githubClient.getPRReviewContext(
			parsed.owner,
			parsed.repo,
			parsed.prNumber
		);

		// Update last review SHA
		await updateTaskMRMetadata(taskId, {
			last_review_sha: context.pr.head.sha,
		});

		return this.formatGitHubCodeReviewInstruction(context, taskDescription);
	}

	/**
	 * Get GitLab code review instruction
	 */
	private async getGitLabCodeReviewInstruction(
		taskId: string,
		taskDescription: string,
		mrUrl: string
	): Promise<string> {
		const parsed = this.gitlabClient.parseMRUrl(mrUrl);

		if (!parsed) {
			throw new Error(`Invalid GitLab MR URL: ${mrUrl}`);
		}

		const context = await this.gitlabClient.getMRReviewContext(parsed.projectPath, parsed.mrIid);

		// Update last review SHA
		await updateTaskMRMetadata(taskId, {
			last_review_sha: context.mr.sha,
		});

		return this.formatGitLabCodeReviewInstruction(context, taskDescription);
	}
}
