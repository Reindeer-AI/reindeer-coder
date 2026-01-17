<script lang="ts">
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal as XTerm } from '@xterm/xterm';
import { onDestroy, onMount } from 'svelte';
import { browser } from '$app/environment';
import { authToken } from '$lib/stores/auth';

interface ConnectionStatus {
	status: 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | null;
	tmuxSession?: string;
	screenSession?: string; // backwards compatibility
	lastActivity?: string;
}

interface SystemMessage {
	type: 'status' | 'connection' | 'system' | 'error' | 'step' | 'done';
	message: string;
	timestamp: Date;
}

interface Props {
	taskId: string;
	onConnectionChange?: (status: ConnectionStatus) => void;
}

let { taskId, onConnectionChange }: Props = $props();

let terminalEl: HTMLDivElement;
let term: XTerm | null = null;
let fitAddon: FitAddon | null = null;
let eventSource: EventSource | null = null;
let connectionState = $state<ConnectionStatus['status']>(null);
let systemMessages = $state<SystemMessage[]>([]);
let systemMessagesEl: HTMLDivElement;
let showSendTextModal = $state(false);
let sendTextInput = $state('');

// Add a system message to the log
function addSystemMessage(type: SystemMessage['type'], message: string) {
	systemMessages = [...systemMessages.slice(-100), { type, message, timestamp: new Date() }];
	// Auto-scroll to bottom
	setTimeout(() => {
		if (systemMessagesEl) {
			systemMessagesEl.scrollTop = systemMessagesEl.scrollHeight;
		}
	}, 10);
}

// System message prefixes to filter from terminal
const systemPrefixes = ['[system]', '[config]', '[step', '[error]', '[ssh]', '[user]', '===='];

// Parse content and route system messages vs terminal output
function processContent(content: string): void {
	// Split into lines while preserving structure
	const lines = content.split(/(\r?\n)/);
	let terminalContent = '';

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmedLine = line.trim();

		// Check if this line is a system message
		const isSystemLine = systemPrefixes.some((prefix) => trimmedLine.startsWith(prefix));

		if (isSystemLine && trimmedLine.length > 0) {
			// Route to system messages area
			let msgType: SystemMessage['type'] = 'system';
			let msgContent = trimmedLine;

			if (trimmedLine.startsWith('[error]')) {
				msgType = 'error';
				msgContent = trimmedLine.replace('[error]', '').trim();
			} else if (trimmedLine.startsWith('[system]')) {
				msgType = 'system';
				msgContent = trimmedLine.replace('[system]', '').trim();
			} else if (trimmedLine.startsWith('[config]')) {
				msgType = 'system';
				msgContent = trimmedLine.replace('[config]', '').trim();
			} else if (trimmedLine.startsWith('[step')) {
				msgType = 'step';
				msgContent = trimmedLine;
			} else if (trimmedLine.startsWith('[ssh]')) {
				msgType = 'system';
				msgContent = trimmedLine.replace('[ssh]', 'SSH:').trim();
			} else if (trimmedLine.startsWith('[user]')) {
				msgType = 'system';
				msgContent = `User: ${trimmedLine.replace('[user]', '').trim()}`;
			} else if (trimmedLine.startsWith('====')) {
				// Skip separator lines
				continue;
			}

			if (msgContent) {
				addSystemMessage(msgType, msgContent);
			}
		} else {
			// Keep for terminal output
			terminalContent += line;
		}
	}

	// Write non-system content to terminal
	if (terminalContent) {
		term?.write(terminalContent);
	}
}

// Send special key sequences
function sendSpecialKey(key: 'ctrl-c' | 'ctrl-d' | 'ctrl-z' | 'esc' | 'tab' | 'enter') {
	const keyMap: Record<string, string> = {
		'ctrl-c': '\x03',
		'ctrl-d': '\x04',
		'ctrl-z': '\x1a',
		esc: '\x1b',
		tab: '\t',
		enter: '\r',
	};
	sendInput(keyMap[key]);
	term?.focus();
}

// Send action number (1-4 for Claude responses)
function sendAction(num: number) {
	sendInput(`${num.toString()}\r`);
	term?.focus();
}

// Handle send text modal
function openSendTextModal() {
	showSendTextModal = true;
	sendTextInput = '';
}

function closeSendTextModal() {
	showSendTextModal = false;
	sendTextInput = '';
}

