# delegate-review

After you finish implementing a feature or making code changes, delegate a code review to a second model via the orager MCP server.

## When to use

Call this skill when:
- You have finished implementing a feature or bug fix
- You want a second opinion on the correctness, security, or quality of your changes
- The task description asks for a review pass

## How to use

The orager MCP server must be running and configured in your MCP settings. Call the `run_agent` tool with a review-focused prompt and a different model than the one you used for implementation.

### Example

```json
{
  "tool": "run_agent",
  "arguments": {
    "model": "anthropic/claude-sonnet-4-6",
    "prompt": "Review the code changes I just made. Run `git diff HEAD~1` to see the diff. Check for: correctness, edge cases, security issues, and anything that could break. Post a comment on Paperclip issue $PAPERCLIP_TASK_ID summarizing your findings.",
    "cwd": "/path/to/project"
  }
}
```

## Model chaining convention

| Step | Purpose | Suggested model |
|---|---|---|
| Implementation | Write code, edit files, run tests | `deepseek/deepseek-chat-v3-0324` (fast, cheap) |
| Review | Audit diff, check correctness | `anthropic/claude-sonnet-4-6` (via OpenRouter) |
| Deep reasoning | Complex architecture decisions | `deepseek/deepseek-r1` or `anthropic/claude-opus-4-6` |

All models are accessed through the same OpenRouter API key — no separate Anthropic API key needed.

## Notes

- The review agent runs in the same `cwd` so it has access to the same files and git history
- Pass `session_id` from the implementation run if you want the reviewer to have full context
- The reviewer can also call `post-comment` directly to post its findings to Paperclip
