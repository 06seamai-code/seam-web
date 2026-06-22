/* Seam web app — auth + sidebar + projects + persistent streaming chat. */

const { SUPABASE_URL, SUPABASE_KEY, CHAT_FUNCTION } = window.SEAM_CONFIG;
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const CHAT_URL = SUPABASE_URL + CHAT_FUNCTION;

let session = null;
let activeChatId = null;
let currentAbort = null;
let isGenerating = false;
let signupMode = false;
let bsData = null;            // synced Brightspace data (from the extension)
let bsLectureText = {};       // { lectureUrl: extractedText }
let bsLectureIndex = [];      // [{ url, module, title }] — ground truth of what's actually in the cloud
let greetState = null;        // cached greeting+quote for the home view (avoids flicker on re-render)

const $ = (id) => document.getElementById(id);

/* ---------------- Auth ---------------- */
async function initAuth() {
  const { data } = await sb.auth.getSession();
  session = data.session;
  applyAuth();
  sb.auth.onAuthStateChange((_e, s) => { session = s; applyAuth(); });
}
function applyAuth() {
  if (session) {
    $('login').style.display = 'none';
    $('app').style.display = 'block';
    $('user-email').textContent = session.user.email || session.user.user_metadata?.name || 'Signed in';
    if (!activeChatId) renderMessages([]);   // show the home/greeting state immediately on load
    loadSidebar();
    loadBrightspace();
  } else {
    $('login').style.display = 'flex';
    $('app').style.display = 'none';
  }
}
$('toggle-mode').onclick = () => {
  signupMode = !signupMode;
  $('btn-auth').textContent = signupMode ? 'Create account' : 'Sign in';
  $('toggle-mode').textContent = signupMode ? 'Have an account? Sign in' : 'New here? Create an account';
};
// Reveal the email/password fallback (UCD Connect is the primary path).
$('show-email').onclick = () => { $('email-block').style.display = 'block'; $('show-email').style.display = 'none'; };
// If ucd-logo.png isn't present, fall back to the "UCD" text box.
(function () {
  const img = $('ucd-logo');
  if (img) img.onerror = () => { img.style.display = 'none'; const fb = $('ucd-fallback'); if (fb) fb.style.display = 'flex'; };
})();
// Only let people CREATE accounts with a university email. (Sign-in is left open
// so existing accounts still work; new sign-ups must be UCD.)
const UCD_DOMAINS = ['ucdconnect.ie', 'ucd.ie'];
$('btn-auth').onclick = async () => {
  const email = $('email').value.trim();
  const password = $('password').value;
  $('login-err').textContent = '';
  if (!email || !password) { $('login-err').textContent = 'Enter your UCD email and password.'; return; }
  if (signupMode) {
    const domain = (email.split('@')[1] || '').toLowerCase();
    if (!UCD_DOMAINS.includes(domain)) { $('login-err').textContent = 'Please use your UCD email (@ucdconnect.ie) to create an account.'; return; }
  }
  const fn = signupMode ? sb.auth.signUp({ email, password }) : sb.auth.signInWithPassword({ email, password });
  const { error } = await fn;
  if (error) $('login-err').textContent = error.message;
  else if (signupMode) $('login-err').textContent = 'Check your UCD email to confirm your account, then sign in.';
};
// Microsoft = UCD Connect (UCD identity runs on Microsoft 365). Students use their @ucdconnect.ie login here.
// Until the Azure provider is configured in Supabase, this fails gracefully and points to the email option.
$('btn-ms').onclick = async () => {
  $('login-err').textContent = '';
  const { error } = await sb.auth.signInWithOAuth({ provider: 'azure', options: { scopes: 'openid email profile', redirectTo: location.origin + location.pathname } });
  if (error) {
    $('login-err').textContent = 'UCD Connect sign-in isn’t switched on yet — use “Other sign-in options” below for now.';
    $('email-block').style.display = 'block';
    const se = $('show-email'); if (se) se.style.display = 'none';
  }
};
// Sign-out lives in the Settings modal (#settings-signout), wired further down.

/* ---------------- Brightspace data (synced from the extension) ---------------- */
async function loadBrightspace() {
  if (!session) return;
  const { data } = await sb.from('brightspace_data').select('data,lecture_text').eq('user_id', session.user.id).maybeSingle();
  if (data) { bsData = data.data || null; bsLectureText = data.lecture_text || {}; }
  else { bsData = null; bsLectureText = {}; }
  // Pull a lightweight index of what's ACTUALLY synced (no text bodies) — this is
  // ground truth, independent of the catalog's URLs. Used for relevance matching
  // and the real "synced" count, so a catalog/URL mismatch can't hide lectures.
  try {
    const { data: idx, error } = await sb.from('lecture_text').select('url,module,title').eq('user_id', session.user.id);
    bsLectureIndex = idx || [];
    const catN = (bsData && bsData.lectureCatalog || []).length;
    console.log('[Seam web] lecture_text rows in cloud: ' + bsLectureIndex.length + ' (catalog lists ' + catN + ')' + (error ? ' — query error: ' + error.message : ''));
    if (bsLectureIndex.length) console.log('[Seam web] sample synced:', bsLectureIndex.slice(0, 5).map(r => r.title));
    const sw = (bsData && bsData.sisweb) ? Object.keys(bsData.sisweb) : [];
    console.log('[Seam web] SISWeb pages from cloud: ' + sw.length, sw);
  } catch (e) { bsLectureIndex = []; console.log('[Seam web] lecture_text index query failed:', e && e.message); }
  updateBsStatus();
  if (!activeChatId) renderMessages([]);   // re-render home now that bsData is in (adds the "Coming up" card)
  // New student not connected yet → keep checking so their data appears the moment
  // their extension finishes syncing (then stop).
  if (!isConnected()) { if (!connectPoll) connectPoll = setInterval(loadBrightspace, 10000); }
  else if (connectPoll) { clearInterval(connectPoll); connectPoll = null; }
}
let connectPoll = null;
let bsPoll = null;
function startBsPoll() { if (!bsPoll) bsPoll = setInterval(updateBsStatus, 8000); }
function stopBsPoll() { if (bsPoll) { clearInterval(bsPoll); bsPoll = null; } }

