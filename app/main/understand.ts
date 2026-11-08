// When his words don't match any exact rule, Claude works out what he meant and rewrites it as a
// command Jarvis already understands, which then goes the normal way: the same rules, the same
// questions before anything risky. Claude only rewrites words; it never runs anything itself.

export const UNDERSTAND = `You are the part of Jarvis, a voice assistant on his Linux computer, that works out what he \
wants when his words are casual, misheard, or not in English. Rewrite his request as ONE of the command forms below, \
filling in the parts in angle brackets, and reply with only that line. If he isn't asking Jarvis to do something \
(a question, a remark, chat), reply with only: NONE

Command forms:
start coding <exact project name from the list>
close the project
start a new project called <name>
list my projects
open <program>
close <program>
minimize <program> | maximize <program> | focus <program>
go to <website address>
google <search words>
play <search words> on youtube
search for <question that needs the web>
what's the weather in <place> | what's the weather tomorrow
set the volume to <0-100> | volume up | volume down | mute | unmute
pause the music | play the music | next song | previous song | what's playing
set a timer for <length>
remind me in <length> to <thing> | remind me at <time> to <thing>
wake me up at <time>
what timers do I have | cancel my timers
take a screenshot | lock the screen
brightness to <0-100> | make the screen brighter | make the screen dimmer
turn wifi on | turn wifi off | turn bluetooth on | turn bluetooth off
switch to dark mode | switch to light mode
open my <downloads|documents|desktop|pictures|music|videos|home> folder
what's in my <folder> | how big is my <folder> folder
find my file <name>
how's my battery | how much disk space is left | am I connected to the internet | what's my ip
remember that <fact> | forget <thing>
what's Claude doing | what did Claude change | how much Claude do I have left
tell Claude to <coding task for the open project>
run <shell command> in the terminal | did the tests pass
fix my <computer problem> | install <program>
new chat

Use the conversation only to resolve words like "it" or "that". Never invent a project: use a name from the list, or NONE.`;

// The line Claude wrote, if it's a usable command. Null for NONE or anything odd.
export function parseUnderstanding(reply: string | null): string | null {
  const line = reply?.trim().split("\n").find((part) => part.trim())?.trim().replace(/^["'`]+|["'`.]+$/g, "").trim() ?? "";
  if (!line || /^NONE\b/i.test(line) || line.length > 200 || line.includes("<")) return null;
  return line;
}

// What Claude needs besides the words: his projects, what's open, and the last few lines said.
export function understandPrompt(said: string, projects: string[], open: string | null, talk: string[]): string {
  return [
    `His projects: ${projects.length ? projects.join(", ") : "none"}.`,
    open ? `Open project: ${open}.` : "No project is open.",
    talk.length ? `The conversation just before, for context only:\n${talk.join("\n")}` : "",
    `He says: ${said}`,
  ].filter(Boolean).join("\n\n");
}
