// What Jarvis remembers, in one private file on this computer. Search is plain text search:
// a vector search would need a second AI model on a graphics card that's already full.
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const STOP_WORDS = new Set(["the", "and", "for", "that", "this", "with", "you", "your", "are", "was", "what", "about", "did", "have", "from", "they", "them", "does"]);
const SECRET = /\b(password|passcode|passphrase|api[ -]?key|secret key|private key|access token|credit card|card number|pin code)\b/i;

type Row = Record<string, unknown>;
export type Chat = { id: number; title: string; updated: number; turns: number };
export type Turn = { role: "user" | "jarvis"; text: string };
export type Fact = { id: number; text: string };
export type Reminder = { kind: string; text: string; due: number };

export const containsSecret = (text: string) => SECRET.test(text);

export function meaningfulWords(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((word) => !STOP_WORDS.has(word));
}

// Turns free text into a safe search: quoted words joined with OR.
export function searchTerms(text: string): string | null {
  const words = meaningfulWords(text);
  return words.length ? [...new Set(words)].map((word) => `"${word}"`).join(" OR ") : null;
}

function titleFrom(text: string): string {
  const title = text.replace(/\s+/g, " ").trim();
  return title.length > 48 ? `${title.slice(0, 48).trimEnd()}...` : title;
}

