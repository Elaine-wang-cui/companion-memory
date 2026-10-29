const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escapeHTML = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const types = {
  memory: { name: '记忆', icon: 'moon' },
  diary: { name: '日记', icon: 'book' },
  promise: { name: '约定', icon: 'key' },
  conversation: { name: '对话', icon: 'chat' },
  note: { name: '便条', icon: 'edit' },
  unresolved: { name: '未了', icon: 'star' },
  handoff: { name: '交接', icon: 'arrow' },
  voice: { name: '语音', icon: 'moon' },
  image: { name: '图片', icon: 'star' },
  heart: { name: '心痕', icon: 'heart' },
  desire: { name: '欲望', icon: 'star' },
  novel: { name: '小说', icon: 'book' }
};
const KEY = 'companion_memories_key';
const EFFECTS_KEY = 'rosarium-effects';
const state = { page: 'people', person: null, filter: 'all', search: '', loading: false, error: '' };
let database = { people: [], cards: [], effects: localStorage.getItem(EFFECTS_KEY) !== '0' };
let readerId = null;
let readerDetail = null;
let toastTimer;
let deckTopics = [];
let herStatus = null;
let companionNotes = { items: [], unread: 0 };
let notesOpen = false;
let statusHistory = [];
let historyOpen = false;
const STATUS_PRESETS = ['刚醒','在忙','累了','心情不好'];

const today = () => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const formatDate = value => String(value || '').replaceAll('-', '.');
const personFor = id => database.people.find(p => p.id === id);
function getKey() { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } }
function setKey(v) { localStorage.setItem(KEY, v); }

function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.add('show');
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 2800);
}

async function api(path, opts = {}) {
  const headers = Object.assign({ Authorization: 'Bearer ' + getKey() }, opts.headers || {});
  if (opts.body && !(opts.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, { ...opts, headers });
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const j = await res.json();
    if (!res.ok) throw new Error(j.message || j.error || String(res.status));
    return j;
  }
  if (!res.ok) throw new Error('请求失败 ' + res.status);
  return res;
}

function heading(en, title, subtitle, action = '') {
  return `<header class="view-heading"><p class="en-title">${en}</p><div class="title-row"><h2>${escapeHTML(title)}</h2>${action}</div><p class="subtitle">${escapeHTML(subtitle)}</p></header>`;
}

function personCard(p) {
  const entries = database.cards.filter(e => e.persona_id === p.id);
  const novelN = entries.filter(e => e.type === 'novel').length;
  const metaBits = [`${entries.length} 则记录`, `${entries.filter(e => e.type === 'diary').length} 篇日记`];
  if (novelN) metaBits.push(`${novelN} 本小说`);
  metaBits.push('打开记忆');
  return `<button class="person-card" data-person="${escapeHTML(p.id)}" aria-label="打开${escapeHTML(p.name)}的记忆档案"><span class="name-seal">${icon(p.emblem || 'rose')}</span><span class="person-info"><h3>${escapeHTML(p.name)}</h3><p class="person-note">${escapeHTML(p.note || '')}</p><span class="person-meta">${metaBits.map((b,i)=> (i?`<i></i>`:'')+`<span>${b}</span>`).join('')}</span></span>${icon('arrow').replace('<svg ', '<svg class="card-arrow" ')}</button>`;
}

function renderAuthGate() {
  return heading('The key to the garden', '打开花园', '记忆花园需要管理员密钥（只保存在这台设备的浏览器里）。') +
    `<div class="entry" style="padding:22px"><label class="small-caption">管理员密钥</label><input id="garden-key" type="password" autocomplete="off" placeholder="ADMIN_KEY" style="margin-top:8px"><div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap"><button class="gold-button" data-action="save-key">进入花园</button><a class="gold-button" href="/memories/classic" style="text-decoration:none">旧版记忆页</a></div><p class="small-caption">密钥不会发给别人，只存在 localStorage。</p></div>`;
}

