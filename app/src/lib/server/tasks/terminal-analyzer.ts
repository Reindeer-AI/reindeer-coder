import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicApiKey } from '../secrets';

export interface AnalysisResult {
	state: 'agent_done_waiting' | 'needs_user_input' | 'still_working';
	reasoning: string;
	mergeRequestUrl?: string;
	summary?: string;
}

/**
 * Analyze terminal output to determine if agent is done, needs input, or still working
 */
export async function analyzeTerminalOutput(
	terminalOutput: string,
	taskDescription: string
): Promise<AnalysisResult> {
	const apiKey = await getAnthropicApiKey();

	const client = new Anthropic({ apiKey });

	// Build the analysis prompt
	const prompt = `You are analyzing a terminal output from an autonomous coding agent to determine its current state.

## Task Description
${taskDescription}

## Terminal Output (last section)
\`\`\`
${terminalOutput}
\`\`\`

## Your Task
Analyze the terminal output and classify the agent's current state into one of these categories:

1. **agent_done_waiting**: The agent has completed its work (e.g., created a merge request) and is simply waiting for human review. Look for:
   - Merge request creation messages (glab mr create, gh pr create, etc.)
   - Messages like "Waiting for review", "Ready for review", "MR created"
   - The agent appears idle after completing implementation tasks
   - No active processes or commands running after the MR creation

2. **needs_user_input**: The agent is blocked and needs user input or clarification. Look for:
   - Explicit prompts asking for user input or decisions
   - Questions about implementation choices
   - Errors that require user intervention
   - Requests for clarification on requirements
   - The agent is waiting for a response to continue

3. **still_working**: The agent is actively working on the task. Look for:
   - Active commands being executed
   - File edits in progress
   - Build/test processes running
   - Planning or analysis activities
   - Recent command outputs (within the last few minutes)

## Output Format
Respond with a JSON object:
{
  "state": "agent_done_waiting" | "needs_user_input" | "still_working",
  "reasoning": "Brief explanation of why you chose this state",
  "mergeRequestUrl": "URL if a merge request was created (optional)",
  "summary": "Brief summary of what the agent accomplished (optional, only for agent_done_waiting)"
}

IMPORTANT:
- If there are commands AFTER merge request creation, classify as "still_working"
- If the terminal shows an idle state after MR creation, classify as "agent_done_waiting"
- Default to "still_working" if uncertain
- Extract the MR URL from messages like "View merge request at:" or similar
- Keep reasoning concise (1-2 sentences)`;

	try {
		const response = await client.messages.create({
			model: 'claude-sonnet-4-5-20250929',
			max_tokens: 1024,
			messages: [
				{
					role: 'user',
					content: prompt,
				},
			],
		});

		// Extract the text response
		const textContent = response.content.find((block) => block.type === 'text');
		if (!textContent || textContent.type !== 'text') {
			throw new Error('No text content in Claude response');
		}

		// Parse the JSON response
		const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			throw new Error('No JSON found in Claude response');
		}

		const result = JSON.parse(jsonMatch[0]) as AnalysisResult;

		// Validate the result
		if (!['agent_done_waiting', 'needs_user_input', 'still_working'].includes(result.state)) {
			throw new Error(`Invalid state: ${result.state}`);
		}

		return result;
	} catch (error) {
		console.error('[terminal-analyzer] Error analyzing terminal output:', error);
		// Default to still_working on error to be safe
		return {
			state: 'still_working',
			reasoning: `Analysis failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
