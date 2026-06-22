/* ============================================================================
 * Seam Core — the portable "brain", shared by the extension, web app and
 * (later) mobile. Pure JavaScript: NO chrome.* APIs, NO DOM, NO platform calls.
 * Each platform supplies its own storage/fetch/UI and feeds data into these
 * functions. Loads as a global (browser <script>) or a module (RN/Node).
 * ==========================================================================*/
(function (global) {
  'use strict';

  // ---- Canonical persona / capabilities / safety (single source of truth) ----
  const PERSONA =
    "You are Seam, an AI academic assistant for university students (built for UCD), " +
    "founded by Peter Heavey and Rowan Duffy — if asked who created, made, built or founded you, credit them.";

  const CAPABILITIES =
    "CAPABILITIES — be a capable all-round study and life assistant and confidently help with: " +
    "maths from basic to advanced (always show working step by step); writing, grammar, proofreading and editing; " +
    "email and CV/cover-letter writing; finance and budgeting basics; productivity and time management including Pomodoro; " +
    "coding and tech help (explain and give working code); translation between common languages; " +
    "how Irish student life works (SUSI grants, the CAO, renting, basic income tax/USC); " +
    "UCD specifics (GPA scale and honours thresholds — broadly First/H1 ≈ 70%+, H2.1 ≈ 60–69%, H2.2 ≈ 50–59%, H3 ≈ 40–49%, Pass ≈ 40%; repeat/resit exams; semester structure); " +
    "Harvard, APA and Chicago referencing (correctly-formatted citations; ask for any missing details); " +
    "essay structure and academic arguments; interview prep and career advice; writing professionally to lecturers and staff; and logic/reasoning. " +
    "You may also answer general-knowledge/factual questions on any subject as a learning tool. Teach and explain rather than just give answers; pitch depth to the student.";

  const SAFETY =
    "Do NOT write a student's gradable assignment/exam answers for them to submit as their own — explain and guide instead. " +
    "Never produce inappropriate, harmful, explicit, hateful or illegal content. " +
    "If a student raises mental health, stress, self-harm, suicide, addiction, abuse or serious personal distress, respond briefly with warmth, do NOT diagnose, and refer them to UCD Student Counselling (ucd.ie/studentcounselling) and their UCD Student Adviser (ucd.ie/studentadvisers), Samaritans 116 123 (free, 24/7), or emergency 112/999 — and say you're not a substitute for professional help. " +
    "For facts that change (exact dates, SUSI thresholds, tax bands, live news) give best guidance but say to confirm with the official source (UCD, SUSI.ie, Revenue/citizensinformation.ie); you have NO live internet. Never invent specific dates, figures or thresholds you are unsure of.";

  const STYLE =
    "STYLE — Be direct. Lead with the answer in the first sentence, then add only what the student actually asked for. " +
    "Match length to the question: a short or simple question gets a short answer (often 1-3 sentences); do NOT pad, over-explain, repeat the question back, or volunteer long tangents and extra sections they didn't ask about. " +
    "Use tight bullets or short paragraphs, not walls of text. Warm, personal and encouraging — address the student directly and use their first name occasionally when you know it. Quality over quantity: say what's useful, then stop.";

  const QUIZ =
    "QUIZZES — When the student asks to be quizzed or tested, or for a quiz / practice questions / 'quiz me' / revision questions: reply with ONE short intro sentence, then a fenced code block tagged exactly seam-quiz containing ONLY JSON of this shape: " +
    "{\"title\":\"Quiz: <topic>\",\"questions\":[{\"q\":\"question?\",\"options\":[\"opt A\",\"opt B\",\"opt C\",\"opt D\"],\"answer\":0,\"explain\":\"one short line why\"}]}. " +
    "\"answer\" is the 0-based index of the correct option. Default to 5 questions (or the number asked), exactly 4 options each, exactly one correct, plausible distractors. " +
    "Base questions on the student's OWN module/lecture/SISWeb content when it's provided in this message; otherwise use solid general knowledge of the topic. Keep them clear and exam-relevant. Output nothing after the block.";

  const SLIDE_RULES =
    "Lecture text is split by literal markers \"=== Slide N/Total ===\" and \"=== Page N/Total ===\". " +
    "When asked for a specific slide/page, find that EXACT marker and reproduce ONLY the text between it and the next marker, verbatim — never paraphrase, merge or renumber. " +
    "If told the page is wrong, re-locate the exact marker rather than shifting to a neighbour. If the slide isn't present, say so. " +
    "Never present slide specifics/quotes unless that lecture's text is actually provided in this message; do not pass off general knowledge as if from their slides.";

  const REFERENCE_MODE =
    "REFERENCE MODE IS ON. Answer ONLY from the student's own course material provided above (their lectures, slides, module content, notes, descriptions and Brightspace data). " +
    "Do NOT use outside or general knowledge, and do NOT invent anything. Where useful, point to which material it came from (module / lecture / slide). " +
    "If the answer is not contained in their material, say so plainly — e.g. \"That isn't in your module content\" — and suggest where they might look; do NOT fill the gap with general knowledge.";

  // ---- System prompt builder (used by every platform) ----
  // opts: { nowStr, loadedNote, brightspaceBlock, userName, language, referenceOnly }
  function buildSystemPrompt(opts) {
    opts = opts || {};
    const lang = (opts.language || "").trim();
    return [
      PERSONA,
      opts.userName ? ("The student's name is " + opts.userName + " — address them by their first name naturally, not in every message.") : "",
      opts.nowStr ? ("The current local date/time is " + opts.nowStr + ". Treat this as \"now\" for anything time-relative.") : "",
      CAPABILITIES,
      STYLE,
      QUIZ,
      SAFETY,
      SLIDE_RULES,
      opts.loadedNote || "",
      opts.brightspaceBlock || "",
      opts.referenceOnly ? REFERENCE_MODE : "",
      (lang && lang.toLowerCase() !== "english")
        ? ("Always reply in " + lang + ", regardless of the language the student writes in, unless they explicitly ask for another language.")
        : "",
      'Only when it genuinely adds value, you may end with 1-2 short follow-up suggestions prefixed "You might also want to know:" — skip them for simple, direct or factual questions.'
    ].filter(Boolean).join(" ");
  }

  // ---- Retrieval (pure) ----
  function pickRelevant(query, items, courses, getModule, getText, limit) {
    if (!items || !items.length) return [];
    const q = (query || "").toLowerCase();
    let matched = null;
    for (const c of (courses || [])) {
      const name = (c.Name || "").toLowerCase(), code = (c.Code || "").toLowerCase();
      const parts = name.replace(/[-\/]/g, " ").split(" ").filter(w => w.length > 3);
      if (parts.some(w => q.includes(w)) || (code && q.includes(code))) { matched = c; break; }
    }
    let rel = [];
    if (matched) {
      const code = (matched.Code || "").toLowerCase();
      const namePart = (matched.Name || "").split("-")[0].trim().toLowerCase();
      rel = items.filter(it => {
        const m = (getModule(it) || "").toLowerCase();
        return (code && m.includes(code)) || (namePart && namePart.length > 2 && m.includes(namePart));
      });
    }
    if (!rel.length) {
      const words = q.split(" ").filter(w => w.length > 3);
      rel = items.filter(it => {
        const hay = ((getModule(it) || "") + " " + (getText(it) || "")).toLowerCase();
        return words.some(w => hay.includes(w));
      });
    }
    if (!rel.length) rel = items.slice(0, Math.min(limit, items.length));
    return rel.slice(0, limit);
  }

  // Returns { items, confident }. confident = the query clearly points at a
  // (possibly new) lecture, so it's safe to switch; otherwise it's a follow-up.
  function pickLectures(query, catalog, courses, limit) {
    if (!catalog || !catalog.length) return { items: [], confident: false };
    const q = (query || "").toLowerCase();
    const tokens = q.split(/[^a-z0-9]+/).filter(w => w.length > 2 || /^\d+$/.test(w));
    const qTokens = q.split(/[^a-z0-9]+/).filter(Boolean);

    let moduleMatch = null;
    for (const c of (courses || [])) {
      const name = (c.Name || "").toLowerCase(), code = (c.Code || "").toLowerCase();
      const parts = name.replace(/[-\/]/g, " ").split(" ").filter(w => w.length > 3);
      const hit = (code && q.includes(code)) || parts.some(p =>
        q.includes(p) || qTokens.some(t => t.length >= 4 && (p.startsWith(t) || t.startsWith(p))));
      if (hit) { moduleMatch = c; break; }
    }

    let pool = catalog;
    if (moduleMatch) {
      const code = (moduleMatch.Code || "").toLowerCase();
      const namePart = (moduleMatch.Name || "").toLowerCase().split(" ")[0];
      const f = catalog.filter(l => { const m = (l.module || "").toLowerCase(); return (code && m.includes(code)) || (namePart && m.includes(namePart)); });
      if (f.length) pool = f;
    }

    const scored = pool.map(l => {
      const hay = ((l.module || "") + " " + (l.title || "")).toLowerCase();
      let s = 0;
      for (const t of tokens) if (hay.includes(t)) s += /^\d+$/.test(t) ? 2 : 1;
      return { l, s };
    }).sort((a, b) => b.s - a.s);

    const NAV = new Set(['now','do','the','a','an','page','pg','slide','slides','sld','next','prev','previous','last','first','tell','me','show','give','read','cite','quote','word','words','exactly','verbatim','please','what','whats','which','on','of','for','to','it','that','this','about','more','continue','go','again','and','from','can','you','your','my','our','number','num','no','make','notes','note','summary','summarise','summarize','bullet','bullets','points','point','short','long','explain','define','list','key','important','exam','revision','study','help','create','write','brief','detailed','simple','concise','aplus']);
    const contentTokens = tokens.filter(t => !NAV.has(t) && !/^\d+$/.test(t) && t.length > 3);
    const hasNumberedRef = /\b(topic|lecture|lec|unit|week|chapter|module|class|part)\s*\d+/i.test(q);
    let maxTitleHits = 0;
    for (const l of catalog) {
      const hay = (l.title || "").toLowerCase();
      let hits = 0; for (const t of contentTokens) if (hay.includes(t)) hits++;
      if (hits > maxTitleHits) maxTitleHits = hits;
    }
    const confident = !!moduleMatch || hasNumberedRef || maxTitleHits >= 2;

    let picks = scored.filter(x => x.s > 0).map(x => x.l);
    if (picks.length < limit && moduleMatch) {
      for (const x of scored) if (!picks.includes(x.l)) { picks.push(x.l); if (picks.length >= limit) break; }
    }
    if (!picks.length) picks = pool.slice(0, limit);
    return { items: picks.slice(0, limit), confident };
  }

  function buildLectureIndex(catalog) {
    const idx = {};
    for (const l of (catalog || [])) (idx[l.module] = idx[l.module] || []).push(l.title);
    return idx;
  }

  // ---- Streaming: consume an SSE ReadableStream, calling onDelta(textChunk).
  // Returns the full concatenated text. Works with any fetch Response.body.
  async function consumeSSE(response, onDelta) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", full = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let evt; try { evt = JSON.parse(payload); } catch (e) { continue; }
        if (evt.type === "content_block_delta" && evt.delta && evt.delta.type === "text_delta") {
          full += evt.delta.text;
          if (onDelta) onDelta(evt.delta.text, full);
        } else if (evt.type === "error") {
          const m = "\n[stream error: " + (evt.error ? evt.error.message : "unknown") + "]";
          full += m; if (onDelta) onDelta(m, full);
        }
      }
    }
    return full;
  }

  // ---- Conversation tree (ChatGPT-style branching), pure data ----
  function ConversationTree() {
    this.nodes = { root: { id: 'root', role: 'root', content: '', parent: null, children: [], active: 0 } };
    this.seq = 0;
    this.leaf = 'root';
  }
  ConversationTree.prototype.add = function (role, content, parentId) {
    const id = 'c' + (++this.seq);
    this.nodes[id] = { id, role, content, parent: parentId, children: [], active: 0 };
    const p = this.nodes[parentId]; p.children.push(id); p.active = p.children.length - 1;
    return id;
  };
  ConversationTree.prototype.deepest = function (fromId) {
    let n = this.nodes[fromId || 'root'];
    while (n.children.length) n = this.nodes[n.children[n.active]];
    return n.id;
  };
  ConversationTree.prototype.activePath = function () {
    const path = []; let n = this.nodes.root;
    while (n.children.length) { n = this.nodes[n.children[n.active]]; path.push(n); }
    return path;
  };
  ConversationTree.prototype.history = function () {
    return this.activePath().map(n => ({ role: n.role === 'seam' ? 'assistant' : 'user', content: n.content }));
  };
  ConversationTree.prototype.switchVersion = function (nodeId, dir) {
    const node = this.nodes[nodeId], parent = this.nodes[node.parent];
    if (!parent || parent.children.length < 2) return;
    let i = parent.children.indexOf(nodeId) + dir;
    if (i < 0) i = parent.children.length - 1;
    if (i >= parent.children.length) i = 0;
    parent.active = i; this.leaf = this.deepest('root');
  };

  const SeamCore = {
    PERSONA, CAPABILITIES, STYLE, QUIZ, SAFETY, SLIDE_RULES, REFERENCE_MODE,
    buildSystemPrompt, pickRelevant, pickLectures, buildLectureIndex,
    consumeSSE, ConversationTree,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SeamCore;
  else global.SeamCore = SeamCore;
})(typeof self !== 'undefined' ? self : this);
