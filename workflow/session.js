// Long-running session workflow: one per conversation. It owns the docker
// container + warm claude/codex CLI (via the exec activities). After the
// container is up it hands the turn loop to a child workflow and awaits it,
// then tears the container down in `finally`.
//
// The child is `loop.agent-loop-cancellable`: the `-cancellable` suffix lets it
// be stopped with the cancel RPC (an external party cancels the child execution
// id), which is how the frontend closes a session. Cancellation reaches the
// child even while it is blocked awaiting the LLM reply, not only between turns.
// It does not weaken structured concurrency: this parent still outlives the
// child and still runs the container cleanup below.

import * as claude from "agent-backed-llm:agent/claude";
import * as codex from "agent-backed-llm:agent/codex";
import * as session from "agent-backed-llm:agent/session";
import { agentLoopCancellable } from "agent-backed-llm:session/loop";

const STARTERS = { claude: claude.start, codex: codex.start };

export default function sessionWorkflow(backend, systemPrompt, maxTurns) {
    const which = (typeof backend === "string" && backend) ? backend : "claude";
    const start = STARTERS[which];
    if (!start) throw `unknown backend: ${which} (expected claude or codex)`;
    if (typeof systemPrompt !== "string") throw "system-prompt is required";

    const executionId = obelisk.executionIdCurrent();
    const sessionId = sanitize(executionId);
    const containerName = `agent-backed-llm-${sessionId}`;
    const socketPath = `/tmp/agent-backed-llm/${sessionId}.sock`;

    let workflowError = null;
    let outcome = "session ended";
    try {
        const startInfo = start(containerName, socketPath, systemPrompt);
        console.log(`Started ${which} agent ${startInfo.container} from ${startInfo.image}`);
        outcome = agentLoopCancellable(socketPath, systemPrompt, maxTurns);
    } catch (error) {
        workflowError = error;
    } finally {
        try {
            session.cleanup(containerName, socketPath);
            console.log(`Cleaned up ${containerName}`);
        } catch (error) {
            console.log(`Cleanup failed for ${containerName}: ${String(error)}`);
            if (workflowError === null) workflowError = error;
        }
    }
    if (workflowError !== null) throw workflowError;
    return outcome;
}

function sanitize(value) { return String(value).replace(/[^A-Za-z0-9_.-]/g, "-"); }
