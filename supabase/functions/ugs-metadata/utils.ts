/**
 * Extract the first two Perforce path fragments (e.g., "//depot/stream").
 * Falls back to returning the original project string if pattern doesn't match.
 */
export function getProjectStream(project: string): string {
  const match = project.match(/(\/\/[a-zA-Z0-9.\-_]+\/[a-zA-Z0-9.\-_]+)/);
  return match ? match[1] : project;
}

/**
 * Build the LIKE pattern string for project matching.
 */
export function projectLikeString(project: string | null): string {
  return "%" + (project == null ? "" : getProjectStream(project)) + "%";
}

/**
 * Check if a project name matches a wildcard pattern (e.g., "//depot/stream/...").
 */
export function matchesWildcard(wildcard: string, project: string): boolean {
  return (
    wildcard.endsWith("...") &&
    project
      .toLowerCase()
      .startsWith(wildcard.substring(0, wildcard.length - 4).toLowerCase())
  );
}

/**
 * Truncate text to a maximum length, preserving newline boundaries where possible.
 */
export function sanitizeText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const newlineIdx = text.lastIndexOf("\n", maxLength);
  if (newlineIdx === -1) {
    return text.substring(0, maxLength - 3).trimEnd() + "...";
  }
  return text.substring(0, newlineIdx + 1) + "...";
}

// -- Enum mappings (C# enums serialize as integers in Newtonsoft.Json by default) --

export const BuildDataResult: Record<string, number> = {
  Starting: 0,
  Failure: 1,
  Warning: 2,
  Success: 3,
  Skipped: 4,
};

export const BuildDataResultFromInt: Record<number, string> = Object.fromEntries(
  Object.entries(BuildDataResult).map(([k, v]) => [v, k])
);

export const EventType: Record<string, number> = {
  Syncing: 0,
  Compiles: 1,
  DoesNotCompile: 2,
  Good: 3,
  Bad: 4,
  Unknown: 5,
  Starred: 6,
  Unstarred: 7,
  Investigating: 8,
  Resolved: 9,
};

export const EventTypeFromInt: Record<number, string> = Object.fromEntries(
  Object.entries(EventType).map(([k, v]) => [v, k])
);

export const TelemetryErrorType: Record<string, number> = {
  Crash: 0,
};

export const TelemetryErrorTypeFromInt: Record<number, string> = Object.fromEntries(
  Object.entries(TelemetryErrorType).map(([k, v]) => [v, k])
);