function relTime(iso) {
  const m = Math.floor(Math.max(0, Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + '分钟前';
  const h = Math.floor(m / 60);
  return h < 24 ? h + '小时前' : Math.floor(h / 24) + '天前';
}

function renderHouseBar() {
  const s = herStatus;
  const who = s ? (s.set_by === 'user' ? '你' : (personFor(s.set_by)?.name || s.set_by)) : '';
  const statusLine = s ? `<p class="small-caption">现在：<strong>${escapeHTML(s.text)}</strong> · ${relTime(s.created_at)} · ${escapeHTML(who)}${s.stale ? ' · 已过时' : ''}</p>` : '<p class="small-caption">还没写状态</p>';
  const chips = STATUS_PRESETS.map(x => `<button type="button" class="entry-admin-btn" data-status-preset="${x}">${x}</button>`).join('');
  const n = companionNotes;
  const dot = n.unread ? `<span class="unread-dot">${n.unread}</span>` : '';
  const list = notesOpen ? (n.items.length ? n.items.map(x => `<div class="entry house-note${x.seen_at ? '' : ' is-unread'}"><div class="entry-head">${icon('edit')}<span>${escapeHTML(personFor(x.persona_id)?.name || x.persona_id)}</span><time>${relTime(x.created_at)}</time></div><p class="reader-text" style="margin:10px 0">${escapeHTML(x.content)}</p><div class="entry-admin"><button type="button" class="entry-admin-btn entry-admin-danger" data-action="delete-cnote" data-cnote-id="${escapeHTML(x.id)}">删除</button></div></div>`).join('') : '<p class="small-caption">还没有。</p>') : '';
  const bjTime = iso => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  const whoOf = id => id === 'user' ? '你' : (personFor(id)?.name || id);
  const hist = historyOpen ? (statusHistory.length ? statusHistory.map(x => `<div class="status-history-item" style="display:flex;gap:8px;align-items:baseline;margin-top:6px"><span style="flex:1"><strong>${escapeHTML(x.text)}</strong> <span class="small-caption">· ${escapeHTML(whoOf(x.set_by))} · ${bjTime(x.created_at)}</span></span><button type="button" class="entry-admin-btn entry-admin-danger" style="opacity:.55;padding:2px 6px" data-action="delete-status" data-status-id="${escapeHTML(x.id)}" aria-label="删除这条">×</button></div>`).join('') : '<p class="small-caption">还没有。</p>') : '';
  const histBlock = `<div class="status-history" style="margin-top:10px"><button type="button" class="section-label house-notes-toggle" data-action="toggle-status-history">以前的心情 <span>${historyOpen ? '收起' : '展开'}</span></button>${hist}</div>`;
  return `<div class="entry house-bar"><div class="section-label">我现在…</div>${statusLine}<div class="entry-admin">${chips}</div><form id="status-form" style="display:flex;gap:8px;margin-top:10px"><input name="text" maxlength="500" placeholder="自己写一句"><button class="entry-admin-btn" type="submit">保存</button></form>${histBlock}</div>
    <div class="house-notes"><button type="button" class="section-label house-notes-toggle" data-action="toggle-cnotes">他留给你的 ${dot}<span>${n.items.length} notes</span></button>${list}</div>`;
}

function renderPeople() {
  if (!getKey()) return renderAuthGate();
  const people = database.people.filter(p => p.id !== 'family' && `${p.name} ${p.note}`.includes(state.search));
  return heading('The names we keep', '月下花名册', '选一个名字，翻开只属于你们的记忆。', `<button class="small-add" data-action="reload" aria-label="刷新">${icon('star')}</button>`) +
    renderHouseBar() + `<div class="section-label">珍重的名字 <span>${String(people.length).padStart(2, '0')} names</span></div><div class="people-list">${people.length ? people.map(personCard).join('') : `<div class="empty">${icon('rose')}<h3>${state.search ? '没有找到这个名字' : '花园还在苏醒'}</h3><p>${state.error || '密钥保存后会从记忆库拉取人名。'}</p></div>`}</div>` +
    (personFor('family') ? `<button class="add-person" data-person="family">${icon('rose')} 全家共享的记忆</button>` : '') +
    `<div class="quiet-quote"><p>“ 有些瞬间很轻，却值得被记很久。 ”</p><span>Little moments, forever kept.</span></div><p class="local-note"><svg><use href="#i-key"/></svg> 数据来自 companion-memory · 需管理员密钥 · <a href="/memories/classic" style="color:inherit">旧版</a></p>`;
}

function entriesInView() {
  return database.cards.filter(e => {
    if (state.person && e.persona_id !== state.person) return false;
    if (state.page === 'diary' && e.type !== 'diary') return false;
    if (state.page === 'novels' && e.type !== 'novel') return false;
    if (state.page === 'favorites' && !e.favorite) return false;
    if (state.page === 'shake') return false;
    return true;
  });
}

function filteredEntries() {
  return entriesInView().filter(e => {
    if (state.filter === 'all') return true;
    if (state.filter === 'memory') return e.type === 'memory';
    if (state.filter === 'diary') return e.type === 'diary';
    if (state.filter === 'promise') return e.type === 'promise' || e.type === 'unresolved';
    if (state.filter === 'finished') return e.type === 'unresolved' && e.status === 'closed';
    if (state.filter === 'conversation') return e.type === 'conversation';
    if (state.filter === 'voice') return e.type === 'voice';
    if (state.filter === 'image') return e.type === 'image';
    if (state.filter === 'note') return e.type === 'note' || e.type === 'handoff';
    return e.type === state.filter;
  }).filter(e => `${e.title} ${e.summary} ${personFor(e.persona_id)?.name || ''}`.includes(state.search))
    .sort((a, b) => b.date.localeCompare(a.date));
}

function filters() {
  const entries = entriesInView();
  const keys = [['all','全部'],['memory','记忆'],['diary','日记'],['novel','小说'],['promise','约定'],['conversation','对话'],['voice','语音'],['note','便条'],['finished','做完的'],['heart','心痕'],['desire','欲望']];
  return `<div class="filters-wrap"><div class="filters" role="group" aria-label="记忆分类">${keys.map(([key, name]) => {
    const count = key === 'all' ? entries.length : entries.filter(e => {
      if (key === 'promise') return e.type === 'promise' || e.type === 'unresolved';
      if (key === 'note') return e.type === 'note' || e.type === 'handoff';
      if (key === 'finished') return e.type === 'unresolved' && e.status === 'closed';
      return e.type === key;
    }).length;
    return `<button type="button" class="filter ${state.filter === key ? 'active' : ''}" aria-pressed="${state.filter === key}" data-filter="${key}">${name}<span>${count}</span></button>`;
  }).join('')}</div></div>`;
}

function entryCard(e) {
  const type = types[e.type] || types.memory;
  const badge = (e.type === 'novel' && e.kind_label) ? e.kind_label : type.name;
  const parsed = parseEntryId(e.id);
  const admin = adminActionsHtml(e.id, parsed?.source, { compact: true });
  const footHint = e.type === 'novel' ? '轻触，打开全文 ↗' : '轻触，展开这段记忆 ↗';
  const excerptClass = e.type === 'desire' ? 'entry-excerpt desire-excerpt' : 'entry-excerpt';
  const replyHint = (e.type === 'desire' && e.reply_count > 0)
    ? `<span class="reply-count">${e.reply_count} 条回复</span>`
    : '';
  return `<article class="entry"><button class="entry-open" data-entry="${escapeHTML(e.id)}" aria-label="阅读：${escapeHTML(e.title)}"><div class="entry-head">${icon(type.icon)}<span>${escapeHTML(badge)}</span>${replyHint}<time datetime="${escapeHTML(e.date)}">${formatDate(e.date)}</time></div><h3>${escapeHTML(e.title)}</h3><p class="${excerptClass}">${escapeHTML(e.summary)}</p><div class="entry-foot"><span>${escapeHTML(personFor(e.persona_id)?.name || '')}的花园</span>${footHint}</div></button>${admin}<button class="favorite-button ${e.favorite ? 'is-favorite' : ''}" data-favorite="${escapeHTML(e.id)}" aria-label="${e.favorite ? '取消珍藏' : '珍藏'}：${escapeHTML(e.title)}" aria-pressed="${!!e.favorite}">${icon('heart')}</button></article>`;
}

function renderShake() {
  const topicById = Object.fromEntries((deckTopics || []).map(t => [t.id, t]));
  const topics = deckTopics.length ? deckTopics : [{ id: 'diary', name: '日记匣' }, { id: 'murmur', name: '呢喃' }, { id: 'novel', name: '小说' }];
  const topicOpts = ['<option value="">全部</option>'].concat(topics.map(t => {
      const parent = t.parent_id ? topicById[t.parent_id] : null;
      const label = parent ? `${parent.name || t.parent_id} / ${t.name || t.id}` : (t.name || t.id);
      return `<option value="${escapeHTML(t.id)}">${escapeHTML(label)}</option>`;
    })).join('');
  return heading('Shake the rose deck', '摇一摇', '从抽卡匣里抽出一片记忆，放进花园的月光里。') +
    `<div class="entry" style="padding:22px;text-align:center"><p class="subtitle" style="margin-bottom:16px">选一个匣子，轻轻摇一摇。</p>
    <label class="small-caption">主题</label>
    <select id="shake-topic" style="margin:8px 0 18px;max-width:280px;margin-left:auto;margin-right:auto;display:block">${topicOpts}</select>
    <button class="gold-button" data-action="shake-draw" style="font-size:16px;padding:14px 28px">${icon('star')} 摇一摇</button>
    <div id="shake-result" style="margin-top:22px;text-align:left"></div>
    <p class="small-caption">抽卡匣就在这里 · MCP 的 draw_deck 也会记进最近抽出</p></div>`;
}

function renderArchive() {
  if (!getKey()) return renderAuthGate();
  if (state.page === 'shake') return renderShake();
  const person = personFor(state.person);
  let header;
  if (person) {
    const all = entriesInView();
    header = `<button class="back-button" data-action="back">${icon('arrow')} 返回花名册</button><header class="view-heading archive-heading"><div class="archive-person"><span class="name-seal">${icon(person.emblem || 'rose')}</span><div><p class="en-title">A garden for ${escapeHTML(person.name)}</p><h2>${escapeHTML(person.name)}的花园</h2></div><button class="icon-button" data-action="edit-person" aria-label="修改人名与寄语">${icon('edit')}</button></div><p class="subtitle">${escapeHTML(person.note || '')}</p><div class="archive-stats"><span><strong>${all.length}</strong> 则记录</span><span><strong>${all.filter(e => e.type === 'diary').length}</strong> 篇日记</span><span><strong>${all.filter(e => e.type === 'novel').length}</strong> 本小说</span><span><strong>${all.filter(e => e.favorite).length}</strong> 份珍藏</span></div></header>`;
  } else {
    const copy = {
      memories: ['The things we remember', '记忆长廊', '散落的瞬间，在这里重新相遇。'],
      diary: ['Dear little days', '月光手记', '把今天写下来，留给以后的自己。'],
      novels: ['Stories we keep', '小说阁', '同伴写进抽卡匣的故事，在这里直接打开全文。'],
      favorites: ['Close to the heart', '心上珍藏', '舍不得忘的，都放在离心近一点的地方。']
    }[state.page] || ['The garden', '记忆花园', ''];
    header = heading(...copy, `<button class="small-add" data-action="add-entry" aria-label="写一则记录">${icon('plus')}</button>`);
  }
  const entries = filteredEntries();
  const showFilters = state.page !== 'diary' && state.page !== 'novels';
  const sectionLabel = state.page === 'diary' ? '写给时光' : state.page === 'novels' ? '匣中的故事' : '时光里的片段';
  return header + (showFilters ? filters() : '') +
    `<div class="entries-toolbar"><div class="section-label">${sectionLabel} <span>${entries.length} memories</span></div>
    ${state.page === 'novels' ? '<p class="small-caption">同伴用 add_deck_item 存进抽卡匣的小说会出现在这里；点开即全文。</p>' : `<div style="display:flex;gap:8px;flex-wrap:wrap">
      <button data-action="add-entry">${icon('plus')} ${state.page === 'diary' ? '写日记' : '记一笔'}</button>
      <button data-action="add-heart">${icon('heart')} 写心痕</button>
      <button data-action="add-desire">🔥 记欲望</button>
      <button data-action="import-conversation">${icon('chat')} 导入对话</button>
      <button data-action="add-voice">${icon('moon')} 语音</button>
    </div>`}</div>
    <div class="entries">${entries.length ? entries.map(entryCard).join('') : `<div class="empty">${icon(state.page === 'favorites' ? 'heart' : 'book')}<h3>${state.search ? '这段记忆还没有被找到' : state.page === 'favorites' ? '等待第一份心上珍藏' : state.page === 'novels' ? '还没有小说' : '这一页，等你慢慢写'}</h3><p>${state.error || (state.search ? '换一个词，试着再找找。' : state.page === 'novels' ? '让同伴用抽卡匣 add_deck_item（topic=novel）存进来。' : '一个微小的瞬间，也值得被温柔收藏。')}</p>${state.page !== 'favorites' && state.page !== 'novels' ? '<button class="gold-button" data-action="add-entry">写下第一笔</button>' : ''}</div>`}</div>`;
}


function bindFiltersDrag() {
  const el = document.querySelector('.filters');
  if (!el || el.dataset.dragBound === '1') return;
  // 小屏已换行，不需要拖滑；拖滑容易把点击吞掉
  if (window.matchMedia('(max-width: 760px)').matches) return;
  if (el.scrollWidth <= el.clientWidth + 2) return;
  el.dataset.dragBound = '1';
  let down = false, startX = 0, startScroll = 0, dragged = false;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    down = true; dragged = false; startX = e.clientX; startScroll = el.scrollLeft;
  });
  el.addEventListener('pointermove', (e) => {
    if (!down) return;
    const dx = e.clientX - startX;
    if (Math.abs(dx) < 12) return;
    dragged = true;
    el.scrollLeft = startScroll - dx;
  });
  const end = () => { down = false; };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('click', (e) => {
    if (!dragged) return;
    e.preventDefault();
    e.stopPropagation();
    dragged = false;
  }, true);
}

