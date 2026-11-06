// What Jarvis remembers, in one private file on this computer. Search is plain text search:
// a vector search would need a second AI model on a graphics card that's already full.
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const STOP_WORDS = new Set(["the", "and", "for", "that", "this", "with", "you", "your", "are", "was", "what", "about", "did", "have", "from", "they", "them", "does"]);
const SECRET = /\b(password|passcode|passphrase|api[ -]?key|secret key|private key|access token|credit card|card number|pin code)\b/i;

type Row = Record<string, unknown>;

export const containsSecret = (text: string) => SECRET.test(text);

export function meaningfulWords(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((word) => !STOP_WORDS.has(word));
}

// Turns free text into a safe search: quoted words joined with OR.
export function searchTerms(text: string): string | null {
  const words = meaningfulWords(text);
  return words.length ? [...new Set(words)].map((word) => `"${word}"`).join(" OR ") : null;
}

export class Memory {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600); // Personal data: only this user may read it.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (id INTEGER PRIMARY KEY, text TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS turns (id INTEGER PRIMARY KEY, role TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS facts_search USING fts5(text, content='facts', content_rowid='id');
      CREATE VIRTUAL TABLE IF NOT EXISTS turns_search USING fts5(text, content='turns', content_rowid='id');
      CREATE TRIGGER IF NOT EXISTS facts_add AFTER INSERT ON facts BEGIN
        INSERT INTO facts_search(rowid, text) VALUES (new.id, new.text); END;
      CREATE TRIGGER IF NOT EXISTS facts_del AFTER DELETE ON facts BEGIN
        INSERT INTO facts_search(facts_search, rowid, text) VALUES ('delete', old.id, old.text); END;
      CREATE TRIGGER IF NOT EXISTS turns_add AFTER INSERT ON turns BEGIN
        INSERT INTO turns_search(rowid, text) VALUES (new.id, new.text); END;
      CREATE TRIGGER IF NOT EXISTS turns_del AFTER DELETE ON turns BEGIN
        INSERT INTO turns_search(turns_search, rowid, text) VALUES ('delete', old.id, old.text); END;
    `);
  }

  remember(text: string, now = Date.now()): boolean {
    if (containsSecret(text)) return false;
    this.db.prepare("INSERT INTO facts (text, created) VALUES (?, ?)").run(text, now);
    return true;
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
    return [...new Set([...matches, ...this.facts(3)])].slice(0, limit + 3);
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
    for (const table of ["facts", "turns"]) {
      const ids = this.db.prepare(`SELECT rowid AS id FROM ${table}_search WHERE ${table}_search MATCH ?`).all(terms) as Row[];
      for (const { id } of ids) this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id as number);
      removed += ids.length;
    }
    this.db.exec("INSERT INTO turns_search(turns_search) VALUES ('rebuild'); INSERT INTO facts_search(facts_search) VALUES ('rebuild');");
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
    return removed;
  }

  addTurn(role: "user" | "jarvis", text: string, now = Date.now()) {
    if (containsSecret(text)) return;
    this.db.prepare("INSERT INTO turns (role, text, created) VALUES (?, ?, ?)").run(role, text, now);
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

// Answers memory requests directly. Returns null when the words aren't about memory.
export function memoryCommand(text: string, memory: Memory, now = new Date()): string | null {
  const lower = text.toLowerCase().replace(/[.!?]+$/, "");
  let match: RegExpMatchArray | null;

  if ((match = text.match(/^(?:please )?(?:remember|don'?t forget|note)(?: that)?[,:]?\s+(.+?)[.!]?$/i))) {
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
  if (/^what do you (know|remember)( about me)?$/.test(lower)) {
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
