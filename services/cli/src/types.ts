export interface ProfileConfig {
  apiUrl?: string;
  wsUrl?: string;
  token?: string;
}

export interface CLIConfig {
  currentProfile: string;
  profiles: Record<string, ProfileConfig>;
}

export interface RuntimeConfig {
  profile: string;
  apiUrl: string;
  wsUrl: string;
  token?: string;
}

export type OptionValue = string | boolean | string[];

export interface ParsedArgs {
  positionals: string[];
  options: Record<string, OptionValue>;
}

export interface GlobalOptions {
  json: boolean;
  quiet: boolean;
  profile?: string;
  apiUrl?: string;
  wsUrl?: string;
  token?: string;
}
