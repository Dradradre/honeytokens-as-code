# Security policy

Honeytokens as Code plants decoys and creates IAM users, so a flaw here can hurt the people relying on it.
Please report vulnerabilities privately.

## Reporting

Use GitHub's private vulnerability reporting: **Security → Report a vulnerability** on
[the repository](https://github.com/Dradradre/honeytokens-as-code/security/advisories/new).
Please do not open a public issue for security problems.

Include what you found, how to reproduce it, and what an attacker could do with it. You will get an
acknowledgement within a few days; fixes ship as a patch release with credit unless you prefer otherwise.

## In scope

- Anything that lets a decoy, the registry (`~/.honeytoken`) or a watchlist leak secrets or decoy locations
- A trap that can be fingerprinted as a decoy from what is planted in the repository
- An AWS canary that can do anything beyond failing (for example a way around the deny-all policy)
- Writing outside the repository (symlinks, path traversal), or alert content that can inject into Slack,
  Discord or an agent
- Supply-chain issues in the published npm package

## Out of scope

- Limitations already documented in the README (CloudTrail delay, data-plane calls, a compromised
  workstation, a compromised alert server)
