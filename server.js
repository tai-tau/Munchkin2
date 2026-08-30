/* ============================================================
   שולחן מאנצ'קין — מערכת ניהול קלפים
   ------------------------------------------------------------
   אינה משחקת בשבילכם. מנהלת ערימות, ידיים ומיקומים.
   הדבר היחיד שנאכף: אי אפשר ששניים יקחו את אותו קלף.
   ============================================================ */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const CARDS = JSON.parse(fs.readFileSync(path.join(__dirname, "cards.json"), "utf8"));

const shuffle = (a) => {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; }
  return x;
};

function buildDeck(which) {
  const out = []; let n = 0;
  for (const c of CARDS) {
    if (c.deck !== which) continue;
    for (let i = 0; i < (c.copies || 1); i++) out.push({ ...c, uid: `${which[0]}${n++}` });
  }
  return shuffle(out);
}

/* ---------- מצב ---------- */

const S = {
  players: [],        // {id,name,level,aura,hand[],gear[],bag[],on}
  door: [], treasure: [],
  doorDiscard: [], treasureDiscard: [],
  board: [],          // קלפים גלויים במרכז השולחן
  peek: {},           // { playerId: card }  — הצצה פרטית לראש הערימה
  turn: 0, log: [], started: false, seq: 0,
};

function reset() {
  S.door = buildDeck("door");
  S.treasure = buildDeck("treasure");
  S.doorDiscard = []; S.treasureDiscard = [];
  S.board = []; S.peek = {}; S.turn = 0; S.log = []; S.seq++;
  for (const p of S.players) { p.level = 1; p.aura = 0; p.hand = []; p.gear = []; p.bag = []; }
  S.started = true;
}
S.door = buildDeck("door");
S.treasure = buildDeck("treasure");

const log = (m) => { S.log.unshift({ t: Date.now(), m }); if (S.log.length > 100) S.log.pop(); };
const me = (id) => S.players.find((p) => p.id === id);
const cur = () => S.players[S.turn];
const deckOf = (w) => (w === "door" ? S.door : S.treasure);
const discOf = (w) => (w === "door" ? S.doorDiscard : S.treasureDiscard);

/* מציאת קלף והסרתו — אטומי.
   byId = מי מבקש. אי אפשר למשוך מהיד של אחר (היא מוסתרת ממנו ממילא). */
function pull(uid, byId) {
  for (const p of S.players)
    for (const zone of ["hand", "gear", "bag"]) {
      const i = p[zone].findIndex((c) => c.uid === uid);
      if (i < 0) continue;
      if (zone === "hand" && byId && p.id !== byId) return { blocked: "הקלף ביד של שחקן אחר" };
      return { card: p[zone].splice(i, 1)[0], from: zone, owner: p };
    }
  let i = S.board.findIndex((c) => c.uid === uid);
  if (i >= 0) return { card: S.board.splice(i, 1)[0], from: "board" };
  for (const w of ["door", "treasure"]) {
    const d = discOf(w);
    i = d.findIndex((c) => c.uid === uid);
    if (i >= 0) return { card: d.splice(i, 1)[0], from: "discard" };
  }
  for (const pid of Object.keys(S.peek))
    if (S.peek[pid] && S.peek[pid].uid === uid) { const c = S.peek[pid]; delete S.peek[pid]; return { card: c, from: "peek" }; }
  return null;
}

/* ---------- פעולות ---------- */

