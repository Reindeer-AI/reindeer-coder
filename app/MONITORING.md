# Task Status Monitoring Dashboard

## Overview

The Task Status Monitoring system provides real-time AI-powered analysis of autonomous coding agent tasks. It monitors terminal output via SSH/tmux connections, analyzes agent behavior using Claude, and suggests next actions.

## Features

### 🔍 Automated Monitoring
- **Background Service**: Continuously monitors all active tasks (running, cloning, initializing)
- **SSH/Tmux Integration**: Connects to VMs via SSH and captures terminal snapshots
- **Smart Polling**: Checks task status every 60 seconds (configurable via `TASK_MONITOR_POLL_INTERVAL_MS`)
- **Throttling**: Skips tasks that were checked less than 5 minutes ago to reduce API costs

### 🤖 AI-Powered Analysis
The system uses Claude Sonnet 4.5 to analyze terminal output and classify agent state:

- **agent_working**: Agent is actively working on the task (commands running, file operations, etc.)
- **agent_idle_waiting**: Agent completed work and is idle (MR created, waiting for review)
- **agent_needs_input**: Agent is blocked and needs user input (questions, clarifications)
- **agent_stuck**: Agent is stuck or in an error state (repeated errors, no progress)
- **agent_completed**: Agent has fully completed the task with deliverables (MR/PR created)

Each analysis includes:
- **State classification** with reasoning
- **Summary** of current activity
- **Suggested actions** (1-3 concrete next steps)
- **Confidence score** (0-100)
- **Terminal snapshot** (last 100 lines for reference)

### 📊 Dashboard API
Comprehensive REST APIs for monitoring:

#### GET `/api/tasks`
List all tasks with embedded analysis:
```json
{
  "tasks": [
    {
      "id": "task-123",
      "status": "running",
      "latestAnalysis": {
        "state": "agent_working",
        "summary": "Implementing authentication feature",
        "confidence": 85,
        "suggestedActions": ["Wait for tests to complete"],
        "timestamp": "2026-02-15T10:30:00Z"
      },
      "lastCheckTimestamp": "2026-02-15T10:30:00Z"
    }
  ]
}
```

#### GET `/api/tasks/:id/analysis`
Get latest analysis for a specific task:
```json
{
  "analysis": {
    "state": "agent_idle_waiting",
    "reasoning": "MR created and agent is waiting at prompt",
    "summary": "Agent completed implementation and created merge request",
    "suggestedActions": [
      "Review the merge request at https://gitlab.com/...",
      "Provide feedback if changes are needed"
    ],
    "confidence": 90,
    "timestamp": "2026-02-15T10:30:00Z",
    "terminalSnapshot": "..."
  }
}
```

#### POST `/api/tasks/:id/analysis`
Trigger immediate analysis (bypasses throttling):
```bash
curl -X POST https://your-app.com/api/tasks/123/analysis \
  -H "Authorization: Bearer YOUR_TOKEN"
```

#### POST `/api/tasks/:id/continue`
Manually prompt agent to continue:
```bash
curl -X POST https://your-app.com/api/tasks/123/continue \
  -H "Authorization: Bearer YOUR_TOKEN"
```

#### GET `/api/monitoring/dashboard`
Comprehensive monitoring dashboard:
```json
{
  "summary": {
    "totalActiveTasks": 5,
    "tasksWorking": 3,
    "tasksIdle": 1,
    "tasksStuck": 1,
    "tasksCompleted": 0,
    "tasksNeedingInput": 0
  },
  "tasks": [
    {
      "id": "task-123",
      "status": "running",
      "repository": "my-org/my-repo",
      "taskDescription": "Implement user authentication...",
      "analysis": {...},
      "lastCheckTimestamp": "2026-02-15T10:30:00Z",
      "autoContinueCount": 0
    }
  ],
  "lastUpdate": "2026-02-15T10:35:00Z"
}
```

## Configuration

### Environment Variables

```bash
# Task monitoring poll interval (default: 60000ms = 60 seconds)
TASK_MONITOR_POLL_INTERVAL_MS=60000

# Anthropic API key (required for AI analysis)
ANTHROPIC_API_KEY_SECRET=your-secret-name
```

### Database Schema

The system stores analysis results in the `tasks.metadata` JSON field:

