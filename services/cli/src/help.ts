export const VERSION = '1.0.0';

export function mainHelp(): string {
  return `TaskQueue CLI ${VERSION}

Usage:
  taskqueue [global options] <command> <subcommand> [options]
  tq [global options] <command> <subcommand> [options]

Commands:
  auth login|token|logout       Manage API authentication
  config get|set|unset|list     Manage profiles and endpoints
  profile list|use|delete       Manage configuration profiles
  job list|submit|get|cancel    Submit and manage jobs
  job watch <id>                Stream job updates over WebSocket
  queue stats                   Show queue statistics
  cron list|create|disable      Manage recurring jobs
  dlq list|requeue              Manage dead-letter entries
  health                       Check API availability
  completion bash|zsh|fish      Print shell completion script

Global options:
  --profile <name>              Select a profile
  --api-url <url>               Override the API URL
  --ws-url <url>                Override the WebSocket URL
  --token <jwt>                 Override the authentication token
  --json, -j                    Emit machine-readable JSON
  --quiet, -q                   Suppress successful output
  --help, -h                    Show help
  --version, -v                 Show version

Examples:
  taskqueue auth login --secret "$JWT_SECRET"
  taskqueue job submit email --payload-file email.json --priority 1
  taskqueue job get <job-id> --json
  taskqueue job watch <job-id>
  taskqueue cron create nightly "0 2 * * *" data --payload '{"operation":"cleanup"}'
`;
}

export function commandHelp(command: string): string {
  const sections: Record<string, string> = {
    auth: `Usage:
  taskqueue auth login --secret <secret> [--client cli] [--expires-in 24h]
  taskqueue auth token <jwt>
  taskqueue auth logout
  taskqueue auth status`,
    config: `Usage:
  taskqueue config list
  taskqueue config get <api-url|ws-url|token>
  taskqueue config set <api-url|ws-url|token> <value>
  taskqueue config unset <api-url|ws-url|token>`,
    profile: `Usage:
  taskqueue profile list
  taskqueue profile use <name>
  taskqueue profile delete <name>`,
    job: `Usage:
  taskqueue job list [--type email|image|data] [--status STATUS] [--limit 50]
  taskqueue job submit <email|image|data> [--payload <json>|--payload-file <path|->]
      [--priority 1-5] [--max-retries n] [--schedule ISO_DATE]
      [--idempotency-key key] [--webhook url]
      [--on-success json] [--on-failure json]
  taskqueue job get <id>
  taskqueue job cancel <id>
  taskqueue job retry <id>
  taskqueue job watch <id> [--timeout seconds]`,
    queue: 'Usage:\n  taskqueue queue stats',
    cron: `Usage:
  taskqueue cron list
  taskqueue cron create <name> <expression> <email|image|data>
      [--payload <json>|--payload-file <path|->] [--priority 1-5]
  taskqueue cron disable <id>`,
    dlq: `Usage:
  taskqueue dlq list [--type email|image|data]
  taskqueue dlq requeue <entry-id>`,
  };
  return sections[command] || mainHelp();
}
