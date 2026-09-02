# .claude/hooks/check-backlog.ps1
#
# PreToolUse hook for Claude Code (Windows/PowerShell). Forces a permission
# prompt on any Write/Edit that would create or modify a docs/backlog/CC-###.md
# ticket file, so a new ticket always needs your live go-ahead rather than
# being filed unprompted — but a "yes, raise it" already said in chat can
# actually be honoured at the prompt, instead of hitting a hard wall no
# matter what (unconditional "deny" was tried first and did exactly that,
# 2026-09-01).
#
# Install:
#   1. Save this file as .claude/hooks/check-backlog.ps1 in the repo
#      (no chmod / executable bit needed on Windows — nothing to set)
#   2. Add the hook registration block to .claude/settings.json (see chat)
#   3. TEST IT before trusting it: ask Claude Code to create a throwaway
#      docs/backlog/CC-099.md and confirm you're prompted and can deny it,
#      not just that the hook ran without error.

$hookPayload = [Console]::In.ReadToEnd() | ConvertFrom-Json

# Normalize backslashes to forward slashes so the regex matches regardless
# of how the path was written internally.
$filePath = $hookPayload.tool_input.file_path -replace '\\', '/'

if ($filePath -match 'docs/backlog/CC-\d+\.md$') {
    $decision = @{
        hookSpecificOutput = @{
            hookEventName            = "PreToolUse"
            permissionDecision        = "ask"
            permissionDecisionReason  = "New/edited backlog ticket ($filePath). Confirm this was actually discussed and approved, not filed on its own."
        }
    } | ConvertTo-Json -Depth 10

    Write-Output $decision
    exit 0
}

# Not a backlog file - no objection, let the write proceed.
exit 0