const A = {
  join({ name }) {
    let p = S.players.find((x) => x.name === name);
    if (p) { p.on = true; return { id: p.id }; }
    p = { id: Math.random().toString(36).slice(2, 9), name: (name || "שחקן").slice(0, 14),
          level: 1, aura: 0, hand: [], gear: [], bag: [], on: true };
    S.players.push(p);
    log(`${p.name} הצטרף`);
    return { id: p.id };
  },

  rename({ pid, name }) {
    const p = me(pid); if (!p || !name) return;
    log(`${p.name} → ${name}`); p.name = name.slice(0, 14);
  },

  newGame() { reset(); log("חפיסות חדשות. 8 קלפים לכל שחקן."); 
    for (const p of S.players) {
      for (let i = 0; i < 4; i++) { const c = S.door.pop(); if (c) p.hand.push(c); }
      for (let i = 0; i < 4; i++) { const c = S.treasure.pop(); if (c) p.hand.push(c); }
    }
  },

  /* --- הצצה לראש ערימה. נעילה: הקלף יוצא מהערימה מיד --- */
  peekTop({ pid, which }) {
    const p = me(pid); if (!p) return { err: "לא נמצא" };
    if (S.peek[pid]) return { err: "יש לך כבר קלף פתוח. החליטו מה לעשות איתו." };
    const d = deckOf(which);
    if (!d.length) {
      const dis = discOf(which);
      if (!dis.length) return { err: "אין קלפים" };
      d.push(...shuffle(dis.splice(0)));
      log(`ערימת ה${which === "door" ? "דלת" : "אוצר"} עורבבה מחדש`);
    }
    S.peek[pid] = d.pop();
    log(`${p.name} שולף מערימת ה${which === "door" ? "דלת" : "אוצר"}`);
    return { card: S.peek[pid] };
  },

  /* החלטה על הקלף שנשלף */
  resolvePeek({ pid, to }) {
    const p = me(pid); const c = S.peek[pid];
    if (!p || !c) return { err: "אין קלף פתוח" };
    delete S.peek[pid];
    if (to === "hand") { p.hand.push(c); log(`${p.name} לקח ליד`); }
    else if (to === "board") { S.board.push({ ...c, by: p.name }); log(`${p.name} חשף: ${c.name}`); }
    else if (to === "back") { deckOf(c.deck).push(c); log(`${p.name} החזיר קלף לערימה`); }
    else if (to === "discard") { discOf(c.deck).push(c); log(`${p.name} זרק: ${c.name}`); }
    else if (to === "gear") { p.gear.push(c); log(`${p.name} צייד: ${c.name}`); }
    else if (to === "bag") { p.bag.push(c); log(`${p.name} → תיק: ${c.name}`); }
    return { ok: true };
  },

  /* --- העברת קלף לכל יעד --- */
  move({ pid, uid, dest, toId }) {
    const p = me(pid); if (!p) return;
    const got = pull(uid, pid);
    if (!got) return { err: "הקלף כבר לא שם" };
    if (got.blocked) return { err: got.blocked };
    const c = got.card;
    const t = me(toId) || p;
    switch (dest) {
      case "hand":     t.hand.push(c); log(`${p.name} → יד${t !== p ? " של " + t.name : ""}`); break;
      case "gear":     t.gear.push(c); log(`${p.name} צייד ${t !== p ? t.name + " ב" : ""}${c.name}`); break;
      case "bag":      t.bag.push(c);  log(`${p.name} → תיק: ${c.name}`); break;
      case "board":    S.board.push({ ...c, by: p.name }); log(`${p.name} הציג: ${c.name}`); break;
      case "discard":  discOf(c.deck).push(c); log(`${p.name} זרק: ${c.name}`); break;
      case "deckTop":  deckOf(c.deck).push(c); log(`${p.name} החזיר לראש הערימה`); break;
      case "deckBottom": deckOf(c.deck).unshift(c); log(`${p.name} החזיר לתחתית`); break;
      default:         t.hand.push(c);
    }
    return { ok: true };
  },

  /* --- מונים --- */
  lvl({ pid, d }) { const p = me(pid); if (p) { p.level = Math.max(1, p.level + d); log(`${p.name} → דרגה ${p.level}`); } },
  aura({ pid, d }) { const p = me(pid); if (p) { p.aura = Math.max(-5, Math.min(9, p.aura + d)); log(`${p.name} → אאורה ${p.aura}`); } },
  roll({ pid, sides }) { const r = 1 + Math.floor(Math.random() * (sides || 6)); log(`🎲 ${me(pid)?.name} הטיל ${r}`); return { roll: r }; },
  nextTurn({ pid }) {
    if (!S.players.length) return;
    S.turn = (S.turn + 1) % S.players.length;
    log(`— תורו של ${cur().name} —`);
  },
  setTurn({ pid, idx }) { S.turn = idx % S.players.length; log(`התור עבר ל${cur().name}`); },
  say({ pid, text }) { const p = me(pid); if (p && text) log(`💬 ${p.name}: ${text}`); },
  clearBoard({ pid }) {
    const n = S.board.length;
    for (const c of S.board) discOf(c.deck).push(c);
    S.board = [];
    if (n) log(`${me(pid)?.name} פינה את השולחן (${n})`);
  },
  shuffleDiscard({ pid, which }) {
    const d = discOf(which), deck = deckOf(which);
    if (!d.length) return;
    deck.push(...shuffle(d.splice(0)));
    log(`${me(pid)?.name} ערבב את הזרוקים חזרה`);
  },
};

/* ---------- תצוגה ---------- */

function view(pid) {
  const p = me(pid);
  return {
    seq: S.seq,
    you: p && { id: p.id, name: p.name, level: p.level, aura: p.aura,
                hand: p.hand, gear: p.gear, bag: p.bag },
    peek: S.peek[pid] || null,
    players: S.players.map((x) => ({
      id: x.id, name: x.name, level: x.level, aura: x.aura,
      hand: x.hand.length, gear: x.gear, bag: x.bag, on: x.on,
      peeking: !!S.peek[x.id],
    })),
    board: S.board,
    decks: { door: S.door.length, treasure: S.treasure.length },
    discards: { door: S.doorDiscard, treasure: S.treasureDiscard },
    turn: S.turn, turnId: cur()?.id, turnName: cur()?.name || "",
    log: S.log, started: S.started,
  };
}

/* ---------- HTTP ---------- */

http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  if (u.pathname === "/" || u.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(__dirname, "index.html")));
  }
  if (u.pathname === "/state") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify(view(u.searchParams.get("pid") || "")));
  }
  if (u.pathname === "/do" && req.method === "POST") {
    let b = ""; req.on("data", (d) => (b += d));
    req.on("end", () => {
      let out = {};
      try { const { action, ...args } = JSON.parse(b || "{}"); if (A[action]) out = A[action](args) || {}; }
      catch (e) { out = { err: e.message }; }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT, () => console.log(`\n  שולחן מאנצ'קין:  http://localhost:${PORT}\n  ${CARDS.length} קלפים\n`));
