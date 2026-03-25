# delete-issue

Delete a Paperclip issue by ID.

## When to use

Call this skill when the user asks you to delete or remove a Paperclip issue.

## Parameters

- `issueId` — the issue ID to delete (required)

## exec

```
curl -s -X DELETE "$PAPERCLIP_API_URL/api/issues/{{issueId}}" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json"
```

## Notes

- This permanently deletes the issue and cannot be undone.
- You must have `PAPERCLIP_API_URL` and `PAPERCLIP_API_KEY` set in your environment (both are injected automatically by the adapter).
- Confirm with the user before deleting unless they have explicitly asked you to proceed.