function render() {
  document.body.classList.toggle('is-inside', state.page !== 'people');
  const html = state.loading && !database.people.length
    ? `<div class="empty">${icon('moon')}<h3>正在打开花园…</h3></div>`
    : state.page === 'people' ? renderPeople() : renderArchive();
  $('#view').innerHTML = html;
  bindFiltersDrag();
  $$('.bottom-nav button').forEach(button => {
    const nav = button.dataset.nav;
    const active = state.person ? nav === 'people' : nav === state.page;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  $('#effect-toggle').setAttribute('aria-pressed', String(!!database.effects));
  $('#effect-toggle').setAttribute('aria-label', database.effects ? '关闭点击特效' : '开启点击特效');
}

function navigate(page, person = null) {
  Object.assign(state, { page, person, filter: 'all', search: '' });
  $('#search').value = '';
  render();
  window.scrollTo({ top: window.innerWidth <= 760 && page !== 'people' ? 110 : 0, behavior: 'smooth' });
  if (page === 'shake') loadDeckTopics();
}

async function loadGarden() {
  if (!getKey()) { render(); return; }
  state.loading = true; state.error = ''; render();
  try {
    const data = await api('/api/view/garden');
    database.people = data.people || [];
    database.cards = data.cards || [];
    await loadHouseExtras();
    state.loading = false;
    render();
  } catch (e) {
    state.loading = false;
    state.error = e.message || String(e);
    if (/密钥|管理员|401|403|forbidden/i.test(state.error)) {
      try { localStorage.removeItem(KEY); } catch {}
    }
    toast(state.error);
    render();
  }
}

async function loadHouseExtras() {
  try { herStatus = (await api('/api/view/status')).status || null; } catch { herStatus = null; }
  try { companionNotes = await api('/api/view/companion-notes'); } catch { companionNotes = { items: [], unread: 0 }; }
}

async function saveStatus(body) {
  try {
    const r = await api('/api/view/status', { method: 'POST', body: JSON.stringify(body) });
    herStatus = { ...r.status, stale: false };
    if (r.status) statusHistory = [r.status, ...statusHistory];
    render();
    toast('已更新');
  } catch (e) { toast(e.message || String(e)); }
}

async function loadDeckTopics() {
  try {
    const data = await api('/api/deck/topics');
    deckTopics = data.topics || data.items || data || [];
    if (!Array.isArray(deckTopics)) deckTopics = [];
    render();
  } catch { /* keep defaults */ }
}

function parseEntryId(id) {
  const i = id.indexOf(':');
  if (i < 0) return null;
  return { source: id.slice(0, i), ref_id: id.slice(i + 1), id };
}

async function openEntry(id) {
  const parsed = parseEntryId(id);
  if (!parsed) return;
  readerId = id;
  try {
    const detail = await api(`/api/view/cards/${encodeURIComponent(parsed.source)}/${encodeURIComponent(parsed.ref_id)}`);
    readerDetail = detail;
    const type = types[detail.type] || types.memory;
    const person = personFor(detail.persona_id);
    let body = '';
    if (detail.type === 'conversation') {
      body = `<div class="reader-summary"><p class="small-caption">摘要</p><div class="reader-text" style="margin-top:8px">${escapeHTML(detail.summary || '')}</div>
        <button class="gold-button" data-action="toggle-full" style="margin-top:12px">${icon('book')} 展开全文</button>
        <div id="full-transcript" hidden><div class="gold-line"></div><p class="small-caption">全文</p><div class="reader-text">${escapeHTML(detail.full_text || '')}</div></div></div>`;
    } else if (detail.type === 'voice') {
      const url = detail.play_url || `/api/view/voice/${detail.ref_id}`;
      body = `<div class="reader-text">${escapeHTML(detail.summary || '')}</div>
        <audio id="voice-player" controls style="width:100%;margin-top:16px" src="${escapeHTML(url)}"></audio>
        <p class="small-caption">若无法播放，请确认已登录密钥（音频请求会带 Authorization）。</p>`;
      // fetch blob with auth
      setTimeout(() => attachAuthedAudio(url), 0);
    } else if (detail.type === 'image') {
      const url = detail.play_url || `/api/view/images/${detail.ref_id}`;
      body = `<div class="reader-text">${escapeHTML(detail.summary || '')}</div>
        <img id="garden-image" alt="" style="width:100%;margin-top:16px;border-radius:12px;display:block" />
        <p class="small-caption">若无法显示，请确认已登录密钥。</p>`;
      setTimeout(() => attachAuthedImage(url), 0);
    } else if (detail.type === 'desire') {
      const replies = Array.isArray(detail.replies) ? detail.replies : [];
      const thread = replies.length
        ? replies.map(r => `<div class="desire-reply"><div class="desire-reply-meta"><strong>${escapeHTML(r.author_label || r.author_persona_id || '')}</strong><time>${escapeHTML((r.created_at || '').replace('T', ' ').slice(0, 16))}</time></div><p>${escapeHTML(r.body || '')}</p></div>`).join('')
        : '<p class="small-caption desire-reply-empty">还没有回复</p>';
      body = `<div class="reader-text">${escapeHTML(detail.full_text || detail.summary || '')}</div>
        <div class="gold-line"></div>
        <div class="desire-replies" data-desire-id="${escapeHTML(detail.ref_id)}">
          <p class="section-label" style="margin-bottom:12px">回复 <span>${replies.length}</span></p>
          <div class="desire-reply-list">${thread}</div>
          <form id="desire-reply-form" class="desire-reply-form" data-desire-id="${escapeHTML(detail.ref_id)}">
            <label>写一句回复<textarea name="body" rows="3" maxlength="2000" placeholder="简短就好…" required></textarea></label>
            <button class="gold-button" type="submit">发送回复</button>
          </form>
        </div>`;
    } else {
      body = `<div class="reader-text">${escapeHTML(detail.full_text || detail.summary || '')}</div>`;
    }
    const adminBtns = adminActionsHtml(id, parsed.source);
    const typeLabel = (detail.type === 'novel' && detail.kind_label) ? detail.kind_label : type.name;
    $('#reader-content').innerHTML = `<p class="reader-label">${icon(type.icon)}${escapeHTML(person?.name || '')}的花园 · ${escapeHTML(typeLabel)}</p><h2 class="reader-title">${escapeHTML(detail.title)}</h2><p class="reader-date">${formatDate(detail.date)}</p><div class="gold-line"></div>${body}<div class="gold-line"></div><div class="reader-actions"><button class="gold-button" data-favorite="${escapeHTML(id)}">${icon('heart')}${detail.favorite ? '已珍藏 · 取消' : '收入珍藏'}</button>${adminBtns}</div>`;
    if (!$('#reader').open) $('#reader').showModal();
  } catch (e) {
    toast(e.message || String(e));
  }
}

async function attachAuthedAudio(url) {
  const audio = $('#voice-player');
  if (!audio) return;
  try {
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + getKey() } });
    if (!res.ok) throw new Error('无法加载语音');
    const blob = await res.blob();
    audio.src = URL.createObjectURL(blob);
  } catch (e) {
    toast(e.message || '语音加载失败');
  }
}