function submitSendText() {
	if (sendTextInput.trim()) {
		// Send the text followed by Enter to make sure it's considered
		sendInput(`${sendTextInput}\r`);
		closeSendTextModal();
		term?.focus();
	}
}

// Send input data to the terminal (called by xterm's onData)
async function sendInput(data: string) {
	if (connectionState !== 'connected') return;

	try {
		const token = $authToken;
		if (!token) return;

		const response = await fetch(`/api/tasks/${taskId}/terminal`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ input: data }),
		});

		if (!response.ok) {
			console.error('Failed to send input:', await response.text());
		}
	} catch (err) {
		console.error('Error sending input:', err);
	}
}

// Send terminal resize event to backend
async function sendTerminalResize(cols: number, rows: number) {
	if (connectionState !== 'connected') return;

	try {
		const token = $authToken;
		if (!token) return;

		const response = await fetch(`/api/tasks/${taskId}/terminal/resize`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ cols, rows }),
		});

		if (!response.ok) {
			console.error('Failed to send resize:', await response.text());
		}
	} catch (err) {
		console.error('Error sending resize:', err);
	}
}

onMount(async () => {
	if (!browser) return;

	// Dynamically import xterm to avoid SSR issues
	const { Terminal } = await import('@xterm/xterm');
	const { FitAddon } = await import('@xterm/addon-fit');
	await import('@xterm/xterm/css/xterm.css');

	term = new Terminal({
		theme: {
			background: '#050f0f',
			foreground: '#e0e0e0',
			cursor: '#1fb8a8',
			cursorAccent: '#050f0f',
			selectionBackground: '#0d535340',
			black: '#050f0f',
			red: '#ef4444',
			green: '#22c55e',
			yellow: '#eab308',
			blue: '#3b82f6',
			magenta: '#14857f',
			cyan: '#1fb8a8',
			white: '#e0e0e0',
			brightBlack: '#6b7280',
			brightRed: '#f87171',
			brightGreen: '#4ade80',
			brightYellow: '#facc15',
			brightBlue: '#60a5fa',
			brightMagenta: '#22d3ee',
			brightCyan: '#2dd4bf',
			brightWhite: '#ffffff',
		},
		fontFamily: 'JetBrains Mono, Menlo, Monaco, monospace',
		fontSize: 14,
		lineHeight: 1.2,
		cursorBlink: true,
		scrollback: 10000,
		scrollOnUserInput: false,
	});

	fitAddon = new FitAddon();
	term.loadAddon(fitAddon);
	term.open(terminalEl);
	fitAddon.fit();

	// Prevent mouse wheel events from being sent to terminal process
	// Only allow scrolling through the buffer, not the SSH session
	const viewport = terminalEl.querySelector('.xterm-viewport');
	if (viewport) {
		viewport.addEventListener(
			'wheel',
			(e: Event) => {
				const wheelEvent = e as WheelEvent;
				// Stop propagation and prevent default to ensure wheel events don't reach terminal
				e.stopPropagation();
				e.preventDefault();

				// Manually handle scrolling on the viewport
				const delta = wheelEvent.deltaY;
				viewport.scrollTop += delta;
			},
			{ passive: false }
		);
	}

	// Handle keyboard input - send all keystrokes to the server
	term.onData((data) => {
		sendInput(data);
	});

	// Handle window resize
	const resizeObserver = new ResizeObserver(() => {
		fitAddon?.fit();
		// Send new terminal dimensions to backend after resize
		if (term && connectionState === 'connected') {
			sendTerminalResize(term.cols, term.rows);
		}
	});
	resizeObserver.observe(terminalEl);

	// Connect to SSE stream
	connectToStream();
});

