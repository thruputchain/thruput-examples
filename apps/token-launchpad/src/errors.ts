const MAX_ERROR_LENGTH = 300;

export function userErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || error.message.trim() === "") return fallback;
  const message = error.message
    .replace(/0x[0-9a-f]{32,}/gi, "[redacted identifier]")
    .replace(/\s+/g, " ")
    .trim();
  return message.length <= MAX_ERROR_LENGTH
    ? message
    : `${message.slice(0, MAX_ERROR_LENGTH - 3)}...`;
}
