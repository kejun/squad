/** Largest lossless counters and longest native Node timer; never use Infinity in saved JSON. */
export const maximumCount = Number.MAX_SAFE_INTEGER;
export const maximumTimeoutMs = 2_147_483_647;
/** DeepSeek V4.1 Flash: actual upstream prompt limit from a real HTTP400, 2026-11-12. */
export const defaultContextWindowTokens = 1_048_571;
/** Requested max_tokens when MAX_TOKENS is unset. Same number DeepSeek V4.1 Flash publishes as its output limit. */
export const defaultMaxOutputTokens = 384_000;
export const deepseekFlashMaximumOutputTokens = defaultMaxOutputTokens;
/** Above undici's 300_000 ms headersTimeout. At 1 token/s, 384_000 tokens need 384_000_000 ms; the Node timer maximum still covers that generation. */
export const defaultModelTransportTimeoutMs = maximumTimeoutMs;
