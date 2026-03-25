---
description: Post a comment on a Paperclip issue to report results, ask questions, or indicate you are blocked
exec: curl -s -X POST "$PAPERCLIP_API_URL/api/issues/{{issueId}}/comments" -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" -d "{\"body\": {{body}}}"
parameters: {"type": "object", "properties": {"issueId": {"type": "string", "description": "The issue UUID"}, "body": {"type": "string", "description": "The comment text (markdown supported)"}}, "required": ["issueId", "body"]}
---
# post-comment

Posts a comment on a Paperclip issue. Use this to:
- Report the results of completed work
- Ask a clarifying question if you are blocked
- Summarize what you did this run

Always call this at the end of a run when you have worked on a task.
