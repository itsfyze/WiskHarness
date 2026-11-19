# Security

Please use the repository’s private vulnerability reporting feature when it is available. Avoid attaching chats, real command output, credentials, or a vault to a public issue.

Electron’s backend binds to loopback and requires a per-launch token. The renderer is sandboxed, uses context isolation, and has Node integration disabled. The desktop blocks navigation away from its app origin and limits external links to official runtime and release destinations.

Agent and terminal commands run as your Windows account. The Agent has no OS process sandbox or network isolation. Workspace restrictions apply to explicit paths in approval requests. WiskHarness resolves existing parents and checks the resolved path, including through junctions. Goose can read files outside ACP permission callbacks, and shell commands can run other programs and access the network. The app does not independently enforce install, build, Git, and external app rules inside shell commands.

Secret protection blocks recognized credential paths where WiskHarness receives an approval request. It redacts recognizable values from saved new replies, captured tool traces and terminal output, and omits snapshots of files that match. Redaction is pattern-based. Live streamed chat text, old data, and Goose's native session files have separate retention behavior. Approved commands and other programs running under the same Windows account may be able to access local credentials and data.

Cloud API keys are encrypted with Windows DPAPI CurrentUser in the local profile. The backend decrypts keys on demand and sends them only to the configured provider. The UI can enter or remove a key and receives only its saved status. Cloud endpoints are fixed HTTPS origins, redirects are rejected, and chat requires explicit consent to send the conversation text. Compatibility tests use synthetic prompts and require separate consent for paid providers. Local compatible endpoints are restricted to IPv4 loopback, and users should trust the service running there.

Diagnostic exports contain allowlisted runtime status fields. Profile backups intentionally contain conversation text and workspace paths, so keep them private. They exclude credential files and Goose native state. When Git stages text with secret protection enabled, it checks for recognizable credentials. Git commits created in the app are unsigned and do not run repository hooks. Local Git configuration and concurrent changes outside the app remain part of the trusted desktop environment.

The update checker reads public GitHub release metadata and verifies downloads using the asset size and GitHub-provided digest. The app saves update files for manual installation. WiskHarness currently ships unsigned executables. The standalone developer server is intended for loopback use.
