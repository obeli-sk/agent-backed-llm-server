import { discoverModels } from "agent-backed-llm:models/codex";
import { errorMessage } from "../errors.js";

export default function refreshModelInventory() {
    let result;
    try {
        const inventory = JSON.parse(discoverModels());
        result = { backend: "codex", status: "ready", discovered_at: inventory.discovered_at, model_count: inventory.models.length };
    } catch (error) {
        const message = errorMessage(error);
        console.log(`Codex model discovery failed: ${message}`);
        result = { backend: "codex", status: "unavailable", error: message };
    }
    return JSON.stringify([result]);
}
