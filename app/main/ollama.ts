// Every request to the local models goes through here, so they're all made the same way.
// Ollama keeps a little of the small model on the processor to leave room on the graphics card,
// and that made each answer about a quarter slower. The whole model fits (about 3 GB of 4), so
// it's asked to put all of it on the card, unless the card turns out to be too full.

export const OLLAMA = "http://localhost:11434";
export const SMALL_MODEL = "qwen3.5:2b";
// The same size for every request: a different size makes Ollama reload the model, which takes seconds.
export const CONTEXT = 4096;

type Body = { model: string; options?: Record<string, unknown>; [key: string]: unknown };
export type ChatReply = { message: { content?: string; tool_calls?: { function: { name: string; arguments: Record<string, string> } }[] } };

let wholeOnCard = true;

export async function ollamaChat(body: Body, timeout?: number): Promise<ChatReply> {
  const send = (onCard: boolean) => fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: timeout ? AbortSignal.timeout(timeout) : undefined,
    body: JSON.stringify({
      stream: false, think: false, ...body,
      options: { num_ctx: CONTEXT, ...(onCard ? { num_gpu: 99 } : {}), ...body.options },
    }),
  });
  const onCard = wholeOnCard && body.model === SMALL_MODEL;
  let response = await send(onCard);
  // Something else is using the card, so let Ollama decide where the model goes from now on.
  if (!response.ok && onCard) {
    wholeOnCard = false;
    response = await send(false);
  }
  if (!response.ok) throw new Error(`Ollama answered ${response.status}`);
  return (await response.json()) as ChatReply;
}
