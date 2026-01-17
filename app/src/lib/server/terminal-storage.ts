import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

// Directory for terminal files (relative to project root)
const TERMINAL_FILES_DIR = './terminal_files';

/**
 * Redact sensitive values from terminal output
 */
function redactSensitive(text: string): string {
	// Patterns for various API keys and tokens
	const patterns = [
		// Anthropic API keys (sk-ant-...)
		/sk-ant-[a-zA-Z0-9_-]{20,}/g,
		// OpenAI API keys (sk-...)
		/sk-[a-zA-Z0-9]{20,}/g,
		// Google API keys
		/AIza[a-zA-Z0-9_-]{35}/g,
		// GitLab tokens (glpat-...)
		/glpat-[a-zA-Z0-9_-]{20,}/g,
		// GitHub tokens (ghp_..., gho_..., ghu_..., ghs_..., ghr_...)
		/gh[pousr]_[a-zA-Z0-9]{36,}/g,
		// Git clone URLs with tokens (https://user:TOKEN@gitlab.com/...)
		/(https:\/\/[^:]+:)[^@\s]+(@(?:gitlab|github)\.com)/gi,
		// Generic Bearer tokens in export commands
		/export\s+[A-Z_]*(?:KEY|TOKEN|SECRET)[A-Z_]*=["']?([^"'\s]+)["']?/gi,
		// Environment variable assignments with sensitive names
		/(ANTHROPIC_API_KEY|OPENAI_API_KEY|GITLAB_TOKEN|GIT_TOKEN|API_KEY|SECRET|TOKEN|PASSWORD)=["']?([^"'\s\r\n]+)["']?/gi,
	];

	let result = text;
	for (const pattern of patterns) {
		result = result.replace(pattern, (match, g1, g2) => {
			// For git clone URLs with tokens (https://user:TOKEN@...), reconstruct with [REDACTED]
			if (match.startsWith('https://') && match.includes(':') && match.includes('@')) {
				return `${g1}[REDACTED]${g2}`;
			}
			// For env var assignments, preserve the var name but redact the value
			if (match.includes('=')) {
				const eqIndex = match.indexOf('=');
				const varPart = match.substring(0, eqIndex + 1);
				return `${varPart}[REDACTED]`;
			}
			// For standalone keys, show first 8 chars then redact
			if (match.length > 12) {
				return `${match.substring(0, 8)}...[REDACTED]`;
			}
			return '[REDACTED]';
		});
	}
	return result;
}

/**
 * Ensure the terminal files directory exists
 */
export function ensureTerminalFilesDir(): void {
	try {
		if (!existsSync(TERMINAL_FILES_DIR)) {
			mkdirSync(TERMINAL_FILES_DIR, { recursive: true });
			console.log(`[terminal-storage] Created directory: ${TERMINAL_FILES_DIR}`);
		}
	} catch (error) {
		console.error(`[terminal-storage] Failed to create directory ${TERMINAL_FILES_DIR}:`, error);
	}
}

/**
 * Get the file path for a task's terminal output
 */
export function getTerminalFilePath(taskId: string): string {
	return join(TERMINAL_FILES_DIR, `${taskId}.txt`);
}

/**
 * Initialize a terminal file for a new task
 */
export function initTerminalFile(taskId: string): string {
	ensureTerminalFilesDir();
	const filePath = getTerminalFilePath(taskId);

	try {
		// Create empty file if it doesn't exist
		if (!existsSync(filePath)) {
			writeFileSync(filePath, '', 'utf-8');
			console.log(`[terminal-storage] Initialized terminal file: ${filePath}`);
		}
	} catch (error) {
		console.error(
			`[terminal-storage] Failed to initialize terminal file for task ${taskId}:`,
			error
		);
		throw error;
	}

	return filePath;
}

/**
 * Append content to a terminal file with redaction
 */
export function appendToTerminalFile(taskId: string, content: string): void {
	const filePath = getTerminalFilePath(taskId);

	try {
		// Apply redaction before writing
		const redacted = redactSensitive(content);
		appendFileSync(filePath, redacted, 'utf-8');
	} catch (error) {
		console.error(
			`[terminal-storage] Failed to append to terminal file for task ${taskId}:`,
			error
		);
		throw error;
	}
}

/**
 * Read terminal file content
 * @param taskId - The task ID
 * @param limitLines - Maximum number of lines to return from the end (default: 1000, null for unlimited)
 */
export function readTerminalFile(taskId: string, limitLines: number | null = 1000): string | null {
	const filePath = getTerminalFilePath(taskId);

	try {
		if (!existsSync(filePath)) {
			return null;
		}
		const content = readFileSync(filePath, 'utf-8');

		// Return only the latest N lines to avoid memory issues
		if (limitLines !== null) {
			const lines = content.split('\n');
			if (lines.length > limitLines) {
				return lines.slice(-limitLines).join('\n');
			}
		}
		return content;
	} catch (error) {
		console.error(`[terminal-storage] Failed to read terminal file for task ${taskId}:`, error);
		return null;
	}
}

