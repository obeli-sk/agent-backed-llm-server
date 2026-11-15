// Long-running session workflow: one per conversation. It owns the docker
// container + warm Codex CLI (via the exec activities). After the
// container is up it hands the turn loop to a child workflow and awaits it,
// then tears the container down in `finally`.
//
// The child is `loop.agent-loop-cancellable`: the `-cancellable` suffix lets it
// be stopped with the cancel RPC (an external party cancels the child execution
// id), which is how the frontend closes a session. Cancellation reaches the
// child even while it is blocked awaiting the LLM reply, not only between turns.
// It does not weaken structured concurrency: this parent still outlives the
// child and still runs the container cleanup below.

import * as codex from "agent-backed-llm:agent/codex";
import * as session from "agent-backed-llm:agent/session";
import { agentLoopCancellable } from "agent-backed-llm:session/loop";
import * as obelisk from "obelisk:workflow@1.0.0";
import { typedError } from "../errors.js";

export default function sessionWorkflow(backend, systemPrompt, maxTurns, model, recovery) {
    if (backend && backend !== "codex") throw { permanent_error: `unknown backend: ${backend} (expected codex)` };
    if (typeof systemPrompt !== "string") throw { permanent_error: "system-prompt is required" };
    const cliModel = typeof model === "string" ? model : "";

    const executionId = obelisk.executionIdCurrent();
    const sessionId = sanitize(executionId);
    const containerName = `agent-backed-llm-${sessionId}`;
    const socketPath = `/tmp/agent-backed-llm/${sessionId}.sock`;

    let workflowError = null;
    let outcome = "session ended";
    let failureCase = "permanent_start_failed";
    try {
        const startInfo = codex.start(containerName, socketPath, systemPrompt, cliModel);
        console.log(`Started Codex agent ${startInfo.container} from ${startInfo.image}`);
        failureCase = "permanent_error";
        outcome = agentLoopCancellable(socketPath, systemPrompt, maxTurns, recovery ?? null);
    } catch (error) {
        workflowError = typedError(error, failureCase);
    } finally {
        try {
            session.cleanup(containerName, socketPath);
            console.log(`Cleaned up ${containerName}`);
        } catch (error) {
            console.log(`Cleanup failed for ${containerName}: ${String(error)}`);
            if (workflowError === null) workflowError = typedError(error, "permanent_cleanup_failed");
        }
    }
    if (workflowError !== null) throw workflowError;
    return outcome;
}

function sanitize(value) { return String(value).replace(/[^A-Za-z0-9_.-]/g, "-"); }
