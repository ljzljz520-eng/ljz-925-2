const B = process.env.BASE_URL || 'http://localhost:3000';
let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : fail++; console.log(`${cond ? '✅' : '❌'} ${name}`); };
const j = (r) => r.json();

(async () => {
  /* ---- 管理端登录 ---- */
  let r = await fetch(`${B}/admin/api/login`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ password: 'wrong' }) });
  ok(r.status === 403, '错误密码被拒绝');

  r = await fetch(`${B}/admin/api/login`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ password: 'admin123' }) });
  const { token: admin } = await j(r);
  ok(!!admin, '管理员登录成功');
  const AH = { 'Content-Type': 'application/json', 'X-Admin-Token': admin };

  r = await fetch(`${B}/admin/api/stats`);
  ok(r.status === 401, '未登录访问管理接口被拒');

  /* ---- 生成卡密 ---- */
  const exp = new Date(Date.now() + 3600e3).toISOString();
  r = await fetch(`${B}/admin/api/keys/generate`, { method: 'POST', headers: AH, body: JSON.stringify({ count: 3, max_uses: 2, expires_at: exp, note: '测试客户A' }) });
  const gen = await j(r);
  ok(gen.keys.length === 3 && /^\w{4}-\w{4}-\w{4}$/.test(gen.keys[0]), `批量生成3张卡密 (${gen.keys[0]})`);
  const [K1, K2] = gen.keys;

  // 已过期卡密
  r = await fetch(`${B}/admin/api/keys/generate`, { method: 'POST', headers: AH, body: JSON.stringify({ count: 1, max_uses: 1, expires_at: new Date(Date.now() - 1000).toISOString(), note: '已过期' }) });
  const K_EXPIRED = (await j(r)).keys[0];
  // 永久卡密
  r = await fetch(`${B}/admin/api/keys/generate`, { method: 'POST', headers: AH, body: JSON.stringify({ count: 1, max_uses: 0 }) });
  const K_FOREVER = (await j(r)).keys[0];

  /* ---- 客户端兑换 ---- */
  r = await fetch(`${B}/api/redeem`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ key: 'XXXX-XXXX-XXXX' }) });
  ok(r.status === 403 && (await j(r)).reason === 'invalid', '不存在的卡密被拒');

  r = await fetch(`${B}/api/redeem`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ key: K_EXPIRED }) });
  ok((await j(r)).reason === 'expired', '过期卡密被拒');

  r = await fetch(`${B}/api/redeem`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ key: K1 }) });
  const { token: sess } = await j(r);
  ok(!!sess, '卡密兑换成功, 签发会话');

  /* ---- 作品访问 ---- */
  r = await fetch(`${B}/api/photos`, { headers: { 'X-Session': sess } });
  const photos = (await j(r)).photos;
  ok(photos.length === 8, `作品列表 (${photos.length} 张)`);

  r = await fetch(`${B}/api/photo/1`, { headers: { 'X-Session': sess } });
  ok(r.status === 200 && (await r.text()).includes('<svg'), '受保护作品可访问');

  r = await fetch(`${B}/api/photo/1`);
  ok(r.status === 403, '无会话直接访问作品被拒');

  /* ---- 心跳 ---- */
  r = await fetch(`${B}/api/heartbeat`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ token: sess }) });
  ok((await j(r)).ok === true, '心跳正常');

  /* ---- 封禁 → 踢出 ---- */
  const keys = (await j(await fetch(`${B}/admin/api/keys`, { headers: AH }))).keys;
  const k1id = keys.find((k) => k.key === K1).id;
  r = await fetch(`${B}/admin/api/keys/${k1id}/ban`, { method: 'POST', headers: AH });
  ok((await j(r)).ok, '管理员封禁卡密');

  r = await fetch(`${B}/api/heartbeat`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ token: sess }) });
  const hb = await j(r);
  ok(r.status === 403 && hb.reason === 'banned', '封禁后心跳被踢出 (banned)');

  r = await fetch(`${B}/api/photos`, { headers: { 'X-Session': sess } });
  ok(r.status === 403, '封禁后作品接口同步失效');

  r = await fetch(`${B}/api/redeem`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ key: K1 }) });
  ok((await j(r)).reason === 'banned', '封禁卡密无法再次兑换');

  /* ---- 解封 ---- */
  await fetch(`${B}/admin/api/keys/${k1id}/unban`, { method: 'POST', headers: AH });
  r = await fetch(`${B}/api/redeem`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ key: K1 }) });
  ok(r.ok, '解封后可再次兑换 (第2次)');

  /* ---- 次数耗尽 ---- */
  r = await fetch(`${B}/api/redeem`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ key: K1 }) });
  ok((await j(r)).reason === 'exhausted', '第3次兑换被拒 (上限2次)');

  /* ---- 不限次卡密 ---- */
  for (let i = 0; i < 3; i++) {
    r = await fetch(`${B}/api/redeem`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ key: K_FOREVER }) });
  }
  ok(r.ok, '不限次卡密可反复兑换');

  /* ---- 统计 ---- */
  const stats = await j(await fetch(`${B}/admin/api/stats`, { headers: AH }));
  ok(stats.totalKeys === 5 && stats.bannedKeys === 0 && stats.totalRedeems === 5, `统计: 卡密${stats.totalKeys} 兑换${stats.totalRedeems} 趋势${stats.trend.length}天`);

  /* ---- 日志 ---- */
  const logs = await j(await fetch(`${B}/admin/api/logs?page=1&size=100`, { headers: AH }));
  const acts = new Set(logs.logs.map((l) => l.action));
  ok(acts.has('redeem') && acts.has('redeem_fail') && acts.has('ban') && acts.has('unban') && acts.has('heartbeat_kick') && acts.has('generate'), `日志完整 (${logs.total} 条, 含踢出记录)`);

  const kickLogs = await j(await fetch(`${B}/admin/api/logs?action=heartbeat_kick`, { headers: AH }));
  ok(kickLogs.logs.length >= 1 && kickLogs.logs[0].detail.includes('请出'), '踢出日志可按类型过滤');

  /* ---- 导出 ---- */
  r = await fetch(`${B}/admin/api/export/keys`, { headers: AH });
  const csv = await r.text();
  ok(r.headers.get('content-type').includes('text/csv') && csv.includes(K1) && csv.includes('测试客户A'), '卡密 CSV 导出');
  r = await fetch(`${B}/admin/api/export/logs`, { headers: AH });
  ok((await r.text()).split('\n').length > 5, '日志 CSV 导出');

  /* ---- 删除 ---- */
  const k2id = keys.find((k) => k.key === K2).id;
  r = await fetch(`${B}/admin/api/keys/${k2id}`, { method: 'DELETE', headers: AH });
  r = await fetch(`${B}/api/redeem`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ key: K2 }) });
  ok((await j(r)).reason === 'invalid', '删除后卡密失效');

  /* ---- 静态页 ---- */
  for (const p of ['/', '/admin', '/gallery']) {
    r = await fetch(B + p);
    ok(r.status === 200, `页面可访问 ${p}`);
  }

  console.log(`\n========== 结果: ${pass} 通过, ${fail} 失败 ==========`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
