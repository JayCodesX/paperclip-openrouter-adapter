---
description: Update the status of a Paperclip issue (e.g. mark as in_progress or done)
exec: curl -s -X PATCH "$PAPERCLIP_API_URL/api/issues/{{issueId}}" -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" -d "{\"status\": {{status}}}"
parameters: {"type": "object", "properties": {"issueId": {"type": "string", "description": "The issue UUID"}, "status": {"type": "string", "enum": ["todo", "in_progress", "done", "cancelled"], "description": "The new status"}}, "required": ["issueId", "status"]}
---
# update-issue-status

Updates the status of a Paperclip issue. Valid statuses: `todo`, `in_progress`, `done`, `cancelled`.

Mark an issue as `in_progress` when you start working on it, and `done` when you finish.