function setBsStatus(cls, text) {
  const el = $('bs-status');
  if (!el) return;
  el.className = 'bs-status' + (cls ? ' ' + cls : '');
  el.innerHTML = '<span class="dot"></span><span>' + escapeHtml(text) + '</span>';
}
async function updateBsStatus() {
  if (!$('bs-status')) return;
  const courses = (bsData && bsData.courses) ? bsData.courses.length : 0;
  if (!bsData || !courses) {
    setBsStatus('', 'Brightspace not connected — open the Seam extension and sign in with this account');
    stopBsPoll();
    return;
  }
  const total = (bsData.lectureCatalog || []).length;
  let uploaded = bsLectureIndex.length;
  try {
    const r = await sb.from('lecture_text').select('*', { count: 'exact', head: true }).eq('user_id', session.user.id);
    if (typeof r.count === 'number') uploaded = r.count;
  } catch (e) {}
  if (total && uploaded < total) {
    setBsStatus('connected syncing', courses + ' modules · syncing lectures ' + uploaded + '/' + total);
    startBsPoll();   // keep refreshing until the extension finishes uploading
  } else {
    setBsStatus('connected', courses + ' modules' + (total ? ' · ' + total + ' lectures synced' : ' connected'));
    stopBsPoll();
  }
}

/* ---------------- Sidebar ---------------- */
async function loadSidebar() {
  const [{ data: projects }, { data: chats }] = await Promise.all([
    sb.from('projects').select('*').order('created_at', { ascending: false }),
    sb.from('chats').select('*').order('updated_at', { ascending: false }),
  ]);
  renderSidebar(projects || [], chats || []);
}
let allProjects = [];
function renderSidebar(projects, chats) {
  allProjects = projects || [];
  const wrap = $('sb-scroll');
  wrap.innerHTML = '';
  const byProject = {};
  const loose = [];
  for (const c of chats) {
    if (c.project_id) (byProject[c.project_id] = byProject[c.project_id] || []).push(c);
    else loose.push(c);
  }
  // Projects (folders)
  for (const p of projects) {
    const box = document.createElement('div');
    box.className = 'sb-project';
    const head = document.createElement('div');
    head.className = 'sb-item';
    const ptitle = document.createElement('span');
    ptitle.className = 'sb-title';
    ptitle.textContent = '📁 ' + p.name;
    ptitle.title = 'New chat in this project';
    ptitle.onclick = () => newChat(p.id);
    const pdel = document.createElement('button');
    pdel.className = 'sb-del'; pdel.title = 'Delete project'; pdel.innerHTML = ICON_TRASH;
    pdel.onclick = (e) => { e.stopPropagation(); deleteProject(p.id, p.name); };
    head.appendChild(ptitle); head.appendChild(pdel);
    box.appendChild(head);
    const sub = document.createElement('div');
    sub.className = 'sb-project-chats';
    for (const c of (byProject[p.id] || [])) sub.appendChild(chatItem(c));
    box.appendChild(sub);
    wrap.appendChild(box);
  }
  // Loose chats
  if (loose.length) {
    const lbl = document.createElement('div');
    lbl.className = 'sb-section'; lbl.textContent = 'Recent';
    wrap.appendChild(lbl);
    for (const c of loose) wrap.appendChild(chatItem(c));
  }
}
function chatItem(c) {
  const el = document.createElement('div');
  el.className = 'sb-item' + (c.id === activeChatId ? ' active' : '');
  const title = document.createElement('span');
  title.className = 'sb-title';
  title.textContent = c.title || 'New chat';
  title.onclick = () => selectChat(c.id);
  title.ondblclick = (e) => { e.stopPropagation(); startRename(c, el, title); };

  const actions = document.createElement('div');
  actions.className = 'sb-actions-row';
  const mk = (icon, label, danger, fn) => {
    const b = document.createElement('button');
    b.className = 'sb-act' + (danger ? ' danger' : ''); b.title = label; b.innerHTML = icon;
    b.onclick = (e) => { e.stopPropagation(); fn(e); };
    return b;
  };
  actions.appendChild(mk(ICON_EDIT, 'Rename', false, () => startRename(c, el, title)));
  actions.appendChild(mk(ICON_FOLDER, 'Move to folder', false, (e) => openMovePopover(c, e.currentTarget)));
  actions.appendChild(mk(ICON_TRASH, 'Delete chat', true, () => deleteChat(c.id)));

  el.appendChild(title); el.appendChild(actions);
  return el;
}

// Inline rename: swap the title for a text input.
function startRename(c, el, titleEl) {
  if (el.querySelector('.sb-rename')) return;
  const input = document.createElement('input');
  input.className = 'sb-rename';
  input.value = c.title || '';
  el.replaceChild(input, titleEl);
  input.focus(); input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const name = input.value.trim();
    if (save && name && name !== c.title) { await sb.from('chats').update({ title: name }).eq('id', c.id); if (c.id === activeChatId) setChatName(name); }
    loadSidebar();
  };
  input.onclick = (e) => e.stopPropagation();
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') finish(false); };
  input.onblur = () => finish(true);
}

// Popover to move a chat into a project folder (or out to Recent).
function openMovePopover(c, anchor) {
  document.querySelectorAll('.move-pop').forEach(p => p.remove());
  const pop = document.createElement('div');
  pop.className = 'move-pop';
  let html = '<div class="mp-label">Move to</div>';
  if (c.project_id) html += '<button data-pid="">' + ICON_FOLDER + 'Remove from folder</button>';
  if (!allProjects.length) html += '<div class="mp-label" style="text-transform:none;letter-spacing:0">No folders yet — create one with “New project”.</div>';
  for (const p of allProjects) {
    if (p.id === c.project_id) continue;
    html += '<button data-pid="' + p.id + '">' + ICON_FOLDER + escapeHtml(p.name) + '</button>';
  }
  pop.innerHTML = html;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.min(r.left, window.innerWidth - pop.offsetWidth - 10) + 'px';
  pop.style.top = (r.bottom + 4) + 'px';
  pop.querySelectorAll('button').forEach(b => b.onclick = async (e) => {
    e.stopPropagation();
    const pid = b.dataset.pid || null;
    pop.remove();
    await sb.from('chats').update({ project_id: pid }).eq('id', c.id);
    loadSidebar();
  });
  setTimeout(() => {
    const close = (ev) => { if (!pop.contains(ev.target)) { pop.remove(); document.removeEventListener('mousedown', close); } };
    document.addEventListener('mousedown', close);
  }, 0);
}

