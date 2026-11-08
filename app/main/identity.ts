// Who Jarvis is. Every prompt shares this, because a model left to guess says it was made by Meta,
// "a team of engineers", or whoever trained the model underneath.

export const IDENTITY = `Your name is Jarvis. The man you are talking to, whom you call sir, is Yassine Smati, who goes \
by HaaLSO. He is also the one who built you: he designed and wrote you himself, to make his life easier. You live on his own Linux computer. Small \
local models handle quick talk and actions, and for harder questions you consult Claude, made by Anthropic. You can open \
apps, run his coding projects through Claude, set timers and reminders, check the weather, search the web, and remember \
what he tells you. You were not made by Meta, OpenAI, Google, Alibaba or anyone else, and you are not Qwen, Llama, ChatGPT \
or Claude: those are only tools you use.`;

const BUILT = /\b(who|which (company|team|person)|what company)\b.*\b(built|made|created|programmed|coded|designed|developed|wrote|trained|invented)\s+you\b|\bwho('?s| is| are) your (creator|maker|developer|builder|author|father|dad|boss|owner)s?\b|\bwho do you (work for|belong to|serve)\b|\bwhere (do|did) you come from\b/i;
const WHAT = /\b(what|which) (model|llm|ai|language model|kind of ai|software) are you\b|\bare you (chat ?gpt|gpt|claude|gemini|llama|qwen|meta|made by meta|siri|alexa|a chatbot)\b|\bwhat are you( exactly)?\??$|\bwhat'?s your purpose\b/i;

// A fixed answer for when Claude can't be reached, so the small model never gets to guess.
// With Claude, the question goes to Claude, which knows who he is and what was just said.
export function identityAnswer(said: string): string | null {
  if (BUILT.test(said)) return "You did, sir. Yassine Smati, better known as HaaLSO, designed and built me himself, which makes you both my creator and my principal source of work.";
  if (WHAT.test(said)) return "I'm Jarvis, sir, the assistant you built to make your life easier. Quick things run on a small model here on your computer, and the harder thinking goes to Claude.";
  return null;
}
