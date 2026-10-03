const API_BASE = (process.env.OBELISK_API_URL || "http://127.0.0.1:5105").replace(/\/$/, "");
const API_TOKEN = process.env.OBELISK_API_TOKEN;

async function api(path) {
    const response = await fetch(`${API_BASE}${path}`, {
        headers: { accept: "application/json", authorization: `Bearer ${API_TOKEN}` },
    });
    if (!response.ok) throw new Error(`Inventory read failed: HTTP ${response.status}`);
    return response.json();
}

async function inventoryFor(backend) {
    const query = `/v1/executions?show_derived=true&ffqn_prefix=${encodeURIComponent(`agent-backed-llm:models/${backend}.discover-models`)}&direction=older&length=1`;
    const [latest, successful] = await Promise.all([
        api(`${query}&state=finished`),
        api(`${query}&state=finished_ok`),
    ]);
    const last = latest[0];
    const success = successful[0];
    const metadata = { status: "pending", discovered_at: null, last_attempt_at: last?.created_at || null, error: null };
    let models = [];
    if (success) {
        const result = await api(`/v1/executions/${encodeURIComponent(success.execution_id)}`);
        const inventory = JSON.parse(result.ok);
        metadata.discovered_at = inventory.discovered_at;
        metadata.image = inventory.image;
        models = inventory.models.map((model) => ({ ...model, created: Math.floor(Date.parse(inventory.discovered_at) / 1000) }));
        metadata.status = "ready";
    }
    if (last && last.execution_id !== success?.execution_id) {
        const result = await api(`/v1/executions/${encodeURIComponent(last.execution_id)}`);
        metadata.status = success ? "stale" : "unavailable";
        metadata.error = typeof result.err === "string" ? result.err : JSON.stringify(result.err);
    }
    return { backend, models, metadata };
}

export default async function handle(request) {
    if (request.method !== "GET") return Response.json({ error: { message: "method not allowed" } }, { status: 405 });
    try {
        const inventories = await Promise.all(["claude", "codex"].map(inventoryFor));
        const data = inventories.flatMap((inventory) => inventory.models);
        return Response.json({
            object: "list", data,
            backends: Object.fromEntries(inventories.map(({ backend, metadata }) => [backend, metadata])),
        }, { status: data.length ? 200 : 503, headers: { "cache-control": "no-store" } });
    } catch (error) {
        return Response.json({ error: { message: String(error.message || error) } }, { status: 502 });
    }
}