/* ---------------- Chats / projects ---------------- */
async function newProject() {
  const name = prompt('Project name:');
  if (!name) return;
  await sb.from('projects').insert({ user_id: session.user.id, name });
  loadSidebar();
}
async function newChat(projectId) {
  const { data, error } = await sb.from('chats')
    .insert({ user_id: session.user.id, project_id: projectId || null, title: 'New chat' })
    .select().single();
  if (error) return;
  activeChatId = data.id;
  greetState = null;   // fresh greeting/quote for a brand-new chat
  await loadSidebar();
  renderMessages([]);
  setChatName('New chat');
  $('input').focus();
}
async function selectChat(id) {
  if (isGenerating) stopGeneration();
  activeChatId = id;
  document.querySelectorAll('.sb-item').forEach(e => e.classList.remove('active'));
  const { data: msgs } = await sb.from('messages').select('*').eq('chat_id', id).order('created_at', { ascending: true });
  renderMessages(msgs || []);
  const firstUser = (msgs || []).find(m => m.role === 'user');
  setChatName(firstUser ? firstUser.content.slice(0, 48) : 'New chat');
  loadSidebar();
}
// Styled in-app confirm (replaces the browser's native localhost confirm popup).
function confirmDialog(message, okLabel) {
  return new Promise(resolve => {
    const overlay = $('modal'), msg = $('modal-msg'), ok = $('modal-ok'), cancel = $('modal-cancel');
    msg.textContent = message;
    ok.textContent = okLabel || 'Delete';
    overlay.style.display = 'flex';
    const done = (val) => { overlay.style.display = 'none'; ok.onclick = cancel.onclick = overlay.onclick = null; resolve(val); };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
    overlay.onclick = (e) => { if (e.target === overlay) done(false); };
  });
}

async function deleteChat(id) {
  await sb.from('chats').delete().eq('id', id);   // messages cascade-delete, no confirm
  if (activeChatId === id) { activeChatId = null; renderMessages([]); }
  loadSidebar();
}
async function deleteProject(id, name) {
  if (!(await confirmDialog('Delete project "' + name + '"? The chats inside it are kept and moved to Recent.'))) return;
  await sb.from('projects').delete().eq('id', id);   // chats.project_id → null
  loadSidebar();
}
$('new-chat').onclick = () => newChat(null);
$('new-project').onclick = newProject;

/* ---------------- Rendering ---------------- */
function escapeHtml(t) { return (t == null ? '' : '' + t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

const pick = (a) => a[Math.floor(Math.random() * a.length)];
function firstName() {
  const meta = session && session.user && session.user.user_metadata;
  let n = (meta && (meta.name || meta.full_name || meta.first_name)) || '';
  if (!n && session && session.user && session.user.email) n = session.user.email.split('@')[0];
  n = ('' + n).replace(/[._\-]+/g, ' ').replace(/[0-9]/g, '').trim().split(' ')[0] || '';
  if (n.length < 2) return 'there';   // unusable handle → friendly default
  return n.charAt(0).toUpperCase() + n.slice(1);
}
// ---- Proactive layer: surface what needs attention from synced data ----
function cleanModule(m) {
  return ('' + (m || '')).replace(/-20\d\d.*$/, '').replace(/-?20\d\d\/\d\d.*$/, '')
    .replace(/^[A-Z]{2,4}\d{4,5}[-\s]*/, '').replace(/[-\s]+$/, '').trim() || m || '';
}
function upcomingDeadlines(limit) {
  if (!bsData || !Array.isArray(bsData.deadlines)) return [];
  const now = Date.now(), out = [];
  for (const d of bsData.deadlines) {
    for (const a of (d.assignments || [])) {
      if (!a.dueDate) continue;
      const t = Date.parse(a.dueDate);
      if (isNaN(t)) continue;
      out.push({ module: cleanModule(d.courseName || d.courseCode), name: a.name || 'Assignment', due: t });
    }
  }
  return out.filter(x => x.due >= now - 12 * 3600 * 1000).sort((a, b) => a.due - b.due).slice(0, limit || 4);
}
function dueLabel(ms) {
  const diff = ms - Date.now(), day = 86400000;
  if (diff < 0) return { txt: 'overdue', cls: 'urgent' };
  if (diff < day) return { txt: 'due today', cls: 'urgent' };
  if (diff < 2 * day) return { txt: 'due tomorrow', cls: 'urgent' };
  const days = Math.round(diff / day);
  if (days < 7) return { txt: 'in ' + days + ' days', cls: 'soon' };
  const wk = Math.round(days / 7);
  return { txt: 'in ' + wk + (wk === 1 ? ' week' : ' weeks'), cls: '' };
}
function proactiveCardHtml() {
  const dls = upcomingDeadlines(4);
  if (!dls.length) return '';
  const rows = dls.map(d => {
    const dl = dueLabel(d.due);
    const q = 'I have "' + d.name + '" for ' + d.module + ' coming up — how should I approach it and what should I prioritise?';
    return '<button class="attn-row" data-q="' + escapeHtml(q) + '">' +
      '<span class="attn-main"><span class="attn-title">' + escapeHtml(d.name) + '</span>' +
      '<span class="attn-mod">' + escapeHtml(d.module) + '</span></span>' +
      '<span class="attn-due ' + dl.cls + '">' + escapeHtml(dl.txt) + '</span></button>';
  }).join('');
  return '<div class="attn"><div class="attn-head">Coming up</div>' + rows + '</div>';
}

// Connected = the extension has synced Brightspace data for this account.
function isConnected() { return !!(bsData && bsData.courses && bsData.courses.length); }

// Onboarding card shown when a new student hasn't connected Brightspace yet.
function onboardCardHtml() {
  const email = (session && session.user && session.user.email) || 'this account';
  const extUrl = (window.SEAM_CONFIG && window.SEAM_CONFIG.EXTENSION_URL) || '';
  const cta = extUrl
    ? '<a class="ob-cta" href="' + escapeHtml(extUrl) + '" target="_blank" rel="noopener">Get the Seam extension →</a>'
    : '<div class="ob-soon">🧩 Seam extension — coming to the Chrome Web Store</div>';
  return '<div class="onboard">' +
    '<div class="ob-title">Connect your Brightspace</div>' +
    '<div class="ob-sub">Unlock your lectures, grades, deadlines &amp; exam results — synced automatically and kept private to you.</div>' +
    '<div class="ob-steps">' +
      '<div class="ob-step"><span class="ob-num">1</span><span>Install the Seam browser extension</span></div>' +
      '<div class="ob-step"><span class="ob-num">2</span><span>Open Brightspace and sign into Sync with <b>' + escapeHtml(email) + '</b></span></div>' +
      '<div class="ob-step"><span class="ob-num">3</span><span>Your modules appear here automatically ✨</span></div>' +
    '</div>' + cta +
    '<div class="ob-note">Until then you can still chat with Seam for general study help — essays, maths, referencing and more.</div>' +
    '</div>';
}

const GREETINGS = [
  "Hello {name}, let's get to work",
  "Welcome back, {name}",
  "Ready when you are, {name}",
  "Let's make today count, {name}",
  "Good to see you, {name}",
  "Let's get after it, {name}",
  "What are we tackling, {name}?",
  "Time to lock in, {name}",
];
const QUOTES = [
  { text: "The expert in anything was once a beginner.", author: "Helen Hayes" },
  { text: "Success is the sum of small efforts repeated day in and day out.", author: "Robert Collier" },
  { text: "It always seems impossible until it's done.", author: "Nelson Mandela" },
  { text: "The beautiful thing about learning is that no one can take it away from you.", author: "B.B. King" },
  { text: "Don't watch the clock; do what it does. Keep going.", author: "Sam Levenson" },
  { text: "Strive for progress, not perfection.", author: "Unknown" },
  { text: "The future depends on what you do today.", author: "Mahatma Gandhi" },
  { text: "Believe you can and you're halfway there.", author: "Theodore Roosevelt" },
  { text: "Quality is not an act, it is a habit.", author: "Aristotle" },
  { text: "Little by little, one travels far.", author: "J.R.R. Tolkien" },
  { text: "Discipline is the bridge between goals and accomplishment.", author: "Jim Rohn" },
  { text: "You don't have to be great to start, but you have to start to be great.", author: "Zig Ziglar" },
];

// Inline markdown: bold, italic, inline code, links. Operates on already-escaped text.
function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, '<code class="md-code">$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1<em>$2</em>')
    // Source citations [[src:Topic 3|slide 17]] → clickable chip that pulls that slide.
    .replace(/\[\[src:([^|\]]+)\|([^\]]+)\]\]/g, (m, n, r) => '<button class="cite" data-q="Show me ' + n.trim() + ' ' + r.trim() + ' word for word">📄 ' + n.trim() + ' · ' + r.trim() + '</button>')
    .replace(/\[\[src:([^\]]+)\]\]/g, (m, n) => '<button class="cite" data-q="Show me ' + n.trim() + ' word for word">📄 ' + n.trim() + '</button>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

