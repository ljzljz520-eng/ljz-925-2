/**
 * server.js — 摄影作品限时查看系统
 * 客户端: 卡密兑换 / 作品列表 / 心跳(封禁即时踢出)
 * 管理端: 登录 / 生成卡密 / 统计 / 日志 / 导出 CSV
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, stmts, now, log, checkKeyUsable } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

app.use(express.json());
app.disable('x-powered-by');

/* ============ 初始化: 登记作品 ============ */
(function seedPhotos() {
  if (stmts.countPhotos.get().c > 0) return;
  const titles = ['山间晨雾', '暮色海岸', '雪原孤树', '沙漠落日', '森林光斑', '城市夜色', '秋日湖畔', '星空旷野'];
  titles.forEach((t, i) => stmts.insertPhoto.run(t, `photo-${i + 1}.svg`, i + 1));
  console.log('[seed] 已登记', titles.length, '张作品');
})();

/* ============ 工具 ============ */
const KEY_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆字符 0/O 1/I
function genKeyText() {
  const seg = () => Array.from({ length: 4 }, () => KEY_CHARS[crypto.randomInt(KEY_CHARS.length)]).join('');
  return `${seg()}-${seg()}-${seg()}`;
}
const clientIp = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();

/* 限流器: 每个接口独立计数, 默认 10 次 / 10 秒 / IP, 可用环境变量调整 */
function makeRateLimit(max, windowMs = 10_000) {
  const hits = new Map();
  return (req, res, next) => {
    const ip = clientIp(req);
    const nowMs = Date.now();
    const arr = (hits.get(ip) || []).filter((t) => nowMs - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: '尝试过于频繁，请稍后再试' });
    arr.push(nowMs);
    hits.set(ip, arr);
    next();
  };
}
const redeemLimit = makeRateLimit(Number(process.env.RATE_LIMIT_REDEEM) || 10);
const loginLimit = makeRateLimit(Number(process.env.RATE_LIMIT_LOGIN) || 5);

/* ============ 客户端 API ============ */

/** 兑换卡密 → 签发会话 token */
app.post('/api/redeem', redeemLimit, (req, res) => {
  const keyText = String(req.body.key || '').trim().toUpperCase();
  const ip = clientIp(req);
  if (!keyText) return res.status(400).json({ error: '请输入卡密' });

  const k = stmts.getKeyByText.get(keyText);
  const check = checkKeyUsable(k);
  if (!check.ok) {
    const msgMap = { invalid: '卡密不存在', banned: '该卡密已被封禁', expired: '该卡密已过期', exhausted: '该卡密使用次数已用完' };
    log('redeem_fail', { keyId: k ? k.id : null, keyText, detail: msgMap[check.reason], ip });
    return res.status(403).json({ error: msgMap[check.reason], reason: check.reason });
  }

  stmts.incUsed.run(k.id);
  const token = crypto.randomUUID();
  stmts.insertSession.run({
    token, key_id: k.id, ip,
    user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
    created_at: now(), last_seen: now(),
  });
  log('redeem', { keyId: k.id, keyText, detail: `第 ${k.used_count + 1} 次使用`, ip });
  res.json({ token, key: keyText });
});

/**
 * 会话校验: 返回 { ok, reason?, key }
 * 供 作品接口 / 心跳 复用。
 * 先查卡密状态再查会话状态: 封禁/过期/次数耗尽时注销该卡密下所有会话,
 * 并仅在会话仍在线时记录一次"踢出"日志, 保证原因准确、日志不重复。
 */
function resolveSession(token, ip) {
  if (!token) return { ok: false, reason: 'invalid' };
  const s = stmts.getSession.get(token);
  if (!s) return { ok: false, reason: 'invalid' };
  const k = stmts.getKeyById.get(s.key_id);
  const check = checkKeyUsable(k);
  if (!check.ok) {
    if (s.active) {
      stmts.deactivateByKey.run(s.key_id);
      log('heartbeat_kick', { keyId: k.id, keyText: k.key, detail: `浏览中被请出(${check.reason})`, ip });
    }
    return { ok: false, reason: check.reason, key: k };
  }
  if (!s.active) return { ok: false, reason: 'invalid' };
  stmts.touchSession.run(now(), token);
  return { ok: true, key: k, session: s };
}

/** 心跳: 前端每 5 秒调用一次, 封禁/过期立即被发现 */
app.post('/api/heartbeat', (req, res) => {
  const r = resolveSession(String(req.body.token || ''), clientIp(req));
  if (!r.ok) return res.status(403).json({ ok: false, reason: r.reason });
  res.json({
    ok: true,
    key: {
      text: r.key.key,
      expires_at: r.key.expires_at,
      max_uses: r.key.max_uses,
      used_count: r.key.used_count,
    },
    server_time: now(),
  });
});