export class Memory {
  private db: DatabaseSync;
  // The conversation being added to. One is only created when something is actually said.
  private current: number | null = null;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600); // Personal data: only this user may read it.
    // Older files searched exact words only. Stemming lets "dentists" find "dentist".
    const search = this.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'facts_search'").get() as Row | undefined;
    const reindex = Boolean(search) && !String(search?.sql).includes("porter");
    if (reindex) this.db.exec("DROP TABLE facts_search; DROP TABLE turns_search;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (id INTEGER PRIMARY KEY, text TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS turns (id INTEGER PRIMARY KEY, role TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS facts_search USING fts5(text, content='facts', content_rowid='id', tokenize='porter unicode61');
      CREATE VIRTUAL TABLE IF NOT EXISTS turns_search USING fts5(text, content='turns', content_rowid='id', tokenize='porter unicode61');
      CREATE TRIGGER IF NOT EXISTS facts_add AFTER INSERT ON facts BEGIN
        INSERT INTO facts_search(rowid, text) VALUES (new.id, new.text); END;
      CREATE TRIGGER IF NOT EXISTS facts_del AFTER DELETE ON facts BEGIN
        INSERT INTO facts_search(facts_search, rowid, text) VALUES ('delete', old.id, old.text); END;
      CREATE TRIGGER IF NOT EXISTS turns_add AFTER INSERT ON turns BEGIN
        INSERT INTO turns_search(rowid, text) VALUES (new.id, new.text); END;
      CREATE TRIGGER IF NOT EXISTS turns_del AFTER DELETE ON turns BEGIN
        INSERT INTO turns_search(turns_search, rowid, text) VALUES ('delete', old.id, old.text); END;
      CREATE TABLE IF NOT EXISTS chats (id INTEGER PRIMARY KEY, title TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, due INTEGER NOT NULL);
    `);
    if (reindex) this.rebuildSearch();
    const columns = this.db.prepare("PRAGMA table_info(turns)").all() as Row[];
    if (!columns.some((column) => column.name === "chat")) this.db.exec("ALTER TABLE turns ADD COLUMN chat INTEGER");
    // Everything said before conversations existed stays together as one.
    const loose = this.db.prepare("SELECT COUNT(*) AS count, MAX(created) AS last FROM turns WHERE chat IS NULL").get() as Row;
    if (Number(loose.count) > 0) {
      const { lastInsertRowid } = this.db.prepare("INSERT INTO chats (title, updated) VALUES ('Earlier conversations', ?)").run(Number(loose.last));
      this.db.prepare("UPDATE turns SET chat = ? WHERE chat IS NULL").run(lastInsertRowid);
    }
  }

  private rebuildSearch() {
    this.db.exec("INSERT INTO turns_search(turns_search) VALUES ('rebuild'); INSERT INTO facts_search(facts_search) VALUES ('rebuild');");
  }

  // Removes deleted text from the file itself, not only from view.
  private compact() {
    this.rebuildSearch();
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
  }

  remember(text: string, now = Date.now()): boolean {
    if (containsSecret(text)) return false;
    const known = this.db.prepare("SELECT 1 FROM facts WHERE LOWER(text) = LOWER(?)").get(text);
    if (!known) this.db.prepare("INSERT INTO facts (text, created) VALUES (?, ?)").run(text, now);
    return true;
  }

  addReminder(kind: string, text: string, due: number) {
    this.db.prepare("INSERT INTO reminders (kind, text, due) VALUES (?, ?, ?)").run(kind, text, due);
  }

  reminders(): Reminder[] {
    const rows = this.db.prepare("SELECT kind, text, due FROM reminders ORDER BY due").all() as Row[];
    return rows.map((row) => ({ kind: String(row.kind), text: String(row.text), due: Number(row.due) }));
  }

  clearReminders(): number {
    return Number(this.db.prepare("DELETE FROM reminders").run().changes);
  }

  // Hands over what's due and removes it, so each one only ever goes off once.
  takeDueReminders(now = Date.now()): Reminder[] {
    const rows = this.db.prepare("SELECT kind, text, due FROM reminders WHERE due <= ? ORDER BY due").all(now) as Row[];
    this.db.prepare("DELETE FROM reminders WHERE due <= ?").run(now);
    return rows.map((row) => ({ kind: String(row.kind), text: String(row.text), due: Number(row.due) }));
  }

  allFacts(): Fact[] {
    const rows = this.db.prepare("SELECT id, text FROM facts ORDER BY id DESC").all() as Row[];
    return rows.map((row) => ({ id: Number(row.id), text: String(row.text) }));
  }

  // Returns the removed text, so the caller can clean it from the log as well.
  forgetFact(id: number): string | null {
    const row = this.db.prepare("SELECT text FROM facts WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    this.db.prepare("DELETE FROM facts WHERE id = ?").run(id);
    this.forget(String(row.text));
    this.compact();
    return String(row.text);
  }

  facts(limit = 10): string[] {
    const rows = this.db.prepare("SELECT text FROM facts ORDER BY id DESC LIMIT ?").all(limit) as Row[];
    return rows.map((row) => String(row.text));
  }

  // The facts worth telling the model about for this request.
  relevant(query: string, limit = 5): string[] {
    const terms = searchTerms(query);
    const matches = terms
      ? (this.db.prepare("SELECT f.text FROM facts_search s JOIN facts f ON f.id = s.rowid WHERE facts_search MATCH ? ORDER BY rank LIMIT ?").all(terms, limit) as Row[]).map((row) => String(row.text))
      : [];
    return [...new Set([...matches, ...this.facts(6)])].slice(0, limit + 6);
  }

  search(query: string, limit = 5): string[] {
    const terms = searchTerms(query);
    if (!terms) return [];
    const rows = this.db.prepare("SELECT f.text FROM facts_search s JOIN facts f ON f.id = s.rowid WHERE facts_search MATCH ? ORDER BY rank LIMIT ?").all(terms, limit) as Row[];
    return rows.map((row) => String(row.text));
  }

  forgetLast(): string | null {
    const row = this.db.prepare("SELECT id, text FROM facts ORDER BY id DESC LIMIT 1").get() as Row | undefined;
    if (!row) return null;
    this.db.prepare("DELETE FROM facts WHERE id = ?").run(row.id as number);
    // Also removes the "remember that..." line it came from.
    this.forget(String(row.text));
    return String(row.text);
  }

  // Forgetting is real: it removes matching facts and conversation lines from the file.
  // Every word has to match here, so "forget my dentist" doesn't wipe everything saying "my".
  forget(query: string): number {
    const words = meaningfulWords(query);
    if (!words.length) return 0;
    const terms = words.map((word) => `"${word}"`).join(" AND ");
    let removed = 0;
    // A conversation's title is copied from its first line, so that has to go as well.
    const lines = this.db.prepare("SELECT t.chat, t.text FROM turns_search s JOIN turns t ON t.id = s.rowid WHERE turns_search MATCH ?").all(terms) as Row[];
    for (const table of ["facts", "turns"]) {
      const ids = this.db.prepare(`SELECT rowid AS id FROM ${table}_search WHERE ${table}_search MATCH ?`).all(terms) as Row[];
      for (const { id } of ids) this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id as number);
      removed += ids.length;
    }
    for (const line of lines) {
      const next = this.db.prepare("SELECT text FROM turns WHERE chat = ? AND role = 'user' ORDER BY id LIMIT 1").get(line.chat as number) as Row | undefined;
      this.db.prepare("UPDATE chats SET title = ? WHERE id = ? AND title = ?").run(next ? titleFrom(String(next.text)) : "Conversation", line.chat as number, titleFrom(String(line.text)));
    }
    this.db.exec("DELETE FROM chats WHERE id NOT IN (SELECT chat FROM turns WHERE chat IS NOT NULL)");
    if (this.current !== null && !this.db.prepare("SELECT 1 FROM chats WHERE id = ?").get(this.current)) this.current = null;
    this.compact();
    return removed;
  }

  addTurn(role: "user" | "jarvis", text: string, now = Date.now()) {
    if (containsSecret(text)) return;
    if (this.current === null) {
      if (role !== "user") return; // Nothing has been said in this conversation yet.
      this.current = Number(this.db.prepare("INSERT INTO chats (title, updated) VALUES (?, ?)").run(titleFrom(text), now).lastInsertRowid);
    }
    this.db.prepare("INSERT INTO turns (role, text, created, chat) VALUES (?, ?, ?, ?)").run(role, text, now, this.current);
    this.db.prepare("UPDATE chats SET updated = ? WHERE id = ?").run(now, this.current);
  }

  get currentChat() {
    return this.current;
  }

  startChat() {
    this.current = null;
  }

  chats(limit = 100): Chat[] {
    const rows = this.db.prepare(`
      SELECT c.id, c.title, c.updated, COUNT(t.id) AS turns FROM chats c JOIN turns t ON t.chat = c.id
      GROUP BY c.id ORDER BY c.updated DESC, c.id DESC LIMIT ?`).all(limit) as Row[];
    return rows.map((row) => ({ id: Number(row.id), title: String(row.title), updated: Number(row.updated), turns: Number(row.turns) }));
  }

  chatTurns(id: number): Turn[] {
    const rows = this.db.prepare("SELECT role, text FROM turns WHERE chat = ? ORDER BY id").all(id) as Row[];
    return rows.map((row) => ({ role: row.role === "user" ? "user" : "jarvis", text: String(row.text) }));
  }

  // Carries on from the given conversation. Returns false if it doesn't exist.
  openChat(id: number): boolean {
    if (!this.db.prepare("SELECT 1 FROM chats WHERE id = ?").get(id)) return false;
    this.current = id;
    return true;
  }

  // Picks up the latest conversation only if it was recent. Older ones are a click away.
  continueRecent(maxAgeMs: number, now = Date.now()): boolean {
    const latest = this.chats(1)[0];
    if (!latest || now - latest.updated > maxAgeMs) return false;
    this.current = latest.id;
    return true;
  }

  // Deleting is real. Returns what the user said in it, so the log can drop those lines too.
  deleteChat(id: number): string[] {
    const said = this.chatTurns(id).filter((turn) => turn.role === "user").map((turn) => turn.text);
    this.db.prepare("DELETE FROM turns WHERE chat = ?").run(id);
    this.db.prepare("DELETE FROM chats WHERE id = ?").run(id);
    if (this.current === id) this.current = null;
    this.compact();
    return said;
  }

  // Lines from other conversations that mention this, for "what did I say about...".
  recall(query: string, limit = 4): string[] {
    const terms = searchTerms(query);
    if (!terms) return [];
    const rows = this.db.prepare(`
      SELECT t.text FROM turns_search s JOIN turns t ON t.id = s.rowid
      WHERE turns_search MATCH ? AND t.role = 'user' AND t.chat IS NOT ? ORDER BY rank LIMIT ?`).all(terms, this.current, limit) as Row[];
    return rows.map((row) => String(row.text));
  }

  // What the user said on a given day, newest first.
  said(from: number, to: number, limit = 5): string[] {
    const rows = this.db.prepare("SELECT text FROM turns WHERE role = 'user' AND created >= ? AND created < ? ORDER BY id DESC LIMIT ?").all(from, to, limit) as Row[];
    return rows.map((row) => String(row.text));
  }

  close() {
    this.db.close();
  }
}

const LASTING = /^(my name is|call me|i live|i'?m from|i am from|i come from|i work|i study|i was born|i'?m allergic|i am allergic|i'?m (a|an) |i am (a|an) |i'?m (vegetarian|vegan|diabetic|married|single)|i am (vegetarian|vegan|diabetic|married|single)|i (really |absolutely |just )?(love|like|hate|enjoy|prefer|dislike|can'?t stand|don'?t like)\b|i (usually|always|never|often)\b|i speak\b|i drive\b|i have (a|an|two|three|four) (son|daughter|brother|sister|child|children|kids?|dog|cat|wife|husband)|my (favou?rite|birthday|wife|husband|partner|girlfriend|boyfriend|son|daughter|kids?|brother|sister|mother|mom|mum|father|dad|friend|best friend|boss|dog|cat|car|laptop|job|company|team)\b)/i;
const ONLY_FOR_NOW = /\b(right now|at the moment|today|tonight|tomorrow|yesterday|this (morning|afternoon|evening|week|time)|just now|again|currently|soon|later|anymore)\b|^i'?m (a|an) (bit|little|lot)\b|\b(this|that|it|them|him|her)\s*$/i;

// Things worth keeping from what he says about himself, kept in his own words. Plain rules do
// this: the small model either missed them or copied its examples, and nothing here can be made
// up. What's kept can be seen and deleted in Preferences.
export function lastingFacts(said: string): string[] {
  return said.split(/(?<=[.!?])\s+|\n+/).map((part) => part.trim().replace(/[.!]+$/, "")).filter((part) => {
    return part.length <= 140 && !part.endsWith("?") && LASTING.test(part) && !ONLY_FOR_NOW.test(part) && !containsSecret(part);
  });
}

// Answers memory requests directly. Returns null when the words aren't about memory.
export function memoryCommand(text: string, memory: Memory, now = new Date()): string | null {
  const lower = text.toLowerCase().replace(/[.!?]+$/, "");
  let match: RegExpMatchArray | null;

  if ((match = text.match(/^(?:please )?(?:remember|don'?t forget|note|take a note|make a note|write down|jot down)(?: that| of)?[,:]?\s+(.+?)[.!]?$/i))) {
    if (!memory.remember(match[1])) return "I won't store passwords or keys, sir. They're safer in a password manager.";
    return "I'll remember that, sir.";
  }
  if (/^forget (that|it|the last thing)$/.test(lower)) {
    const fact = memory.forgetLast();
    return fact ? `Forgotten, sir. I removed: ${fact}.` : "There's nothing to forget, sir.";
  }
  if ((match = lower.match(/^forget (?:about |that )?(.+)$/))) {
    const removed = memory.forget(match[1]);
    return removed ? `Forgotten, sir. I removed ${removed} ${removed === 1 ? "item" : "items"}.` : `I don't have anything about ${match[1]}, sir.`;
  }
  if (/^(what do you (know|remember)( about me)?|what are my notes|(show|read)( me)? my notes)$/.test(lower)) {
    const facts = memory.facts(5);
    return facts.length ? `I remember this, sir: ${facts.join(". ")}.` : "You haven't asked me to remember anything yet, sir.";
  }
  if ((match = lower.match(/^what do you (?:know|remember) about (.+)$/))) {
    const facts = memory.search(match[1]);
    return facts.length ? `I remember this, sir: ${facts.join(". ")}.` : `I don't have anything about ${match[1]}, sir.`;
  }
  if ((match = lower.match(/^what did i (?:ask|say|tell)(?: you)?(?: to)?\s*(yesterday|today|earlier)?$/))) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterday = match[1] === "yesterday";
    const from = yesterday ? day - 86_400_000 : day;
    const said = memory.said(from, yesterday ? day : now.getTime(), 3);
    const when = yesterday ? "yesterday" : "today";
    return said.length ? `${when === "today" ? "Today" : "Yesterday"} you said: ${said.join(". ")}.` : `I don't have anything from ${when}, sir.`;
  }
  return null;
}