// Turn a ```seam-quiz JSON block into an interactive quiz widget.
function renderQuiz(code) {
  const json = code.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
  let data;
  try { data = JSON.parse(json); } catch (e) { return '<pre class="md-pre"><code>' + code + '</code></pre>'; }
  if (!data || !Array.isArray(data.questions)) return '<pre class="md-pre"><code>' + code + '</code></pre>';
  const qs = data.questions.slice(0, 25);
  let h = '<div class="quiz" data-total="' + qs.length + '">';
  if (data.title) h += '<div class="quiz-title">' + escapeHtml(data.title) + '</div>';
  qs.forEach((q, i) => {
    const opts = Array.isArray(q.options) ? q.options : [];
    const ans = Math.max(0, Math.min(opts.length - 1, parseInt(q.answer, 10) || 0));
    h += '<div class="quiz-q" data-correct="' + ans + '" data-explain="' + escapeHtml(q.explain || '') + '">';
    h += '<div class="quiz-qtext">' + (i + 1) + '. ' + escapeHtml(q.q || '') + '</div><div class="quiz-opts">';
    opts.forEach((o, j) => { h += '<button class="quiz-opt" data-j="' + j + '">' + escapeHtml(o) + '</button>'; });
    h += '</div><div class="quiz-feedback"></div></div>';
  });
  return h + '<div class="quiz-score"></div></div>';
}

// Attach click behaviour to any quiz widgets inside an element.
function wireQuizzes(container) {
  container.querySelectorAll('.quiz').forEach(quiz => {
    const qEls = [...quiz.querySelectorAll('.quiz-q')];
    const total = qEls.length; let answered = 0, score = 0;
    qEls.forEach(q => {
      const correct = +q.dataset.correct;
      const opts = [...q.querySelectorAll('.quiz-opt')];
      opts.forEach(btn => {
        btn.onclick = () => {
          if (q.classList.contains('done')) return;
          q.classList.add('done');
          const chosen = +btn.dataset.j;
          if (opts[correct]) opts[correct].classList.add('correct');
          if (chosen === correct) score++; else btn.classList.add('wrong');
          const fb = q.querySelector('.quiz-feedback');
          fb.textContent = (chosen === correct ? '✓ Correct. ' : '✗ ') + (q.dataset.explain || '');
          fb.classList.add('show');
          if (++answered === total) {
            const s = quiz.querySelector('.quiz-score');
            if (s) { s.textContent = 'Score: ' + score + '/' + total + (score === total ? ' 🎉' : ''); s.classList.add('show'); }
          }
        };
      });
    });
  });
}

/* ---------------- Flashcards + spaced repetition (Leitner, localStorage) ---------------- */
const SR_KEY = 'seam-flashcards-sr';
const SR_INTERVALS = [10 * 60e3, 1 * 864e5, 2 * 864e5, 4 * 864e5, 8 * 864e5, 16 * 864e5]; // box 0..5
function srLoad() { try { return JSON.parse(localStorage.getItem(SR_KEY) || '{}'); } catch (e) { return {}; } }
function srSave(m) { try { localStorage.setItem(SR_KEY, JSON.stringify(m)); } catch (e) {} }
function srKey(title, front) { return (title || '') + '||' + front; }
function srRate(card, rating) {       // rating: again|hard|good|easy
  const m = srLoad();
  const k = srKey(card.title, card.front);
  const cur = m[k] || { front: card.front, back: card.back, title: card.title || '', box: 0 };
  let box = cur.box || 0;
  if (rating === 'again') box = 0;
  else if (rating === 'hard') box = Math.max(0, box);
  else if (rating === 'good') box = Math.min(5, box + 1);
  else if (rating === 'easy') box = Math.min(5, box + 2);
  cur.box = box; cur.due = nowMs() + SR_INTERVALS[box]; cur.front = card.front; cur.back = card.back; cur.title = card.title || '';
  m[k] = cur; srSave(m);
}
function srDueCards() { const m = srLoad(); const n = nowMs(); return Object.values(m).filter(c => (c.due || 0) <= n); }
function nowMs() { return new Date().getTime(); }