/**
 * Read terminal file from a specific offset (for streaming)
 */
export function readTerminalFileFromOffset(taskId: string, offset: number): string | null {
	const filePath = getTerminalFilePath(taskId);

	try {
		if (!existsSync(filePath)) {
			return null;
		}
		const content = readFileSync(filePath, 'utf-8');
		return content.slice(offset);
	} catch (error) {
		console.error(
			`[terminal-storage] Failed to read terminal file from offset for task ${taskId}:`,
			error
		);
		return null;
	}
}

/**
 * Get the age of the terminal file in minutes
 * Returns null if file doesn't exist or on error
 */
export function getTerminalFileAge(taskId: string): number | null {
	const filePath = getTerminalFilePath(taskId);

	try {
		if (!existsSync(filePath)) {
			return null;
		}
		const stats = statSync(filePath);
		const now = Date.now();
		const mtime = stats.mtime.getTime();
		const ageInMinutes = (now - mtime) / 1000 / 60;
		return ageInMinutes;
	} catch (error) {
		console.error(`[terminal-storage] Failed to get file age for task ${taskId}:`, error);
		return null;
	}
}

/**
 * Check if a task needs attention (terminal hasn't changed for 5+ minutes)
 * Only returns true for running tasks
 */
export function needsAttention(taskId: string, status: string): boolean {
	// Only check running tasks
	if (status !== 'running') {
		return false;
	}

	const age = getTerminalFileAge(taskId);
	if (age === null) {
		return false;
	}

	// Terminal hasn't changed in 5+ minutes
	return age >= 5;
}

/**
 * Strip ANSI escape codes from text
 */
function stripAnsi(text: string): string {
	// Remove ANSI escape sequences:
	// - CSI sequences: ESC [ ... (letter) - colors, cursor movement, etc.
	// - OSC sequences: ESC ] ... (BEL or ESC \) - window titles, etc.
	// - Simple escapes: ESC (letter) - like ESC c for reset
	return text
		.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '') // CSI sequences
		.replace(/\x1b\][^\x07]*\x07/g, '') // OSC sequences (BEL terminated)
		.replace(/\x1b\][^\x1b]*\x1b\\/g, '') // OSC sequences (ST terminated)
		.replace(/\x1b[()][AB012]/g, '') // Character set selection
		.replace(/\x1b[a-zA-Z]/g, '') // Simple escape sequences
		.replace(/\r/g, ''); // Carriage returns
}

/**
 * Render terminal output as plain text, simulating a basic terminal
 * Handles cursor movement and line clearing for a cleaner preview
 */
function renderTerminalAsText(content: string, rows: number): string {
	// Strip ANSI codes first
	const stripped = stripAnsi(content);

	// Split into lines, handling various line endings
	const rawLines = stripped.split('\n');

	// Process lines - skip empty lines at the end and system messages
	const processedLines: string[] = [];

	for (const line of rawLines) {
		const trimmed = line.trim();

		// Skip system messages
		if (
			trimmed.startsWith('[system]') ||
			trimmed.startsWith('[step') ||
			trimmed.startsWith('[error]') ||
			trimmed.startsWith('[config]') ||
			trimmed.startsWith('[ssh]') ||
			trimmed.startsWith('[user]') ||
			trimmed.startsWith('====')
		) {
			continue;
		}

		// Skip lines that are just control characters or empty after stripping
		if (trimmed.length === 0) {
			// Keep one empty line but not multiple consecutive
			if (processedLines.length > 0 && processedLines[processedLines.length - 1] !== '') {
				processedLines.push('');
			}
			continue;
		}

		processedLines.push(line);
	}

	// Remove trailing empty lines
	while (processedLines.length > 0 && processedLines[processedLines.length - 1] === '') {
		processedLines.pop();
	}

	// Get last N lines
	const lastLines = processedLines.slice(-rows);
	return lastLines.join('\n');
}

/**
 * Get a preview of the terminal output (last N rows, rendered as plain text)
 * @param taskId - The task ID
 * @param rows - Number of rows to return (default: 20)
 */
export function getTerminalPreview(taskId: string, rows: number = 20): string | null {
	const filePath = getTerminalFilePath(taskId);

	if (!existsSync(filePath)) {
		return null;
	}

	try {
		const content = readFileSync(filePath, 'utf-8');
		return renderTerminalAsText(content, rows);
	} catch (error) {
		console.error(`[terminal-storage] Failed to read terminal preview for task ${taskId}:`, error);
		return null;
	}
}
