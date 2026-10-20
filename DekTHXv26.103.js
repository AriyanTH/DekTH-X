// DekTH X - Single File Worker (Merged from TS)
// Bindings: DB (D1). Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, ADMIN_POINT_SECRET, WORKER_URL (optional but recommended)

const HOUR = 3600000;
const DAY = 86400000;
const TAX_THRESHOLD = 250;
const TAX_PERCENT = 10;
const PVP_TTL_MS = 10 * 60000;
const GROW_MIN = -10;
const GROW_MAX = 30;
const DAY_PRIZE_MIN = 10;
const DAY_PRIZE_MAX = 50;
const SPECIAL_WINDOW_MS = 12 * HOUR;
const DEFAULT_WIN_TARGET = 500; // Changed from 400 to 500
const TZ = "Asia/Tehran";
const WEBHOOK_PATH = "/telegram/webhook";
const TOP_PAGE_SIZE = 20;
const ANON_ADMIN_BOT_ID = 1087968824;

const POINT_SECRET_MIN_LEN = 16;
const RATE_LIMIT_WINDOW_MS = 15 * 60000;
const RATE_LIMIT_MAX_FAILS = 3;
const PROMPT_TTL_MS = 2 * 60000;

const UPDATE_LEASE_MS = 5 * 60000;
const SETUP_RATE_WINDOW_MS = 15 * 60000;
const SETUP_RATE_MAX = 5;

const ANNIVERSARY_TEXT = `━━━━━━━━━━━━━━━━━━\n🏆🎉 <b>Happy Dek Rankd Anniversary!</b> 🎉🏆\n\n📅 <b>October 25</b>\n🔥 Let the competition continue! ⚔️\n━━━━━━━━━━━━━━━━━━`;