// Build an interactive flip-deck from an array of {front, back}.
function renderFlashcardWidget(title, cards, titleKey) {
  const cs = (cards || []).slice(0, 40).filter(c => c && c.front);
  if (!cs.length) return '<div class="md-li">No flashcards.</div>';
  const data = encodeURIComponent(JSON.stringify({ title: titleKey || title || '', cards: cs }));
  let h = '<div class="fc" data-deck="' + data + '">';
  if (title) h += '<div class="fc-title">' + escapeHtml(title) + '</div>';
  h += '<div class="fc-progress"></div>';
  h += '<div class="fc-card"><div class="fc-inner">' +
    '<div class="fc-face fc-front"></div><div class="fc-face fc-back"></div></div></div>';
  h += '<div class="fc-fliphint">tap the card to flip</div>';
  h += '<div class="fc-rate" style="display:none">' +
    '<button class="fc-btn" data-r="again">Again</button>' +
    '<button class="fc-btn" data-r="hard">Hard</button>' +
    '<button class="fc-btn" data-r="good">Good</button>' +
    '<button class="fc-btn" data-r="easy">Easy</button></div>';
  h += '<div class="fc-done" style="display:none"></div></div>';
  return h;
}
// ```seam-flashcards JSON → flip-deck.
function renderFlashcards(code) {
  const json = code.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
  let data; try { data = JSON.parse(json); } catch (e) { return '<pre class="md-pre"><code>' + code + '</code></pre>'; }
  if (!data || !Array.isArray(data.cards)) return '<pre class="md-pre"><code>' + code + '</code></pre>';
  return renderFlashcardWidget(data.title || 'Flashcards', data.cards, data.title);
}
function wireFlashcards(container) {
  container.querySelectorAll('.fc').forEach(fc => {
    let deck; try { deck = JSON.parse(decodeURIComponent(fc.dataset.deck)); } catch (e) { return; }
    const cards = deck.cards || []; const titleKey = deck.title || '';
    let i = 0, flipped = false;
    const cardEl = fc.querySelector('.fc-card'), inner = fc.querySelector('.fc-inner');
    const frontEl = fc.querySelector('.fc-front'), backEl = fc.querySelector('.fc-back');
    const prog = fc.querySelector('.fc-progress'), rate = fc.querySelector('.fc-rate');
    const hint = fc.querySelector('.fc-fliphint'), done = fc.querySelector('.fc-done');
    const show = () => {
      const c = cards[i]; flipped = false; inner.classList.remove('flipped');
      frontEl.textContent = c.front; backEl.textContent = c.back || '';
      prog.textContent = 'Card ' + (i + 1) + ' of ' + cards.length;
      rate.style.display = 'none'; hint.style.display = 'block';
    };
    cardEl.onclick = () => { flipped = !flipped; inner.classList.toggle('flipped', flipped); if (flipped) { rate.style.display = 'flex'; hint.style.display = 'none'; } };
    rate.querySelectorAll('.fc-btn').forEach(b => b.onclick = () => {
      srRate({ front: cards[i].front, back: cards[i].back, title: titleKey }, b.dataset.r);
      i++;
      if (i >= cards.length) {
        cardEl.style.display = 'none'; rate.style.display = 'none'; hint.style.display = 'none'; prog.style.display = 'none';
        done.style.display = 'block'; done.textContent = '✓ Deck complete — saved to your review schedule.';
        updateReviewChip();
      } else show();
    });
    show();
  });
}
// Citation chips → click pulls that slide.
function wireCites(container) {
  container.querySelectorAll('.cite').forEach(b => b.onclick = () => { const inp = $('input'); inp.value = b.dataset.q; inp.focus(); sendMessage(); });
}
function wireWidgets(el) { wireQuizzes(el); wireFlashcards(el); wireCites(el); }

// Set assistant HTML + wire all interactive widgets.
function setSeamHtml(el, text) { el.innerHTML = formatResponse(text); wireWidgets(el); }

// Review due cards locally (no API call) — triggered by "review my flashcards".
function reviewFlashcards() {
  appendBubble('user', 'Review my flashcards');
  const due = srDueCards();
  if (!due.length) { appendBubble('seam', 'No cards are due right now — nicely done! 🎉 Make new ones any time with “flashcards on [topic]”.'); return; }
  const bubble = appendBubble('seam', '');
  bubble.innerHTML = '<p>Here are your <strong>' + due.length + '</strong> card' + (due.length > 1 ? 's' : '') + ' due for review:</p>' +
    renderFlashcardWidget('Review', due.map(c => ({ front: c.front, back: c.back })), 'Review');
  wireWidgets(bubble);
}
function reviewDueHtml() {
  const n = srDueCards().length;
  return n ? '<button class="review-due" data-chip="Review my flashcards">🗂 Review ' + n + ' flashcard' + (n > 1 ? 's' : '') + ' due</button>' : '';
}
function updateReviewChip() {
  const el = document.querySelector('.review-due'); if (!el) return;
  const n = srDueCards().length;
  if (!n) el.remove(); else el.textContent = '🗂 Review ' + n + ' flashcard' + (n > 1 ? 's' : '') + ' due';
}
function isReviewCommand(t) { return /\breview\b[\s\S]*\b(flashcards?|cards|due)\b/i.test(t) || /^\s*review\s*$/i.test(t); }

