# .claude/hooks/check-backlog.ps1
#
# PreToolUse hook for Claude Code (Windows/PowerShell). Blocks Write calls
# that would create or modify a docs/backlog/CC-###.md ticket file, so a
# new ticket needs your explicit go-ahead rather than being filed on its own.
#
# Install:
#   1. Save this file as .claude/hooks/check-backlog.ps1 in the repo
#      (no chmod / executable bit needed on Windows — nothing to set)
#   2. Add the hook registration block to .claude/settings.json (see chat)
#   3. TEST IT before trusting it: ask Claude Code to create a throwaway
#      docs/backlog/CC-099.md and confirm the write is actually denied,
#      not just that the hook ran without error.

$hookPayload = [Console]::In.ReadToEnd() | ConvertFrom-Json

# Normalize backslashes to forward slashes so the regex matches regardless
# of how the path was written internally.
$filePath = $hookPayload.tool_input.file_path -replace '\\', '/'

if ($filePath -match 'docs/backlog/CC-\d+\.md$') {
    $decision = @{
        hookSpecificOutput = @{
            hookEventName            = "PreToolUse"
            permissionDecision        = "deny"
            permissionDecisionReason  = "New/edited backlog ticket ($filePath) needs explicit approval. Propose it in plan mode or ask directly - don't file it on your own."
        }
    } | ConvertTo-Json -Depth 10

    Write-Output $decision
    exit 0
}

# Not a backlog file - no objection, let the write proceed.
exit 0