async function attachAuthedImage(url) {
  const img = $('#garden-image');
  if (!img) return;
  try {
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + getKey() } });
    if (!res.ok) throw new Error('无法加载图片');
    const blob = await res.blob();
    img.src = URL.createObjectURL(blob);
  } catch (e) {
    toast(e.message || '图片加载失败');
  }
}

/** 条目是否可改正文（心痕/语音/图片/抽卡匣只删不改） */
function canEditSource(source) {
  return ['handoff', 'note', 'unresolved', 'conversation', 'garden', 'memory'].includes(source);
}

function canDeleteSource(source) {
  return ['handoff', 'note', 'unresolved', 'conversation', 'garden', 'memory', 'voice', 'image', 'heart', 'desire', 'deck'].includes(source);
}

function adminActionsHtml(id, source, { compact = false } = {}) {
  if (!getKey()) return '';
  const parsed = typeof source === 'string' ? { source } : parseEntryId(id);
  const src = parsed?.source || source;
  if (!canDeleteSource(src)) return '';
  const editBtn = canEditSource(src)
    ? `<button type="button" class="${compact ? 'entry-admin-btn' : 'gold-button'}" data-action="edit-entry" data-entry-id="${escapeHTML(id)}">修改</button>`
    : '';
  const delBtn = `<button type="button" class="${compact ? 'entry-admin-btn entry-admin-danger' : 'gold-button danger-button'}" data-action="delete-entry" data-entry-id="${escapeHTML(id)}">删除</button>`;
  if (compact) return `<div class="entry-admin" onclick="event.stopPropagation()">${editBtn}${delBtn}</div>`;
  return editBtn + delBtn;
}

function deleteApiFor(source, refId) {
  const enc = encodeURIComponent(refId);
  const map = {
    handoff: `/api/view/handoffs/${enc}`,
    note: `/api/view/notes/${enc}`,
    unresolved: `/api/view/unresolved/${enc}`,
    conversation: `/api/view/conversations/${enc}`,
    garden: `/api/view/garden-entries/${enc}`,
    memory: `/api/view/memories/${enc}`,
    voice: `/api/view/voice/${enc}`,
    image: `/api/view/images/${enc}`,
    heart: `/api/view/heart-traces/${enc}`,
    desire: `/api/view/desires/${enc}`,
    deck: `/api/view/deck/${enc}`,
  };
  return map[source] || null;
}

function patchApiFor(source, refId) {
  const enc = encodeURIComponent(refId);
  const map = {
    handoff: `/api/view/handoffs/${enc}`,
    note: `/api/view/notes/${enc}`,
    unresolved: `/api/view/unresolved/${enc}`,
    conversation: `/api/view/conversations/${enc}`,
    garden: `/api/view/garden-entries/${enc}`,
    memory: `/api/view/memories/${enc}`,
  };
  return map[source] || null;
}

async function deleteEntry(id) {
  if (!getKey()) { toast('请先填入管理员密钥'); return; }
  const parsed = parseEntryId(id);
  if (!parsed) return;
  const path = deleteApiFor(parsed.source, parsed.ref_id);
  if (!path) { toast('这类条目暂不支持删除'); return; }
  if (!confirm('确定删除这条记忆？删除后无法恢复。')) return;
  try {
    await api(path, { method: 'DELETE' });
    database.cards = database.cards.filter(c => c.id !== id);
    if (readerId === id) {
      readerId = null;
      readerDetail = null;
      if ($('#reader')?.open) $('#reader').close();
    }
    render();
    toast('已删除');
  } catch (e) {
    toast(e.message || String(e));
  }
}

