const commands = 'auth config profile job queue cron dlq health completion help version';

export function completionScript(shell: string): string {
  if (shell === 'bash') {
    return `# TaskQueue CLI completion
_taskqueue_complete() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=( $(compgen -W "${commands}" -- "$cur") )
}
complete -F _taskqueue_complete taskqueue tq
`;
  }
  if (shell === 'zsh') {
    return `#compdef taskqueue tq
_arguments '1:command:(${commands})'
`;
  }
  if (shell === 'fish') {
    return commands
      .split(' ')
      .map((command) => `complete -c taskqueue -c tq -f -a '${command}'`)
      .join('\n')
      .concat('\n');
  }
  throw new Error('Supported shells: bash, zsh, fish');
}