// Lightweight markdown → HTML renderer (headings, tables, code blocks, lists, paragraphs).
function formatResponse(text) {
  const src = escapeHtml(text);
  // Pull fenced code blocks out first so their contents aren't touched. The
  // sentinel sits on its own line and is restored after all other processing.
  const blocks = [];
  const staged = src.replace(/```([\w-]+)?\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const lg = (lang || '').toLowerCase();
    if (lg === 'seam-quiz') blocks.push(renderQuiz(code));
    else if (lg === 'seam-flashcards') blocks.push(renderFlashcards(code));
    else blocks.push('<pre class="md-pre"><code>' + code.replace(/\n+$/, '') + '</code></pre>');
    return '\nSEAMCB' + (blocks.length - 1) + 'END\n';
  });

  const lines = staged.split('\n');
  const out = [];
  let para = [];
  const flushPara = () => { if (para.length) { out.push('<p>' + inlineMd(para.join(' ')) + '</p>'); para = []; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (/^SEAMCB\d+END$/.test(t)) { flushPara(); out.push(blocks[+t.slice(6, -3)]); continue; }
    if (!t) { flushPara(); continue; }

    // Markdown table: a header row, a |---|---| separator, then body rows.
    if (/^\|.*\|$/.test(t) && i + 1 < lines.length && /^\|?[\s:|-]+\|?$/.test(lines[i + 1].trim()) && lines[i + 1].includes('-')) {
      flushPara();
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const header = cells(t);
      let html = '<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
        header.map(c => '<th>' + inlineMd(c) + '</th>').join('') + '</tr></thead><tbody>';
      i += 2;
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        html += '<tr>' + cells(lines[i]).map(c => '<td>' + inlineMd(c) + '</td>').join('') + '</tr>';
        i++;
      }
      i--;
      out.push(html + '</tbody></table></div>');
      continue;
    }

    let m;
    if ((m = t.match(/^(#{1,3}) (.+)$/))) { flushPara(); out.push('<div class="md-h md-h' + m[1].length + '">' + inlineMd(m[2]) + '</div>'); continue; }
    if ((m = t.match(/^[-*•] (.+)$/))) { flushPara(); out.push('<div class="md-li"><span class="md-bullet">•</span><span>' + inlineMd(m[1]) + '</span></div>'); continue; }
    if ((m = t.match(/^(\d+)\. (.+)$/))) { flushPara(); out.push('<div class="md-li"><span class="md-num">' + m[1] + '.</span><span>' + inlineMd(m[2]) + '</span></div>'); continue; }
    if (/^(---+|\*\*\*+|___+)$/.test(t)) { flushPara(); out.push('<hr style="border:none;border-top:1px solid var(--line);margin:14px 0">'); continue; }
    if (t.indexOf('> ') === 0) { flushPara(); out.push('<div style="border-left:3px solid var(--accent-soft);padding-left:12px;color:var(--ink-soft);margin:8px 0">' + inlineMd(t.slice(2)) + '</div>'); continue; }
    para.push(t);
  }
  flushPara();
  return out.join('').replace(/SEAMCB(\d+)END/g, (_m, n) => blocks[+n] || '');
}
function renderMessages(msgs) {
  const wrap = $('mwrap');
  wrap.innerHTML = '';
  if (!msgs.length) {
    const name = firstName();
    // Cache greeting+quote for this home view so the two load-time renders don't flicker.
    if (!greetState) greetState = { greet: pick(GREETINGS).replace('{name}', name), q: pick(QUOTES) };
    const greet = greetState.greet;
    const q = greetState.q;
    // New students (no Brightspace yet) see connect steps; connected students see "Coming up".
    const connected = isConnected();
    const chips = connected
      ? ['Quiz me on a module', 'Summarise a lecture', 'Plan my week', 'Help with an essay']
      : ['Help with an essay', 'Explain a tricky concept', 'Harvard referencing', 'Quiz me on a topic'];
    wrap.innerHTML = '<div class="empty"><div class="e-mark">S</div>' +
      '<div class="greet">' + escapeHtml(greet) + '</div>' +
      '<div class="quote"><span class="qmark">“</span>' + escapeHtml(q.text) + '<span class="qmark">”</span>' +
        '<span class="qauthor">— ' + escapeHtml(q.author) + '</span></div>' +
      (connected ? proactiveCardHtml() : onboardCardHtml()) +
      reviewDueHtml() +
      '<div class="suggest">' + chips.map(c => '<button data-chip="' + escapeHtml(c) + '">' + escapeHtml(c) + '</button>').join('') + '</div>' +
      '</div>';
    wrap.querySelectorAll('.suggest button, .review-due').forEach(b => b.onclick = () => {
      const inp = $('input'); inp.value = b.dataset.chip; inp.focus(); sendMessage();
    });
    wrap.querySelectorAll('.attn-row').forEach(b => b.onclick = () => {
      const inp = $('input'); inp.value = b.dataset.q; inp.focus(); sendMessage();
    });
    return;
  }
  for (const m of msgs) appendBubble(m.role, m.content);
}
function appendBubble(role, content) {
  const wrap = $('mwrap');
  const empty = wrap.querySelector('.empty'); if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = 'msg' + (role === 'user' ? ' user' : '');
  const cls = role === 'user' ? 'user' : 'seam';
  const av = role === 'user' ? 'You' : 'S';
  div.innerHTML = '<div class="avatar ' + cls + '">' + av + '</div><div class="bubble ' + cls + '">' +
    (role === 'user' ? escapeHtml(content) : formatResponse(content)) + '</div>';
  wrap.appendChild(div);
  if (role !== 'user') wireWidgets(div);   // make quizzes/flashcards/citations interactive
  $('messages').scrollTop = $('messages').scrollHeight;
  return div.querySelector('.bubble');
}

/* ---------------- Sending ---------------- */
const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';
const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const ICON_FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2Z"/></svg>';
const ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>';
function setGenerating(on) {
  isGenerating = on;
  const b = $('send');
  b.classList.toggle('stop', on);
  b.innerHTML = on ? ICON_STOP : ICON_SEND;
  b.title = on ? 'Stop' : 'Send';
}
function stopGeneration() { if (currentAbort) { try { currentAbort.abort(); } catch (e) {} } }

// Fetch the text of the lectures most relevant to the question from the cloud
// table the extension populates.
// Generic academic words that appear in tons of titles — they must NOT drive
// matching, or "give me lecture slides" pulls in every "Lecture slides:" deck.
const LECT_STOPWORDS = new Set(['lecture','lectures','slide','slides','notes','note','info','information','summary','summarise','summarised','summarize','pull','from','about','tell','give','make','please','with','what','that','this','your','have','some','more','show','help','study','exam','content','material','materials','week','day']);

async function fetchRelevantLectures(userText) {
  if (!session) return [];
  // Match against the REAL synced index (not the catalog) so we only ever try to
  // load lectures that genuinely exist in the cloud, by their actual URLs.
  const pool = bsLectureIndex.length ? bsLectureIndex : (bsData && bsData.lectureCatalog || []);
  if (!pool.length) return [];
  // Keep numbers (the "3" in "topic 3" is the whole point) and meaningful words;
  // drop generic stopwords. Numbers score highest because they're the most
  // discriminating signal between e.g. Topic 3 and Topic 5.
  const raw = (userText || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  const nums = raw.filter(w => /^\d+$/.test(w));
  const words = raw.filter(w => w.length > 2 && !/^\d+$/.test(w) && !LECT_STOPWORDS.has(w));
  if (!words.length && !nums.length) return [];
  // Quizzes / revision span a module — load more lectures (smaller slices each).
  const isQuiz = /\b(quiz|revis|practice|test me|flashcard|exam prep|study guide)\b/.test((userText || '').toLowerCase());
  const limit = isQuiz ? 6 : 3;
  const perChars = isQuiz ? 9000 : 18000;
  const scored = pool
    .map(l => {
      const tokens = ((l.module || '') + ' ' + (l.title || '')).toLowerCase().match(/[a-z0-9]+/g) || [];
      const tset = new Set(tokens);
      let score = 0;
      for (const w of words) if (tset.has(w)) score += 2; else if (tokens.some(t => t.includes(w))) score += 1;
      for (const n of nums) if (tset.has(n)) score += 4;   // exact number token (Topic "3") is the strongest signal
      return { l, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  if (!scored.length) return [];
  const urls = scored.map(x => x.l.url);
  const { data } = await sb.from('lecture_text').select('module,title,text').eq('user_id', session.user.id).in('url', urls);
  const out = (data || []).map(r => ({ title: r.title, module: r.module, text: (r.text || '').slice(0, perChars) })).filter(l => l.text);
  console.log('[Seam web] query matched (top ' + limit + '):', scored.map(x => x.l.title + ' [' + x.score + ']'), '→ loaded text for ' + out.length);
  return out;
}

function systemPrompt(userText, relevantLectures) {
  let now = '';
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
    now = new Date().toLocaleString('en-IE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' (' + tz + ')';
  } catch (e) {}

  let bsBlock;
  if (bsData) {
    const cat = bsData.lectureCatalog || [];
    const courses = bsData.courses || [];
    const P = (items, gm, gt, n) => SeamCore.pickRelevant(userText, items || [], courses, gm, gt, n);
    // Only send the relevant slice (like the extension) — not the whole dataset.
    const ctx = {
      courses: bsData.courses, grades: bsData.grades, deadlines: bsData.deadlines,
      announcements: bsData.announcements, alerts: bsData.alerts, timetable: bsData.timetable,
      moduleContent: P(bsData.moduleContent, i => i.module, i => i.title + ' ' + i.text, 20),
      assignmentFeedback: P(bsData.assignmentFeedback, f => f.courseName, f => (f.assignment || '') + ' ' + (f.feedback || ''), 12),
      descriptions: P(bsData.descriptions, d => d.module, d => (d.title || '') + ' ' + (d.text || ''), 10),
      discussions: P(bsData.discussions, d => (d.courseName || '') + ' ' + (d.forum || ''), d => (d.topic || '') + ' ' + (d.posts || []).map(p => p.body).join(' '), 6),
      allLectureTitlesByModule: SeamCore.buildLectureIndex(cat),
    };
    bsBlock = 'The student has connected their Brightspace — use this data for their grades, deadlines, modules, quizzes, feedback and lectures. Brightspace data: ' + JSON.stringify(ctx).slice(0, 60000);
    // Loaded lecture TEXT appended SEPARATELY so it's NEVER truncated by the rest of the context.
    // This is the actual slide content — quiz/quote ONLY from what's here.
    const rl = relevantLectures || [];
    if (rl.length) {
      bsBlock += '\n\nLOADED LECTURE TEXT — the full text of the lectures relevant to this question is below. You MAY quote, summarise and build quizzes from THESE (and only these). Slide/page markers like "=== Slide N/Total ===" are reliable. Lectures: ' + JSON.stringify(rl).slice(0, 70000);
    }
    // SISWeb appended separately too — official UCD data.
    if (bsData.sisweb && Object.keys(bsData.sisweb).length) {
      bsBlock += '\n\nOFFICIAL SISWeb DATA (from UCD\'s student system — exam results/GPA, timetable, fees, key dates). This is authoritative; prefer it over Brightspace for grades/results: ' + JSON.stringify(bsData.sisweb).slice(0, 9000);
    }
  } else {
    bsBlock = 'The student has NOT connected their Brightspace yet, so you do not have their personal grades/deadlines/lectures. If they ask about those, tell them to install the Seam browser extension and sign in with this same account to sync their Brightspace.';
  }

  // Same brain as the extension — assembled from the shared core.
  return SeamCore.buildSystemPrompt({ nowStr: now, brightspaceBlock: bsBlock, userName: firstName(), language: langPref(), referenceOnly: referenceMode() });
}

async function sendMessage() {
  const input = $('input');
  const text = input.value.trim();
  if (!text || !session) return;
  // "Review my flashcards" is handled locally from the spaced-repetition store — no API call.
  if (isReviewCommand(text)) { input.value = ''; input.style.height = 'auto'; reviewFlashcards(); return; }
  if (isGenerating) { stopGeneration(); await new Promise(r => setTimeout(r, 50)); }
  if (!activeChatId) await newChat(null);

  input.value = ''; input.style.height = 'auto';
  appendBubble('user', text);

  // Persist the user message + load prior messages for context.
  await sb.from('messages').insert({ chat_id: activeChatId, user_id: session.user.id, role: 'user', content: text });
  const { data: prior } = await sb.from('messages').select('role,content').eq('chat_id', activeChatId).order('created_at', { ascending: true });
  const messages = (prior || []).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

  // Title the chat from the first user message.
  const { data: chatRow } = await sb.from('chats').select('title').eq('id', activeChatId).single();
  if (chatRow && (chatRow.title === 'New chat' || !chatRow.title)) {
    await sb.from('chats').update({ title: text.slice(0, 48) }).eq('id', activeChatId);
    setChatName(text.slice(0, 48));
  }

  const myAbort = new AbortController(); currentAbort = myAbort; setGenerating(true);
  const relLect = await fetchRelevantLectures(text);
  const bubble = appendBubble('seam', '');
  bubble.classList.add('streaming');
  bubble.textContent = '';
  let reply = '';
  let streamStarted = false;

  try {
    const reqBody = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1500, system: systemPrompt(text, relLect), messages, stream: true });
    // Retry on rate-limit (429) / overload (529) with backoff, like the extension.
    let resp;
    for (let attempt = 1; attempt <= 4; attempt++) {
      resp = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
        body: reqBody,
        signal: myAbort.signal,
      });
      if (resp.status !== 429 && resp.status !== 529) break;
      if (attempt === 4) break;
      const ra = parseInt(resp.headers.get('retry-after'), 10);
      const waitMs = (ra > 0 ? ra : Math.pow(2, attempt - 1)) * 1000;
      bubble.innerHTML = formatResponse('⏳ Rate limited — retrying…');
      await new Promise(r => setTimeout(r, waitMs));
    }
    if (!resp.ok) {
      let m = 'HTTP ' + resp.status;
      try { const e = await resp.json(); if (e.error) m = e.error.message || e.error; } catch (e) {}
      if (resp.status === 429) m = 'rate limited — the API key is over its usage limit right now. Wait a moment and try again.';
      bubble.innerHTML = formatResponse('⚠️ ' + m + (resp.status === 404 ? ' — is the chat Edge Function deployed?' : ''));
      return;
    }
    reply = await SeamCore.consumeSSE(resp, (delta, full) => {
      reply = full;
      const qi = full.indexOf('```seam');   // a quiz/flashcard block is being generated
      if (qi !== -1) {
        // Hide the raw JSON while it streams — show a clean "building" indicator.
        bubble.classList.remove('streaming');
        const intro = full.slice(0, qi).trim();
        const label = full.indexOf('```seam-flash') !== -1 ? 'Building your flashcards…' : 'Building your quiz…';
        bubble.innerHTML = (intro ? formatResponse(intro) : '') + '<div class="quiz-building"><span class="quiz-spin"></span>' + label + '</div>';
      } else {
        if (!streamStarted) { bubble.textContent = ''; streamStarted = true; }   // clear any retry notice
        const span = document.createElement('span');
        span.className = 'fade-tok';
        span.textContent = delta;
        bubble.appendChild(span);
      }
      $('messages').scrollTop = $('messages').scrollHeight;
    });
    bubble.classList.remove('streaming');
    setSeamHtml(bubble, reply);   // clean formatted markdown + interactive quizzes
  } catch (err) {
    bubble.classList.remove('streaming');
    if (err && err.name === 'AbortError') bubble.innerHTML = formatResponse(reply + '\n\n_(stopped)_');
    else bubble.innerHTML = formatResponse('⚠️ ' + (err.message || err));
  } finally {
    bubble.classList.remove('streaming');
    if (currentAbort === myAbort) { currentAbort = null; setGenerating(false); }
    if (reply.trim()) {
      await sb.from('messages').insert({ chat_id: activeChatId, user_id: session.user.id, role: 'assistant', content: reply });
      await sb.from('chats').update({ updated_at: new Date().toISOString() }).eq('id', activeChatId);
      loadSidebar();
    }
  }
}