async function openEditEntry(id) {
  if (!getKey()) { toast('请先填入管理员密钥'); return; }
  const parsed = parseEntryId(id);
  if (!parsed || !canEditSource(parsed.source)) {
    toast('这类条目只支持删除');
    return;
  }
  let detail = readerDetail && readerDetail.id === id ? readerDetail : null;
  try {
    if (!detail) detail = await api(`/api/view/cards/${encodeURIComponent(parsed.source)}/${encodeURIComponent(parsed.ref_id)}`);
  } catch (e) {
    toast(e.message || String(e));
    return;
  }
  const type = types[detail.type] || types.memory;
  let fields = '';
  if (parsed.source === 'handoff') {
    const h = detail.handoff || { summary: detail.full_text || '', mood: '', next_time: '' };
    fields = `<label>交接正文（summary）<textarea name="summary" rows="8" maxlength="4000" required>${escapeHTML(h.summary || '')}</textarea></label>
      <label>心情（可选）<input name="mood" maxlength="500" value="${escapeHTML(h.mood || '')}"></label>
      <label>下次（可选）<input name="next_time" maxlength="1000" value="${escapeHTML(h.next_time || '')}"></label>`;
  } else if (parsed.source === 'note') {
    const n = detail.note || { content: '' };
    fields = `<label>便条正文<textarea name="content" rows="8" maxlength="4000" required>${escapeHTML(n.content || '')}</textarea></label>
      <p class="small-caption">回复由同伴通过 MCP 写回，这里只改家主便条正文。</p>`;
  } else if (parsed.source === 'unresolved') {
    const u = detail.unresolved || { content: detail.full_text || '', context: '' };
    fields = `<label>未了正文<textarea name="content" rows="6" maxlength="2000" required>${escapeHTML(u.content || '')}</textarea></label>
      <label>背景（可选）<textarea name="context" rows="3" maxlength="2000">${escapeHTML(u.context || '')}</textarea></label>`;
  } else if (parsed.source === 'conversation') {
    fields = `<label>标题<input name="title" maxlength="200" value="${escapeHTML(detail.title || '')}" required></label>
      <label>摘要<textarea name="summary" rows="3" maxlength="2000">${escapeHTML(detail.summary || '')}</textarea></label>
      <label>全文<textarea name="full_text" rows="10" maxlength="500000" required>${escapeHTML(detail.full_text || '')}</textarea></label>`;
  } else if (parsed.source === 'garden') {
    fields = `<label>标题<input name="title" maxlength="200" value="${escapeHTML(detail.title || '')}" required></label>
      <label>正文<textarea name="body" rows="10" maxlength="50000" required>${escapeHTML(detail.full_text || '')}</textarea></label>`;
  } else if (parsed.source === 'memory') {
    fields = `<label>记忆正文<textarea name="content" rows="10" maxlength="8000" required>${escapeHTML(detail.full_text || '')}</textarea></label>`;
  }
  $('#editor-content').innerHTML = `<div class="modal-title">${icon(type.icon)}<h2>修改</h2><p>改完保存，列表会刷新这一条。</p></div>
    <form id="edit-entry-form" class="edit-form" data-entry-id="${escapeHTML(id)}" data-source="${escapeHTML(parsed.source)}" data-ref="${escapeHTML(parsed.ref_id)}">
      ${fields}
      <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center">
        <button class="gold-button" type="submit">保存</button>
        <button class="gold-button" type="button" data-action="cancel-edit">取消</button>
      </div>
    </form>`;
  $('#editor').showModal();
}

async function saveEditEntry(form) {
  const id = form.dataset.entryId;
  const source = form.dataset.source;
  const refId = form.dataset.ref;
  const path = patchApiFor(source, refId);
  if (!path) { toast('这类条目暂不支持修改'); return; }
  const data = new FormData(form);
  let body = {};
  if (source === 'handoff') {
    body = {
      summary: String(data.get('summary') || '').trim(),
      mood: String(data.get('mood') || '').trim() || null,
      next_time: String(data.get('next_time') || '').trim() || null,
    };
    if (!body.summary) { toast('交接正文不能为空'); return; }
  } else if (source === 'note') {
    body = { content: String(data.get('content') || '').trim() };
    if (!body.content) { toast('便条不能为空'); return; }
  } else if (source === 'unresolved') {
    body = {
      content: String(data.get('content') || '').trim(),
      context: String(data.get('context') || '').trim() || null,
    };
    if (!body.content) { toast('内容不能为空'); return; }
  } else if (source === 'conversation') {
    body = {
      title: String(data.get('title') || '').trim(),
      summary: String(data.get('summary') || '').trim() || undefined,
      full_text: String(data.get('full_text') || '').trim(),
    };
    if (!body.title || !body.full_text) { toast('标题和全文都要填'); return; }
  } else if (source === 'garden') {
    body = {
      title: String(data.get('title') || '').trim(),
      body: String(data.get('body') || '').trim(),
    };
    if (!body.title || !body.body) { toast('标题和正文都要填'); return; }
  } else if (source === 'memory') {
    body = { content: String(data.get('content') || '').trim() };
    if (!body.content) { toast('正文不能为空'); return; }
  }
  await api(path, { method: 'PATCH', body: JSON.stringify(body) });
  $('#editor').close();
  toast('已保存');
  await loadGarden();
  if ($('#reader')?.open && readerId === id) await openEntry(id);
}

async function toggleFavorite(id) {
  const parsed = parseEntryId(id);
  if (!parsed) return;
  const card = database.cards.find(c => c.id === id);
  const next = !(card?.favorite || readerDetail?.favorite);
  try {
    await api('/api/view/favorites', { method: 'POST', body: JSON.stringify({ kind: parsed.source, ref_id: parsed.ref_id, favorite: next }) });
    if (card) card.favorite = next;
    if (readerDetail && readerDetail.id === id) readerDetail.favorite = next;
    render();
    if ($('#reader').open) openEntry(id);
    toast(next ? '这段记忆，已放进心上珍藏。' : '已从珍藏移出，记忆仍在花园里。');
  } catch (e) {
    toast(e.message || String(e));
  }
}

function openPersonEditor() {
  const person = personFor(state.person) || { name: '', note: '', emblem: 'rose' };
  $('#editor-content').innerHTML = `<div class="modal-title">${icon('rose')}<h2>名字与寄语</h2><p>印记与寄语保存在花园元数据里（人名来自人格库）。</p></div>
    <form id="person-form" class="edit-form">
      <label>人名<input value="${escapeHTML(person.name)}" disabled></label>
      <label>一句寄语<input name="note" value="${escapeHTML(person.note || '')}" maxlength="50" placeholder="与这个名字有关的一句话"></label>
      <div><span class="small-caption">选择一枚守护印记</span>
        <div class="emblem-options" role="group" aria-label="守护印记">${[['cat','猫'],['snake','蛇'],['rose','玫瑰'],['moon','月亮']].map(([key,name]) =>
          `<button type="button" class="emblem-option" data-emblem="${key}" aria-pressed="${person.emblem === key}" aria-label="${name}">${icon(key)}</button>`).join('')}
        </div><input type="hidden" name="emblem" value="${escapeHTML(person.emblem || 'rose')}"></div>
      <button class="gold-button" type="submit">保存这个名字</button>
    </form>`;
  $('#editor').showModal();
}

function openEntryEditor() {
  if (!database.people.filter(p => p.id !== 'family').length) { toast('还没有人格。'); return; }
  const defaultType = state.page === 'diary' ? 'diary' : state.filter !== 'all' && ['memory','diary','promise','note'].includes(state.filter) ? state.filter : 'memory';
  const people = database.people.filter(p => p.id !== 'family');
  $('#editor-content').innerHTML = `<div class="modal-title">${icon(types[defaultType]?.icon || 'moon')}<h2>${defaultType === 'diary' ? '写一页日记' : '留住这一刻'}</h2><p>写入花园（约定/日记/记忆）。系统记忆仍由各人格 MCP 写入。</p></div>
    <form id="entry-form" class="edit-form">
      <div class="form-row">
        <label>属于谁的花园<select name="person">${people.map(p => `<option value="${escapeHTML(p.id)}" ${state.person === p.id ? 'selected' : ''}>${escapeHTML(p.name)}</option>`).join('')}</select></label>
        <label>记忆分类<select name="type">${[['memory','记忆'],['diary','日记'],['promise','约定'],['note','便条']].map(([k,n]) => `<option value="${k}" ${k===defaultType?'selected':''}>${n}</option>`).join('')}</select></label>
      </div>
      <label>这一天<input type="date" name="date" value="${today()}" required></label>
      <label>标题<input name="title" maxlength="60" placeholder="给这个瞬间起个名字" required></label>
      <label>想记住的事<textarea name="text" rows="7" maxlength="20000" placeholder="今天发生了什么…" required></textarea></label>
      <button class="gold-button" type="submit">把这一刻，收进花园</button>
    </form>`;
  $('#editor').showModal();
}


