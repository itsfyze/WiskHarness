import { Readable } from "node:stream";
import { createInterface } from "node:readline";

const instruction = "You are in Plan mode. Help the user reason, brainstorm, explain and plan. You have no tools and cannot inspect files, run commands or write notes. Describe checks as proposed steps unless the user supplies evidence.";

export async function streamPlan({ endpoint, model, messages, signal, onText, contextTokens, onMetrics }) {
  const history = messages
    .filter(message => ["user", "assistant"].includes(message.role) && message.text)
    .map(message => ({ role: message.role, content: message.text }));
  const response = await fetch(endpoint + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: true,
      ...(contextTokens ? {options:{num_ctx:contextTokens}} : {}),
      messages: [{ role: "system", content: instruction }, ...history]
    }),
    signal
  });
  if (!response.ok || !response.body) {
    throw new Error("Ollama chat returned HTTP " + response.status);
  }
  const lines = createInterface({
    input: Readable.fromWeb(response.body),
    crlfDelay: Infinity
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.error) throw new Error(String(event.error));
    if (typeof event.message?.content === "string") onText(event.message.content);
    if (event.done === true) {
      const stats={};
      for (const key of ["eval_count","eval_duration","prompt_eval_count","prompt_eval_duration","total_duration","load_duration"]) {
        if (Number.isFinite(event[key]) && event[key]>=0) stats[key]=event[key];
      }
      if (Number.isFinite(stats.eval_count) && stats.eval_duration > 0) stats.tokensPerSecond=stats.eval_count*1e9/stats.eval_duration;
      onMetrics?.(stats);
      return event.done_reason || "end_turn";
    }
  }
  throw new Error("Ollama closed the chat stream before completing the turn");
}

