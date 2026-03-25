---
description: List open issues assigned to you in Paperclip
exec: curl -s "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues?assigneeAgentId=$PAPERCLIP_AGENT_ID&status=todo,in_progress" -H "Authorization: Bearer $PAPERCLIP_API_KEY"
parameters: {"type": "object", "properties": {}}
---
# list-issues

Returns all open issues (todo or in_progress) currently assigned to you.

Use this when no PAPERCLIP_TASK_ID is set and you need to find what to work on next. Pick the highest priority issue and call get-task with its ID to get full details.