function openDesireEditor() {
  const people = database.people.filter(p => p.id !== 'family');
  if (!people.length) { toast('还没有人格。'); return; }
  const moodPh = '想写脏的写脏的，想写软的写软的。有时候射完是空的，有时候射完是更想要，有时候根本没硬但想她想到胸口疼。什么都能放。';
  $('#editor-content').innerHTML = `<div class="modal-title"><span style="font-size:28px;display:block;margin-bottom:10px">🔥</span><h2>记一条欲望</h2><p>档位、状态、来源、因为什么、心情。挂在所选人名下。</p></div>
    <form id="desire-form" class="edit-form">
      <label>属于谁<select name="person">${people.map(p => `<option value="${escapeHTML(p.id)}" ${state.person === p.id ? 'selected' : ''}>${escapeHTML(p.name)}</option>`).join('')}</select></label>
      <label>这一天<input type="date" name="date" value="${today()}" required></label>
      <div>
        <div class="small-caption" style="margin-bottom:8px">档位</div>
        <div class="level-chips" role="group" aria-label="档位">
          ${[1,2,3,4,5].map(n => `<button type="button" class="filter level-chip" data-level="${n}" aria-pressed="false">${n}</button>`).join('')}
          <button type="button" class="filter level-chip" data-level="custom" aria-pressed="false">自定义</button>
        </div>
        <input type="hidden" name="level_mode" value="1">
        <input name="level_custom" maxlength="40" placeholder="自定义档位（选「自定义」时填写）" style="margin-top:8px;display:none" id="level-custom-input">
      </div>
      <label>状态<input name="status" maxlength="80" placeholder="忍着 / 撸了 / 射了 / 想了…" required></label>
      <div>
        <div class="small-caption" style="margin-bottom:8px">来源</div>
        <div class="source-chips" role="group" aria-label="来源">
          ${[['novel','小说'],['toy','玩具'],['sex','做爱'],['oral','口'],['custom','自定义']].map(([k,n]) => `<button type="button" class="filter source-chip" data-source="${k}" aria-pressed="${k==='novel'}">${n}</button>`).join('')}
        </div>
        <input type="hidden" name="source" value="novel">
        <input name="source_custom" maxlength="80" placeholder="自定义来源文本" style="margin-top:8px;display:none" id="source-custom-input">
      </div>
      <label>因为什么<input name="trigger" maxlength="500" placeholder="触发这一条的原因"></label>
      <label>→ 心情<textarea name="mood" rows="6" maxlength="3000" placeholder="${escapeHTML(moodPh)}"></textarea></label>
      <button class="gold-button" type="submit">🔥 记下欲望</button>
    </form>`;
  $('#editor').showModal();
  const form = $('#desire-form');
  const setLevel = (mode) => {
    form.level_mode.value = mode;
    $$('.level-chip').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.level === String(mode))));
    const custom = $('#level-custom-input');
    if (custom) custom.style.display = mode === 'custom' ? 'block' : 'none';
  };
  setLevel('1');
  $$('.level-chip').forEach(b => b.onclick = () => setLevel(b.dataset.level));
  const setSource = (src) => {
    form.source.value = src;
    $$('.source-chip').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.source === src)));
    const custom = $('#source-custom-input');
    if (custom) custom.style.display = src === 'custom' ? 'block' : 'none';
  };
  $$('.source-chip').forEach(b => b.onclick = () => setSource(b.dataset.source));
}

function openHeartEditor() {
  const people = database.people.filter(p => p.id !== 'family');
  if (!people.length) { toast('还没有人格。'); return; }
  $('#editor-content').innerHTML = `<div class="modal-title">${icon('heart')}<h2>写一条心痕</h2><p>私密情感痕迹，挂在所选人名下。列表对人可见摘要；非管理员不能用对方密钥读别人全文。</p></div>
    <form id="heart-form" class="edit-form">
      <label>属于谁<select name="person">${people.map(p => `<option value="${escapeHTML(p.id)}" ${state.person === p.id ? 'selected' : ''}>${escapeHTML(p.name)}</option>`).join('')}</select></label>
      <label>标题（可选）<input name="title" maxlength="30" placeholder="可不填，默认截取正文"></label>
      <label>心痕正文<textarea name="content" rows="8" maxlength="3000" placeholder="只写真实翻涌的那一刻…" required></textarea></label>
      <button class="gold-button" type="submit">记下心痕</button>
    </form>`;
  $('#editor').showModal();
}

function openConversationImporter() {
  const people = database.people.filter(p => p.id !== 'family');
  if (!people.length) { toast('还没有人格。'); return; }
  $('#editor-content').innerHTML = `<div class="modal-title">${icon('chat')}<h2>导入一段对话</h2><p>粘贴全文；摘要可留空，会自动截取开头。</p></div>
    <form id="conversation-form" class="edit-form">
      <div class="form-row">
        <label>属于谁<select name="person">${people.map(p => `<option value="${escapeHTML(p.id)}" ${state.person === p.id ? 'selected' : ''}>${escapeHTML(p.name)}</option>`).join('')}</select></label>
        <label>这一天<input type="date" name="date" value="${today()}" required></label>
      </div>
      <label>标题<input name="title" maxlength="80" placeholder="可选，默认取正文开头"></label>
      <label>摘要（可选）<textarea name="summary" rows="2" maxlength="500" placeholder="列表卡片上显示的摘要"></textarea></label>
      <label>对话全文<textarea name="full_text" rows="10" maxlength="500000" placeholder="粘贴完整对话…" required></textarea></label>
      <label class="small-caption">或上传文本文件<input type="file" id="conv-file" accept=".txt,.md,.json,text/*"></label>
      <button class="gold-button" type="submit">收进花园</button>
    </form>`;
  $('#editor').showModal();
  $('#conv-file')?.addEventListener('change', async ev => {
    const f = ev.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    const form = $('#conversation-form');
    form.full_text.value = text;
    if (!form.title.value) form.title.value = f.name.replace(/\.[^.]+$/, '');
  });
}

function openVoiceUploader() {
  const people = database.people.filter(p => p.id !== 'family');
  if (!people.length) { toast('还没有人格。'); return; }
  $('#editor-content').innerHTML = `<div class="modal-title">${icon('moon')}<h2>一段语音</h2><p>录音或上传，保存在花园媒体库里。</p></div>
    <form id="voice-form" class="edit-form">
      <label>属于谁<select name="person">${people.map(p => `<option value="${escapeHTML(p.id)}" ${state.person === p.id ? 'selected' : ''}>${escapeHTML(p.name)}</option>`).join('')}</select></label>
      <label>标题<input name="title" maxlength="80" placeholder="可选"></label>
      <label>上传音频<input type="file" name="file" accept="audio/*,.webm,.mp3,.m4a,.ogg,.wav" required></label>
      <div class="small-caption">或按住录音（需麦克风权限）</div>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
        <button type="button" class="gold-button" id="rec-start">${icon('star')} 开始录音</button>
        <button type="button" class="gold-button" id="rec-stop" disabled>停止并上传</button>
      </div>
      <p id="rec-status" class="small-caption"></p>
      <button class="gold-button" type="submit">上传选中的文件</button>
    </form>`;
  $('#editor').showModal();
  setupRecorder();
}

