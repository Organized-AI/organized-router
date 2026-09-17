// Codex 0.154.0 drops root -c flags when a subcommand also receives -c.
// Collect them at the root, then apply transport settings last. A router
// launcher must not silently change to a direct provider.
export function codexArguments(userArgs, transportArgs, defaults = []) {
  const configuration = [], remaining = [];
  for (let i = 0; i < userArgs.length; i++) {
    const value = userArgs[i];
    if (value === '--') { remaining.push(...userArgs.slice(i)); break; }
    if (value === '-c' || value === '--config') {
      if (i + 1 >= userArgs.length) throw new Error('A Codex configuration value is required after ' + value);
      configuration.push('-c', userArgs[++i]);
    } else if (value.startsWith('--config=')) configuration.push('-c', value.slice('--config='.length));
    else if (value.startsWith('-c') && value.length > 2 && !value.startsWith('--')) configuration.push('-c', value.slice(2));
    else remaining.push(value);
  }
  return [...configuration, ...transportArgs, ...defaults, ...remaining];
}
