---
description: Fetch full details for a Paperclip task/issue including title, description, project, goal, and wake comment
exec: curl -s "$PAPERCLIP_API_URL/api/issues/{{issueId}}/heartbeat-context" -H "Authorization: Bearer $PAPERCLIP_API_KEY"
parameters: {"type": "object", "properties": {"issueId": {"type": "string", "description": "The issue UUID (use $PAPERCLIP_TASK_ID env var if set)"}}, "required": ["issueId"]}
---
# get-task

Fetches the full details of a Paperclip issue including its title, description, status, priority, project, goal, and the comment that triggered this run (if any).

Always call this first when PAPERCLIP_TASK_ID is set in your environment.
