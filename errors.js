const STRING_CASES = new Set([
    "permanent_malformed_reply", "permanent_agent_exited", "permanent_error",
    "transient_error", "permanent_start_failed", "permanent_cleanup_failed",
]);

export function typedError(error, fallback = "permanent_error") {
    const value = error && typeof error === "object" && "value" in error ? error.value : error;
    if (value === "execution_failed") return value;
    if (value && typeof value === "object") {
        const entries = Object.entries(value);
        if (entries.length === 1) {
            const [kind, detail] = entries[0];
            if (STRING_CASES.has(kind) && typeof detail === "string") return value;
            if (kind === "permanent_rate_limited" && detail && typeof detail === "object") return value;
        }
    }
    return { [fallback]: typeof value === "string" ? value : String(error) };
}

export function errorMessage(error) {
    const value = typedError(error);
    if (typeof value === "string") return value;
    const detail = Object.values(value)[0];
    return typeof detail === "string" ? detail : detail.message;
}
