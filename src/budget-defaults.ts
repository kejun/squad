/** Largest lossless counters and longest native Node timer; never use Infinity in saved JSON. */
export const maximumCount = Number.MAX_SAFE_INTEGER;
export const maximumTimeoutMs = 2_147_483_647;
/** DeepSeek V4.1 Flash: actual upstream prompt limit from a real HTTP400, 2026-11-12. */
export const defaultContextWindowTokens = 1_048_571;
export const deepseekFlashMaximumOutputTokens = 384_000;