// === Time ===
const fmtCache = new Map();
function getFmt(tz) { let f = fmtCache.get(tz); if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); fmtCache.set(tz, f); } return f; }
function tzOffsetMs(ms, tz = TZ) { const parts = getFmt(tz).formatToParts(new Date(ms)); const g = (t) => Number(parts.find((p) => p.type === t).value); const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second")); return asUtc - Math.floor(ms / 1000) * 1000; }
function localDayId(ms, tz = TZ) { return new Date(ms + tzOffsetMs(ms, tz)).toISOString().slice(0, 10); }
function startOfLocalDay(dayId, tz = TZ) { const [y, m, d] = dayId.split("-").map(Number); const naive = Date.UTC(y, m - 1, d); let guess = naive - tzOffsetMs(naive, tz); guess = naive - tzOffsetMs(guess, tz); return guess; }
function addDays(dayId, n) { const [y, m, d] = dayId.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
function formatRemaining(ms) { const totalMin = Math.max(1, Math.ceil(ms / 60000)); const h = Math.floor(totalMin / 60); const m = totalMin % 60; return `${h}h ${m}m`; }

// === RNG ===
function rand32() { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0]; }
function below(n) { if (n <= 0 || !Number.isSafeInteger(n) || n > 0xffffffff) throw new RangeError("bad range"); const limit = Math.floor(0x100000000 / n) * n; let x = rand32(); while (x >= limit) x = rand32(); return x % n; }
const cryptoRng = {
  int(min, max) { return min + below(max - min + 1); },
  sample(items, k) { const arr = items.slice(); const n = Math.min(k, arr.length); for (let i = 0; i < n; i++) { const j = i + below(arr.length - i); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr.slice(0, n); },
  token() { const b = new Uint8Array(16); crypto.getRandomValues(b); return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""); },
};

// === Text ===
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
const b = (s) => `<b>${esc(s)}</b>`;
const code = (s) => `<code>${esc(s)}</code>`;
function userDisplayName(u) { const full = [u.first_name, u.last_name].filter(Boolean).join(" ").trim(); return (full || u.username || String(u.id)).slice(0, 40); }

// === DB Helpers ===
async function first(db, sql, ...params) { return (await db.prepare(sql).bind(...params).first()) ?? null; }
async function all(db, sql, ...params) { return (await db.prepare(sql).bind(...params).all()).results ?? []; }
async function run(db, sql, ...params) { return (await db.prepare(sql).bind(...params).run()).meta?.changes ?? 0; }
function st(db, sql, ...params) { return db.prepare(sql).bind(...params); }
function countingDb(db, counter) {
  const wrapStmt = (s) => ({ bind: (...v) => wrapStmt(s.bind(...v)), first: (...a) => { counter.used++; return s.first(...a); }, all: () => { counter.used++; return s.all(); }, run: () => { counter.used++; return s.run(); }, raw: (...a) => { counter.used++; return s.raw(...a); }, __inner: s });
  return { prepare: (sql) => wrapStmt(db.prepare(sql)), batch: (stmts) => { counter.used += stmts.length; return db.batch(stmts.map((x) => x.__inner ?? x)); }, exec: (q) => { counter.used++; return db.exec(q); }, dump: () => db.dump(), withSession: (c) => db.withSession(c) };
}
const budgetLeft = (c, need = 1) => c.limit - c.used >= need;

// === Telegram API ===
function createTelegramApi(token, fetchImpl = fetch) {
  async function call(method, body) {
    try {
      const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      let json;
      try { json = await res.json(); } catch { return { ok: false, error: `non-json (${res.status})`, code: res.status }; }
      if (json && json.ok) return { ok: true, result: json.result };
      return { ok: false, error: String(json?.description ?? `http ${res.status}`), code: json?.error_code ?? res.status };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  }
  return {
    sendMessage: (chatId, html, opts) => call("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...opts }),
    editMessageText: (chatId, messageId, html, markup) => call("editMessageText", { chat_id: chatId, message_id: messageId, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: markup ?? { inline_keyboard: [] } }),
    answerCallbackQuery: (id, text, alert) => call("answerCallbackQuery", { callback_query_id: id, text, show_alert: alert ?? false }),
    getChatMember: (chatId, userId) => call("getChatMember", { chat_id: chatId, user_id: userId }),
    deleteMessage: (chatId, messageId) => call("deleteMessage", { chat_id: chatId, message_id: messageId }),
  };
}

async function sendLongMessage(ctx, chatId, text) {
  const MAX_LEN = 4000;
  if (text.length <= MAX_LEN) {
    return await ctx.tg.sendMessage(chatId, text);
  }
  const lines = text.split('\n');
  let current = '';
  const parts = [];
  for (const line of lines) {
    if (current.length + line.length + 1 > MAX_LEN) {
      parts.push(current);
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  if (current) parts.push(current);
  for (const part of parts) {
    await ctx.tg.sendMessage(chatId, part);
    await new Promise(r => setTimeout(r, 300));
  }
}

// === Security ===
function timingSafeEqual(a, b) { const enc = new TextEncoder(), x = enc.encode(a), y = enc.encode(b); let diff = x.length ^ y.length; const n = Math.max(x.length, y.length); for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0); return diff === 0; }
async function logSecurityAttempt(ctx, chatId, userId, action, success) { try { await run(ctx.db, `INSERT INTO point_security_log (chat_id, user_id, action, success, created_at) VALUES (?, ?, ?, ?, ?)`, chatId, userId, String(action).slice(0, 50), success ? 1 : 0, ctx.now()); } catch (e) {} }
async function checkRateLimit(ctx, chatId, userId) { const row = await first(ctx.db, `SELECT COUNT(*) AS c FROM point_security_log WHERE chat_id = ? AND user_id = ? AND success = 0 AND created_at > ?`, chatId, userId, ctx.now() - RATE_LIMIT_WINDOW_MS); return (row?.c ?? 0) < RATE_LIMIT_MAX_FAILS; }
function getRequiredSecret(ctx) { const s = ctx.env?.ADMIN_POINT_SECRET; if (!s || typeof s !== "string" || s.length < POINT_SECRET_MIN_LEN) return null; return s; }

async function checkSetupRateLimit(env, ip) {
  if (!ip || ip === "unknown") return true;
  try { const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM setup_attempts WHERE ip = ? AND success = 0 AND created_at > ?`).bind(ip, Date.now() - SETUP_RATE_WINDOW_MS).first(); return ((row?.c) ?? 0) < SETUP_RATE_MAX; }
  catch { return true; }
}
async function logSetupAttempt(env, ip, success) {
  if (!ip || ip === "unknown") return;
  try { await env.DB.prepare(`INSERT INTO setup_attempts (ip, success, created_at) VALUES (?, ?, ?)`).bind(ip, success ? 1 : 0, Date.now()).run(); } catch (e) {}
}

// === Economy & SQL ===
function lockedExpr(chatExpr, userExpr) { return `(SELECT COALESCE(SUM(p.stake), 0) FROM pvp_matches p WHERE p.chat_id = ${chatExpr} AND ((p.creator_id = ${userExpr} AND p.status IN ('open','accepted')) OR (p.opponent_id = ${userExpr} AND p.status = 'accepted')))`; }
function syncStmt(db, chatId, userId, now) { const next = addDays(localDayId(now), 1); return st(db, `UPDATE members SET tax_start_day = CASE WHEN balance > ? THEN COALESCE(tax_start_day, ?) ELSE NULL END, reached_target_at = CASE WHEN balance >= (SELECT win_target FROM groups g WHERE g.chat_id = members.chat_id) THEN COALESCE(reached_target_at, ?) ELSE NULL END WHERE chat_id = ? AND user_id = ?`, TAX_THRESHOLD, next, now, chatId, userId); }
function syncGroupStmt(db, chatId, now) { const next = addDays(localDayId(now), 1); return st(db, `UPDATE members SET tax_start_day = CASE WHEN balance > ? THEN COALESCE(tax_start_day, ?) ELSE NULL END, reached_target_at = CASE WHEN balance >= (SELECT win_target FROM groups g WHERE g.chat_id = members.chat_id) THEN COALESCE(reached_target_at, ?) ELSE NULL END WHERE chat_id = ?`, TAX_THRESHOLD, next, now, chatId); }
function deltaStmts(db, s) {
  const g = s.guard ?? { sql: "1 = 1", params: [] }; const e = s.extraSet;
  const update = st(db, `UPDATE members SET balance = balance + ?, updated_at = ?${e ? ", " + e.sql : ""} WHERE chat_id = ? AND user_id = ? AND NOT EXISTS (SELECT 1 FROM ledger WHERE op_key = ?) AND (${g.sql})`, s.delta, s.now, ...(e?.params ?? []), s.chatId, s.userId, s.opKey, ...g.params);
  const ledger = st(db, `INSERT INTO ledger (chat_id, user_id, delta, balance_before, balance_after, reason, actor_id, note, op_key, created_at) SELECT ?, ?, ?, m.balance - ?, m.balance, ?, ?, ?, ?, ? FROM members m WHERE m.chat_id = ? AND m.user_id = ? AND changes() > 0`, s.chatId, s.userId, s.delta, s.delta, s.reason, s.actorId ?? null, s.note ?? null, s.opKey, s.now, s.chatId, s.userId);
  return [update, ledger, syncStmt(db, s.chatId, s.userId, s.now)];
}
function exposureCond(alias, dayId) { const a = alias; return { sql: `(${a}.balance > ${TAX_THRESHOLD} AND ${a}.tax_start_day IS NOT NULL AND ${a}.tax_start_day <= ? AND NOT EXISTS (SELECT 1 FROM pvp_matches px WHERE px.chat_id = ${a}.chat_id AND px.status = 'resolved' AND px.resolved_at >= ? AND px.resolved_at < ? AND (px.winner_id = ${a}.user_id OR px.loser_id = ${a}.user_id)))`, params: [dayId, startOfLocalDay(dayId), startOfLocalDay(addDays(dayId, 1))] }; }
function reachedCond(alias, now, days) { const a = alias; return { sql: `(CASE WHEN ${a}.special_active = 1 AND ${a}.special_deadline_at IS NOT NULL THEN ? >= ${a}.special_deadline_at ELSE ? >= ${a}.activity_anchor_at + ? END)`, params: [now, now, days * DAY] }; }
function syncIdsStmt(db, chatId, userIds, now) { const next = addDays(localDayId(now), 1); return st(db, `UPDATE members SET tax_start_day = CASE WHEN balance > ? THEN COALESCE(tax_start_day, ?) ELSE NULL END, reached_target_at = CASE WHEN balance >= (SELECT win_target FROM groups g WHERE g.chat_id = members.chat_id) THEN COALESCE(reached_target_at, ?) ELSE NULL END WHERE chat_id = ? AND user_id IN (${userIds.map(() => "?").join(",")})`, TAX_THRESHOLD, next, now, chatId, ...userIds); }
const ACTIVE_NOT_BLOCKED = { sql: `EXISTS (SELECT 1 FROM groups g WHERE g.chat_id = members.chat_id AND g.status = 'active') AND NOT EXISTS (SELECT 1 FROM blocks bl WHERE bl.chat_id = members.chat_id AND bl.user_id = members.user_id)`, params: [] };
function and(...gs) { return { sql: gs.map((g) => `(${g.sql})`).join(" AND "), params: gs.flatMap((g) => g.params) }; }

// === Outbox ===
function outboxStmt(db, chatId, dedupeKey, payload, now) { return st(db, `INSERT OR IGNORE INTO outbox (chat_id, dedupe_key, payload, created_at) VALUES (?, ?, ?, ?)`, chatId, dedupeKey, JSON.stringify(payload), now); }
function outboxGuardedStmt(db, chatId, dedupeKey, payload, now, guardSql, guardParams) { return st(db, `INSERT OR IGNORE INTO outbox (chat_id, dedupe_key, payload, created_at) SELECT ?, ?, ?, ? WHERE ${guardSql}`, chatId, dedupeKey, JSON.stringify(payload), now, ...guardParams); }
async function flushOutbox(ctx, opts = {}) {
  const now = ctx.now();
  const rows = await all(ctx.db, `SELECT id, chat_id, payload, attempts FROM outbox WHERE status = 'pending' AND created_at <= ? ${opts.chatId !== undefined ? "AND chat_id = ?" : ""} ORDER BY id LIMIT ?`, now - (opts.minAgeMs ?? 0), ...(opts.chatId !== undefined ? [opts.chatId] : []), opts.limit ?? 10);
  let sent = 0;
  for (const row of rows) {
    const claimed = await run(ctx.db, `UPDATE outbox SET attempts = attempts + 1 WHERE id = ? AND status = 'pending' AND attempts = ?`, row.id, row.attempts);
    if (claimed !== 1) continue;
    let payload;
    try { payload = JSON.parse(row.payload); } catch { await run(ctx.db, `UPDATE outbox SET status='failed' WHERE id = ?`, row.id); continue; }
    const res = await ctx.tg.sendMessage(row.chat_id, payload.text, payload.markup ? { reply_markup: payload.markup } : undefined);
    if (res.ok) { await run(ctx.db, `UPDATE outbox SET status = 'sent', sent_at = ? WHERE id = ?`, ctx.now(), row.id); sent++; }
    else { const permanent = res.code === 403 || res.code === 400 || row.attempts + 1 >= 6; if (permanent) await run(ctx.db, `UPDATE outbox SET status = 'failed' WHERE id = ?`, row.id); if (res.code === 429) break; }
  }
  return sent;
}

// === Anniversary ===
async function queueAnniversaryMessages(ctx) {
  const today = localDayId(ctx.now());
  if (!today.endsWith("-10-25")) return 0;
  const year = today.slice(0, 4);
  const groups = await all(ctx.db, `SELECT chat_id FROM groups`);
  let queued = 0;
  for (const g of groups) {
    const key = `anniv:${year}:${g.chat_id}`;
    const r = await run(ctx.db, `INSERT OR IGNORE INTO outbox (chat_id, dedupe_key, payload, created_at) VALUES (?, ?, ?, ?)`, g.chat_id, key, JSON.stringify({ text: ANNIVERSARY_TEXT }), ctx.now());
    if (r === 1) queued++;
  }
  return queued;
}

// === Members ===
async function ensureGroup(ctx, chat) { const now = ctx.now(); const [, r] = await ctx.db.batch([st(ctx.db, `INSERT INTO groups (chat_id, title, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET title = COALESCE(excluded.title, groups.title)`, chat.id, chat.title ?? null, now, now), st(ctx.db, `SELECT * FROM groups WHERE chat_id = ?`, chat.id)]); return r.results[0]; }
async function getGroup(ctx, chatId) { return first(ctx.db, `SELECT * FROM groups WHERE chat_id = ?`, chatId); }
async function ensureMember(ctx, chatId, user) { const now = ctx.now(); const [, r] = await ctx.db.batch([st(ctx.db, `INSERT INTO members (chat_id, user_id, username, display_name, registered_at, activity_anchor_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id, user_id) DO UPDATE SET username = excluded.username, display_name = excluded.display_name`, chatId, user.id, user.username ?? null, userDisplayName(user), now, now, now), st(ctx.db, `SELECT * FROM members WHERE chat_id = ? AND user_id = ?`, chatId, user.id)]); return r.results[0]; }
async function getMember(ctx, chatId, userId) { return first(ctx.db, `SELECT * FROM members WHERE chat_id = ? AND user_id = ?`, chatId, userId); }
async function isBlocked(ctx, chatId, userId) { return !!(await first(ctx.db, `SELECT 1 AS x FROM blocks WHERE chat_id = ? AND user_id = ?`, chatId, userId)); }
async function lockedOf(ctx, chatId, userId) { const r = await first(ctx.db, `SELECT ${lockedExpr("?", "?")} AS v`, chatId, userId, userId); return r?.v ?? 0; }
async function rankOf(ctx, chatId, userId) { const r = await first(ctx.db, `SELECT 1 + COUNT(*) AS r FROM members m, members o WHERE m.chat_id = ? AND m.user_id = ? AND o.chat_id = m.chat_id AND (o.balance > m.balance OR (o.balance = m.balance AND (o.registered_at < m.registered_at OR (o.registered_at = m.registered_at AND o.user_id < m.user_id))))`, chatId, userId); return r?.r ?? 1; }
async function countMembers(ctx, chatId) { const r = await first(ctx.db, `SELECT COUNT(*) AS n FROM members WHERE chat_id = ?`, chatId); return r?.n ?? 0; }
function taxActiveToday(group, today) { if (group.status !== "active") return false; return !(group.tax_not_before_day && today <= group.tax_not_before_day); }
async function topPage(ctx, group, page) { const today = localDayId(ctx.now()); const ex = exposureCond("m", today); const flag = taxActiveToday(group, today) ? ex.sql : "0"; const params = taxActiveToday(group, today) ? ex.params : []; return all(ctx.db, `SELECT m.user_id, m.display_name, m.balance, (${flag}) AS exposed FROM members m WHERE m.chat_id = ? ORDER BY m.balance DESC, m.registered_at ASC, m.user_id ASC LIMIT ? OFFSET ?`, ...params, group.chat_id, TOP_PAGE_SIZE, page * TOP_PAGE_SIZE); }

// === PvP ===
async function nameOf(ctx, chatId, userId) { if (userId == null) return "?"; const m = await first(ctx.db, `SELECT display_name FROM members WHERE chat_id = ? AND user_id = ?`, chatId, userId); return m?.display_name ?? String(userId); }
const openKeyboard = (id) => ({ inline_keyboard: [[{ text: "⚔️ Accept", callback_data: `pa:${id}` }, { text: "❌ Cancel", callback_data: `pc:${id}` }]] });
async function renderMatch(ctx, m) {
  const creator = await nameOf(ctx, m.chat_id, m.creator_id); const stake = b(`${m.stake} cm`);
  if (m.status === "open") return { text: `⚔️ ${b(creator)} challenged the chat with a bet of ${stake}!\n\nStatus: ${b("open")}\nExpires in: ${b(formatRemaining(m.expires_at - ctx.now()))}`, markup: openKeyboard(m.id) };
  if (m.status === "accepted") return { text: `⚔️ ${b(creator)} vs ${b(await nameOf(ctx, m.chat_id, m.opponent_id))} — bet ${stake}\n\nStatus: ${b("fighting…")}` };
  if (m.status === "resolved") {
    const wM = await getMember(ctx, m.chat_id, m.winner_id), lM = await getMember(ctx, m.chat_id, m.loser_id);
    const wRank = await rankOf(ctx, m.chat_id, m.winner_id), lRank = await rankOf(ctx, m.chat_id, m.loser_id);
    const wRate = wM.wins + wM.losses > 0 ? Math.round((wM.wins / (wM.wins + wM.losses)) * 100) : 0;
    const lRate = lM.wins + lM.losses > 0 ? Math.round((lM.wins / (lM.wins + lM.losses)) * 100) : 0;
    let text = `The winner is ${b(wM.display_name)}! His dick is now ${b(wM.balance + " cm")} long. The loser's one is ${b(lM.balance + " cm")}\nThe bet was ${b(m.stake + " cm")}.\n\n${b(wM.display_name)}'s position in the top is ${b(wRank)}.\n${b(lM.display_name)}'s position in the top is ${b(lRank)}.\n\nWin rate of the winner — ${b(wRate)}%.\nHis current win streak — ${b(wM.streak)}, max win streak — ${b(wM.max_streak)}.\nWin rate of the loser — ${b(lRate)}%.`;
    if (m.loser_streak_lost > 0) text += `\nThe streak of ${b(m.loser_streak_lost)} victories in a row was lost.`;
    return { text };
  }
  const why = m.status === "expired" ? "expired (nobody accepted in time)" : m.end_reason === "creator_cancelled" ? "cancelled by the creator" : "cancelled";
  return { text: `⚔️ ${b(creator)}'s challenge of ${stake} was ${b(why)}. The bet was released.` };
}
async function refreshMessage(ctx, m) { if (m.message_id == null) return; const fresh = await first(ctx.db, `SELECT * FROM pvp_matches WHERE id = ?`, m.id); if (!fresh) return; const r = await renderMatch(ctx, fresh); await ctx.tg.editMessageText(fresh.chat_id, m.message_id, r.text, r.markup); }
async function createPvp(ctx, chat, user, stake, updateId) {
  const group = await ensureGroup(ctx, chat); await ensureMember(ctx, chat.id, user);
  if (group.status !== "active") { await ctx.tg.sendMessage(chat.id, group.status === "pending_winner" ? "⏸ The game is frozen until the owner confirms the winner." : "🏁 This round is finished. The owner can start a new round."); return; }
  if (await isBlocked(ctx, chat.id, user.id)) { await ctx.tg.sendMessage(chat.id, "🚫 You are blocked from PvP in this group."); return; }
  const now = ctx.now(), key = `pvp:${chat.id}:${updateId}`;
  const changes = await run(ctx.db, `INSERT OR IGNORE INTO pvp_matches (chat_id, creator_id, stake, status, created_at, expires_at, create_key) SELECT ?, ?, ?, 'open', ?, ?, ? WHERE EXISTS (SELECT 1 FROM groups WHERE chat_id = ? AND status = 'active') AND NOT EXISTS (SELECT 1 FROM blocks WHERE chat_id = ? AND user_id = ?) AND (SELECT balance FROM members WHERE chat_id = ? AND user_id = ?) - ${lockedExpr("?", "?")} >= ?`, chat.id, user.id, stake, now, now + PVP_TTL_MS, key, chat.id, chat.id, user.id, chat.id, user.id, chat.id, user.id, user.id, stake);
  const match = await first(ctx.db, `SELECT * FROM pvp_matches WHERE create_key = ?`, key);
  if (!match) { const me = await getMember(ctx, chat.id, user.id), locked = await lockedOf(ctx, chat.id, user.id), total = me?.balance ?? 0; await ctx.tg.sendMessage(chat.id, `❌ Not enough free length for a ${b(stake + " cm")} bet.\nTotal: ${b(total + " cm")} · Locked: ${b(locked + " cm")} · Free: ${b(total - locked + " cm")}`); return; }
  if (changes === 0 && match.message_id != null) return;
  const r = await renderMatch(ctx, match);
  const sent = await ctx.tg.sendMessage(chat.id, r.text, r.markup ? { reply_markup: r.markup } : undefined);
  if (sent.ok) await run(ctx.db, `UPDATE pvp_matches SET message_id = ? WHERE id = ?`, sent.result.message_id, match.id);
}
async function cancelPvpByCreator(ctx, chatId, matchId, userId) {
  const m = await first(ctx.db, `SELECT * FROM pvp_matches WHERE id = ? AND chat_id = ?`, matchId, chatId);
  if (!m) return { text: "This match no longer exists.", alert: true };
  if (m.creator_id !== userId) return { text: "Only the creator can cancel this challenge.", alert: true };
  const n = await run(ctx.db, `UPDATE pvp_matches SET status = 'cancelled', end_reason = 'creator_cancelled', resolved_at = ? WHERE id = ? AND status = 'open'`, ctx.now(), matchId);
  if (n === 0) return { text: "This challenge is no longer open.", alert: true };
  await refreshMessage(ctx, m); return { text: "Challenge cancelled." };
}
async function expireMatch(ctx, m) { const n = await run(ctx.db, `UPDATE pvp_matches SET status = 'expired', end_reason = 'expired', resolved_at = ? WHERE id = ? AND status = 'open' AND expires_at <= ?`, ctx.now(), m.id, ctx.now()); if (n === 1) await refreshMessage(ctx, m); return n === 1; }
async function acceptPvp(ctx, chatId, matchId, user) {
  const m = await first(ctx.db, `SELECT * FROM pvp_matches WHERE id = ? AND chat_id = ?`, matchId, chatId);
  if (!m) return { text: "This match no longer exists.", alert: true };
  if (m.status !== "open") return { text: m.status === "accepted" || m.status === "resolved" ? "Someone already accepted this fight." : "This challenge is no longer open.", alert: true };
  const now = ctx.now();
  if (m.expires_at <= now) { await expireMatch(ctx, m); return { text: "This challenge has expired.", alert: true }; }
  if (m.creator_id === user.id) return { text: "You cannot accept your own challenge.", alert: true };
  const group = await ensureGroup(ctx, { id: chatId, type: "supergroup" });
  if (group.status !== "active") return { text: "The game is not active right now.", alert: true };
  await ensureMember(ctx, chatId, user);
  if (await isBlocked(ctx, chatId, user.id)) return { text: "You are blocked from PvP in this group.", alert: true };
  const n = await run(ctx.db, `UPDATE pvp_matches SET status = 'accepted', opponent_id = ?, accepted_at = ? WHERE id = ? AND chat_id = ? AND status = 'open' AND expires_at > ? AND creator_id != ? AND EXISTS (SELECT 1 FROM groups WHERE chat_id = pvp_matches.chat_id AND status = 'active') AND NOT EXISTS (SELECT 1 FROM blocks bl WHERE bl.chat_id = pvp_matches.chat_id AND (bl.user_id = ? OR bl.user_id = pvp_matches.creator_id)) AND (SELECT balance FROM members WHERE chat_id = pvp_matches.chat_id AND user_id = ?) - ${lockedExpr("pvp_matches.chat_id", "?")} >= pvp_matches.stake`, user.id, now, matchId, chatId, now, user.id, user.id, user.id, user.id, user.id);
  if (n !== 1) { const cur = await first(ctx.db, `SELECT * FROM pvp_matches WHERE id = ?`, matchId); if (cur && cur.status === "open") { const me = await getMember(ctx, chatId, user.id), locked = await lockedOf(ctx, chatId, user.id); return { text: `Not enough free length. You have ${(me?.balance ?? 0) - locked} cm free, the bet is ${m.stake} cm.`, alert: true }; } return { text: "Too late — this challenge was just taken or closed.", alert: true }; }
  const res = await settlePvp(ctx, matchId);
  return { text: res ? "Fight resolved!" : "Fight is being processed." };
}
async function settlePvp(ctx, matchId) {
  const m = await first(ctx.db, `SELECT * FROM pvp_matches WHERE id = ?`, matchId);
  if (!m || m.status !== "accepted" || m.opponent_id == null) return null;
  const group = await first(ctx.db, `SELECT status FROM groups WHERE chat_id = ?`, m.chat_id);
  if (!group || group.status !== "active") { await run(ctx.db, `UPDATE pvp_matches SET status = 'cancelled', end_reason = 'game_not_active', resolved_at = ? WHERE id = ? AND status = 'accepted'`, ctx.now(), matchId); await refreshMessage(ctx, m); return null; }
  const creatorWins = ctx.rng.int(0, 1) === 1;
  const winner = creatorWins ? m.creator_id : m.opponent_id, loser = creatorWins ? m.opponent_id : m.creator_id;
  const now = ctx.now(), token = ctx.rng.token();
  const guard = { sql: `EXISTS (SELECT 1 FROM pvp_matches WHERE id = ? AND resolve_token = ?)`, params: [matchId, token] };
  const oldL = await getMember(ctx, m.chat_id, loser);
  const lostStreak = oldL ? oldL.streak : 0;
  const statsWinner = st(ctx.db, `UPDATE members SET wins = wins + 1, streak = streak + 1, max_streak = MAX(max_streak, streak + 1), last_pvp_at = ?, activity_anchor_at = ?, special_active = 0, special_deadline_at = NULL, updated_at = ? WHERE chat_id = ? AND user_id = ? AND ${guard.sql}`, now, now, now, m.chat_id, winner, ...guard.params);
  const statsLoser = st(ctx.db, `UPDATE members SET losses = losses + 1, streak = 0, last_pvp_at = ?, activity_anchor_at = ?, special_active = 0, special_deadline_at = NULL, updated_at = ? WHERE chat_id = ? AND user_id = ? AND ${guard.sql}`, now, now, now, m.chat_id, loser, ...guard.params);
  const rs = await ctx.db.batch([
    st(ctx.db, `UPDATE pvp_matches SET status = 'resolved', winner_id = ?, loser_id = ?, resolved_at = ?, resolve_token = ?, loser_streak_lost = ? WHERE id = ? AND status = 'accepted'`, winner, loser, now, token, lostStreak, matchId),
    ...deltaStmts(ctx.db, { chatId: m.chat_id, userId: winner, delta: m.stake, reason: "pvp_win", opKey: `pvp:${matchId}:win`, now, guard }),
    ...deltaStmts(ctx.db, { chatId: m.chat_id, userId: loser, delta: -m.stake, reason: "pvp_loss", opKey: `pvp:${matchId}:loss`, now, guard }),
    statsWinner, statsLoser,
  ]);
  if ((rs[0].meta?.changes ?? 0) !== 1) return null;
  await refreshMessage(ctx, m); await checkWinner(ctx, m.chat_id);
  return await first(ctx.db, `SELECT * FROM pvp_matches WHERE id = ?`, matchId);
}
async function cancelUserMatches(ctx, chatId, userId, reason) { const rows = await all(ctx.db, `UPDATE pvp_matches SET status = 'cancelled', end_reason = ?, resolved_at = ? WHERE chat_id = ? AND status IN ('open','accepted') AND (creator_id = ? OR opponent_id = ?) RETURNING *`, reason, ctx.now(), chatId, userId, userId); for (const m of rows) await refreshMessage(ctx, m); return rows.length; }
async function recoverPvp(ctx) { const now = ctx.now(); const expiredRows = await all(ctx.db, `UPDATE pvp_matches SET status = 'expired', end_reason = 'expired', resolved_at = ? WHERE id IN (SELECT id FROM pvp_matches WHERE status = 'open' AND expires_at <= ? LIMIT 20) RETURNING *`, now, now); for (const m of expiredRows) await refreshMessage(ctx, m); const stuck = await all(ctx.db, `SELECT id FROM pvp_matches WHERE status = 'accepted' AND accepted_at <= ? LIMIT 10`, now - 60000); let settled = 0; for (const s of stuck) if (await settlePvp(ctx, s.id)) settled++; return { expired: expiredRows.length, settled }; }

// === Tax ===
const taxAmount = (balance) => Math.floor((balance * TAX_PERCENT) / 100);
function dueTaxDays(group, now) { const today = localDayId(now), yesterday = addDays(today, -1); let first_ = addDays(today, -3); const created = localDayId(group.created_at); if (created > first_) first_ = created; if (group.tax_not_before_day) { const afterResume = addDays(group.tax_not_before_day, 1); if (afterResume > first_) first_ = afterResume; } const days = []; for (let d = first_; d <= yesterday; d = addDays(d, 1)) days.push(d); return days; }
async function processTax(ctx, group, counter) { if (group.status !== "active") return true; const days = dueTaxDays(group, ctx.now()); if (days.length === 0) return true; const done = await all(ctx.db, `SELECT day_id FROM jobs WHERE kind = 'tax' AND chat_id = ? AND status IN ('done','skipped') AND day_id >= ?`, group.chat_id, days[0]); const doneSet = new Set(done.map((d) => d.day_id)); for (const day of days) { if (doneSet.has(day)) continue; if (!(await processTaxDay(ctx, group, day, counter))) return false; } return true; }
async function processTaxDay(ctx, group, day, counter) {
  const key = `tax:${group.chat_id}:${day}`, now = ctx.now();
  await run(ctx.db, `INSERT OR IGNORE INTO jobs (job_key, kind, chat_id, day_id, stage, created_at, updated_at) VALUES (?, 'tax', ?, ?, 'collect', ?, ?)`, key, group.chat_id, day, now, now);
  const job = await first(ctx.db, `SELECT job_key, stage, cursor, status, attempts FROM jobs WHERE job_key = ?`, key);
  if (!job || job.status === "done" || job.status === "skipped") return true;
  await run(ctx.db, `UPDATE jobs SET attempts = attempts + 1, updated_at = ?, status = 'running' WHERE job_key = ?`, now, key);
  const ex = exposureCond("m", day);
  let cursor = job.cursor;
  try {
    while (budgetLeft(counter, 7)) {
      const take = Math.min(4, Math.floor((counter.limit - counter.used - 2) / 5));
      if (take < 1) return false;
      const rows = await all(ctx.db, `SELECT m.user_id, m.display_name, m.balance FROM members m WHERE m.chat_id = ? AND m.user_id > ? AND ${ex.sql} ORDER BY m.user_id LIMIT ?`, group.chat_id, cursor, ...ex.params, take);
      if (rows.length === 0) return await finishTaxDay(ctx, group, day, key);
      for (const r of rows) {
        await cancelUserMatches(ctx, group.chat_id, r.user_id, "tax");
        for (let attempt = 0; attempt < 3; attempt++) {
          const cur = await first(ctx.db, `SELECT balance FROM members WHERE chat_id = ? AND user_id = ?`, group.chat_id, r.user_id);
          if (!cur || cur.balance <= 250) break;
          const tax = taxAmount(cur.balance);
          const rs = await ctx.db.batch(deltaStmts(ctx.db, { chatId: group.chat_id, userId: r.user_id, delta: -tax, reason: "tax", opKey: `tax:${group.chat_id}:${day}:${r.user_id}`, now: ctx.now(), note: day, guard: { sql: "members.balance = ? AND members.balance > 250", params: [cur.balance] } }));
          if ((rs[0].meta?.changes ?? 0) === 1) break;
          const already = await first(ctx.db, `SELECT 1 AS x FROM ledger WHERE op_key = ?`, `tax:${group.chat_id}:${day}:${r.user_id}`);
          if (already) break;
        }
        cursor = r.user_id;
      }
      await run(ctx.db, `UPDATE jobs SET cursor = ?, stage = 'collect', updated_at = ? WHERE job_key = ?`, cursor, ctx.now(), key);
    }
    return false;
  } catch (e) { await run(ctx.db, `UPDATE jobs SET last_error = ?, updated_at = ? WHERE job_key = ?`, String(e instanceof Error ? e.message : e).slice(0, 300), ctx.now(), key); throw e; }
}
async function finishTaxDay(ctx, group, day, key) {
  const rows = await all(ctx.db, `SELECT m.display_name, l.balance_before, l.delta, l.balance_after FROM ledger l JOIN members m ON m.chat_id = l.chat_id AND m.user_id = l.user_id WHERE l.chat_id = ? AND l.reason = 'tax' AND l.op_key LIKE ? ORDER BY l.id`, group.chat_id, `tax:${group.chat_id}:${day}:%`);
  const now = ctx.now(), stmts = [];
  if (rows.length > 0) {
    const shown = rows.slice(0, 40).map((r) => `${b(r.display_name)}: ${r.balance_before} cm → −${-r.delta} cm tax → ${b(r.balance_after + " cm")}`);
    const more = rows.length > 40 ? `\n…and ${rows.length - 40} more` : "";
    stmts.push(outboxStmt(ctx.db, group.chat_id, `tax-report:${group.chat_id}:${day}`, { text: `💸 ${b("Daily tax report")} (${esc(day)})\nNo finished PvP yesterday, so 10% was collected:\n\n${shown.join("\n")}${more}` }, now));
  }
  stmts.push(st(ctx.db, `UPDATE jobs SET status = 'done', stage = 'done', updated_at = ? WHERE job_key = ?`, now, key));
  await ctx.db.batch(stmts); return true;
}

// === Inactivity ===
async function processInactivity(ctx, group, counter) {
  if (group.status !== "active") return 0;
  const now = ctx.now(); const reach = reachedCond("m", now, group.inactivity_days);
  const rows = await all(ctx.db, `SELECT m.user_id, m.display_name, m.balance FROM members m WHERE m.chat_id = ? AND m.balance > 0 AND ${reach.sql} ORDER BY m.user_id LIMIT 3`, group.chat_id, ...reach.params);
  let splits = 0;
  for (const r of rows) { if (!budgetLeft(counter, 12)) break; if (await splitUser(ctx, group, r)) splits++; }
  if (splits > 0) { await checkWinner(ctx, group.chat_id); await flushOutbox(ctx, { chatId: group.chat_id }); }
  return splits;
}
async function splitUser(ctx, group, r) {
  const chatId = group.chat_id;
  await cancelUserMatches(ctx, chatId, r.user_id, "inactive_split");
  const cur = await first(ctx.db, `SELECT balance FROM members WHERE chat_id = ? AND user_id = ?`, chatId, r.user_id);
  if (!cur || cur.balance <= 0) return false;
  const B = cur.balance, now = ctx.now();
  const reach = reachedCond("m", now, group.inactivity_days), reachSelf = reachedCond("members", now, group.inactivity_days);
  const today = localDayId(now), ex = exposureCond("m", today);
  const exSql = taxActiveToday(group, today) ? `AND NOT ${ex.sql}` : "";
  const exParams = taxActiveToday(group, today) ? ex.params : [];
  const recips = await all(ctx.db, `SELECT m.user_id FROM members m WHERE m.chat_id = ? AND m.user_id != ? AND NOT ${reach.sql} ${exSql} AND NOT EXISTS (SELECT 1 FROM blocks bl WHERE bl.chat_id = m.chat_id AND bl.user_id = m.user_id) ORDER BY m.user_id`, chatId, r.user_id, ...reach.params, ...exParams);
  const ids = recips.map((x) => x.user_id);
  const token = ctx.rng.token();
  const guardSql = `EXISTS (SELECT 1 FROM members WHERE chat_id = ? AND user_id = ? AND op_token = ?)`;
  const gp = [chatId, r.user_id, token];
  const stmts = [
    st(ctx.db, `UPDATE members SET balance = 0, activity_anchor_at = ?, special_active = 1, special_deadline_at = NULL, op_token = ?, updated_at = ? WHERE chat_id = ? AND user_id = ? AND balance = ? AND balance > 0 AND ${reachSelf.sql}`, now, token, now, chatId, r.user_id, B, ...reachSelf.params),
    st(ctx.db, `INSERT INTO ledger (chat_id, user_id, delta, balance_before, balance_after, reason, actor_id, note, op_key, created_at) SELECT ?, ?, ?, ?, 0, ?, NULL, ?, ?, ? WHERE ${guardSql}`, chatId, r.user_id, -B, B, ids.length ? "split_out" : "split_burn", ids.length ? `shared with ${ids.length}` : "no eligible recipient", `split:${token}:out`, now, ...gp),
  ];
  let announce;
  if (ids.length === 0) announce = `⏳ ${b(r.display_name)} was inactive. ${b(B + " cm")} had no eligible recipient and were removed from the game.`;
  else {
    const base = Math.floor(B / ids.length), rem = B % ids.length, lucky = new Set(ctx.rng.sample(ids, rem));
    const groups = [{ amount: base, members: ids.filter((i) => !lucky.has(i)) }, { amount: base + 1, members: ids.filter((i) => lucky.has(i)) }];
    for (const g of groups) {
      if (g.amount === 0 || g.members.length === 0) continue;
      for (let i = 0; i < g.members.length; i += 60) {
        const part = g.members.slice(i, i + 60), inList = part.map(() => "?").join(",");
        stmts.push(st(ctx.db, `UPDATE members SET balance = balance + ?, updated_at = ? WHERE chat_id = ? AND user_id IN (${inList}) AND ${guardSql}`, g.amount, now, chatId, ...part, ...gp), st(ctx.db, `INSERT INTO ledger (chat_id, user_id, delta, balance_before, balance_after, reason, actor_id, note, op_key, created_at) SELECT chat_id, user_id, ?, balance - ?, balance, 'split_in', NULL, ?, 'split:' || ? || ':in:' || user_id, ? FROM members WHERE chat_id = ? AND user_id IN (${inList}) AND ${guardSql}`, g.amount, g.amount, `from user ${r.user_id}`, token, now, chatId, ...part, ...gp));
      }
    }
    stmts.push(syncIdsStmt(ctx.db, chatId, [r.user_id], now));
    for (let i = 0; i < ids.length; i += 60) stmts.push(syncIdsStmt(ctx.db, chatId, ids.slice(i, i + 60), now));
    const per = rem === 0 ? `${base} cm each` : `${base} cm each (+1 cm for ${rem} random player${rem === 1 ? "" : "s"})`;
    announce = `⏳ ${b(r.display_name)} was inactive. ${b(B + " cm")} were shared equally between ${b(ids.length)} active player${ids.length === 1 ? "" : "s"}: ${per}.`;
  }
  stmts.push(outboxGuardedStmt(ctx.db, chatId, `split:${token}`, { text: announce }, now, guardSql, gp));
  const rs = await ctx.db.batch(stmts);
  return (rs[0].meta?.changes ?? 0) === 1;
}

// === Winner ===
const INF = Number.MAX_SAFE_INTEGER;
async function checkWinner(ctx, chatId) {
  const group = await getGroup(ctx, chatId);
  if (!group || group.status !== "active") return false;
  const cands = await all(ctx.db, `SELECT user_id, display_name, balance, reached_target_at FROM members WHERE chat_id = ? AND balance >= ? ORDER BY balance DESC, COALESCE(reached_target_at, ${INF}) ASC, user_id ASC LIMIT 10`, chatId, group.win_target);
  if (cands.length === 0) return false;
  const top = cands[0], tied = cands.filter((c) => c.balance === top.balance && (c.reached_target_at ?? INF) === (top.reached_target_at ?? INF));
  const main = tied.length === 1 ? top : null, now = ctx.now(), token = ctx.rng.token();
  const rows = tied.map((c) => `${b(c.display_name)} — ${b(c.balance + " cm")}`).join("\n");
  const text = main ? `🏆 ${b("We have a winner candidate!")}\n\n${b(main.display_name)} reached ${b(main.balance + " cm")} (win target: ${b(group.win_target + " cm")}).\n\nThe game is frozen. Only the group owner can confirm the winner.` : `🏆 ${b("Winner candidates are tied!")}\n\n${rows}\n\nWin target: ${b(group.win_target + " cm")}. The game is frozen. Only the group owner can pick and confirm the winner.`;
  const markup = { inline_keyboard: tied.slice(0, 8).map((c) => [{ text: `✅ Confirm ${Array.from(c.display_name).slice(0, 30).join("")}`, callback_data: `wc:${c.user_id}` }]) };
  const guard = `EXISTS (SELECT 1 FROM groups WHERE chat_id = ? AND op_token = ?)`;
  const rs = await ctx.db.batch([
    st(ctx.db, `UPDATE groups SET status = 'pending_winner', paused_at = ?, pending_candidates = ?, winner_candidate_id = ?, op_token = ?, updated_at = ? WHERE chat_id = ? AND status = 'active'`, now, JSON.stringify(tied.map((c) => c.user_id)), main?.user_id ?? null, token, now, chatId),
    st(ctx.db, `UPDATE pvp_matches SET status = 'cancelled', end_reason = 'winner_pending', resolved_at = ? WHERE chat_id = ? AND status = 'open' AND ${guard}`, now, chatId, chatId, token),
    outboxGuardedStmt(ctx.db, chatId, `winner:${chatId}:${group.round}:${token}`, { text, markup }, now, guard, [chatId, token]),
  ]);
  if ((rs[0].meta?.changes ?? 0) !== 1) return false;
  await flushOutbox(ctx, { chatId }); return true;
}
async function resumeGroup(ctx, group, from, bumpRound, actorId, action) {
  const now = ctx.now(), token = ctx.rng.token(), paused = group.paused_at != null ? Math.max(0, now - group.paused_at) : 0;
  const guard = `EXISTS (SELECT 1 FROM groups WHERE chat_id = ? AND op_token = ?)`;
  const rs = await ctx.db.batch([
    st(ctx.db, `UPDATE groups SET status = 'active', round = round + ?, paused_at = NULL, tax_not_before_day = ?, winner_candidate_id = NULL, pending_candidates = NULL, winner_confirmed_id = NULL, finished_at = NULL, op_token = ?, updated_at = ? WHERE chat_id = ? AND status = ?`, bumpRound ? 1 : 0, localDayId(now), token, now, group.chat_id, from),
    st(ctx.db, `UPDATE members SET activity_anchor_at = activity_anchor_at + ?, special_deadline_at = CASE WHEN special_deadline_at IS NULL THEN NULL ELSE special_deadline_at + ? END, updated_at = ? WHERE chat_id = ? AND ${guard}`, paused, paused, now, group.chat_id, group.chat_id, token),
    syncGroupStmt(ctx.db, group.chat_id, now),
    st(ctx.db, `INSERT INTO audit_log (chat_id, actor_id, action, detail, created_at) SELECT ?, ?, ?, ?, ? WHERE ${guard}`, group.chat_id, actorId, action, JSON.stringify({ paused_ms: paused, win_target: group.win_target }), now, group.chat_id, token),
  ]);
  return (rs[0].meta?.changes ?? 0) === 1;
}
async function confirmWinner(ctx, chatId, ownerId, candidateId) {
  const group = await getGroup(ctx, chatId);
  if (!group || group.status !== "pending_winner") return { ok: false, message: "No winner is waiting for confirmation." };
  const allowed = group.pending_candidates ? JSON.parse(group.pending_candidates) : [];
  if (!allowed.includes(candidateId)) return { ok: false, message: "This user is not one of the current candidates." };
  const cand = await first(ctx.db, `SELECT user_id, display_name, balance, reached_target_at FROM members WHERE chat_id = ? AND user_id = ?`, chatId, candidateId);
  if (!cand || cand.balance < group.win_target) { await resumeGroup(ctx, group, "pending_winner", false, ownerId, "winner_invalid_resume"); return { ok: false, message: "That candidate no longer reaches the win target. The game has been resumed." }; }
  const now = ctx.now(), token = ctx.rng.token(), guard = `EXISTS (SELECT 1 FROM groups WHERE chat_id = ? AND op_token = ?)`;
  const text = `🎉 ${b("Winner confirmed: " + cand.display_name)}!\n\nFinal length: ${b(cand.balance + " cm")} (target ${b(group.win_target + " cm")}). Round ${b(group.round)} is over.\n\nAdmins can raise the win target from /panel. The new target must be higher than the current top length (${b("" + (await topBalance(ctx, chatId)) + " cm")}). Then the owner can start the next round. All lengths and stats are kept.`;
  const rs = await ctx.db.batch([
    st(ctx.db, `UPDATE groups SET status = 'finished', winner_confirmed_id = ?, finished_at = ?, op_token = ?, updated_at = ? WHERE chat_id = ? AND status = 'pending_winner'`, candidateId, now, token, now, chatId),
    st(ctx.db, `INSERT INTO audit_log (chat_id, actor_id, action, target_user_id, detail, created_at) SELECT ?, ?, 'winner_confirmed', ?, ?, ? WHERE ${guard}`, chatId, ownerId, candidateId, JSON.stringify({ balance: cand.balance, round: group.round }), now, chatId, token),
    st(ctx.db, `INSERT INTO global_points (user_id, display_name, points) SELECT ?, ?, 1 FROM groups WHERE chat_id = ? AND op_token = ? ON CONFLICT(user_id) DO UPDATE SET points = points + 1, display_name = excluded.display_name`, candidateId, cand.display_name, chatId, token),
    outboxGuardedStmt(ctx.db, chatId, `finished:${chatId}:${group.round}`, { text, markup: { inline_keyboard: [[{ text: "🔄 Start new round (owner)", callback_data: "wn" }]] } }, now, guard, [chatId, token]),
  ]);
  if ((rs[0].meta?.changes ?? 0) !== 1) return { ok: false, message: "Already handled." };
  await flushOutbox(ctx, { chatId }); return { ok: true, message: "Winner confirmed. +1 Global Point!" };
}
async function topBalance(ctx, chatId) { const r = await first(ctx.db, `SELECT MAX(balance) AS m FROM members WHERE chat_id = ?`, chatId); return r?.m ?? 0; }
async function startNewRound(ctx, chatId, ownerId) {
  const group = await getGroup(ctx, chatId);
  if (!group || group.status !== "finished") return { ok: false, message: "The round is not finished yet." };
  const top = await topBalance(ctx, chatId);
  if (group.win_target <= top) return { ok: false, message: `Cannot start: the win target (${group.win_target} cm) must be higher than the top length (${top} cm). Admins can raise it from /panel.` };
  const ok = await resumeGroup(ctx, group, "finished", true, ownerId, "round_started");
  if (!ok) return { ok: false, message: "Already handled." };
  await ctx.tg.sendMessage(chatId, `🚀 ${b("Round " + (group.round + 1) + " has started!")}\nWin target: ${b(group.win_target + " cm")}. Good luck!`);
  return { ok: true, message: "New round started." };
}
async function resyncAfterTargetChange(ctx, chatId) { await ctx.db.batch([syncGroupStmt(ctx.db, chatId, ctx.now())]); }

// === Game ===
const HELP_TEXT = `<b>DekTH X</b>
<i>A Telegram Game Bot by AriyanTH</i>

🇮🇷 <b>درباره پروژه</b>
سلام! من <b>AriyanTH</b> هستم و DekTH X یک پروژه شخصی با محوریت برنامه‌نویسی و سرگرمیه که با هدف ساخت یک تجربه جذاب برای کاربران تلگرام توسعه داده شده.

این پروژه کاملاً <b>رایگان و متن‌باز (Free &amp; Open Source)</b> است. هدفم از انتشار اون، به‌اشتراک‌گذاشتن نتیجه کارم با دیگران، فراهم‌کردن فرصتی برای یادگیری و ایجاد بستری برای مشارکت و توسعه بیشتره.

در فرایند توسعه پروژه، از ابزارهای هوش مصنوعی نیز به‌عنوان دستیار برنامه‌نویسی برای پیاده‌سازی ایده‌ها، حل مشکلات و بهبود کد استفاده شده است.

⚙️ <b>مشخصات فنی</b>
DekTH X با JavaScript مدرن توسعه داده شده و روی زیرساخت بدون سرور Cloudflare Workers اجرا می‌شه. برای ذخیره‌سازی داده‌ها از Cloudflare D1 مبتنی بر SQLite و برای ارتباط با تلگرام از Telegram Bot API استفاده شده است.

معماری پروژه با تمرکز بر سادگی، کارایی و پایداری طراحی شده و از قابلیت‌هایی مانند Webhook، پردازش زمان‌بندی‌شده، جلوگیری از پردازش تکراری درخواست‌ها و مدیریت مطمئن پیام‌های خروجی بهره می‌بره. همچنین تلاش شده با استفاده از APIهای داخلی محیط اجرا، وابستگی به کتابخانه‌های خارجی به حداقل برسه.

این پروژه همچنان فرصتی برای یادگیری، آزمایش و بهبود مستمره و از پیشنهادها و مشارکت‌های سازنده استقبال می‌کنم.

🔗 <b>لینک‌ها و ارتباط</b>
<b>GitHub:</b> https://github.com/AriyanTH/DekTH-X.git
<b>Email:</b> bikarjoon@gmail.com

از تمام کسانی که از پروژه بازدید می‌کنن، بازخورد می‌دن یا در توسعه اون مشارکت می‌کنن، ممنونم. ❤️

🇬🇧 <b>About the Project</b>
<b>DekTH X</b> is a personal Telegram game bot developed by <b>AriyanTH</b>, combining programming and entertainment in a project focused on creating an engaging experience for Telegram users.

The project is <b>completely free and open-source</b>, with the goal of sharing my work with the community, encouraging learning, and making further development and collaboration possible.

AI tools were used during development as programming assistants to help implement ideas, troubleshoot issues, and improve the code.

⚙️ <b>Technical Overview</b>
DekTH X is built with modern JavaScript and runs on <b>Cloudflare Workers</b>, using a serverless architecture. It uses <b>Cloudflare D1 (SQLite)</b> for data storage and the <b>Telegram Bot API</b> for communication with Telegram.

The architecture focuses on simplicity, efficiency, and reliability. Key mechanisms include webhook-based updates, scheduled tasks, duplicate-processing protection, and reliable outgoing message handling. The project also minimizes external dependencies by relying on built-in runtime APIs wherever practical.

Beyond its functionality as a game bot, DekTH X is an ongoing personal project for learning, experimentation, and continuous improvement. Feedback, ideas, and community contributions are always welcome.

🔗 <b>Links &amp; Contact</b>
<b>GitHub Repository:</b> https://github.com/AriyanTH/DekTH-X.git
<b>Email:</b> bikarjoon@gmail.com

Thank you to everyone who takes the time to explore the project, share feedback, or contribute to its development.

<b>Built with curiosity and dedication by AriyanTH.</b> ❤️

━━━━━━━━━━━━━━━━━━━━

<b>🎮 DekTH X — Game Guide</b>
<i>Grow your rank. Challenge players. Become the champion.</i>

━━━━━━━━━━━━━━━━━━

<b>📌 PLAYER COMMANDS</b>

/grow
Change your length by a random amount between -10 and +30 cm.
• Available once every 24 hours.
• Your length can increase or decrease.

/pvp 20
Challenge the group to a 20 cm PvP match.
• The winner gains the bet amount.
• The loser loses the same amount.
• Each player must have enough available balance.
• The opponent has 10 minutes to accept.
• The winner is selected randomly with a 50/50 chance.

/dick_of_day
Enter the daily prize draw.
• One winner receives 10–50 cm.
• Available once every 24 hours per group.
• Recent /grow users are preferred; if none qualify, all unblocked registered players can enter.

/stats
View your length and PvP statistics.
Reply to another player's message to view their stats.

/top
View the group's leaderboard.
Use the navigation buttons to browse the rankings.

/ontop
View the global leaderboard of champions.
Points earned by winning a round count across groups.

/help
Display this guide.

━━━━━━━━━━━━━━━━━━

<b>⚖️ GAME RULES</b>

<b>💸 Daily Tax</b>
If your length is above 250 cm, you must complete at least one resolved PvP match each calendar day in the Asia/Tehran time zone. Otherwise, 10% of your length may be collected as tax.

Both PvP wins and losses count as completed matches.

<b>⏳ Inactivity</b>
If you go without a completed PvP for the group's inactivity deadline (3 days by default), your positive balance may be distributed equally among eligible active players.

If no eligible recipients exist, the balance is removed from the game.

<b>⚠️ Post-Split Deadline</b>
After your balance is distributed, a special 12-hour PvP deadline starts when you next use /grow. You must complete a real PvP match before it expires to avoid another share-out.

<b>🏆 Winning a Round</b>
The default win target is 500 cm.
When a player reaches the target, the game pauses while the group owner confirms the winner.

The confirmed champion earns +1 Global Point.
The owner can then start a new round. Player lengths and PvP statistics are preserved.

━━━━━━━━━━━━━━━━━━

<b>🛠️ ADMIN COMMANDS</b>

/panel
Open the administration panel.
Group admins can manage the win target and inactivity deadline. The group owner also has access to player management, balance adjustments, and winner confirmation.

/block
Reply to a player's message with /block to block them from playing.

/block off
Reply to a blocked player's message with /block off to unblock them.

Blocking and unblocking are restricted to the real group owner.

━━━━━━━━━━━━━━━━━━

<b>💡 QUICK TIPS</b>
• Keep track of your available balance before placing a bet.
• Use /stats to monitor your progress and win streak.
• Stay active to protect your length.
• Compete, climb the leaderboard, and become a global champion!

<i>DekTH X — Built by AriyanTH ❤️</i>`;

function fmtGrow(delta, total) { if (delta > 0) return `Your rank length has grown by ${delta} cm and is now ${total} cm long.`; if (delta < 0) return `Your rank length has shrunk by ${-delta} cm and is now ${total} cm long.`; return `Your rank length did not change and is still ${total} cm long.`; }
async function inactiveGameReply(ctx, chatId, group) { if (group.status === "active") return false; await ctx.tg.sendMessage(chatId, group.status === "pending_winner" ? "⏸ The game is frozen until the group owner confirms the winner." : "🏁 This round is finished. The owner can start a new round."); return true; }
async function cmdGrow(ctx, chat, user, updateId) {
  const group = await ensureGroup(ctx, chat); await ensureMember(ctx, chat.id, user);
  if (await inactiveGameReply(ctx, chat.id, group)) return;
  if (await isBlocked(ctx, chat.id, user.id)) { await ctx.tg.sendMessage(chat.id, "🚫 You are blocked from playing in this group."); return; }
  const opKey = `grow:${chat.id}:${updateId}`, now = ctx.now();
  const prior = await first(ctx.db, `SELECT delta FROM ledger WHERE op_key = ?`, opKey);
  let delta;
  if (prior) delta = prior.delta;
  else {
    delta = ctx.rng.int(GROW_MIN, GROW_MAX);
    const guard = and(ACTIVE_NOT_BLOCKED, { sql: `members.last_grow_at IS NULL OR members.last_grow_at <= ?`, params: [now - DAY] });
    const rs = await ctx.db.batch([
      ...deltaStmts(ctx.db, { chatId: chat.id, userId: user.id, delta, reason: "grow", opKey, now, guard, extraSet: { sql: "last_grow_at = ?", params: [now] } }),
      st(ctx.db, `UPDATE members SET special_deadline_at = ? WHERE chat_id = ? AND user_id = ? AND special_active = 1 AND (special_deadline_at IS NULL OR (special_deadline_at <= ? AND balance - ? <= 0)) AND EXISTS (SELECT 1 FROM ledger WHERE op_key = ?)`, now + SPECIAL_WINDOW_MS, chat.id, user.id, now, delta, opKey),
    ]);
    if ((rs[0].meta?.changes ?? 0) !== 1) {
      const me = await getMember(ctx, chat.id, user.id);
      if (me?.last_grow_at != null && now - me.last_grow_at < DAY) await ctx.tg.sendMessage(chat.id, `⏳ You already used /grow. Next attempt in ${b(formatRemaining(me.last_grow_at + DAY - now))}.`);
      else await ctx.tg.sendMessage(chat.id, "⚠️ /grow could not be applied right now. Please try again.");
      return;
    }
  }
  const me = await getMember(ctx, chat.id, user.id), rank = await rankOf(ctx, chat.id, user.id), next = me.last_grow_at != null ? me.last_grow_at + DAY - now : DAY;
  let text = `${b(fmtGrow(delta, me.balance))}\n\nYour position in the top is ${b(rank)}.\n\nNext attempt in ${b(formatRemaining(next))}.`;
  if (me.special_active === 1 && me.special_deadline_at != null) text += `\n\n⚠️ ${b("Warning:")} you have ${b(formatRemaining(me.special_deadline_at - now))} to finish a real PvP. If you don't, your positive length can be shared out again among active players.`;
  await ctx.tg.sendMessage(chat.id, text);
  await checkWinner(ctx, chat.id);
}
async function cmdStats(ctx, chat, sender, replied) {
  await ensureGroup(ctx, chat); await ensureMember(ctx, chat.id, sender);
  const target = replied && !replied.is_bot ? replied : sender;
  const m = await getMember(ctx, chat.id, target.id);
  if (!m) { await ctx.tg.sendMessage(chat.id, `${b(userDisplayName(target))} has not joined the game yet.`); return; }
  await ctx.tg.sendMessage(chat.id, `📊 ${b(m.display_name)}\n\nLength: ${b(m.balance + " cm")}\nWins: ${b(m.wins)}\nLosses: ${b(m.losses)}\nTotal fights: ${b(m.wins + m.losses)}`);
}
async function renderTop(ctx, group, requestedPage) {
  const total = await countMembers(ctx, group.chat_id), pages = Math.max(1, Math.ceil(total / TOP_PAGE_SIZE)), page = Math.min(Math.max(0, requestedPage), pages - 1);
  if (total === 0) return { text: `${b("top dek")}\n\nNobody has joined yet. Use /grow to start!`, page, pages };
  const rows = await topPage(ctx, group, page);
  const lines = rows.map((r, i) => `<code>${page * TOP_PAGE_SIZE + i + 1} | ${esc(r.display_name)} — ${r.balance} cm</code>${r.exposed ? " ❌" : ""}`);
  const text = `${b("top dek")}\n\n${lines.join("\n")}\n\nPage ${page + 1}/${pages} · ${total} registered player${total === 1 ? "" : "s"}\n❌ = must finish a PvP today or pay the tax`;
  const nav = [];
  if (page > 0) nav.push({ text: "◀️ Prev", callback_data: `t:${group.chat_id}:${page - 1}` });
  if (page < pages - 1) nav.push({ text: "Next ▶️", callback_data: `t:${group.chat_id}:${page + 1}` });
  return { text, markup: nav.length ? { inline_keyboard: [nav] } : undefined, page, pages };
}
async function cmdTop(ctx, chat, sender) { const group = await ensureGroup(ctx, chat); await ensureMember(ctx, chat.id, sender); const r = await renderTop(ctx, group, 0); await ctx.tg.sendMessage(chat.id, r.text, r.markup ? { reply_markup: r.markup } : undefined); }
async function cmdOnTop(ctx, chat, sender) {
  await ensureGroup(ctx, chat); await ensureMember(ctx, chat.id, sender);
  const rows = await all(ctx.db, `SELECT display_name, points FROM global_points ORDER BY points DESC, user_id ASC LIMIT 20`);
  const lines = rows.map((r, i) => { const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`; return `${medal} ${esc(r.display_name)} — ${b(r.points + " pts")}`; });
  await ctx.tg.sendMessage(chat.id, `🏆 ${b("Global Winners Leaderboard")}\n\n${lines.join("\n") || "No points awarded yet."}`);
}
async function cmdDay(ctx, chat, user, updateId) {
  const group = await ensureGroup(ctx, chat); await ensureMember(ctx, chat.id, user);
  if (await inactiveGameReply(ctx, chat.id, group)) return;
  if (await isBlocked(ctx, chat.id, user.id)) { await ctx.tg.sendMessage(chat.id, "🚫 You are blocked from playing in this group."); return; }
  const now = ctx.now(), token = `day:${chat.id}:${updateId}`;
  let draw = await first(ctx.db, `SELECT draw_no, winner_id, prize, drawn_at FROM day_draws WHERE token = ?`, token);
  if (!draw) {
    if (group.last_day_draw_at != null && now < group.last_day_draw_at + DAY) { await ctx.tg.sendMessage(chat.id, `⏳ Today's draw is already done. Next draw in ${b(formatRemaining(group.last_day_draw_at + DAY - now))}.`); return; }
    let source = "active_growers";
    let pool = await all(ctx.db, `SELECT DISTINCT l.user_id FROM ledger l WHERE l.chat_id = ? AND l.reason = 'grow' AND l.created_at > ? AND NOT EXISTS (SELECT 1 FROM blocks bl WHERE bl.chat_id = l.chat_id AND bl.user_id = l.user_id) ORDER BY l.user_id`, chat.id, now - DAY);
    if (pool.length === 0) { source = "all_members"; pool = await all(ctx.db, `SELECT m.user_id FROM members m WHERE m.chat_id = ? AND NOT EXISTS (SELECT 1 FROM blocks bl WHERE bl.chat_id = m.chat_id AND bl.user_id = m.user_id) ORDER BY m.user_id`, chat.id); }
    if (pool.length === 0) { await ctx.tg.sendMessage(chat.id, "No eligible players for the draw yet."); return; }
    const winnerId = pool[ctx.rng.int(0, pool.length - 1)].user_id, prize = ctx.rng.int(DAY_PRIZE_MIN, DAY_PRIZE_MAX);
    const tokenGuard = { sql: `EXISTS (SELECT 1 FROM day_draws WHERE token = ?)`, params: [token] };
    const rs = await ctx.db.batch([
      st(ctx.db, `INSERT INTO day_draws (chat_id, draw_no, drawn_at, winner_id, prize, source, token) SELECT ?, (SELECT COALESCE(MAX(draw_no), 0) + 1 FROM day_draws WHERE chat_id = ?), ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM groups WHERE chat_id = ? AND status = 'active' AND (last_day_draw_at IS NULL OR last_day_draw_at <= ?))`, chat.id, chat.id, now, winnerId, prize, source, token, chat.id, now - DAY),
      st(ctx.db, `UPDATE groups SET last_day_draw_at = ?, updated_at = ? WHERE chat_id = ? AND ${tokenGuard.sql}`, now, now, chat.id, token),
      st(ctx.db, `INSERT INTO day_draw_participants (chat_id, draw_no, user_id) SELECT d.chat_id, d.draw_no, CAST(j.value AS INTEGER) FROM day_draws d, json_each(?) j WHERE d.token = ?`, JSON.stringify(pool.map((p) => p.user_id)), token),
      ...deltaStmts(ctx.db, { chatId: chat.id, userId: winnerId, delta: prize, reason: "day_prize", opKey: `day:${token}`, now, guard: tokenGuard }),
    ]);
    if ((rs[0].meta?.changes ?? 0) !== 1) { const g = await getGroup(ctx, chat.id), left = g?.last_day_draw_at != null ? g.last_day_draw_at + DAY - now : DAY; await ctx.tg.sendMessage(chat.id, `⏳ Today's draw is already done. Next draw in ${b(formatRemaining(left))}.`); return; }
    draw = await first(ctx.db, `SELECT draw_no, winner_id, prize, drawn_at FROM day_draws WHERE token = ?`, token);
  }
  if (!draw) return;
  const w = await getMember(ctx, chat.id, draw.winner_id), rank = await rankOf(ctx, chat.id, draw.winner_id);
  await ctx.tg.sendMessage(chat.id, `${b("The Rank of the Day is " + (w?.display_name ?? draw.winner_id) + "!")}\n\nTheir rank length increased by ${b(draw.prize + " cm")} and is now ${b((w?.balance ?? 0) + " cm")} long.\n\nTheir position in the top is ${b(rank)}.\n\nNext draw in ${b(formatRemaining(draw.drawn_at + DAY - now))}.`);
  await checkWinner(ctx, chat.id);
}
async function cmdBlock(ctx, chat, actor, target, off) {
  if (target.is_bot) { await ctx.tg.sendMessage(chat.id, "Bots cannot be blocked."); return; }
  if (target.id === actor.id) { await ctx.tg.sendMessage(chat.id, "You cannot block yourself."); return; }
  const m = await ensureMember(ctx, chat.id, target), now = ctx.now();
  if (off) {
    const n = await run(ctx.db, `DELETE FROM blocks WHERE chat_id = ? AND user_id = ?`, chat.id, target.id);
    await run(ctx.db, `INSERT INTO audit_log (chat_id, actor_id, action, target_user_id, created_at) VALUES (?, ?, 'unblock', ?, ?)`, chat.id, actor.id, target.id, now);
    await ctx.tg.sendMessage(chat.id, n ? `✅ ${b(m.display_name)} is unblocked.` : `${b(m.display_name)} was not blocked.`);
    return;
  }
  await ctx.db.batch([st(ctx.db, `INSERT OR IGNORE INTO blocks (chat_id, user_id, blocked_by, created_at) VALUES (?, ?, ?, ?)`, chat.id, target.id, actor.id, now), st(ctx.db, `INSERT INTO audit_log (chat_id, actor_id, action, target_user_id, created_at) VALUES (?, ?, 'block', ?, ?)`, chat.id, actor.id, target.id, now)]);
  await cancelUserMatches(ctx, chat.id, target.id, "blocked");
  await ctx.tg.sendMessage(chat.id, `🚫 ${b(m.display_name)} is blocked from /grow, /pvp and /day. Their data is kept.`);
}

// === Admin ===
const PANEL_TTL_S = 30 * 60, MAX_VALUE = 1000000000;
async function getRole(ctx, chatId, userId) { const r = await ctx.tg.getChatMember(chatId, userId); if (!r.ok) return "member"; if (r.result.status === "creator") return "owner"; if (r.result.status === "administrator") return "admin"; return "member"; }
const isAdmin = (r) => r === "owner" || r === "admin";
function mainPanel(group, role, players, candidates) {
  const status = group.status === "active" ? "active" : group.status === "pending_winner" ? "waiting for winner confirmation" : "finished (waiting for new round)";
  const text = `🛠 ${b("Dek Rankd panel")}\n\nRound: ${b(group.round)} · Status: ${b(status)}\nWin target: ${b(group.win_target + " cm")}\nInactivity deadline: ${b(group.inactivity_days + " day" + (group.inactivity_days === 1 ? "" : "s"))}\nRegistered players: ${b(players)}`;
  const rows = [[{ text: "🎯 Win target", callback_data: "p:t" }, { text: "⏳ Inactivity days", callback_data: "p:i" }]];
  if (role === "owner") { rows.push([{ text: "👤 User tools", callback_data: "p:u" }]); if (group.status === "pending_winner") for (const id of candidates.slice(0, 6)) rows.push([{ text: `🏆 Confirm winner #${id}`, callback_data: `wc:${id}` }]); if (group.status === "finished") rows.push([{ text: "🔄 Start new round", callback_data: "wn" }]); }
  rows.push([{ text: "🔃 Refresh", callback_data: "p:r" }]);
  return { text, markup: { inline_keyboard: rows } };
}
async function renderMain(ctx, chatId, role) { const group = await getGroup(ctx, chatId), players = await countMembers(ctx, chatId), cands = group.pending_candidates ? JSON.parse(group.pending_candidates) : []; return mainPanel(group, role, players, cands); }
async function cmdPanel(ctx, chat, actor, replied) {
  await ensureGroup(ctx, chat);
  const role = await getRole(ctx, chat.id, actor.id);
  if (!isAdmin(role)) { await ctx.tg.sendMessage(chat.id, "🔒 The panel is only available to group admins."); return; }
  if (replied && !replied.is_bot && role === "owner") { const card = await userCard(ctx, chat.id, replied.id); if (card) { await ctx.tg.sendMessage(chat.id, card.text, { reply_markup: card.markup }); return; } await ctx.tg.sendMessage(chat.id, "That user has not joined the game yet."); return; }
  const m = await renderMain(ctx, chat.id, role);
  await ctx.tg.sendMessage(chat.id, m.text, { reply_markup: m.markup });
}
async function userCard(ctx, chatId, userId) {
  const m = await getMember(ctx, chatId, userId);
  if (!m) return null;
  const locked = await lockedOf(ctx, chatId, userId), blocked = await isBlocked(ctx, chatId, userId);
  const gPoints = await first(ctx.db, `SELECT points FROM global_points WHERE user_id = ?`, userId);
  const text = `👤 ${b(m.display_name)} (${code(userId)})\n\nLength: ${b(m.balance + " cm")} · locked ${locked} cm · free ${m.balance - locked} cm\nGlobal Points: ${b(gPoints?.points ?? 0)}\nWins/Losses: ${b(m.wins)}/${b(m.losses)}\nBlocked: ${b(blocked ? "yes" : "no")}\nPost-split special window: ${b(m.special_active ? (m.special_deadline_at ? "running" : "armed (starts at next /grow)") : "no")}`;
  const u = userId;
  return { text, markup: { inline_keyboard: [
    [{ text: "⭐ +1 Point", callback_data: `p:up:${u}` }, { text: "⭐ -1 Point", callback_data: `p:um:${u}` }],
    [{ text: "−100", callback_data: `p:ua:${u}:-100` }, { text: "−10", callback_data: `p:ua:${u}:-10` }, { text: "+10", callback_data: `p:ua:${u}:10` }, { text: "+100", callback_data: `p:ua:${u}:100` }],
    [{ text: "✏️ Set value", callback_data: `p:us:${u}` }, { text: "➕ Custom Δ", callback_data: `p:uc:${u}` }],
    [{ text: "📜 History", callback_data: `p:uh:${u}` }, { text: blocked ? "✅ Unblock" : "🚫 Block", callback_data: `p:${blocked ? "uu" : "ub"}:${u}` }]
  ] } };
}
function menu(title, current, rows) { return { text: `${title}\nCurrent: ${b(current)}`, markup: { inline_keyboard: [...rows.map((r) => r.map(([t, d]) => ({ text: t, callback_data: d }))), [{ text: "⬅️ Back", callback_data: "p:b" }]] } }; }
async function setWinTarget(ctx, chatId, actorId, value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_VALUE) return "The win target must be a whole number between 1 and 1,000,000,000 cm.";
  const g = await getGroup(ctx, chatId);
  if (!g) return "Group not found.";
  if (g.status === "finished") {
    const top = await topBalance(ctx, chatId);
    if (value <= top) return `Cannot set: the new target (${value} cm) must be higher than the current top length (${top} cm).`;
  }
  const now = ctx.now();
  await ctx.db.batch([st(ctx.db, `UPDATE groups SET win_target = ?, updated_at = ? WHERE chat_id = ?`, value, now, chatId), syncGroupStmt(ctx.db, chatId, now), st(ctx.db, `INSERT INTO audit_log (chat_id, actor_id, action, detail, created_at) VALUES (?, ?, 'set_win_target', ?, ?)`, chatId, actorId, JSON.stringify({ from: g.win_target, to: value }), now)]);
  await resyncAfterTargetChange(ctx, chatId);
  if (g.status === "active") await checkWinner(ctx, chatId);
  return `Win target is now ${value} cm.`;
}
async function setInactivityDays(ctx, chatId, actorId, days) {
  if (!Number.isInteger(days) || days < 1 || days > 365) return "Inactivity days must be a whole number between 1 and 365.";
  const g = await getGroup(ctx, chatId);
  if (!g) return "Group not found.";
  const now = ctx.now();
  await ctx.db.batch([st(ctx.db, `UPDATE groups SET inactivity_days = ?, updated_at = ? WHERE chat_id = ?`, days, now, chatId), st(ctx.db, `INSERT INTO audit_log (chat_id, actor_id, action, detail, created_at) VALUES (?, ?, 'set_inactivity_days', ?, ?)`, chatId, actorId, JSON.stringify({ from: g.inactivity_days, to: days }), now)]);
  return `Inactivity deadline is now ${days} day${days === 1 ? "" : "s"}.`;
}
async function adjustBalance(ctx, chatId, ownerId, targetId, mode, value, reasonText) {
  if (!Number.isInteger(value) || Math.abs(value) > MAX_VALUE) return "The value must be a whole number (|value| ≤ 1,000,000,000).";
  const m = await getMember(ctx, chatId, targetId);
  if (!m) return "That user has not joined the game yet.";
  const delta = mode === "set" ? value - m.balance : value;
  if (delta === 0) return "No change: the value is already that.";
  const now = ctx.now(), guard = and({ sql: "members.balance = ?", params: [m.balance] }, { sql: `members.balance + ? >= ${lockedExpr("members.chat_id", "members.user_id")}`, params: [delta] });
  const reason = mode === "set" ? "admin_set" : delta > 0 ? "admin_add" : "admin_sub";
  const rs = await ctx.db.batch(deltaStmts(ctx.db, { chatId, userId: targetId, delta, reason, opKey: `admin:${ctx.rng.token()}`, now, actorId: ownerId, note: (reasonText || "panel").slice(0, 200), guard }));
  if ((rs[0].meta?.changes ?? 0) !== 1) { const locked = await lockedOf(ctx, chatId, targetId); return `Rejected: the total cannot go below the locked PvP bets (${locked} cm), or the value changed meanwhile. Try again.`; }
  await checkWinner(ctx, chatId);
  const after = await getMember(ctx, chatId, targetId);
  return `${m.display_name}: ${m.balance} cm → ${after?.balance ?? "?"} cm (${delta > 0 ? "+" : ""}${delta}).`;
}
async function startPrompt(ctx, chatId, userId, action, targetId, text) {
  const sent = await ctx.tg.sendMessage(chatId, text, { reply_markup: { force_reply: true, selective: true } });
  if (!sent.ok) return;
  await run(ctx.db, `INSERT OR REPLACE INTO pending_inputs (chat_id, user_id, action, target_user_id, prompt_message_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)`, chatId, userId, action, targetId, sent.result.message_id, ctx.now() + 10 * 60000);
}
async function startPointPasswordPrompt(ctx, chatId, userId, targetId, displayName, mode) {
  const actionStr = mode === "sub" ? "point_pwd_sub" : "point_pwd_add";
  const verb = mode === "sub" ? "remove 1 Global Point from" : "give 1 Global Point to";
  const sent = await ctx.tg.sendMessage(chatId, `🔐 ${b("Security Check")}\n\nReply to this message with the SECURITY PASSWORD to ${verb} ${b(displayName)}.\n\n⚠️ <i>Your reply will be deleted immediately. Make sure I have the "Delete Messages" admin permission. This prompt expires in 2 minutes.</i>`, { reply_markup: { force_reply: true, selective: true } });
  if (!sent.ok) return;
  await run(ctx.db, `INSERT OR REPLACE INTO pending_inputs (chat_id, user_id, action, target_user_id, prompt_message_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)`, chatId, userId, actionStr, targetId, sent.result.message_id, ctx.now() + PROMPT_TTL_MS);
}
async function consumePendingInput(ctx, chat, from, text, replyToMessageId, msgId) {
  if (replyToMessageId === undefined) return false;
  const row = await first(ctx.db, `SELECT action, target_user_id, prompt_message_id, expires_at FROM pending_inputs WHERE chat_id = ? AND user_id = ?`, chat.id, from.id);
  if (!row || row.prompt_message_id !== replyToMessageId) return false;
  const taken = await run(ctx.db, `DELETE FROM pending_inputs WHERE chat_id = ? AND user_id = ? AND prompt_message_id = ?`, chat.id, from.id, replyToMessageId);
  if (taken !== 1) return true;
  if (row.action === "point_pwd_add" || row.action === "point_pwd_sub") {
    try { await ctx.tg.deleteMessage(chat.id, msgId); } catch {}
    try { await ctx.tg.deleteMessage(chat.id, row.prompt_message_id); } catch {}
    if (row.expires_at < ctx.now()) { await ctx.tg.sendMessage(chat.id, "❌ Password prompt expired."); return true; }
    if (!(await checkRateLimit(ctx, chat.id, from.id))) { await logSecurityAttempt(ctx, chat.id, from.id, row.action, false); await ctx.tg.sendMessage(chat.id, "🚫 Too many failed attempts. Please wait 15 minutes."); return true; }
    const expected = getRequiredSecret(ctx);
    if (!expected) { await ctx.tg.sendMessage(chat.id, "❌ Point management is disabled (secret not configured)."); return true; }
    const provided = (text || "").trim();
    const ok = timingSafeEqual(provided, expected);
    await logSecurityAttempt(ctx, chat.id, from.id, row.action, ok);
    if (!ok) { await ctx.tg.sendMessage(chat.id, "❌ Wrong password. This attempt was logged."); return true; }
    const m = await getMember(ctx, chat.id, row.target_user_id);
    if (!m) { await ctx.tg.sendMessage(chat.id, "❌ User not found."); return true; }
    const isSub = row.action === "point_pwd_sub";
    if (isSub) {
      const current = await first(ctx.db, `SELECT points FROM global_points WHERE user_id = ?`, row.target_user_id);
      const pts = current ? current.points : 0;
      if (pts <= 0) { await ctx.tg.sendMessage(chat.id, `❌ ${b(m.display_name)} has 0 points already.`); return true; }
      await run(ctx.db, `UPDATE global_points SET points = points - 1, display_name = ? WHERE user_id = ?`, m.display_name, row.target_user_id);
    } else {
      await run(ctx.db, `INSERT INTO global_points (user_id, display_name, points) VALUES (?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET points = points + 1, display_name = excluded.display_name`, row.target_user_id, m.display_name);
    }
    const fresh = await first(ctx.db, `SELECT points FROM global_points WHERE user_id = ?`, row.target_user_id);
    const verb = isSub ? "lost" : "received";
    await ctx.tg.sendMessage(chat.id, `✅ ${b(m.display_name)} ${verb} 1 Global Point! New total: ${b(fresh.points)} pts.`);
    return true;
  }
  if (row.expires_at < ctx.now()) { await ctx.tg.sendMessage(chat.id, "That prompt expired. Open /panel again."); return true; }
  const role = await getRole(ctx, chat.id, from.id), ownerOnly = row.action === "uset" || row.action === "uadd";
  if (ownerOnly ? role !== "owner" : !isAdmin(role)) { await ctx.tg.sendMessage(chat.id, "🔒 You are not allowed to do that."); return true; }
  const m = /^\s*(-?\d{1,10})(?:\s+(.{1,200}))?\s*$/s.exec(text);
  if (!m) { await ctx.tg.sendMessage(chat.id, "Please reply with a whole number (optionally followed by a reason). Open /panel to try again."); return true; }
  const n = Number(m[1]), why = m[2] ?? "";
  let msg;
  if (row.action === "target") msg = await setWinTarget(ctx, chat.id, from.id, n);
  else if (row.action === "inact") msg = await setInactivityDays(ctx, chat.id, from.id, n);
  else if (row.action === "uset" && row.target_user_id != null) msg = await adjustBalance(ctx, chat.id, from.id, row.target_user_id, "set", n, why);
  else if (row.action === "uadd" && row.target_user_id != null) msg = await adjustBalance(ctx, chat.id, from.id, row.target_user_id, "add", n, why);
  else msg = "Unknown action.";
  await ctx.tg.sendMessage(chat.id, `✅ ${esc(msg)}`);
  return true;
}
async function handlePanelCallback(ctx, pc, data) {
  if (pc.messageDate === 0 || ctx.now() / 1000 - pc.messageDate > PANEL_TTL_S) return { toast: "This panel expired. Send /panel again.", alert: true };
  const role = await getRole(ctx, pc.chatId, pc.from.id);
  if (!isAdmin(role)) return { toast: "Only group admins can use this.", alert: true };
  const parts = data.split(":"), act = parts[1], ownerOnly = act === "u" || act === "ua" || act === "us" || act === "uc" || act === "uh" || act === "ub" || act === "uu" || act === "up" || act === "um";
  if (ownerOnly && role !== "owner") return { toast: "Only the real group owner can do that.", alert: true };
  const show = async (t) => { if (pc.messageId !== undefined) await ctx.tg.editMessageText(pc.chatId, pc.messageId, t.text, t.markup); };
  const group = await getGroup(ctx, pc.chatId);
  if (!group) return { toast: "Group not found.", alert: true };
  const targetId = Number(parts[2]);
  switch (act) {
    case "r": case "b": await show(await renderMain(ctx, pc.chatId, role)); return {};
    case "t": await show(menu(`🎯 ${b("Win target")}`, group.win_target + " cm", [[["−100", "p:ta:-100"], ["−50", "p:ta:-50"], ["+50", "p:ta:50"], ["+100", "p:ta:100"]], [["✏️ Custom", "p:tc"]]])); return {};
    case "ta": { const msg = await setWinTarget(ctx, pc.chatId, pc.from.id, group.win_target + Number(parts[2])); const fresh = await getGroup(ctx, pc.chatId); await show(menu(`🎯 ${b("Win target")}`, (fresh?.win_target ?? group.win_target) + " cm", [[["−100", "p:ta:-100"], ["−50", "p:ta:-50"], ["+50", "p:ta:50"], ["+100", "p:ta:100"]], [["✏️ Custom", "p:tc"]]])); return { toast: msg }; }
    case "tc": await startPrompt(ctx, pc.chatId, pc.from.id, "target", null, `${esc(pc.from.first_name ?? "Admin")}, reply to this message with the new win target in cm (whole number).`); return {};
    case "i": await show(menu(`⏳ ${b("Inactivity deadline")}`, group.inactivity_days + " day(s)", [[["−1", "p:ia:-1"], ["+1", "p:ia:1"]], [["1 d", "p:is:1"], ["3 d", "p:is:3"], ["7 d", "p:is:7"]], [["✏️ Custom", "p:ic"]]])); return {};
    case "ia": case "is": { const days = act === "ia" ? group.inactivity_days + Number(parts[2]) : Number(parts[2]); const msg = await setInactivityDays(ctx, pc.chatId, pc.from.id, days); const fresh = await getGroup(ctx, pc.chatId); await show(menu(`⏳ ${b("Inactivity deadline")}`, (fresh?.inactivity_days ?? group.inactivity_days) + " day(s)", [[["−1", "p:ia:-1"], ["+1", "p:ia:1"]], [["1 d", "p:is:1"], ["3 d", "p:is:3"], ["7 d", "p:is:7"]], [["✏️ Custom", "p:ic"]]])); return { toast: msg }; }
    case "ic": await startPrompt(ctx, pc.chatId, pc.from.id, "inact", null, `${esc(pc.from.first_name ?? "Admin")}, reply to this message with the inactivity deadline in days (1–365).`); return {};
    case "u": return { toast: "Reply to a player's message with /panel to open their tools.", alert: true };
    case "up": { const m = await getMember(ctx, pc.chatId, targetId); if (!m) return { toast: "Unknown user.", alert: true }; await startPointPasswordPrompt(ctx, pc.chatId, pc.from.id, targetId, m.display_name, "add"); return { toast: "Reply to the prompt in the group with the password.", alert: false }; }
    case "um": { const m = await getMember(ctx, pc.chatId, targetId); if (!m) return { toast: "Unknown user.", alert: true }; await startPointPasswordPrompt(ctx, pc.chatId, pc.from.id, targetId, m.display_name, "sub"); return { toast: "Reply to the prompt in the group with the password.", alert: false }; }
    case "ua": { const msg = await adjustBalance(ctx, pc.chatId, pc.from.id, targetId, "add", Number(parts[3]), "panel button"); const card = await userCard(ctx, pc.chatId, targetId); if (card) await show(card); return { toast: msg, alert: true }; }
    case "us": await startPrompt(ctx, pc.chatId, pc.from.id, "uset", targetId, "Reply to this message with the NEW total length in cm, optionally followed by a reason (e.g. <code>250 fixing a bug</code>)."); return {};
    case "uc": await startPrompt(ctx, pc.chatId, pc.from.id, "uadd", targetId, "Reply to this message with the change in cm (e.g. <code>-40</code> or <code>25 contest prize</code>)."); return {};
    case "uh": { const rows = await all(ctx.db, `SELECT delta, balance_before, balance_after, reason, actor_id, created_at FROM ledger WHERE chat_id = ? AND user_id = ? ORDER BY id DESC LIMIT 12`, pc.chatId, targetId); const lines = rows.map((r) => code(`${new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ")} ${r.delta >= 0 ? "+" : ""}${r.delta} (${r.balance_before}→${r.balance_after}) ${r.reason}${r.actor_id ? " by " + r.actor_id : ""}`)); await ctx.tg.sendMessage(pc.chatId, `📜 ${b("History")} of user ${code(targetId)}\n\n${lines.join("\n") || "No changes yet."}`); return {}; }
    case "ub": case "uu": { const m = await getMember(ctx, pc.chatId, targetId); if (!m) return { toast: "Unknown user.", alert: true }; await cmdBlock(ctx, { id: pc.chatId, type: "supergroup" }, pc.from, { id: targetId, first_name: m.display_name, username: m.username ?? undefined }, act === "uu"); const card = await userCard(ctx, pc.chatId, targetId); if (card) await show(card); return {}; }
    default: return { toast: "Unknown action.", alert: true };
  }
}

// === Router ===
function parseCommand(text, botUsername) {
  if (!text || text[0] !== "/") return null;
  const first = text.split(/\s+/)[0].slice(1), [name, target] = first.split("@");
  if (!/^[A-Za-z_]{1,32}$/.test(name)) return null;
  if (target && botUsername && target.toLowerCase() !== botUsername.toLowerCase()) return null;
  return { cmd: name.toLowerCase(), args: text.split(/\s+/).slice(1).filter(Boolean) };
}
function parseStake(args) { if (args.length !== 1 || !/^\d{1,9}$/.test(args[0])) return null; const n = Number(args[0]); return n >= 1 ? n : null; }

async function claimUpdate(ctx, updateId) {
  const now = ctx.now();
  const workerId = ctx.rng.token();
  const leaseExpires = now + UPDATE_LEASE_MS;
  const ins = await run(ctx.db, `INSERT OR IGNORE INTO processed_updates (update_id, status, received_at, worker_id, lease_expires_at) VALUES (?, 'processing', ?, ?, ?)`, updateId, now, workerId, leaseExpires);
  if (ins === 1) return { action: "run", workerId };
  const takeover = await run(ctx.db,
    `UPDATE processed_updates SET status = 'processing', received_at = ?, attempts = attempts + 1, worker_id = ?, lease_expires_at = ?
     WHERE update_id = ? AND (status = 'failed' OR (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))`,
    now, workerId, leaseExpires, updateId, now);
  if (takeover === 1) return { action: "run", workerId };
  return { action: "skip", workerId: null };
}
async function finishUpdate(ctx, updateId, workerId, ok) {
  if (!workerId) return;
  await run(ctx.db, `UPDATE processed_updates SET status = ?, completed_at = ?, worker_id = NULL, lease_expires_at = NULL WHERE update_id = ? AND worker_id = ?`, ok ? "done" : "failed", ctx.now(), updateId, workerId);
}

async function handleUpdate(ctx, update) {
  if (update.message) return handleMessage(ctx, update.update_id, update.message);
  if (update.callback_query) return handleCallback(ctx, update.callback_query);
  if (update.chat_member) return handleMemberChange(ctx, update.chat_member);
}
async function handleMessage(ctx, updateId, msg) {
  const from = msg.from;
  if (!from || from.is_bot) return;
  const chat = msg.chat, parsed = parseCommand(msg.text, ctx.botUsername);
  if (chat.type !== "group" && chat.type !== "supergroup") { if (parsed && (parsed.cmd === "start" || parsed.cmd === "help")) await ctx.tg.sendMessage(chat.id, "👋 Add me to a group (and make me an admin so I can see members leaving) to play DekTH X.\n\n" + HELP_TEXT); return; }
  if (!parsed) { if (msg.text && msg.reply_to_message) await consumePendingInput(ctx, chat, from, msg.text, msg.reply_to_message.message_id, msg.message_id); return; }
  if (from.id === ANON_ADMIN_BOT_ID || msg.sender_chat) { await ctx.tg.sendMessage(chat.id, "I cannot identify anonymous admins. Please turn off anonymous mode to use commands."); return; }
  const replied = msg.reply_to_message?.from;
  switch (parsed.cmd) {
    case "grow": return cmdGrow(ctx, chat, from, updateId);
    case "pvp": { const stake = parseStake(parsed.args); if (stake === null) { await ctx.tg.sendMessage(chat.id, "Usage: <code>/pvp 20</code> — the bet must be a whole number of cm, at least 1."); return; } return createPvp(ctx, chat, from, stake, updateId); }
    case "day": case "dick_of_day": return cmdDay(ctx, chat, from, updateId);
    case "stats": return cmdStats(ctx, chat, from, replied);
    case "top": return cmdTop(ctx, chat, from);
    case "ontop": return cmdOnTop(ctx, chat, from);
    case "help": case "start": await sendLongMessage(ctx, chat.id, HELP_TEXT); return;
    case "panel": return cmdPanel(ctx, chat, from, replied);
    case "block": { await ensureGroup(ctx, chat); if ((await getRole(ctx, chat.id, from.id)) !== "owner") { await ctx.tg.sendMessage(chat.id, "🔒 Only the real group owner can block or unblock players."); return; } if (!replied) { await ctx.tg.sendMessage(chat.id, "Reply to the user's message with /block (or /block off)."); return; } return cmdBlock(ctx, chat, from, replied, parsed.args[0]?.toLowerCase() === "off"); }
    default: return;
  }
}
async function handleCallback(ctx, cq) {
  const answer = (t, alert = false) => ctx.tg.answerCallbackQuery(cq.id, t, alert);
  const msg = cq.message, data = cq.data ?? "";
  if (!msg || cq.from.is_bot) { await answer(); return; }
  const chatId = msg.chat.id;
  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") { await answer(); return; }
  if (data.startsWith("pa:") || data.startsWith("pc:")) { const id = Number(data.slice(3)); if (!Number.isInteger(id)) { await answer("Invalid button.", true); return; } const t = data.startsWith("pa:") ? await acceptPvp(ctx, chatId, id, cq.from) : await cancelPvpByCreator(ctx, chatId, id, cq.from.id); await answer(t.text, t.alert); return; }
  if (data.startsWith("t:")) {
    const [, chatStr, pageStr] = data.split(":"), page = Number(pageStr);
    if (Number(chatStr) !== chatId || !Number.isInteger(page) || page < 0 || msg.date === 0 || ctx.now() / 1000 - msg.date > 600) { await answer("This list expired. Send /top again.", true); return; }
    const group = await getGroup(ctx, chatId);
    if (!group) { await answer(); return; }
    const r = await renderTop(ctx, group, page);
    if (page !== r.page) { await answer("This list expired. Send /top again.", true); return; }
    await ctx.tg.editMessageText(chatId, msg.message_id, r.text, r.markup); await answer(); return;
  }
  if (data.startsWith("wc:") || data === "wn") {
    if ((await getRole(ctx, chatId, cq.from.id)) !== "owner") { await answer("Only the real group owner can do that.", true); return; }
    const res = data === "wn" ? await startNewRound(ctx, chatId, cq.from.id) : await confirmWinner(ctx, chatId, cq.from.id, Number(data.slice(3)));
    await answer(res.message, !res.ok);
    if (res.ok) await ctx.tg.editMessageText(chatId, msg.message_id, msg.text ?? "Done.", undefined);
    return;
  }
  if (data.startsWith("p:")) { const r = await handlePanelCallback(ctx, { chatId, messageId: msg.message_id, messageDate: msg.date, from: cq.from }, data); await answer(r.toast, r.alert); return; }
  await answer();
}
async function handleMemberChange(ctx, u) {
  const status = u.new_chat_member.status;
  if (status !== "left" && status !== "kicked") return;
  const known = await first(ctx.db, `SELECT 1 AS x FROM groups WHERE chat_id = ?`, u.chat.id);
  if (!known) return;
  await cancelUserMatches(ctx, u.chat.id, u.new_chat_member.user.id, "member_left");
}

// === Scheduled ===
async function runScheduled(base, queryBudget) {
  const counter = { used: 0, limit: queryBudget }, ctx = { ...base, db: countingDb(base.db, counter) };
  const report = { groupsProcessed: 0, groupsFailed: 0, used: 0, pvpExpired: 0, pvpSettled: 0, splits: 0, outboxSent: 0, anniversary: 0 }, now = ctx.now();
  const rec = await recoverPvp(ctx); report.pvpExpired = rec.expired; report.pvpSettled = rec.settled;
  report.anniversary = await queueAnniversaryMessages(ctx);
  if (budgetLeft(counter, 3)) report.outboxSent += await flushOutbox(ctx, { limit: 5, minAgeMs: 30000 });
  if (new Date(now).getUTCMinutes() < 5 && budgetLeft(counter, 3)) { await run(ctx.db, `DELETE FROM processed_updates WHERE received_at < ?`, now - 3 * 86400000); await run(ctx.db, `DELETE FROM outbox WHERE status != 'pending' AND created_at < ?`, now - 14 * 86400000); }
  const groups = await all(ctx.db, `SELECT * FROM groups ORDER BY COALESCE(last_cron_at, 0) ASC, chat_id ASC LIMIT 25`);
  for (const g of groups) {
    if (!budgetLeft(counter, 12)) break;
    try {
      if (g.status === "active") { const taxDone = await processTax(ctx, g, counter); if (taxDone) { report.splits += await processInactivity(ctx, g, counter); await run(ctx.db, `UPDATE groups SET last_cron_at = ? WHERE chat_id = ?`, ctx.now(), g.chat_id); report.groupsProcessed++; } }
      else { await run(ctx.db, `UPDATE groups SET last_cron_at = ? WHERE chat_id = ?`, ctx.now(), g.chat_id); report.groupsProcessed++; }
    } catch (e) { report.groupsFailed++; console.error("scheduled: group failed", g.chat_id, e instanceof Error ? e.message : e); if (budgetLeft(counter, 1)) await run(ctx.db, `UPDATE groups SET last_cron_at = ? WHERE chat_id = ?`, ctx.now(), g.chat_id); }
  }
  if (budgetLeft(counter, 3)) report.outboxSent += await flushOutbox(ctx, { limit: 8, minAgeMs: 0 });
  report.used = counter.used; return report;
}

// === Entry Point & Setup ===
function buildCtx(env, fetchImpl = fetch) { return { db: env.DB, tg: createTelegramApi(env.TELEGRAM_BOT_TOKEN, fetchImpl), now: () => Date.now(), rng: cryptoRng, botUsername: env.BOT_USERNAME ?? "", env }; }
async function handleRequest(request, env, ctx = null) {
  const url = new URL(request.url);
  if (url.pathname === "/health") return new Response("ok", { status: 200 });
  if (url.pathname !== WEBHOOK_PATH) return new Response("not found", { status: 404 });
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) { console.error("missing required secrets"); return new Response("server misconfigured", { status: 500 }); }
  const provided = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!timingSafeEqual(provided, env.TELEGRAM_WEBHOOK_SECRET)) return new Response("forbidden", { status: 403 });
  let update;
  try { update = await request.json(); } catch { return new Response("bad request", { status: 400 }); }
  if (!update || typeof update !== "object" || !Number.isSafeInteger(update.update_id)) return new Response("bad request", { status: 400 });
  const c = ctx ?? buildCtx(env);
  let claim;
  try { claim = await claimUpdate(c, update.update_id); } catch (e) { console.error("claimUpdate failed", e instanceof Error ? e.message : e); return new Response("temporarily unavailable", { status: 503 }); }
  if (claim.action === "skip") return new Response("ok", { status: 200 });
  try { await handleUpdate(c, update); await finishUpdate(c, update.update_id, claim.workerId, true); } catch (e) { console.error("handleUpdate failed", update.update_id, e instanceof Error ? e.message : e); try { await finishUpdate(c, update.update_id, claim.workerId, false); } catch {} const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id; if (chatId !== undefined) await c.tg.sendMessage(chatId, "⚠️ Something went wrong. Please try again in a moment."); }
  return new Response("ok", { status: 200 });
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS groups (chat_id INTEGER PRIMARY KEY, title TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending_winner','finished')), round INTEGER NOT NULL DEFAULT 1, win_target INTEGER NOT NULL DEFAULT 500 CHECK (win_target >= 1), inactivity_days INTEGER NOT NULL DEFAULT 3 CHECK (inactivity_days BETWEEN 1 AND 365), last_day_draw_at INTEGER, paused_at INTEGER, tax_not_before_day TEXT, winner_candidate_id INTEGER, pending_candidates TEXT, winner_confirmed_id INTEGER, finished_at INTEGER, op_token TEXT, last_cron_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS members (chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, username TEXT, display_name TEXT NOT NULL, balance INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, streak INTEGER NOT NULL DEFAULT 0, max_streak INTEGER NOT NULL DEFAULT 0, registered_at INTEGER NOT NULL, last_grow_at INTEGER, last_pvp_at INTEGER, activity_anchor_at INTEGER NOT NULL, tax_start_day TEXT, special_active INTEGER NOT NULL DEFAULT 0 CHECK (special_active IN (0,1)), special_deadline_at INTEGER, reached_target_at INTEGER, op_token TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (chat_id, user_id), FOREIGN KEY (chat_id) REFERENCES groups (chat_id)) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS idx_members_rank ON members (chat_id, balance DESC, registered_at, user_id)`,
  `CREATE TABLE IF NOT EXISTS blocks (chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, blocked_by INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (chat_id, user_id), FOREIGN KEY (chat_id) REFERENCES groups (chat_id)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, delta INTEGER NOT NULL, balance_before INTEGER NOT NULL, balance_after INTEGER NOT NULL, reason TEXT NOT NULL, actor_id INTEGER, note TEXT, op_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, FOREIGN KEY (chat_id) REFERENCES groups (chat_id))`,
  `CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger (chat_id, user_id, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ledger_reason ON ledger (chat_id, reason, created_at)`,
  `CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, actor_id INTEGER, action TEXT NOT NULL, target_user_id INTEGER, detail TEXT, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_chat ON audit_log (chat_id, id DESC)`,
  `CREATE TABLE IF NOT EXISTS pvp_matches (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, creator_id INTEGER NOT NULL, opponent_id INTEGER, stake INTEGER NOT NULL CHECK (stake >= 1), status TEXT NOT NULL CHECK (status IN ('open','accepted','resolved','cancelled','expired')), message_id INTEGER, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, accepted_at INTEGER, resolved_at INTEGER, winner_id INTEGER, loser_id INTEGER, resolve_token TEXT, end_reason TEXT, create_key TEXT UNIQUE, loser_streak_lost INTEGER DEFAULT 0, FOREIGN KEY (chat_id) REFERENCES groups (chat_id))`,
  `CREATE INDEX IF NOT EXISTS idx_pvp_chat_status ON pvp_matches (chat_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_pvp_expiry ON pvp_matches (status, expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_pvp_resolved ON pvp_matches (chat_id, resolved_at)`,
  `CREATE TABLE IF NOT EXISTS day_draws (chat_id INTEGER NOT NULL, draw_no INTEGER NOT NULL, drawn_at INTEGER NOT NULL, winner_id INTEGER NOT NULL, prize INTEGER NOT NULL, source TEXT NOT NULL CHECK (source IN ('active_growers','all_members')), token TEXT NOT NULL UNIQUE, PRIMARY KEY (chat_id, draw_no), FOREIGN KEY (chat_id) REFERENCES groups (chat_id))`,
  `CREATE TABLE IF NOT EXISTS day_draw_participants (chat_id INTEGER NOT NULL, draw_no INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (chat_id, draw_no, user_id), FOREIGN KEY (chat_id, draw_no) REFERENCES day_draws (chat_id, draw_no)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS processed_updates (update_id INTEGER PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('processing','done','failed')), attempts INTEGER NOT NULL DEFAULT 1, received_at INTEGER NOT NULL, completed_at INTEGER, worker_id TEXT, lease_expires_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_processed_received ON processed_updates (received_at)`,
  `CREATE TABLE IF NOT EXISTS jobs (job_key TEXT PRIMARY KEY, kind TEXT NOT NULL, chat_id INTEGER NOT NULL, day_id TEXT, stage TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','skipped','failed')), attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_chat ON jobs (chat_id, kind, status)`,
  `CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')), attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, sent_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox (status, chat_id, id)`,
  `CREATE TABLE IF NOT EXISTS pending_inputs (chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, action TEXT NOT NULL, target_user_id INTEGER, prompt_message_id INTEGER, expires_at INTEGER NOT NULL, PRIMARY KEY (chat_id, user_id)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS global_points (user_id INTEGER PRIMARY KEY, display_name TEXT NOT NULL, points INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS point_security_log (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, action TEXT NOT NULL, success INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_psl_rl ON point_security_log (chat_id, user_id, success, created_at)`,
  `CREATE TABLE IF NOT EXISTS setup_attempts (ip TEXT NOT NULL, success INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_setup_rl ON setup_attempts (ip, success, created_at)`
];

const MIGRATIONS = [
  `ALTER TABLE members ADD COLUMN streak INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE members ADD COLUMN max_streak INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE pvp_matches ADD COLUMN loser_streak_lost INTEGER DEFAULT 0`,
  `ALTER TABLE processed_updates ADD COLUMN worker_id TEXT`,
  `ALTER TABLE processed_updates ADD COLUMN lease_expires_at INTEGER`
];

const POST_MIGRATIONS = [
  `UPDATE groups SET win_target = 500 WHERE win_target = 400`
];

let _schInit = false;
async function ensureSchema(env) {
  if (_schInit) return;
  try {
    for (const s of SCHEMA) {
      try { await env.DB.prepare(s).run(); } catch (e) { if (!String(e.message).includes("already exists")) throw e; }
    }
    for (const m of MIGRATIONS) {
      try { await env.DB.prepare(m).run(); } catch (e) { if (!String(e.message).includes("duplicate column name")) throw e; }
    }
    for (const m of POST_MIGRATIONS) {
      try { await env.DB.prepare(m).run(); } catch (e) {}
    }
    _schInit = true;
  } catch (e) {
    console.error("Schema initialization failed:", e);
    throw e;
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      await ensureSchema(env);
      const url = new URL(request.url);
      if (url.pathname === "/setup") {
        if (request.method !== "POST") {
          return new Response("Method Not Allowed. Please use POST with X-Setup-Key header.", { status: 405 });
        }
        const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
        if (!(await checkSetupRateLimit(env, ip))) {
          return new Response("Too Many Requests", { status: 429 });
        }

        const expectedKey = env.TELEGRAM_WEBHOOK_SECRET;
        if (!expectedKey || typeof expectedKey !== "string" || expectedKey.length < 16) {
          console.error("setup: TELEGRAM_WEBHOOK_SECRET is missing or shorter than 16 chars");
          return new Response("Server misconfigured: TELEGRAM_WEBHOOK_SECRET must be at least 16 characters", { status: 500 });
        }

        const providedKey = request.headers.get("X-Setup-Key") ?? "";
        if (!timingSafeEqual(providedKey, expectedKey)) {
          await logSetupAttempt(env, ip, false);
          console.warn("setup: invalid key attempt", { ip });
          return new Response("Forbidden", { status: 403 });
        }

        const token = env.TELEGRAM_BOT_TOKEN;
        if (!token) {
          console.error("setup: TELEGRAM_BOT_TOKEN missing");
          return new Response("Server misconfigured", { status: 500 });
        }

        let whBase;
        if (env.WORKER_URL && typeof env.WORKER_URL === "string" && /^https:\/\//i.test(env.WORKER_URL)) {
          whBase = env.WORKER_URL.replace(/\/+$/, "");
        } else {
          whBase = url.origin.replace(/^http:/i, "https:");
          console.warn("setup: WORKER_URL not set, falling back to request origin:", whBase);
        }
        const whUrl = `${whBase}${WEBHOOK_PATH}`;

        const whRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: whUrl,
            secret_token: expectedKey,
            allowed_updates: ["message", "callback_query", "chat_member", "my_chat_member"]
          })
        }).then(r => r.json());

        const cmdRes = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ commands: [
            { command: "help", description: "I'll help you, my friend" },
            { command: "grow", description: "Grow your dick!" },
            { command: "top", description: "Get the biggest dicks of the chat" },
            { command: "dick_of_day", description: "Elect the Dick of a Day" },
            { command: "pvp", description: "Fight with your friends' dick" }
          ] })
        }).then(r => r.json());

        if (whRes.ok && cmdRes.ok) await logSetupAttempt(env, ip, true);
        console.log("setup: webhook configured", { ok: whRes.ok && cmdRes.ok, whUrl });

        return new Response(JSON.stringify({
          ok: whRes.ok && cmdRes.ok,
          webhook_url: whUrl,
          webhook: whRes.description || "ok",
          commands: cmdRes.description || "ok"
        }, null, 2), { headers: { "Content-Type": "application/json" } });
      }
      return handleRequest(request, env);
    } catch (e) { console.error("fetch error:", e); return new Response("Internal Server Error", { status: 500 }); }
  },
  async scheduled(_event, env) {
    try {
      await ensureSchema(env);
      const budget = Math.max(10, Number(env.CRON_QUERY_BUDGET ?? "40") || 40);
      const r = await runScheduled(buildCtx(env), budget);
      console.log("scheduled", JSON.stringify(r));
    } catch (e) { console.error("scheduled failed", e); throw e; }
  }
};