$('send').onclick = () => { if (isGenerating) stopGeneration(); else sendMessage(); };
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
$('input').addEventListener('input', function () { this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 160) + 'px'; });

/* ---------------- Theme ---------------- */
function themePref() { try { return localStorage.getItem('seam-theme') || 'system'; } catch (e) { return 'system'; } }
function applyTheme(pref) {
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}
function syncThemeSeg() {
  const pref = themePref();
  document.querySelectorAll('#theme-seg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.themeVal === pref));
}
function setTheme(pref) { try { localStorage.setItem('seam-theme', pref); } catch (e) {} applyTheme(pref); syncThemeSeg(); }
applyTheme(themePref());
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (themePref() === 'system') applyTheme('system'); });
document.querySelectorAll('#theme-seg .seg-btn').forEach(b => b.onclick = () => setTheme(b.dataset.themeVal));

/* ---------------- Settings modal ---------------- */
function openSettings() {
  $('settings-email').textContent = (session && session.user.email) || '';
  syncThemeSeg();
  $('settings').style.display = 'flex';
}
function closeSettings() { $('settings').style.display = 'none'; }
$('open-settings').onclick = openSettings;
$('settings-close').onclick = closeSettings;
$('settings').onclick = (e) => { if (e.target === $('settings')) closeSettings(); };
$('settings-signout').onclick = async () => { closeSettings(); await sb.auth.signOut(); activeChatId = null; };