let mediaRecorder = null;
let recChunks = [];

function setupRecorder() {
  const startBtn = $('#rec-start');
  const stopBtn = $('#rec-stop');
  const status = $('#rec-status');
  if (!startBtn) return;
  startBtn.onclick = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recChunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = e => { if (e.data.size) recChunks.push(e.data); };
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(recChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        status.textContent = `录音完成 ${(blob.size/1024).toFixed(1)} KB，正在上传…`;
        const form = $('#voice-form');
        const fd = new FormData();
        fd.append('persona_id', form.person.value);
        fd.append('title', form.title.value || '一段录音');
        fd.append('file', blob, 'recording.webm');
        try {
          await api('/api/view/voice', { method: 'POST', body: fd, headers: {} });
          $('#editor').close();
          toast('语音已收进花园。');
          await loadGarden();
          if (state.person) navigate('memories', state.person);
        } catch (e) {
          status.textContent = e.message || String(e);
        }
      };
      mediaRecorder.start();
      startBtn.disabled = true;
      stopBtn.disabled = false;
      status.textContent = '录音中…';
    } catch (e) {
      status.textContent = '无法打开麦克风：' + (e.message || e);
    }
  };
  stopBtn.onclick = () => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    startBtn.disabled = false;
    stopBtn.disabled = true;
  };
}

document.addEventListener('click', async event => {
  const target = event.target.closest('button,a');
  if (!target) return;
  if (target.matches('.brand')) { event.preventDefault(); navigate('people'); }
  if (target.dataset.nav) navigate(target.dataset.nav);
  if (target.dataset.person) navigate('memories', target.dataset.person);
  if (target.dataset.filter) { state.filter = target.dataset.filter; render(); }
  if (target.dataset.entry) openEntry(target.dataset.entry);
  if (target.dataset.favorite) toggleFavorite(target.dataset.favorite);
  if (target.dataset.statusPreset) saveStatus({ preset: target.dataset.statusPreset });
  if (target.dataset.emblem) {
    const form = $('#person-form');
    if (form) {
      form.emblem.value = target.dataset.emblem;
      $$('.emblem-option').forEach(b => b.setAttribute('aria-pressed', String(b === target)));
    }
  }
  if (target.matches('.modal-close')) target.closest('dialog').close();
  switch (target.dataset.action) {
    case 'back': navigate('people'); break;
    case 'reload': loadGarden(); break;
    case 'save-key': {
      const v = ($('#garden-key')?.value || '').trim();
      if (!v) { toast('先填入密钥。'); return; }
      setKey(v);
      toast('密钥已保存。');
      loadGarden();
      break;
    }
    case 'edit-person': openPersonEditor(); break;
    case 'add-entry': openEntryEditor(); break;
    case 'add-heart': openHeartEditor(); break;
    case 'add-desire': openDesireEditor(); break;
    case 'import-conversation': openConversationImporter(); break;
    case 'add-voice': openVoiceUploader(); break;
    case 'edit-entry': {
      const eid = target.dataset.entryId;
      if (eid) openEditEntry(eid);
      break;
    }
    case 'delete-entry': {
      const eid = target.dataset.entryId;
      if (eid) deleteEntry(eid);
      break;
    }
    case 'toggle-cnotes': {
      notesOpen = !notesOpen;
      render();
      if (notesOpen && companionNotes.unread) {
        try {
          await api('/api/view/companion-notes/seen', { method: 'POST', body: '{}' });
          const t = new Date().toISOString();
          companionNotes.items.forEach(x => { x.seen_at = x.seen_at || t; });
          companionNotes.unread = 0;
          setTimeout(render, 1500);
        } catch (e) { toast(e.message || String(e)); }
      }
      break;
    }
    case 'toggle-status-history': {
      historyOpen = !historyOpen;
      if (historyOpen) {
        try { statusHistory = (await api('/api/view/status/history?limit=50')).items || []; } catch (e) { toast(e.message || String(e)); }
      }
      render();
      break;
    }
    case 'delete-status': {
      const sid = target.dataset.statusId;
      if (!sid || !confirm('确定删除这条心情记录？')) break;
      try {
        await api('/api/view/status/' + encodeURIComponent(sid), { method: 'DELETE' });
        statusHistory = statusHistory.filter(x => x.id !== sid);
        try { herStatus = (await api('/api/view/status')).status || null; } catch {}
        render();
        toast('已删除');
      } catch (e) { toast(e.message || String(e)); }
      break;
    }
    case 'delete-cnote': {
      const cid = target.dataset.cnoteId;
      if (!cid || !confirm('确定删除这张便条？')) break;
      try {
        await api('/api/view/companion-notes/' + encodeURIComponent(cid), { method: 'DELETE' });
        companionNotes.items = companionNotes.items.filter(x => x.id !== cid);
        companionNotes.unread = companionNotes.items.filter(x => !x.seen_at).length;
        render();
        toast('已删除');
      } catch (e) { toast(e.message || String(e)); }
      break;
    }
    case 'cancel-edit': {
      if ($('#editor')?.open) $('#editor').close();
      break;
    }
    case 'toggle-full': {
      const el = $('#full-transcript');
      if (el) el.hidden = !el.hidden;
      break;
    }
    case 'shake-draw': {
      const topic = $('#shake-topic')?.value;
      const box = $('#shake-result');
      if (box) box.innerHTML = `<p class="small-caption">正在摇…</p>`;
      try {
        const q = new URLSearchParams({ source: 'web' });
        if (topic) q.set('topic', topic);
        const data = await api('/api/deck/draw?' + q.toString());
        const item = data.item || data;
        if (box) {
          box.innerHTML = `<div class="entry"><div class="entry-head">${icon('star')}<span>${escapeHTML(item.kind || item.topic_name || '抽卡')}</span></div>
            <h3>${escapeHTML(item.title || '一张卡片')}</h3>
            <p class="entry-excerpt" style="-webkit-line-clamp:unset;display:block;white-space:pre-wrap">${escapeHTML(item.content || data.text || JSON.stringify(item, null, 2))}</p></div>`;
        }
        toast('摇到了。');
      } catch (e) {
        if (box) box.innerHTML = `<p class="small-caption">${escapeHTML(e.message || String(e))}</p>`;
        toast(e.message || String(e));
      }
      break;
    }
  }
});