/** 作品列表 */
app.get('/api/photos', (req, res) => {
  const r = resolveSession(String(req.headers['x-session'] || ''), clientIp(req));
  if (!r.ok) return res.status(403).json({ ok: false, reason: r.reason });
  res.json({ photos: stmts.listPhotos.all().map((p) => ({ id: p.id, title: p.title })) });
});

/** 作品文件(受保护) */
app.get('/api/photo/:id', (req, res) => {
  const r = resolveSession(String(req.headers['x-session'] || req.query.token || ''), clientIp(req));
  if (!r.ok) return res.status(403).json({ ok: false, reason: r.reason });
  const p = stmts.getPhoto.get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const file = path.join(__dirname, 'photos', path.basename(p.filename));
  if (!fs.existsSync(file)) return res.status(404).json({ error: '文件缺失' });
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(file);
});

/* ============ 管理端 API ============ */

/* 管理员 token (内存保存, 重启后需重新登录) */
const adminTokens = new Map();
const TOKEN_TTL = 12 * 3600 * 1000;

app.post('/admin/api/login', loginLimit, (req, res) => {
  if (String(req.body.password || '') !== ADMIN_PASSWORD) {
    log('admin_login_fail', { detail: '密码错误', ip: clientIp(req) });
    return res.status(403).json({ error: '密码错误' });
  }
  const token = crypto.randomUUID();
  adminTokens.set(token, Date.now() + TOKEN_TTL);
  log('admin_login', { detail: '管理员登录', ip: clientIp(req) });
  res.json({ token });
});

function adminAuth(req, res, next) {
  const t = String(req.headers['x-admin-token'] || '');
  const exp = adminTokens.get(t);
  if (!exp || exp < Date.now()) {
    adminTokens.delete(t);
    return res.status(401).json({ error: '未登录或会话已过期' });
  }
  next();
}

/** 统计概览 */
app.get('/admin/api/stats', adminAuth, (req, res) => {
  const totalKeys = db.prepare(`SELECT COUNT(*) c FROM keys`).get().c;
  const activeKeys = db.prepare(`SELECT COUNT(*) c FROM keys WHERE status='active'`).get().c;
  const bannedKeys = db.prepare(`SELECT COUNT(*) c FROM keys WHERE status='banned'`).get().c;
  const expiredKeys = db.prepare(`SELECT COUNT(*) c FROM keys WHERE expires_at IS NOT NULL AND expires_at < ?`).get(now()).c;
  const totalRedeems = db.prepare(`SELECT COALESCE(SUM(used_count),0) c FROM keys`).get().c;
  const onlineSessions = db.prepare(`SELECT COUNT(*) c FROM sessions WHERE active=1 AND last_seen > ?`)
    .get(new Date(Date.now() - 15_000).toISOString()).c;
  const totalLogs = stmts.countLogs.get().c;

  /* 近 14 天兑换趋势 */
  const since = new Date(Date.now() - 13 * 86400_000);
  since.setHours(0, 0, 0, 0);
  const rows = db.prepare(`
    SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS c
    FROM logs WHERE action='redeem' AND created_at >= ?
    GROUP BY day ORDER BY day`).all(since.toISOString());
  const trend = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(since.getTime() + i * 86400_000).toISOString().slice(0, 10);
    trend.push({ day: d, count: (rows.find((r) => r.day === d) || {}).c || 0 });
  }

  /* 卡密使用排行 TOP5 */
  const topKeys = db.prepare(`SELECT key, note, used_count, max_uses FROM keys ORDER BY used_count DESC LIMIT 5`).all();

  res.json({ totalKeys, activeKeys, bannedKeys, expiredKeys, totalRedeems, onlineSessions, totalLogs, trend, topKeys });
});

/** 卡密列表 */
app.get('/admin/api/keys', adminAuth, (req, res) => {
  const rows = stmts.listKeys.all();
  const nowMs = Date.now();
  res.json({
    keys: rows.map((k) => ({
      ...k,
      effective_status:
        k.status === 'banned' ? 'banned'
        : (k.expires_at && new Date(k.expires_at).getTime() < nowMs) ? 'expired'
        : (k.max_uses > 0 && k.used_count >= k.max_uses) ? 'exhausted'
        : 'active',
    })),
  });
});