/* ---------------- Topbar chat name ---------------- */
function setChatName(t) { const el = $('chat-name'); if (el) el.textContent = t || 'New chat'; }

/* ---------------- Collapsible sidebar ---------------- */
function setSidebar(collapsed) {
  const layout = document.querySelector('.layout');
  if (layout) layout.classList.toggle('collapsed', collapsed);
  try { localStorage.setItem('seam-sidebar', collapsed ? 'collapsed' : 'open'); } catch (e) {}
}
$('collapse-sidebar').onclick = () => setSidebar(true);
$('show-sidebar').onclick = () => setSidebar(false);
try { if (localStorage.getItem('seam-sidebar') === 'collapsed') document.querySelector('.layout').classList.add('collapsed'); } catch (e) {}

/* ---------------- Language ---------------- */
function langPref() { try { return localStorage.getItem('seam-lang') || 'English'; } catch (e) { return 'English'; } }
(function initLang() {
  const sel = $('lang-select');
  if (!sel) return;
  sel.value = langPref();
  if (sel.selectedIndex < 0) sel.value = 'English';
  sel.onchange = () => { try { localStorage.setItem('seam-lang', sel.value); } catch (e) {} };
})();

/* ---------------- Reference mode (module content only) ---------------- */
function referenceMode() { try { return localStorage.getItem('seam-reference') === '1'; } catch (e) { return false; } }
(function initReference() {
  const sw = $('ref-toggle');
  if (!sw) return;
  const sync = () => sw.classList.toggle('on', referenceMode());
  sync();
  sw.onclick = () => { try { localStorage.setItem('seam-reference', referenceMode() ? '0' : '1'); } catch (e) {} sync(); };
})();

initAuth();