function connectToStream() {
	const token = $authToken;
	if (!token || !term) return;

	eventSource = new EventSource(`/api/tasks/${taskId}/terminal?token=${encodeURIComponent(token)}`);

	eventSource.onmessage = (event) => {
		try {
			const data = JSON.parse(event.data);

			switch (data.type) {
				case 'buffer':
					// Initial buffer - parse and route system messages
					processContent(data.content);
					break;
				case 'output':
					// New streaming output - write directly to terminal to preserve escape sequences
					// This is important for tmux/screen which use cursor positioning
					term?.write(data.content);
					break;
				case 'status':
					// Status update - show in system messages area
					addSystemMessage('status', `Task is ${data.status}`);
					break;
				case 'connection': {
					// Connection status update
					connectionState = data.status;
					// Support both tmuxSession (new) and screenSession (legacy)
					const sessionName = data.tmuxSession || data.screenSession;
					onConnectionChange?.({
						status: data.status,
						tmuxSession: sessionName,
						screenSession: sessionName, // backwards compatibility
						lastActivity: data.lastActivity,
					});
					if (data.status === 'reconnecting') {
						addSystemMessage('connection', 'Reconnecting to session...');
					} else if (data.status === 'connected') {
						addSystemMessage('connection', `Connected to session: ${sessionName}`);
						// Send terminal dimensions to backend when connected
						if (term) {
							sendTerminalResize(term.cols, term.rows);
						}
					} else if (data.status === 'disconnected') {
						addSystemMessage('connection', 'Disconnected');
					}
					break;
				}
				case 'done':
					// Task completed - show in system messages area
					addSystemMessage('done', `Task ${data.status}`);
					eventSource?.close();
					break;
			}
		} catch (err) {
			console.error('Failed to parse SSE data:', err);
		}
	};

	eventSource.onerror = () => {
		addSystemMessage('error', 'Connection lost. Retrying...');
		eventSource?.close();
		// Retry after 3 seconds
		setTimeout(connectToStream, 3000);
	};
}

onDestroy(() => {
	eventSource?.close();
	term?.dispose();
});
</script>

<!-- Special keys toolbar for mobile -->
<div class="flex items-center gap-2 px-3 py-2 bg-[#0a1a1a] border-b border-reindeer-teal/20 flex-wrap">
	<span class="text-xs text-gray-500 mr-2">Keys:</span>
	<button
		onclick={() => sendSpecialKey('ctrl-c')}
		disabled={connectionState !== 'connected'}
		class="px-3 py-1.5 text-xs font-mono bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
	>
		Ctrl+C
	</button>
	<button
		onclick={() => sendSpecialKey('esc')}
		disabled={connectionState !== 'connected'}
		class="px-3 py-1.5 text-xs font-mono bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-400 border border-yellow-500/50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
	>
		Esc
	</button>
	<button
		onclick={() => sendSpecialKey('ctrl-z')}
		disabled={connectionState !== 'connected'}
		class="px-3 py-1.5 text-xs font-mono bg-orange-500/20 hover:bg-orange-500/30 text-orange-400 border border-orange-500/50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
	>
		Ctrl+Z
	</button>
	<button
		onclick={() => sendSpecialKey('tab')}
		disabled={connectionState !== 'connected'}
		class="px-3 py-1.5 text-xs font-mono bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 border border-blue-500/50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
	>
		Tab
	</button>
	<button
		onclick={() => sendSpecialKey('ctrl-d')}
		disabled={connectionState !== 'connected'}
		class="px-3 py-1.5 text-xs font-mono bg-gray-500/20 hover:bg-gray-500/30 text-gray-400 border border-gray-500/50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
	>
		Ctrl+D
	</button>
	<button
		onclick={() => sendSpecialKey('enter')}
		disabled={connectionState !== 'connected'}
		class="px-3 py-1.5 text-xs font-mono bg-green-500/20 hover:bg-green-500/30 text-green-400 border border-green-500/50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
	>
		Enter
	</button>

	<!-- Divider -->
	<div class="h-6 w-px bg-gray-700"></div>

	<!-- Action selector for Claude question responses -->
	<span class="text-xs text-gray-500 mr-2">Actions:</span>
	<button
		onclick={() => sendAction(1)}
		disabled={connectionState !== 'connected'}
		class="px-3 py-1.5 text-xs font-mono bg-purple-500/20 hover:bg-purple-500/30 text-purple-400 border border-purple-500/50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
	>
		1
	</button>
	<button
		onclick={() => sendAction(2)}
		disabled={connectionState !== 'connected'}
		class="px-3 py-1.5 text-xs font-mono bg-purple-500/20 hover:bg-purple-500/30 text-purple-400 border border-purple-500/50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
	>
		2
	</button>
	<button
		onclick={() => sendAction(3)}
		disabled={connectionState !== 'connected'}
		class="px-3 py-1.5 text-xs font-mono bg-purple-500/20 hover:bg-purple-500/30 text-purple-400 border border-purple-500/50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
	>
		3
	</button>
	<button
		onclick={() => sendAction(4)}
		disabled={connectionState !== 'connected'}
		class="px-3 py-1.5 text-xs font-mono bg-purple-500/20 hover:bg-purple-500/30 text-purple-400 border border-purple-500/50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
	>
		4
	</button>

	<!-- Divider -->
	<div class="h-6 w-px bg-gray-700"></div>

	<!-- Send Text button -->
	<button
		onclick={openSendTextModal}
		disabled={connectionState !== 'connected'}
		class="px-3 py-1.5 text-xs font-mono bg-teal-500/20 hover:bg-teal-500/30 text-teal-400 border border-teal-500/50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
	>
		Send Text
	</button>