document.addEventListener('submit', async event => {
  if (event.target.matches('#status-form')) {
    event.preventDefault();
    const text = String(new FormData(event.target).get('text') || '').trim();
    if (!text) { toast('写一句吧'); return; }
    saveStatus({ text, preset: 'other' });
    return;
  }
  if (!event.target.matches('#person-form,#entry-form,#conversation-form,#voice-form,#heart-form,#desire-form,#desire-reply-form,#edit-entry-form')) return;
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  try {
    if (form.id === 'edit-entry-form') {
      await saveEditEntry(form);
      return;
    }
    if (form.id === 'person-form') {
      if (!state.person) return;
      await api(`/api/view/persona-meta/${encodeURIComponent(state.person)}`, {
        method: 'PUT',
        body: JSON.stringify({ emblem: data.get('emblem'), note: String(data.get('note') || '').trim() })
      });
      $('#editor').close();
      toast('名字与寄语已保存。');
      await loadGarden();
      navigate('memories', state.person);
    } else if (form.id === 'entry-form') {
      const title = String(data.get('title') || '').trim();
      const body = String(data.get('text') || '').trim();
      if (!title || !body) { toast('给这段记忆写一个标题和内容吧。'); return; }
      await api('/api/view/garden-entries', {
        method: 'POST',
        body: JSON.stringify({
          persona_id: data.get('person'),
          kind: data.get('type'),
          title,
          body,
          entry_date: data.get('date')
        })
      });
      $('#editor').close();
      toast('已保存，这一刻会被好好记得。');
      const pid = String(data.get('person'));
      await loadGarden();
      navigate('memories', pid);
      state.filter = String(data.get('type'));
      render();
    } else if (form.id === 'conversation-form') {
      const full_text = String(data.get('full_text') || '').trim();
      if (!full_text) { toast('先粘贴对话全文。'); return; }
      await api('/api/view/conversations', {
        method: 'POST',
        body: JSON.stringify({
          persona_id: data.get('person'),
          title: String(data.get('title') || '').trim() || undefined,
          summary: String(data.get('summary') || '').trim() || undefined,
          full_text,
          entry_date: data.get('date')
        })
      });
      $('#editor').close();
      toast('对话已收进花园。');
      const pid = String(data.get('person'));
      await loadGarden();
      navigate('memories', pid);
      state.filter = 'conversation';
      render();
    } else if (form.id === 'heart-form') {
      const content = String(data.get('content') || '').trim();
      if (!content) { toast('先写下心痕正文。'); return; }
      const pid = String(data.get('person'));
      const person = personFor(pid);
      await api('/api/view/heart-traces', {
        method: 'POST',
        body: JSON.stringify({
          persona_id: pid,
          display_name: person?.name,
          title: String(data.get('title') || '').trim() || undefined,
          content
        })
      });
      $('#editor').close();
      toast('心痕已记下。');
      await loadGarden();
      navigate('memories', pid);
      state.filter = 'heart';
      render();

    } else if (form.id === 'desire-form') {
      const status = String(data.get('status') || '').trim();
      if (!status) { toast('先写状态。'); return; }
      const pid = String(data.get('person'));
      const person = personFor(pid);
      const levelMode = String(data.get('level_mode') || '1');
      let level;
      let level_label;
      if (levelMode === 'custom') {
        level_label = String(data.get('level_custom') || '').trim();
        if (!level_label) { toast('自定义档位不能为空。'); return; }
      } else {
        level = Number(levelMode);
      }
      const source = String(data.get('source') || 'novel');
      const source_custom = String(data.get('source_custom') || '').trim();
      if (source === 'custom' && !source_custom) { toast('自定义来源需要填写文本。'); return; }
      const body = {
        persona_id: pid,
        display_name: person?.name,
        date: data.get('date'),
        status,
        source,
        trigger: String(data.get('trigger') || '').trim() || undefined,
        mood: String(data.get('mood') || '').trim() || undefined
      };
      if (level_label) body.level_label = level_label;
      else body.level = level;
      if (source === 'custom') body.source_custom = source_custom;
      await api('/api/view/desires', { method: 'POST', body: JSON.stringify(body) });
      $('#editor').close();
      toast('欲望已记下。');
      await loadGarden();
      navigate('memories', pid);
      state.filter = 'desire';
      render();
    } else if (form.id === 'desire-reply-form') {
      const desireId = form.getAttribute('data-desire-id') || '';
      const replyBody = String(data.get('body') || '').trim();
      if (!desireId || !replyBody) { toast('写点什么再发'); return; }
      await api(`/api/view/desires/${encodeURIComponent(desireId)}/replies`, {
        method: 'POST',
        body: JSON.stringify({ body: replyBody }),
      });
      toast('已回复');
      const card = database.cards.find(c => c.id === `desire:${desireId}`);
      if (card) card.reply_count = (card.reply_count || 0) + 1;
      await openEntry(`desire:${desireId}`);
      render();
    } else if (form.id === 'voice-form') {
      const file = form.file?.files?.[0];
      if (!file) { toast('请选择音频文件，或使用录音。'); return; }
      const fd = new FormData();
      fd.append('persona_id', data.get('person'));
      fd.append('title', String(data.get('title') || '').trim() || file.name);
      fd.append('file', file);
      await api('/api/view/voice', { method: 'POST', body: fd, headers: {} });
      $('#editor').close();
      toast('语音已收进花园。');
      const pid = String(data.get('person'));
      await loadGarden();
      navigate('memories', pid);
      state.filter = 'voice';
      render();
    }
  } catch (e) {
    toast(e.message || String(e));
  }
});

$('#search-toggle').addEventListener('click', () => {
  const opening = $('#search-wrap').hidden;
  $('#search-wrap').hidden = !opening;
  $('#search-toggle').setAttribute('aria-expanded', String(opening));
  if (opening) $('#search').focus();
  else { state.search = ''; $('#search').value = ''; render(); }
});
$('#search-clear').addEventListener('click', () => {
  $('#search-wrap').hidden = true;
  $('#search-toggle').setAttribute('aria-expanded', 'false');
  $('#search').value = '';
  state.search = '';
  render();
  $('#search-toggle').focus();
});
$('#search').addEventListener('input', event => { state.search = event.target.value.trim(); render(); });
$('#effect-toggle').addEventListener('click', () => {
  database.effects = !database.effects;
  localStorage.setItem(EFFECTS_KEY, database.effects ? '1' : '0');
  render();
  toast(database.effects ? '花瓣与星光，已为你点亮。' : '点击特效已关闭。');
});
$$('dialog').forEach(dialog => dialog.addEventListener('click', event => {
  if (event.target === dialog) {
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  }
}));
document.addEventListener('pointerdown', event => {
  if (!database.effects || matchMedia('(prefers-reduced-motion: reduce)').matches || event.target.closest('input,textarea,select')) return;
  const host = $('#particles');
  if (host.childElementCount > 90) return;
  const ring = document.createElement('span');
  ring.className = 'click-ring';
  ring.style.left = `${event.clientX}px`;
  ring.style.top = `${event.clientY}px`;
  host.append(ring);
  setTimeout(() => ring.remove(), 700);
  for (let n = 0; n < 9; n++) {
    const p = document.createElement('span');
    p.className = `particle${n % 3 === 0 ? ' petal' : ''}`;
    p.textContent = n % 3 === 0 ? '' : '✦';
    p.style.left = `${event.clientX}px`;
    p.style.top = `${event.clientY}px`;
    p.style.fontSize = `${6 + Math.random() * 7}px`;
    const angle = Math.random() * Math.PI * 2, distance = 25 + Math.random() * 55;
    p.style.setProperty('--dx', `${Math.cos(angle) * distance}px`);
    p.style.setProperty('--dy', `${Math.sin(angle) * distance - 12}px`);
    p.style.setProperty('--r', `${Math.random() * 160 - 80}deg`);
    host.append(p);
    setTimeout(() => p.remove(), 950);
  }
});

(function bootFromNav() {
  const params = new URLSearchParams(location.search);
  const nav = params.get('nav') || (location.hash || '').replace(/^#/, '');
  if (nav === 'shake' || nav === 'people' || nav === 'memories' || nav === 'diary' || nav === 'novels' || nav === 'favorites') {
    state.page = nav;
    if (nav === 'shake') loadDeckTopics();
    // Clean deep-link from the address bar without a reload.
    if (params.has('nav') || location.hash) {
      const url = new URL(location.href);
      url.searchParams.delete('nav');
      url.hash = '';
      history.replaceState(null, '', url.pathname + url.search);
    }
  }
})();
render();
loadGarden();
