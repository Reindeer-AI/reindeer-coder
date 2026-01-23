import { configService } from '../config-service';
import { getTaskById, updateTaskMRMetadata } from '../db';
import { GitLabClient } from '../gitlab/client';
import type { GitLabMRNote, MRReviewContext } from '../gitlab/types';

export class CodeReviewHandler {
	private gitlabClient: GitLabClient;

	constructor() {
		this.gitlabClient = new GitLabClient();
	}

	/**
	 * Format code review context into a comprehensive instruction for the agent
	 */
	formatCodeReviewInstruction(context: MRReviewContext, taskDescription: string): string {
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
	 * Extract MR URL from terminal output after implementation
	 */
	async detectAndStoreMRInfo(taskId: string, terminalOutput: string): Promise<void> {
		const mrUrl = this.gitlabClient.extractMRUrl(terminalOutput);

		if (!mrUrl) {
			console.log(`[CodeReviewHandler] No MR URL found in terminal output for task ${taskId}`);
			return;
		}

		const parsed = this.gitlabClient.parseMRUrl(mrUrl);
		if (!parsed) {
			console.log(`[CodeReviewHandler] Could not parse MR URL: ${mrUrl}`);
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

			console.log(`[CodeReviewHandler] Stored MR info for task ${taskId}: ${mrUrl}`);

			// Assign the ticket creator as a reviewer
			await this.assignTicketCreatorAsReviewer(taskId, parsed.projectPath, parsed.mrIid);
		} catch (error) {
			console.error(`[CodeReviewHandler] Failed to fetch MR details for task ${taskId}:`, error);
		}
	}

	/**
	 * Assign the Linear ticket creator as a reviewer to the merge request
	 */
	private async assignTicketCreatorAsReviewer(
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
			console.error(`[CodeReviewHandler] Failed to assign reviewer for task ${taskId}:`, error);
		}
	}

	/**
	 * Get comprehensive code review instruction for a task
	 */
	async getCodeReviewInstruction(
		taskId: string,
		taskDescription: string,
		gitlabMRUrl: string
	): Promise<string> {
		const parsed = this.gitlabClient.parseMRUrl(gitlabMRUrl);

		if (!parsed) {
			throw new Error(`Invalid GitLab MR URL: ${gitlabMRUrl}`);
		}

		const context = await this.gitlabClient.getMRReviewContext(parsed.projectPath, parsed.mrIid);

		// Update last review SHA
		await updateTaskMRMetadata(taskId, {
			last_review_sha: context.mr.sha,
		});

		return this.formatCodeReviewInstruction(context, taskDescription);
	}
}
