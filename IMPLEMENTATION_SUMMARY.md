# REI-538: Task Status Monitoring Dashboard - Implementation Summary

## Overview

Implemented a comprehensive AI-powered task monitoring system that:
- ✅ Monitors all active tasks via SSH/tmux connections
- ✅ Uses Anthropic Agent SDK (Claude Sonnet 4.5) for intelligent analysis
- ✅ Suggests next actions based on terminal state
- ✅ Can autonomously continue agents when appropriate
- ✅ Provides REST APIs for dashboard integration
- ✅ Replaces old "needs attention" logic with AI-based analysis

## Architecture

### Background Service
**File**: `app/src/lib/server/tasks/task-status-monitor.ts`

- Polls all active tasks every 60 seconds (configurable)
- Checks for active SSH connections using `getConnectionInfo()`
- Reads terminal output from files populated by live SSH connections
- Analyzes with Claude API to determine agent state
- Stores analysis results in task metadata
- Can autonomously prompt agents to continue

**Key Features**:
- Throttling: Only analyzes tasks that haven't been checked in 5+ minutes
- SSH-aware: Only analyzes tasks with active SSH connections
- Smart state detection: 5 distinct states (working, idle, needs_input, stuck, completed)
- Confidence scoring: 0-100% confidence in analysis
- Action suggestions: 1-3 concrete next steps per analysis

### API Endpoints

#### GET `/api/tasks`
**Enhanced**: Now includes AI analysis in response
- Removed old `needsAttention` time-based logic
- Added AI-based `needsAttention` flag (based on analysis state)
- Includes full analysis object with state, summary, actions, confidence

#### GET `/api/tasks/:id/analysis`
Get latest AI analysis for a specific task

#### POST `/api/tasks/:id/analysis`
Trigger immediate analysis (bypasses throttling)

#### POST `/api/tasks/:id/continue`
Manually prompt agent to continue work

#### GET `/api/monitoring/dashboard`
Comprehensive monitoring dashboard with statistics:
- Summary: counts by state (working, idle, stuck, completed, needs_input)
- Task list with analysis data
- Last update timestamp

### Database Schema

Extended `tasks.metadata` JSON field:
```json
{
  "monitoring": {
    "last_analysis": {
      "state": "agent_working",
      "reasoning": "...",
      "summary": "...",
      "suggestedActions": ["...", "..."],
      "confidence": 85,
      "timestamp": "2026-02-15T10:30:00Z",
      "terminalSnapshot": "..."
    },
    "last_check_timestamp": "2026-02-15T10:30:00Z",
    "auto_continue_count": 0
  }
}
```

### Integration Points

**hooks.server.ts**:
- Starts task status monitor on server boot
- Graceful shutdown on SIGTERM/SIGINT

**vm/orchestrator.ts**:
- Added helper functions: `hasActiveConnection()`, `getConnectionInfo()`
- Monitor uses these to verify SSH connection status before analysis

**terminal-storage.ts**:
- Monitor reads terminal output via `readTerminalFile()`
- Files are populated in real-time by SSH connection

## AI Analysis

### Agent States
1. **agent_working**: Actively working (recent commands, file operations)
2. **agent_idle_waiting**: Completed work, waiting for review (MR created)
3. **agent_needs_input**: Blocked, needs user input (questions, clarifications)
4. **agent_stuck**: Stuck or erroring (repeated errors, no progress)
5. **agent_completed**: Fully completed with deliverables (MR/PR created, tests passing)

### Analysis Prompt
The system uses a detailed prompt that instructs Claude to:
- Classify agent state based on terminal output
- Provide reasoning (1-2 sentences)
- Summarize current activity (1 sentence)
- Suggest 1-3 concrete next actions
- Provide confidence score (0-100)
- Determine if auto-continue is safe

### Safety Features
- Conservative classification (defaults to "working" if uncertain)
- High confidence threshold for auto-continue (disabled by default)
- Auto-continue limit (max 2 times per task)
- Requires explicit user configuration to enable auto-continue

## Files Created/Modified

### New Files
1. `app/src/lib/server/tasks/task-status-monitor.ts` - Main monitoring service
2. `app/src/routes/api/tasks/[id]/analysis/+server.ts` - Analysis API endpoints
3. `app/src/routes/api/tasks/[id]/continue/+server.ts` - Continue agent endpoint
4. `app/src/routes/api/monitoring/dashboard/+server.ts` - Monitoring dashboard API
5. `app/MONITORING.md` - Comprehensive documentation
6. `IMPLEMENTATION_SUMMARY.md` - This file

### Modified Files
1. `app/src/hooks.server.ts` - Start monitoring service on boot
2. `app/src/routes/api/tasks/+server.ts` - Add AI analysis to task list
3. `app/src/lib/server/vm/orchestrator.ts` - Add SSH connection helpers

## Configuration

### Environment Variables
```bash
# Task monitoring poll interval (default: 60000ms)
TASK_MONITOR_POLL_INTERVAL_MS=60000

# Anthropic API key (required)
ANTHROPIC_API_KEY_SECRET=your-secret-name
```

