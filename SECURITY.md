# Security Policy

## Supported Versions

NorixorTrans is still in the `0.x` development phase. Security fixes target the
latest code on the default branch; older development builds and historical
archives are generally not maintained separately. Please confirm the issue on
the latest version first, but do not expand data access, bypass site
permissions, or expose real credentials merely to reproduce it.

## Reporting a Vulnerability Privately

Do not open a public issue for an unpatched vulnerability. Do not paste API
keys, cookies, authentication headers, user text, complete subtitles, raw
Provider responses, or directly exploitable details into public discussions.

Use **Report a vulnerability** on the GitHub repository's **Security** page to
submit a report through Private Vulnerability Reporting. If that option is
temporarily unavailable, open a regular issue without sensitive details and
ask the maintainers for a private contact channel.

A useful report should include, where possible:

- The affected version, commit, or build identifier;
- The impact and a realistic attack scenario;
- Minimal reproduction steps or a minimal test page;
- Expected and actual behavior;
- Any known mitigation;
- Only the logs or screenshots needed to investigate without exposing user
  data.

Do not test against real accounts, paid services, or third-party systems
without authorization. Use accounts you control, synthetic text, and a
least-privilege environment. Do not perform denial-of-service testing, bulk
scraping, social engineering, or destructive actions.

The maintainers will first determine whether the report is reproducible and in
scope, then coordinate remediation and disclosure. Response times depend on
the issue's complexity and maintainer availability; this policy does not
promise a fixed SLA. Please allow reasonable time for coordination before
public disclosure.

## Security Scope

The following issues are generally in scope for a security report:

- Exposure of API keys, authentication data, or user translation text;
- Bypasses of extension permissions, messaging protocols, page isolation, or
  Shadow DOM boundaries;
- Remote code execution, Manifest V3 policy bypasses, or supply-chain risks;
- Incorrect cross-site ownership of subtitles, cached data, or settings;
- Bypasses of OCR screenshot protections, model download verification, or
  local-processing guarantees.

For ordinary functional defects, translation-quality problems, broken site
selectors, or compatibility issues without a security impact, use a public
issue and follow the [contribution guidelines](./CONTRIBUTING.md).