```json
{
  "monitoring": {
    "last_analysis": {
      "state": "agent_working",
      "reasoning": "Agent is running tests",
      "summary": "Running test suite",
      "suggestedActions": ["Wait for tests to complete"],
      "confidence": 85,
      "timestamp": "2026-02-15T10:30:00Z",
      "terminalSnapshot": "..."
    },
    "last_check_timestamp": "2026-02-15T10:30:00Z",
    "auto_continue_count": 0
  }
}
```

## Architecture

### Background Service
`task-status-monitor.ts` - Main monitoring service
- Polls database every 60 seconds for active tasks
- Skips tasks checked less than 5 minutes ago
- Reads terminal output via `readTerminalFile()`
- Calls Claude API to analyze terminal output
- Stores results in task metadata

### API Endpoints
- `/api/tasks/:id/analysis` - Get/trigger analysis for a single task
- `/api/tasks/:id/continue` - Manually continue an agent
- `/api/monitoring/dashboard` - Comprehensive monitoring view

### Integration Points
- **hooks.server.ts**: Starts monitoring service on server startup
- **terminal-storage.ts**: Reads terminal output from local files
- **vm/orchestrator.ts**: SSH connections and terminal capture
- **db/index.ts**: Task metadata storage and retrieval

## Usage Examples

### Frontend Dashboard Integration

```typescript
// Fetch monitoring dashboard
const response = await fetch('/api/monitoring/dashboard', {
  headers: { 'Authorization': `Bearer ${token}` }
});
const dashboard = await response.json();

// Display task states
dashboard.tasks.forEach(task => {
  if (task.analysis) {
    console.log(`Task ${task.id}: ${task.analysis.state}`);
    console.log(`Summary: ${task.analysis.summary}`);
    console.log(`Actions:`, task.analysis.suggestedActions);
  }
});
```

### Trigger Analysis on Demand

```typescript
// Trigger immediate analysis for a specific task
const response = await fetch(`/api/tasks/${taskId}/analysis`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}` }
});
const { analysis } = await response.json();
```

### Auto-Continue Agent

```typescript
// Manually prompt agent to continue
const response = await fetch(`/api/tasks/${taskId}/continue`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}` }
});
```

## Future Enhancements

### Planned Features
- [ ] Automatic agent continuation based on analysis (currently commented out)
- [ ] Webhook notifications when agents need attention
- [ ] Historical analysis tracking and trend visualization
- [ ] Custom analysis rules and thresholds
- [ ] Integration with alerting systems (Slack, PagerDuty, etc.)
- [ ] Agent performance metrics (time to completion, error rates)

### Auto-Continue Feature
The system supports automatic agent continuation, but it's **disabled by default** to prevent unintended behavior. To enable:

1. Edit `task-status-monitor.ts`
2. Uncomment the auto-continue logic in `handleAnalysisResult()`
3. Set appropriate confidence thresholds and limits

```typescript
// Example: Auto-continue idle agents with high confidence
if (
  analysis.state === 'agent_idle_waiting' &&
  analysis.confidence > 70 &&
  autoContinueCount < 2
) {
  await this.autoContinueAgent(task, analysis);
}
```

## Troubleshooting

### Analysis not running
- Check that `ANTHROPIC_API_KEY_SECRET` is configured
- Verify the monitoring service started (check server logs for "Starting Task Status Monitor")
- Ensure tasks have status "running" (not "cloning" or "initializing")

### Stale analysis data
- Analysis is throttled to every 5 minutes per task
- Use `POST /api/tasks/:id/analysis` to force immediate analysis

### High API costs
- Increase `TASK_MONITOR_POLL_INTERVAL_MS` to reduce frequency
- Adjust throttling in `analyzeTask()` method
- Consider disabling monitoring for non-critical tasks

## Security Considerations

- All API endpoints require authentication
- Users can only access their own task analyses (unless admin)
- Terminal snapshots are truncated to last 100 lines
- Sensitive data is redacted from terminal output before storage
- Analysis results are stored in task metadata (encrypted at rest in database)

## Performance

- **API Calls**: 1 Claude API call per task every 5+ minutes
- **Database Queries**: Lightweight metadata updates (JSON field)
- **Memory**: Minimal (terminal snapshots are read from disk, not cached)
- **CPU**: Negligible (background service uses async/await)

## Contributing

To extend the monitoring system:

1. Add new analysis states in `TaskAnalysis` interface
2. Update the Claude prompt in `analyzeTerminalOutput()`
3. Add new API endpoints as needed
4. Update this documentation

## Support

For issues or questions:
- Check server logs for monitoring service status
- Review task metadata in database for analysis results
- File issues in the project repository