/** 批量生成卡密 */
app.post('/admin/api/keys/generate', adminAuth, (req, res) => {
  const count = Math.min(Math.max(parseInt(req.body.count, 10) || 1, 1), 500);
  const maxUses = Math.max(parseInt(req.body.max_uses, 10) || 0, 0); // 0 = 不限
  const note = String(req.body.note || '').slice(0, 200);
  let expiresAt = null;
  if (req.body.expires_at) {
    const t = new Date(req.body.expires_at);
    if (isNaN(t.getTime())) return res.status(400).json({ error: '有效期格式不正确' });
    expiresAt = t.toISOString();
  }

  const created = [];
  const insertMany = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      let keyText;
      do { keyText = genKeyText(); } while (stmts.getKeyByText.get(keyText));
      stmts.insertKey.run({ key: keyText, note, max_uses: maxUses, expires_at: expiresAt, created_at: now() });
      created.push(keyText);
    }
  });
  insertMany();
  log('generate', { detail: `生成 ${count} 张卡密${note ? ` (备注: ${note})` : ''}`, ip: clientIp(req) });
  res.json({ ok: true, count, keys: created });
});

/** 封禁 / 解封 */
app.post('/admin/api/keys/:id/ban', adminAuth, (req, res) => {
  const k = stmts.getKeyById.get(Number(req.params.id));
  if (!k) return res.status(404).json({ error: '卡密不存在' });
  stmts.setStatus.run('banned', k.id);
  // 不主动注销会话: 由在线客户端的下一次心跳(≤5s)发现封禁、注销并记录踢出日志
  log('ban', { keyId: k.id, keyText: k.key, detail: '管理员封禁', ip: clientIp(req) });
  res.json({ ok: true });
});

app.post('/admin/api/keys/:id/unban', adminAuth, (req, res) => {
  const k = stmts.getKeyById.get(Number(req.params.id));
  if (!k) return res.status(404).json({ error: '卡密不存在' });
  stmts.setStatus.run('active', k.id);
  log('unban', { keyId: k.id, keyText: k.key, detail: '管理员解封', ip: clientIp(req) });
  res.json({ ok: true });
});

/** 删除卡密 */
app.delete('/admin/api/keys/:id', adminAuth, (req, res) => {
  const k = stmts.getKeyById.get(Number(req.params.id));
  if (!k) return res.status(404).json({ error: '卡密不存在' });
  stmts.deleteKey.run(k.id);
  log('delete', { keyId: k.id, keyText: k.key, detail: '管理员删除', ip: clientIp(req) });
  res.json({ ok: true });
});

/** 日志(分页 + 按动作过滤) */
app.get('/admin/api/logs', adminAuth, (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const size = Math.min(Math.max(parseInt(req.query.size, 10) || 50, 1), 200);
  const action = String(req.query.action || '');
  let rows, total;
  if (action) {
    rows = db.prepare(`SELECT * FROM logs WHERE action = ? ORDER BY id DESC LIMIT ? OFFSET ?`).all(action, size, (page - 1) * size);
    total = db.prepare(`SELECT COUNT(*) c FROM logs WHERE action = ?`).get(action).c;
  } else {
    rows = stmts.listLogs.all(size, (page - 1) * size);
    total = stmts.countLogs.get().c;
  }
  res.json({ logs: rows, total, page, size });
});

/** CSV 导出 (带 BOM, Excel 友好) */
function toCSV(headers, rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return '﻿' + [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n');
}

app.get('/admin/api/export/keys', adminAuth, (req, res) => {
  const rows = stmts.listKeys.all().map((k) => [
    k.id, k.key, k.note, k.max_uses === 0 ? '不限' : k.max_uses, k.used_count,
    k.expires_at || '永久', k.status, k.created_at,
  ]);
  const csv = toCSV(['ID', '卡密', '备注', '最大次数', '已用次数', '有效期至', '状态', '创建时间'], rows);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="keys-${Date.now()}.csv"`);
  res.send(csv);
});

app.get('/admin/api/export/logs', adminAuth, (req, res) => {
  const rows = db.prepare(`SELECT * FROM logs ORDER BY id DESC LIMIT 5000`).all()
    .map((l) => [l.id, l.created_at, l.action, l.key_text || '', l.detail || '', l.ip || '']);
  const csv = toCSV(['ID', '时间', '动作', '卡密', '详情', 'IP'], rows);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="logs-${Date.now()}.csv"`);
  res.send(csv);
});

/* ============ 静态页面 ============ */
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/gallery', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gallery.html')));

app.listen(PORT, () => {
  console.log(`✔ 客户端  http://localhost:${PORT}/`);
  console.log(`✔ 管理端  http://localhost:${PORT}/admin  (密码: ${ADMIN_PASSWORD})`);
});