### Feature Flags
**Auto-Continue** (disabled by default):
- Edit `task-status-monitor.ts`
- Uncomment auto-continue logic in `handleAnalysisResult()`
- Set appropriate confidence thresholds

## Testing

### Manual Testing Steps

1. **Start the server**:
   ```bash
   cd app && npm run dev
   ```

2. **Create a test task**:
   ```bash
   curl -X POST http://localhost:5173/api/tasks \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "repository": "your-org/your-repo",
       "base_branch": "main",
       "task_description": "Test task for monitoring",
       "coding_cli": "claude-code"
     }'
   ```

3. **Wait for task to start running** (status: "running")

4. **Check monitoring dashboard**:
   ```bash
   curl http://localhost:5173/api/monitoring/dashboard \
     -H "Authorization: Bearer YOUR_TOKEN"
   ```

5. **Trigger immediate analysis**:
   ```bash
   curl -X POST http://localhost:5173/api/tasks/{TASK_ID}/analysis \
     -H "Authorization: Bearer YOUR_TOKEN"
   ```

6. **Check task list with analysis**:
   ```bash
   curl http://localhost:5173/api/tasks \
     -H "Authorization: Bearer YOUR_TOKEN"
   ```

### Expected Behavior

1. **Server logs** should show:
   ```
   [Server] Starting Task Status Monitor...
   [TaskStatusMonitor] Starting monitor...
   [TaskStatusMonitor] Poll interval: 60000ms
   [TaskStatusMonitor] Checking N active tasks
   ```

2. **Analysis results** should appear in task metadata after first poll (60s)

3. **API responses** should include:
   - `needsAttention` flag (true for idle/stuck/needs_input/completed)
   - `analysis` object with state, summary, actions, confidence
   - `lastCheckTimestamp` showing when last analyzed

## Performance Characteristics

- **API Calls**: ~1 Claude API call per active task every 5+ minutes
- **CPU**: Negligible (async background polling)
- **Memory**: Minimal (terminal data read from disk, not cached)
- **Database**: Lightweight JSON metadata updates only
- **Cost**: With 10 active tasks: ~12 API calls/hour, ~288 calls/day

## Security

- All endpoints require authentication
- Users can only access their own tasks (unless admin)
- Terminal snapshots truncated to last 100 lines
- Sensitive data redacted before analysis
- Analysis stored in task metadata (encrypted at rest)

## Future Enhancements

### Immediate (Should be done next)
- [ ] Frontend dashboard component to display monitoring data
- [ ] Real-time updates via WebSocket or SSE
- [ ] Email/Slack notifications for stuck agents
- [ ] Historical analysis tracking (separate table)

### Nice to Have
- [ ] Custom analysis rules per project
- [ ] Agent performance metrics (time to completion, error rates)
- [ ] Predictive analysis (estimate time to completion)
- [ ] Integration with Linear/Jira for ticket updates
- [ ] Automated code quality checks before MR creation

## Migration Notes

### Breaking Changes
None - this is additive functionality.

### Backward Compatibility
- Old tasks without analysis will show `analysis: null`
- Old `needsAttention` logic replaced but API field name preserved
- Existing Linear integration continues to work alongside new monitoring

### Rollback Plan
If issues arise:
1. Comment out monitoring service start in `hooks.server.ts`
2. Revert changes to `app/src/routes/api/tasks/+server.ts`
3. Old time-based `needsAttention` logic can be restored

## Deployment

### Prerequisites
1. Ensure `ANTHROPIC_API_KEY_SECRET` is configured in Secret Manager
2. Verify database supports JSONB (PostgreSQL) or TEXT (SQLite) for metadata
3. Check that SSH connections are working for existing tasks

### Deployment Steps
1. Deploy new code to server
2. Server will automatically start monitoring service
3. Wait 60 seconds for first analysis cycle
4. Verify in logs: `[TaskStatusMonitor] Starting monitor...`
5. Test monitoring API endpoints

### Monitoring
Watch server logs for:
- `[TaskStatusMonitor] Checking N active tasks` - every 60 seconds
- `[TaskStatusMonitor] Analysis for {id}: {state}` - per task analyzed
- Any error messages from Claude API

## Support

For issues or questions:
- Check `app/MONITORING.md` for detailed documentation
- Review server logs for monitoring service status
- Inspect task metadata in database for analysis results
- File issues in GitLab with logs and task IDs

## Success Criteria

✅ Background service monitors all active tasks
✅ SSH connection status verified before analysis
✅ Claude API analyzes terminal output correctly
✅ Analysis stored in task metadata
✅ API endpoints return analysis data
✅ Old "needs attention" logic replaced with AI-based version
✅ Comprehensive documentation provided
✅ Safe defaults (auto-continue disabled)
✅ Performance optimized (5-minute throttling)
✅ Security considered (auth, permissions, data redaction)

## Credits

Implemented as part of Linear ticket REI-538.
Uses Anthropic Claude Sonnet 4.5 for AI analysis.
