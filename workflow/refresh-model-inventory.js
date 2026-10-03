import { discoverModelsSubmit as claudeSubmit } from "agent-backed-llm:models-obelisk-ext/claude";
import { discoverModelsSubmit as codexSubmit } from "agent-backed-llm:models-obelisk-ext/codex";
import * as obelisk from "obelisk:workflow@1.0.0";
import { errorMessage } from "../errors.js";

export default function refreshModelInventory() {
    const probes = [["claude", claudeSubmit], ["codex", codexSubmit]].map(([backend, submit]) => {
        const joinSet = obelisk.createJoinSet({ name: backend });
        submit(joinSet);
        return { backend, joinSet };
    });
    const results = [];
    for (const { backend, joinSet } of probes) {
        try {
            const inventory = JSON.parse(joinSet.joinNext());
            results.push({ backend, status: "ready", discovered_at: inventory.discovered_at, model_count: inventory.models.length });
        } catch (error) {
            const message = errorMessage(error);
            console.log(`${backend} model discovery failed: ${message}`);
            results.push({ backend, status: "unavailable", error: message });
        } finally {
            joinSet.close();
        }
    }
    return JSON.stringify(results);
}