</div>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	bind:this={terminalEl}
	class="h-[600px] bg-[#050f0f] cursor-text {connectionState !== 'connected' ? 'opacity-75' : ''}"
	onclick={() => term?.focus()}
></div>

<!-- System Messages Area -->
{#if systemMessages.length > 0}
	<div
		bind:this={systemMessagesEl}
		class="max-h-32 overflow-y-auto bg-[#0a1a1a] border-t border-reindeer-teal/20 px-4 py-2 space-y-1"
	>
		{#each systemMessages as msg}
			<div class="flex items-start gap-2 text-xs font-mono">
				<span class="text-gray-600 shrink-0">
					{msg.timestamp.toLocaleTimeString()}
				</span>
				<span class={
					msg.type === 'error' ? 'text-red-400' :
					msg.type === 'connection' ? 'text-cyan-400' :
					msg.type === 'done' ? 'text-emerald-400' :
					msg.type === 'status' ? 'text-yellow-400' :
					'text-gray-400'
				}>
					[{msg.type}]
				</span>
				<span class="text-gray-300">{msg.message}</span>
			</div>
		{/each}
	</div>
{/if}

<!-- Send Text Modal -->
{#if showSendTextModal}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
		onclick={(e) => {
			if (e.target === e.currentTarget) closeSendTextModal();
		}}
	>
		<div class="bg-[#0a1a1a] border border-reindeer-teal/30 rounded-lg shadow-xl max-w-xl w-full">
			<!-- Modal Header -->
			<div class="flex items-center justify-between px-6 py-4 border-b border-reindeer-teal/20">
				<h3 class="text-lg font-semibold text-white">Send Text to Terminal</h3>
				<button
					onclick={closeSendTextModal}
					class="text-gray-400 hover:text-white transition-colors"
				>
					<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
					</svg>
				</button>
			</div>

			<!-- Modal Body -->
			<div class="px-6 py-4">
				<p class="text-sm text-gray-400 mb-4">
					Enter the text you want to send to the terminal. It will be sent as a single input.
				</p>
				<textarea
					bind:value={sendTextInput}
					placeholder="Type your text here..."
					class="w-full h-32 px-4 py-3 bg-[#050f0f] border border-reindeer-teal/30 rounded-md text-white font-mono text-sm focus:outline-none focus:border-reindeer-teal/60 resize-none"
					onkeydown={(e) => {
						if (e.key === 'Enter' && e.ctrlKey) {
							e.preventDefault();
							submitSendText();
						}
						if (e.key === 'Escape') {
							e.preventDefault();
							closeSendTextModal();
						}
					}}
					autofocus
				></textarea>
				<p class="text-xs text-gray-500 mt-2">
					Press Ctrl+Enter to send, Esc to cancel
				</p>
			</div>

			<!-- Modal Footer -->
			<div class="flex items-center justify-end gap-3 px-6 py-4 border-t border-reindeer-teal/20">
				<button
					onclick={closeSendTextModal}
					class="px-4 py-2 text-sm font-medium text-gray-400 hover:text-white transition-colors"
				>
					Cancel
				</button>
				<button
					onclick={submitSendText}
					disabled={!sendTextInput.trim()}
					class="px-4 py-2 text-sm font-medium bg-teal-500/20 hover:bg-teal-500/30 text-teal-400 border border-teal-500/50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
				>
					Send
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	:global(.xterm) {
		padding: 12px;
		height: 100%;
	}
	:global(.xterm-viewport) {
		overflow-y: auto !important;
	}
	:global(.xterm-viewport::-webkit-scrollbar) {
		width: 10px;
	}
	:global(.xterm-viewport::-webkit-scrollbar-track) {
		background: #0a1a1a;
	}
	:global(.xterm-viewport::-webkit-scrollbar-thumb) {
		background: #0d5353;
		border-radius: 5px;
	}
	:global(.xterm-viewport::-webkit-scrollbar-thumb:hover) {
		background: #1fb8a8;
	}
</style>
