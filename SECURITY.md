# Security Policy

## Supported versions

Security fixes are provided for the latest released version of Magic Reactions.
Deployers should keep their Railway service on the repository's current `main`
branch and review release notes before upgrading.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's security
advisory flow for this repository. Do not post credentials, owner codes, signed
asset URLs, OAuth tokens, database URLs, or Bucket keys in a public issue.

Include the affected version, a minimal reproduction, the expected behavior,
and the observed behavior. Replace every secret and personal reaction with a
clearly fake value before attaching logs or screenshots.

## Deployment responsibility

Each Railway deployment receives its own generated owner and OAuth secrets.
Deployers are responsible for protecting their Railway account, GIPHY key, and
ChatGPT connector access. If a secret may have leaked, replace it in Railway and
reconnect ChatGPT before continuing to use the deployment.
