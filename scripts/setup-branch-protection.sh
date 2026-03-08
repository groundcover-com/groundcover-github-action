#!/usr/bin/env bash
set -euo pipefail

REPO="groundcover-com/groundcover-github-action"
BRANCH="main"

echo "Setting up branch protection for $REPO ($BRANCH)"
echo "Requires: gh auth with admin access to the repo"
echo ""

gh api \
  --method PUT \
  "repos/$REPO/branches/$BRANCH/protection" \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "lint",
      "typecheck",
      "test (ubuntu-latest)",
      "test (windows-latest)",
      "test (macos-latest)",
      "build",
      "security",
      "codeql"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true,
    "require_last_push_approval": true
  },
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": true,
  "restrictions": null
}
EOF

echo ""
echo "Branch protection configured for $BRANCH"
echo ""
echo "Summary:"
echo "  - Required checks: lint, typecheck, test (3 OS), build, security, codeql"
echo "  - Strict status checks (branch must be up to date)"
echo "  - 1 approving review required"
echo "  - Dismiss stale reviews on new push"
echo "  - CODEOWNERS review required"
echo "  - Last push approval required"
echo "  - Linear history (no merge commits)"
echo "  - No force pushes or branch deletion"
echo "  - Conversation resolution required"
