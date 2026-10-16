# Security Policy

## Report privately

Email [contact@byteforge.software](mailto:contact@byteforge.software) with `SECURITY: Merge Forge`
in the subject. Do not put exploit details, credentials, or private repository content in a public
issue or pull request. GitHub private vulnerability reporting is not currently enabled for this
repository, so use email.

Include:

- The affected Merge Forge version, editor version, and operating system.
- The affected component and the impact you observed.
- Minimal reproduction steps using a disposable repository and synthetic files.
- Sanitized logs, screenshots, or a suggested fix, if available.

Remove API keys, tokens, personal data, private code, and sensitive paths before sending a report.
If credentials were exposed, revoke or rotate them through the relevant provider. Do not send the
credentials themselves.

## Relevant security areas

- Repository access and Git operations, including path handling and preserving user changes.
- AI tool access to files and repository context, including instructions embedded in untrusted files.
- Handling of AI-provider credentials and data sent to configured providers.
- Webview content, message validation, and interaction with the extension host.
- Dependencies and the integrity of extension bundles and packages.

The extension works with local repository content. AI features can send prompts and repository
context to the selected model provider. Use synthetic examples for reports and tests, and confirm
your organization's rules before using AI features with confidential code.

## Triage and fixes

The maintainer will assess the report and coordinate next steps privately. Response and fix timing
depend on severity, reproducibility, and maintainer availability. No response-time or older-version
support guarantee is made. Coordinate public disclosure with the maintainer after remediation.
