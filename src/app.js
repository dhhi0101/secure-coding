'use strict';


const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const path = require("path");
const http = require("http");
const { Pool } = require("pg");
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret-change-me";
const DATABASE_URL = process.env.DATABASE_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DEFAULT_BALANCE = 100000;
const PRODUCT_REPORT_THRESHOLD = 3;
const USER_REPORT_THRESHOLD = 3;
const BUCKET = "uploads";
const REGIONS = ["서울특별시","부산광역시","대구광역시","인천광역시","광주광역시","대전광역시","울산광역시","세종특별자치시","경기도","강원특별자치도","충청북도","충청남도","전북특별자치도","전라남도","경상북도","경상남도","제주특별자치도"];

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  realtime: { transport: ws }
});

async function query(sql, params) {
  const result = await pool.query(sql, params);
  return result.rows;
}

async function queryOne(sql, params) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      bio TEXT NOT NULL DEFAULT '',
      balance INTEGER NOT NULL DEFAULT 0,
      is_dormant INTEGER NOT NULL DEFAULT 0,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      seller_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      price INTEGER NOT NULL,
      image_path TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '기타',
      region TEXT NOT NULL DEFAULT '미지정',
      status TEXT NOT NULL DEFAULT '판매중',
      is_blocked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id SERIAL PRIMARY KEY,
      reporter_id INTEGER NOT NULL REFERENCES users(id),
      target_type TEXT NOT NULL CHECK(target_type IN ('user', 'product')),
      target_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(reporter_id, target_type, target_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS direct_rooms (
      id SERIAL PRIMARY KEY,
      user_a_id INTEGER NOT NULL,
      user_b_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      room_type TEXT NOT NULL CHECK(room_type IN ('global', 'direct')),
      room_id INTEGER,
      sender_id INTEGER NOT NULL REFERENCES users(id),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transfers (
      id SERIAL PRIMARY KEY,
      sender_id INTEGER NOT NULL REFERENCES users(id),
      receiver_id INTEGER NOT NULL REFERENCES users(id),
      amount INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TEXT`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      type TEXT NOT NULL DEFAULT 'dm',
      message TEXT NOT NULL,
      link TEXT NOT NULL DEFAULT '',
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`ALTER TABLE direct_rooms ADD COLUMN IF NOT EXISTS user_a_left INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE direct_rooms ADD COLUMN IF NOT EXISTS user_b_left INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE direct_rooms ADD COLUMN IF NOT EXISTS user_a_last_read TEXT`);
  await pool.query(`ALTER TABLE direct_rooms ADD COLUMN IF NOT EXISTS user_b_last_read TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_pin_hash TEXT`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'text'`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS meta TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS warnings INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMP`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_blocks (
      id SERIAL PRIMARY KEY,
      blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(blocker_id, blocked_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id SERIAL PRIMARY KEY,
      reviewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reviewee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      transfer_id INTEGER NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
      rating TEXT NOT NULL CHECK(rating IN ('like','dislike')),
      content TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(reviewer_id, transfer_id)
    )
  `);

  const adminCheck = await queryOne("SELECT COUNT(*) AS count FROM users WHERE is_admin = 1");
  if (parseInt(adminCheck.count) === 0) {
    await pool.query(
      "INSERT INTO users (username, display_name, password_hash, bio, balance, is_admin) VALUES ($1, $2, $3, $4, $5, 1)",
      ["admin", "관리자", bcrypt.hashSync("admin1234", 10), "기본 관리자 계정", 1000000]
    );
  }
}

async function initStorage() {
  const { data: buckets } = await supabase.storage.listBuckets();
  const exists = buckets && buckets.find(function (b) { return b.name === BUCKET; });
  if (!exists) {
    await supabase.storage.createBucket(BUCKET, { public: true });
  }
}

async function uploadImage(file) {
  const filename = Date.now() + "-" + file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
  const { error } = await supabase.storage.from(BUCKET).upload(filename, file.buffer, {
    contentType: file.mimetype,
    upsert: false
  });
  if (error) throw new Error("이미지 업로드 실패: " + error.message);
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(filename);
  return data.publicUrl;
}

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: function (_req, file, cb) {
    if (file.mimetype && file.mimetype.startsWith("image/")) {
      cb(null, true);
      return;
    }
    cb(new Error("이미지 파일만 업로드할 수 있습니다."));
  }
});

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax" }
});

app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, "public")));

io.use(function (socket, next) {
  sessionMiddleware(socket.request, {}, next);
});

function h(value) {
  return String(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function amount(value) {
  return Number(value || 0).toLocaleString("ko-KR") + "원";
}

function formatKST(v, opts) {
  if (!v) return "";
  try {
    const base = { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" };
    if (opts && opts.seconds) base.second = "2-digit";
    return new Date(v).toLocaleString("ko-KR", base);
  } catch (e) { return String(v); }
}

function flash(req) {
  const error = req.session.error || "";
  const success = req.session.success || "";
  delete req.session.error;
  delete req.session.success;
  return [
    error ? '<div class="flash error">' + h(error) + "</div>" : "",
    success ? '<div class="flash success">' + h(success) + "</div>" : ""
  ].join("");
}

function navLinks(user) {
  if (!user) return '<a href="/login">로그인</a><a href="/register">회원가입</a>';
  const nc = user.unreadNotifs || 0;
  const badge = '<span id="notif-badge" class="notif-badge"' + (nc > 0 ? "" : ' style="display:none"') + ">" + nc + "</span>";
  return [
    '<a href="/users">사용자</a>',
    '<a href="/notifications">알림' + badge + '</a>',
    '<a href="/wallet">지갑</a>',
    '<a href="/mypage">마이페이지</a>',
    '<a href="/my-products">내 상품</a>',
    '<a href="/my-blocks">차단목록</a>',
    user.isAdmin ? '<a href="/admin">관리</a>' : "",
    '<form method="post" action="/logout" class="inline"><button type="submit">로그아웃</button></form>'
  ].join("");
}

function layout(req, title, body) {
  const user = req.session.user;
  const socketInit = user ? [
    '<script src="/socket.io/socket.io.js"></script>',
    '<script>',
    'window._socket=io();',
    'window._socket.on("notification",function(n){',
    '  var b=document.getElementById("notif-badge");',
    '  if(b){b.textContent=n.count;b.style.display=n.count>0?"":"none";}',
    '  showGlobalToast(n.message,n.link);',
    '});',
    'window._socket.on("chat-message",function(n){',
    '  var cfg=window._activeChatConfig;',
    '  if(cfg&&cfg.roomType==="direct") return;', // 같은 DM방이면 layout 레벨 토스트 안 띄움 (chatPage가 직접 처리)
    '});',
    'function showGlobalToast(msg,link){',
    '  if(window._activeChatConfig&&link&&link.indexOf("/chat/direct/"+window._activeChatConfig.roomId)!==-1) return;',
    '  var t=document.createElement("div");t.className="toast";',
    '  t.innerHTML=\'<a href="\'+link+\'">\'+msg+"</a>";',
    '  document.body.appendChild(t);',
    '  setTimeout(function(){t.classList.add("hide");setTimeout(function(){t.remove();},400);},4000);',
    '}',
    '</script>'
  ].join("") : "";
  return [
    "<!DOCTYPE html>",
    '<html lang="ko"><head>',
    '<meta charset="UTF-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    "<title>" + h(title) + "</title>",
    '<link rel="stylesheet" href="/style.css" />',
    "</head><body>",
    socketInit,
    '<header class="topbar">',
    '<a class="brand" href="/">UsedHub</a>',
    '<button class="hamburger" id="nav-hamburger" aria-label="메뉴" onclick="document.getElementById(\'main-nav\').classList.toggle(\'open\')">&#9776;</button>',
    '<nav id="main-nav"><a href="/products">상품</a><a href="/chat">채팅</a>' + navLinks(user) + '</nav>',
    '</header>',
    '<script>document.addEventListener("click",function(e){var n=document.getElementById("main-nav"),b=document.getElementById("nav-hamburger");if(n&&b&&!n.contains(e.target)&&!b.contains(e.target))n.classList.remove("open");});</script>',
    '<main class="container">' + flash(req) + body + "</main>",
    "</body></html>"
  ].join("");
}

async function currentUserRow(userId) {
  return await queryOne(
    `SELECT id, username, display_name AS "displayName", bio, balance,
     is_dormant AS "isDormant", is_admin AS "isAdmin", warnings,
     suspended_until AS "suspendedUntil" FROM users WHERE id = $1`,
    [userId]
  );
}

async function refreshSessionUser(req) {
  if (req.session.user) {
    req.session.user = await currentUserRow(req.session.user.id) || null;
  }
}

async function getDirectRoomId(userAId, userBId) {
  const sorted = [Number(userAId), Number(userBId)].sort(function (a, b) { return a - b; });
  let room = await queryOne(
    "SELECT id FROM direct_rooms WHERE user_a_id = $1 AND user_b_id = $2",
    [sorted[0], sorted[1]]
  );
  if (!room) {
    const result = await pool.query(
      "INSERT INTO direct_rooms (user_a_id, user_b_id) VALUES ($1, $2) RETURNING id",
      [sorted[0], sorted[1]]
    );
    room = result.rows[0];
  }
  return room.id;
}

function suspendLabel(until) {
  if (!until) return "활동";
  const diff = new Date(until) - Date.now();
  if (diff <= 0) return "활동";
  const days = Math.ceil(diff / 86400000);
  return "정지 (" + days + "일 남음)";
}

async function enforceModeration(targetType, targetId) {
  const row = await queryOne(
    "SELECT COUNT(*) AS count FROM reports WHERE target_type = $1 AND target_id = $2",
    [targetType, targetId]
  );
  const count = parseInt(row.count);
  if (targetType === "product" && count >= PRODUCT_REPORT_THRESHOLD) {
    await pool.query("UPDATE products SET is_blocked = 1 WHERE id = $1", [targetId]);
  }
  if (targetType === "user" && count >= USER_REPORT_THRESHOLD) {
    await pool.query("UPDATE users SET warnings = warnings + 1 WHERE id = $1", [targetId]);
    await pool.query("DELETE FROM reports WHERE target_type = 'user' AND target_id = $1", [targetId]);
    const warned = await queryOne("SELECT warnings FROM users WHERE id = $1", [targetId]);
    const notifMsg = "신고가 누적되어 경고가 부여되었습니다. (총 " + warned.warnings + "회)";
    await pool.query(
      "INSERT INTO notifications (user_id, type, message, link) VALUES ($1, 'warning', $2, '/mypage')",
      [targetId, notifMsg]
    );
    io.to("user:" + targetId).emit("notification", { message: notifMsg, link: "/mypage" });
  }
}

function reportForm(targetType, targetId) {
  return [
    '<form method="post" action="/reports" class="stack report-form">',
    '<input type="hidden" name="targetType" value="' + h(targetType) + '" />',
    '<input type="hidden" name="targetId" value="' + Number(targetId) + '" />',
    "<label>신고 사유<textarea name=\"reason\" rows=\"3\" required></textarea></label>",
    "<button type=\"submit\">신고하기</button>",
    "</form>"
  ].join("");
}

function productCard(product) {
  const img = product.imagePath || product.image_path || "";
  const sold = product.status === "판매완료";
  return [
    '<article class="card product-card' + (sold ? " product-card--sold" : "") + '">',
    '<a href="/products/' + product.id + '">',
    '<div class="product-card-img-wrap">',
    '<img src="' + h(img) + '" alt="' + h(product.name) + '" />',
    sold ? '<span class="product-sold-badge">판매완료</span>' : "",
    "</div>",
    "<h3>" + h(product.name) + "</h3>",
    "</a>",
    "</article>"
  ].join("");
}

function renderTransferCard(m, isMine, uid) {
  var meta = {};
  try { meta = JSON.parse(m.meta || m.metaJson || "{}"); } catch (_) {}
  var reviewBtn = isMine
    ? '<a class="button primary" style="margin-top:8px;display:inline-block" href="/users/' + (m.receiverId || meta.receiverId || "") + '?review=' + meta.transferId + '">후기 남기기 →</a>'
    : "";
  return '<div class="transfer-card">' +
    '<div class="transfer-card-icon">💸</div>' +
    '<div><strong>' + h(m.content) + '</strong>' +
    (meta.note ? '<p style="font-size:12px;color:var(--muted);margin:2px 0">' + h(meta.note) + '</p>' : '') +
    '<small>' + formatKST(m.createdAt || m.created_at) + '</small>' +
    reviewBtn + '</div></div>';
}

function chatPage(title, roomType, roomId, messages, currentUserId, partnerLastRead, partnerId) {
  const uid = Number(currentUserId || 0);
  const pid = Number(partnerId || 0);
  const pRead = partnerLastRead ? new Date(partnerLastRead).getTime() : 0;
  const initial = messages.map(function (m) {
    const sid = Number(m.senderId || m.sender_id || 0);
    const uname = h(m.senderUsername || m.sender_username || "");
    const dname = h(m.displayName || m.display_name);
    const isMine = uid !== 0 && sid === uid;
    const msgType = m.type || "text";

    if (msgType === "transfer") {
      var meta = {};
      try { meta = JSON.parse(m.meta || m.metaJson || "{}"); } catch (_) {}
      meta.receiverId = isMine ? pid : uid;
      const enriched = Object.assign({}, m, { meta: JSON.stringify(meta) });
      return '<div class="chat-message-transfer">' + renderTransferCard(enriched, isMine, uid) + '</div>';
    }

    const nameEl = !isMine ? '<strong class="chat-name" data-userid="' + sid + '" data-username="' + uname + '" data-displayname="' + dname + '">' + dname + '</strong>' : "";
    let readEl = "";
    if (isMine && roomType === "direct") {
      const msgT = new Date(m.createdAt || m.created_at).getTime();
      readEl = (pRead && pRead >= msgT) ? '<span class="read-marker">읽음</span>' : '<span class="unread-marker">1</span>';
    }
    return '<div class="chat-message ' + (isMine ? "mine" : "other") + '">' + nameEl +
      '<div class="bubble"><span>' + h(m.content) + '</span><small>' + formatKST(m.createdAt || m.created_at) + '</small></div>' + readEl + '</div>';
  }).join("");
  const popupHtml = [
    '<div id="user-popup-overlay" onclick="closeUserPopup()">',
    '<div id="user-popup" onclick="event.stopPropagation()">',
    '<h3 id="popup-name"></h3>',
    '<p id="popup-username"></p>',
    '<div class="actions" style="margin-top:16px">',
    '<a id="popup-profile-link" class="button" href="#">프로필 보기</a>',
    '<a id="popup-chat-link" class="button primary" href="#">1:1 채팅하기</a>',
    '</div>',
    '<button onclick="closeUserPopup()" style="margin-top:10px;width:100%">닫기</button>',
    '</div></div>'
  ].join("");
  return [
    popupHtml,
    '<section class="card chat-section">',
    "<h2>" + h(title) + "</h2>",
    '<div id="messages" class="chat-box">' + initial + "</div>",
    '<form id="chat-form" class="chat-input-row">',
    '<input id="content" autocomplete="off" maxlength="500" placeholder="메시지를 입력하세요." />',
    '<button type="submit" class="primary">전송</button>',
    "</form></section>",
    "<script>",
    "(function(){",
    "const socket = window._socket;",
    "const chatConfig = " + JSON.stringify({ roomType: roomType, roomId: roomId }) + ";",
    "window._activeChatConfig = chatConfig;",
    "const currentUserId = " + uid + ";",
    'const messagesEl = document.getElementById("messages");',
    'const form = document.getElementById("chat-form");',
    'const input = document.getElementById("content");',
    'socket.emit("join", chatConfig);',
    'function fmtDate(v){try{return new Date(v).toLocaleString("ko-KR",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});}catch(e){return String(v||"");}}',
    'function renderTransferCard(m, isMine) {',
    '  var meta={};try{meta=JSON.parse(m.meta||"{}");}catch(e){}',
    '  var reviewBtn = isMine ? \'<a class="button primary" style="margin-top:8px;display:inline-block" href="/users/\'+meta.receiverId+\'?review=\'+meta.transferId+\'">후기 남기기 →</a>\' : "";',
    '  return \'<div class="transfer-card"><div class="transfer-card-icon">💸</div><div><strong>\'+safe(m.content)+\'</strong>\'+(meta.note?\'<p style="font-size:12px;color:var(--muted);margin:2px 0">\'+safe(meta.note)+\'</p>\':\'\')+\'<small>\'+fmtDate(m.createdAt)+\'</small>\'+reviewBtn+\'</div></div>\';',
    '}',
    'socket.on("chat-message", function(m) {',
    '  const isMine = m.senderId === currentUserId;',
    '  const div = document.createElement("div");',
    '  if (m.type === "transfer") {',
    '    div.className = "chat-message-transfer";',
    '    var meta = {}; try { meta = JSON.parse(m.meta || "{}"); } catch(e) {}',
    '    meta.receiverId = isMine ? ' + (pid ? pid : 0) + ' : currentUserId;',
    '    m.meta = JSON.stringify(meta);',
    '    div.innerHTML = renderTransferCard(m, isMine);',
    '  } else {',
    '    div.className = "chat-message " + (isMine ? "mine" : "other");',
    '    const nameEl = !isMine ? \'<strong class="chat-name" data-userid="\' + (m.senderId||0) + \'" data-username="\' + safe(m.senderUsername||"") + \'" data-displayname="\' + safe(m.displayName) + \'">\' + safe(m.displayName) + "</strong>" : "";',
    '    const readEl = (isMine && chatConfig.roomType==="direct") ? \'<span class="unread-marker">1</span>\' : "";',
    '    div.innerHTML = nameEl + \'<div class="bubble"><span>\' + safe(m.content) + "</span><small>" + fmtDate(m.createdAt) + "</small></div>" + readEl;',
    '  }',
    "  messagesEl.appendChild(div);",
    "  messagesEl.scrollTop = messagesEl.scrollHeight;",
    '  if(!isMine && chatConfig.roomType==="direct"){socket.emit("mark-read",{roomId:chatConfig.roomId});}',
    "});",
    'socket.on("messages-read", function() {',
    '  document.querySelectorAll(".unread-marker").forEach(function(el){el.className="read-marker";el.textContent="읽음";});',
    '});',
    'form.addEventListener("submit", function(e) {',
    "  e.preventDefault();",
    "  if (!input.value.trim()) return;",
    '  socket.emit("chat-message", { roomType: chatConfig.roomType, roomId: chatConfig.roomId, content: input.value });',
    '  input.value = "";',
    "});",
    'messagesEl.scrollTop = messagesEl.scrollHeight;',
    'document.addEventListener("click", function(e) {',
    '  const name = e.target.closest(".chat-name");',
    '  if (!name) return;',
    '  const userId = +name.dataset.userid;',
    '  document.getElementById("popup-name").textContent = name.dataset.displayname;',
    '  document.getElementById("popup-username").textContent = "@" + name.dataset.username;',
    '  document.getElementById("popup-profile-link").href = "/users/" + userId;',
    '  const chatLink = document.getElementById("popup-chat-link");',
    '  if (!userId || userId === currentUserId) { chatLink.style.display = "none"; } else { chatLink.style.display = ""; chatLink.href = "/chat/start/" + userId; }',
    '  document.getElementById("user-popup-overlay").style.display = "flex";',
    "});",
    'function safe(v) { return String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/\'/g,"&#39;"); }',
    "})();",
    'function closeUserPopup() { document.getElementById("user-popup-overlay").style.display = "none"; }',
    "</script>"
  ].join("");
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    req.session.error = "로그인이 필요합니다.";
    return res.redirect("/login");
  }
  if (req.session.user.isDormant) {
    req.session.error = "휴면 계정은 이용할 수 없습니다.";
    return res.redirect("/login");
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || !req.session.user.isAdmin) {
    req.session.error = "관리자만 접근할 수 있습니다.";
    return res.redirect("/");
  }
  next();
}

app.use(async function (req, _res, next) {
  if (req.session.user) {
    try {
      req.session.user = await currentUserRow(req.session.user.id) || null;
      if (req.session.user) {
        const nc = await queryOne("SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1 AND is_read = 0", [req.session.user.id]);
        req.session.user.unreadNotifs = parseInt(nc.count) || 0;
      }
    } catch (_e) { /* ignore */ }
  }
  next();
});

app.get("/health", function (_req, res) {
  res.json({ ok: true });
});

app.get("/", async function (req, res, next) {
  try {
    const featured = await query(
      `SELECT p.id, p.name, p.price, p.image_path AS "imagePath", p.category, p.region, p.status,
       u.display_name AS "sellerName" FROM products p
       JOIN users u ON u.id = p.seller_id
       WHERE p.is_blocked = 0 ORDER BY p.created_at DESC LIMIT 6`
    );
    const p = await queryOne("SELECT COUNT(*) AS count FROM products WHERE is_blocked = 0");
    const productCount = parseInt(p.count);
    const authModal = req.session.user ? "" : [
      '<div id="auth-modal" class="modal-overlay" style="display:none" onclick="if(event.target===this)closeAuthModal()">',
      '<div class="modal-box">',
      '<button class="modal-close" onclick="closeAuthModal()">&#10005;</button>',
      '<div class="auth-tabs">',
      '<button class="auth-tab active" id="tab-login" onclick="switchTab(\'login\')">로그인</button>',
      '<button class="auth-tab" id="tab-register" onclick="switchTab(\'register\')">회원가입</button>',
      '</div>',
      '<div id="pane-login" class="auth-pane">',
      '<form method="post" action="/login" class="stack">',
      '<label>아이디<input name="username" required autocomplete="username"/></label>',
      '<label>비밀번호<input type="password" name="password" required autocomplete="current-password"/></label>',
      '<button type="submit" class="button primary" style="width:100%">로그인</button>',
      '</form>',
      '</div>',
      '<div id="pane-register" class="auth-pane" style="display:none">',
      '<form method="post" action="/register" class="stack">',
      '<label>아이디<input name="username" required placeholder="영문 소문자, 숫자만" autocomplete="username"/><small class="hint">영문 소문자(a-z)와 숫자(0-9)만 사용 가능합니다.</small></label>',
      '<label>닉네임<input name="displayName" required placeholder="다른 사람에게 보이는 이름"/></label>',
      '<label>비밀번호<input type="password" name="password" required placeholder="영문, 숫자, 특수문자" autocomplete="new-password"/><small class="hint">영문(대소문자), 숫자, 특수문자만 사용 가능합니다.</small></label>',
      '<label>소개글<textarea name="bio" rows="3"></textarea></label>',
      '<button type="submit" class="button primary" style="width:100%">가입하기</button>',
      '</form>',
      '</div>',
      '</div></div>',
      '<script>',
      'function openAuthModal(tab){document.getElementById("auth-modal").style.display="flex";switchTab(tab||"login");}',
      'function closeAuthModal(){document.getElementById("auth-modal").style.display="none";}',
      'function switchTab(t){["login","register"].forEach(function(x){document.getElementById("pane-"+x).style.display=x===t?"block":"none";document.getElementById("tab-"+x).classList.toggle("active",x===t);});}',
      'document.addEventListener("keydown",function(e){if(e.key==="Escape")closeAuthModal();});',
      '</script>'
    ].join("");

    res.send(layout(req, "UsedHub", [
      authModal,
      '<section class="hero"><div>',
      "<h1>중고거래 플랫폼</h1>",
      "<p>현재 <strong>" + productCount + "개</strong>의 상품이 등록되어 있습니다.</p>",
      '<div class="actions"><a class="button primary" href="/products">상품 둘러보기</a>' +
        (req.session.user
          ? '<a class="button" href="/wallet">송금하기</a>'
          : '<button class="button" onclick="openAuthModal(\'login\')">로그인</button><button class="button" onclick="openAuthModal(\'register\')">회원가입</button>'
        ) + "</div>",
      "</div></section>",
      "<section><h2>최근 등록 상품</h2><div class=\"grid\">" +
        (featured.map(productCard).join("") || "<p>등록된 상품이 없습니다.</p>") + "</div></section>"
    ].join("")));
  } catch (e) { next(e); }
});

app.get("/register", function (req, res) {
  res.send(layout(req, "회원가입", [
    '<section class="card auth"><h1>회원가입</h1>',
    '<form method="post" action="/register" class="stack">',
    '<label>아이디<input name="username" required placeholder="영문 소문자, 숫자만" /><small class="hint">영문 소문자(a-z)와 숫자(0-9)만 사용 가능합니다.</small></label>',
    '<label>닉네임<input name="displayName" required placeholder="다른 사람에게 보이는 이름" /></label>',
    '<label>비밀번호<input type="password" name="password" required placeholder="영문, 숫자, 특수문자" /><small class="hint">영문(대소문자), 숫자, 특수문자만 사용 가능합니다.</small></label>',
    "<label>소개글<textarea name=\"bio\" rows=\"4\"></textarea></label>",
    "<button type=\"submit\">가입하기</button>",
    "</form></section>"
  ].join("")));
});

app.post("/register", async function (req, res, next) {
  try {
    const username = (req.body.username || "").trim();
    const displayName = (req.body.displayName || "").trim();
    const password = req.body.password || "";
    const bio = (req.body.bio || "").trim();
    if (!username || !displayName || !password) {
      req.session.error = "필수 항목을 모두 입력해주세요.";
      return res.redirect("/register");
    }
    if (!/^[a-z0-9]+$/.test(username)) {
      req.session.error = "아이디는 영문 소문자와 숫자만 사용할 수 있습니다.";
      return res.redirect("/register");
    }
    if (!/^[a-zA-Z0-9!@#$%^&*()\-_=+\[\]{}|;:'",.<>/?~`\\]+$/.test(password)) {
      req.session.error = "비밀번호는 영문, 숫자, 특수문자만 사용할 수 있습니다.";
      return res.redirect("/register");
    }
    const exists = await queryOne("SELECT id FROM users WHERE username = $1", [username]);
    if (exists) {
      req.session.error = "이미 사용 중인 아이디입니다.";
      return res.redirect("/register");
    }
    const existsName = await queryOne("SELECT id FROM users WHERE display_name = $1", [displayName]);
    if (existsName) {
      req.session.error = "이미 사용 중인 닉네임입니다.";
      return res.redirect("/register");
    }
    await pool.query(
      "INSERT INTO users (username, display_name, password_hash, bio, balance) VALUES ($1, $2, $3, $4, $5)",
      [username, displayName, bcrypt.hashSync(password, 10), bio, DEFAULT_BALANCE]
    );
    req.session.success = "회원가입이 완료되었습니다. 로그인해주세요.";
    res.redirect("/login");
  } catch (e) { next(e); }
});

app.get("/login", function (req, res) {
  res.send(layout(req, "로그인", [
    '<section class="card auth"><h1>로그인</h1>',
    '<form method="post" action="/login" class="stack">',
    "<label>아이디<input name=\"username\" required /></label>",
    "<label>비밀번호<input type=\"password\" name=\"password\" required /></label>",
    "<button type=\"submit\">로그인</button>",
    "</form>",
    "</section>"
  ].join("")));
});

app.post("/login", async function (req, res, next) {
  try {
    const username = (req.body.username || "").trim();
    const password = req.body.password || "";
    const user = await queryOne(
      `SELECT id, username, display_name AS "displayName", password_hash AS "passwordHash", bio, balance,
       is_dormant AS "isDormant", is_admin AS "isAdmin", warnings, suspended_until AS "suspendedUntil"
       FROM users WHERE username = $1`,
      [username]
    );
    if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
      req.session.error = "아이디 또는 비밀번호가 올바르지 않습니다.";
      return res.redirect("/login");
    }
    if (user.isDormant) {
      req.session.error = "영구 정지된 계정입니다. 관리자에게 문의하세요.";
      return res.redirect("/login");
    }
    if (user.suspendedUntil && new Date(user.suspendedUntil) > new Date()) {
      const until = new Date(user.suspendedUntil);
      const diff = Math.ceil((until - Date.now()) / 86400000);
      req.session.error = "계정이 정지되었습니다. " + diff + "일 후 해제됩니다. (" + until.toLocaleDateString("ko-KR") + " 해제)";
      return res.redirect("/login");
    }
    await pool.query("UPDATE users SET last_seen = $1 WHERE id = $2", [new Date().toISOString(), user.id]);
    req.session.user = {
      id: user.id, username: user.username, displayName: user.displayName,
      bio: user.bio, balance: user.balance, isDormant: user.isDormant, isAdmin: user.isAdmin
    };
    req.session.success = "로그인되었습니다.";
    res.redirect("/");
  } catch (e) { next(e); }
});

app.post("/logout", function (req, res) {
  req.session.destroy(function () { res.redirect("/"); });
});

app.get("/users", requireAuth, async function (req, res, next) {
  try {
    const q = (req.query.q || "").trim();
    const users = await query(
      `SELECT id, username, display_name AS "displayName", bio, is_dormant AS "isDormant", last_seen AS "lastSeen"
       FROM users
       WHERE ($1 = '' OR username ILIKE '%' || $1 || '%' OR display_name ILIKE '%' || $1 || '%')
       ORDER BY created_at DESC`,
      [q]
    );
    res.send(layout(req, "사용자 목록", [
      '<section class="section-head"><h1>사용자 목록</h1></section>',
      '<form method="get" action="/users" class="card search-panel" style="margin-bottom:16px">',
      '<input name="q" value="' + h(q) + '" placeholder="아이디 또는 닉네임으로 검색" style="max-width:320px" />',
      '<button type="submit" class="primary">검색</button>',
      q ? '<a class="button" href="/users">초기화</a>' : "",
      "</form>",
      '<div class="stack">',
      users.map(function (u) {
        const lastSeen = u.isDormant ? '<span class="badge dormant">휴면 계정</span>' :
          (u.lastSeen ? '<span class="badge muted">마지막 접속 ' + formatKST(u.lastSeen) + '</span>' : '<span class="badge muted">접속 기록 없음</span>');
        const avatar = '<div class="avatar">' + h(u.displayName).charAt(0) + '</div>';
        return '<article class="card user-card"><a href="/users/' + u.id + '" class="user-card-inner">' +
          avatar + '<div class="user-info"><strong>' + h(u.displayName) + '</strong>' +
          '<p>@' + h(u.username) + '</p>' +
          '<p>' + h(u.bio || "소개글 없음") + '</p>' +
          lastSeen + '</div></a></article>';
      }).join("") || "<p>검색 결과가 없습니다.</p>",
      "</div>"
    ].join("")));
  } catch (e) { next(e); }
});

app.get("/users/:id", requireAuth, async function (req, res, next) {
  try {
    const myId = req.session.user.id;
    const user = await currentUserRow(Number(req.params.id));
    if (!user) return res.status(404).send(layout(req, "사용자 없음", "<p>사용자를 찾을 수 없습니다.</p>"));
    const isMe = myId === user.id;
    const focusTransferId = Number(req.query.review || 0);

    const [blockRow, reviewStats, reviewList, writableTransfers] = await Promise.all([
      isMe ? null : queryOne(
        "SELECT id FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2",
        [myId, user.id]
      ),
      queryOne(
        `SELECT COUNT(*) FILTER (WHERE rating='like') AS likes,
                COUNT(*) FILTER (WHERE rating='dislike') AS dislikes
         FROM reviews WHERE reviewee_id = $1`,
        [user.id]
      ),
      query(
        `SELECT r.rating, r.content, r.created_at AS "createdAt", u.display_name AS "reviewerName"
         FROM reviews r JOIN users u ON u.id = r.reviewer_id
         WHERE r.reviewee_id = $1 ORDER BY r.created_at DESC LIMIT 20`,
        [user.id]
      ),
      isMe ? [] : query(
        `SELECT t.id, t.amount, t.created_at AS "createdAt"
         FROM transfers t
         WHERE t.sender_id = $1 AND t.receiver_id = $2
           AND NOT EXISTS (SELECT 1 FROM reviews rv WHERE rv.reviewer_id = $1 AND rv.transfer_id = t.id)
         ORDER BY t.created_at DESC`,
        [myId, user.id]
      )
    ]);

    const isBlocked = !!blockRow;
    const likes = parseInt(reviewStats.likes) || 0;
    const dislikes = parseInt(reviewStats.dislikes) || 0;

    const actions = isMe ? "" : [
      '<div class="actions">',
      '<a class="button primary" href="/chat/start/' + user.id + '">1:1 채팅하기</a>',
      '<a class="button" href="/wallet?receiver=' + user.id + '">송금하기</a>',
      '<form method="post" action="/users/' + user.id + '/block" class="inline">',
      '<button type="submit" class="' + (isBlocked ? "danger" : "") + '">' + (isBlocked ? "차단 해제" : "차단하기") + '</button>',
      '</form>',
      '</div>'
    ].join("");

    const reviewForm = writableTransfers.length ? [
      '<section class="card" id="review-section"><h2>거래 후기 작성</h2>',
      '<p class="hint">송금한 거래에 대해 후기를 남길 수 있습니다.</p>',
      writableTransfers.map(function (t) {
        const isFocused = focusTransferId && t.id === focusTransferId;
        return '<form method="post" action="/reviews" class="stack review-form' + (isFocused ? " review-focus" : "") + '"' +
          (isFocused ? ' id="review-focus"' : '') + '>' +
          '<input type="hidden" name="revieweeId" value="' + user.id + '" />' +
          '<input type="hidden" name="transferId" value="' + t.id + '" />' +
          '<p class="hint">송금 ' + amount(t.amount) + ' · ' + formatKST(t.createdAt) + '</p>' +
          '<div class="rating-row">' +
          '<label><input type="radio" name="rating" value="like" required /> 👍 추천해요</label>' +
          '<label><input type="radio" name="rating" value="dislike" /> 👎 비추천해요</label>' +
          '</div>' +
          '<label>후기<textarea name="content" rows="3" placeholder="거래 경험을 자유롭게 적어주세요 (선택)"></textarea></label>' +
          '<button type="submit" class="primary">후기 등록</button></form>';
      }).join("") +
      (focusTransferId ? '<script>var _rf=document.getElementById("review-focus");if(_rf)_rf.scrollIntoView({behavior:"smooth",block:"center"});</script>' : '') +
      '</section>'
    ].join("") : "";

    const reviewSection = [
      '<section class="card"><h2>받은 후기</h2>',
      '<div class="review-stats">',
      '<span class="review-like">👍 ' + likes + '</span>',
      '<span class="review-dislike">👎 ' + dislikes + '</span>',
      '</div>',
      reviewList.length ? '<div class="stack">' + reviewList.map(function (r) {
        return '<div class="subcard">' +
          '<div class="row"><strong>' + (r.rating === "like" ? "👍 추천" : "👎 비추천") + '</strong>' +
          '<small>' + h(r.reviewerName) + ' · ' + formatKST(r.createdAt) + '</small></div>' +
          (r.content ? '<p>' + h(r.content) + '</p>' : '') +
          '</div>';
      }).join("") + '</div>' : '<p class="hint">아직 후기가 없습니다.</p>',
      '</section>'
    ].join("");

    res.send(layout(req, user.displayName, [
      '<section class="card">',
      "<h1>" + h(user.displayName) + "</h1>",
      "<p>아이디: @" + h(user.username) + "</p>",
      "<p>소개글: " + h(user.bio || "소개글 없음") + "</p>",
      isMe ? "<p>잔액: " + amount(user.balance) + "</p>" : "",
      "<p>상태: " + (user.isDormant ? "휴면 계정" : "활동 중") + "</p>",
      actions,
      isMe ? "" : reportForm("user", user.id),
      "</section>",
      reviewForm,
      reviewSection
    ].join("")));
  } catch (e) { next(e); }
});

app.post("/users/:id/block", requireAuth, async function (req, res, next) {
  try {
    const myId = req.session.user.id;
    const targetId = Number(req.params.id);
    if (myId === targetId) return res.redirect("/users/" + targetId);
    const existing = await queryOne(
      "SELECT id FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2", [myId, targetId]
    );
    if (existing) {
      await pool.query("DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2", [myId, targetId]);
      req.session.success = "차단을 해제했습니다.";
    } else {
      await pool.query("INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)", [myId, targetId]);
      req.session.success = "사용자를 차단했습니다.";
    }
    res.redirect("/users/" + targetId);
  } catch (e) { next(e); }
});

app.get("/my-blocks", requireAuth, async function (req, res, next) {
  try {
    const blocks = await query(
      `SELECT u.id, u.display_name AS "displayName", u.username, ub.created_at AS "blockedAt"
       FROM user_blocks ub JOIN users u ON u.id = ub.blocked_id
       WHERE ub.blocker_id = $1 ORDER BY ub.created_at DESC`,
      [req.session.user.id]
    );
    res.send(layout(req, "차단 목록", [
      '<section class="section-head"><h1>차단 목록</h1></section>',
      '<div class="stack">',
      blocks.length ? blocks.map(function (u) {
        return '<article class="card inline-card"><div>' +
          '<strong><a href="/users/' + u.id + '">' + h(u.displayName) + '</a></strong>' +
          '<p>@' + h(u.username) + '</p>' +
          '<small>차단일: ' + formatKST(u.blockedAt) + '</small></div>' +
          '<form method="post" action="/users/' + u.id + '/block" class="inline">' +
          '<button type="submit">차단 해제</button></form>' +
          '</article>';
      }).join("") : '<p>차단한 사용자가 없습니다.</p>',
      '</div>'
    ].join("")));
  } catch (e) { next(e); }
});

app.post("/reviews", requireAuth, async function (req, res, next) {
  try {
    const myId = req.session.user.id;
    const revieweeId = Number(req.body.revieweeId);
    const transferId = Number(req.body.transferId);
    const rating = req.body.rating;
    const content = (req.body.content || "").trim();
    if (!revieweeId || !transferId || !["like", "dislike"].includes(rating)) {
      req.session.error = "후기 정보가 올바르지 않습니다.";
      return res.redirect("/users/" + revieweeId);
    }
    const transfer = await queryOne(
      "SELECT id FROM transfers WHERE id = $1 AND sender_id = $2 AND receiver_id = $3",
      [transferId, myId, revieweeId]
    );
    if (!transfer) {
      req.session.error = "해당 거래 내역이 없습니다.";
      return res.redirect("/users/" + revieweeId);
    }
    try {
      await pool.query(
        "INSERT INTO reviews (reviewer_id, reviewee_id, transfer_id, rating, content) VALUES ($1, $2, $3, $4, $5)",
        [myId, revieweeId, transferId, rating, content]
      );
    } catch (err) {
      if (err.code === "23505") {
        req.session.error = "이미 해당 거래에 후기를 남겼습니다.";
        return res.redirect("/users/" + revieweeId);
      }
      throw err;
    }
    req.session.success = "후기가 등록되었습니다.";
    res.redirect("/users/" + revieweeId);
  } catch (e) { next(e); }
});

app.get("/mypage", requireAuth, function (req, res) {
  const user = req.session.user;
  const suspStatus = user.suspendedUntil && new Date(user.suspendedUntil) > new Date()
    ? suspendLabel(user.suspendedUntil)
    : null;
  res.send(layout(req, "마이페이지", [
    '<section class="card"><h1>마이페이지</h1>',
    (user.warnings > 0 || suspStatus)
      ? '<div class="notice warn"><strong>계정 상태</strong>' +
        (user.warnings > 0 ? " · 경고 " + user.warnings + "회" : "") +
        (suspStatus ? " · " + suspStatus : "") + "</div>"
      : "",
    '<form method="post" action="/mypage" class="stack">',
    '<label>닉네임<input name="displayName" value="' + h(user.displayName) + '" required /></label>',
    '<label>소개글<textarea name="bio" rows="4">' + h(user.bio || "") + "</textarea></label>",
    "<label>새 비밀번호<input type=\"password\" name=\"password\" placeholder=\"변경하지 않으려면 비워두기\" /></label>",
    "<button type=\"submit\">수정하기</button>",
    "</form></section>"
  ].join("")));
});

app.post("/mypage", requireAuth, async function (req, res, next) {
  try {
    const displayName = (req.body.displayName || "").trim();
    const bio = (req.body.bio || "").trim();
    const password = req.body.password || "";
    if (!displayName) {
      req.session.error = "닉네임은 필수입니다.";
      return res.redirect("/mypage");
    }
    const dupName = await queryOne("SELECT id FROM users WHERE display_name = $1 AND id != $2", [displayName, req.session.user.id]);
    if (dupName) {
      req.session.error = "이미 사용 중인 닉네임입니다.";
      return res.redirect("/mypage");
    }
    if (password) {
      if (!/^[a-zA-Z0-9!@#$%^&*()\-_=+\[\]{}|;:'",.<>/?~`\\]+$/.test(password)) {
        req.session.error = "비밀번호는 영문, 숫자, 특수문자만 사용할 수 있습니다.";
        return res.redirect("/mypage");
      }
      await pool.query("UPDATE users SET display_name = $1, bio = $2, password_hash = $3 WHERE id = $4",
        [displayName, bio, bcrypt.hashSync(password, 10), req.session.user.id]);
    } else {
      await pool.query("UPDATE users SET display_name = $1, bio = $2 WHERE id = $3",
        [displayName, bio, req.session.user.id]);
    }
    await refreshSessionUser(req);
    req.session.success = "마이페이지가 업데이트되었습니다.";
    res.redirect("/mypage");
  } catch (e) { next(e); }
});

app.get("/api/users/search", requireAuth, async function (req, res, next) {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.json([]);
    const users = await query(
      `SELECT id, display_name AS "displayName", username FROM users
       WHERE id != $1 AND is_dormant = 0
       AND (username ILIKE '%' || $2 || '%' OR display_name ILIKE '%' || $2 || '%')
       ORDER BY display_name ASC LIMIT 10`,
      [req.session.user.id, q]
    );
    res.json(users);
  } catch (e) { next(e); }
});

app.get("/notifications", requireAuth, async function (req, res, next) {
  try {
    const notifs = await query(
      `SELECT id, type, message, link, is_read AS "isRead", created_at AS "createdAt"
       FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.session.user.id]
    );
    await pool.query("UPDATE notifications SET is_read = 1 WHERE user_id = $1", [req.session.user.id]);
    res.send(layout(req, "알림", [
      '<section class="card"><h1>알림</h1>',
      '<div class="stack" style="margin-top:16px">',
      notifs.length ? notifs.map(function (n) {
        return '<a href="' + h(n.link) + '" class="subcard notif-item' + (n.isRead ? "" : " unread") + '">' +
          '<span>' + h(n.message) + '</span>' +
          '<small>' + formatKST(n.createdAt) + '</small></a>';
      }).join("") : '<p style="color:var(--muted);text-align:center;padding:24px 0">알림이 없습니다.</p>',
      '</div></section>'
    ].join("")));
  } catch (e) { next(e); }
});

app.post("/notifications/read-all", requireAuth, async function (req, res, next) {
  try {
    await pool.query("UPDATE notifications SET is_read = 1 WHERE user_id = $1", [req.session.user.id]);
    res.redirect("/notifications");
  } catch (e) { next(e); }
});

function pinKeypadHtml(titleText, subtitleText, formAction, extraInputs) {
  return [
    '<section class="card auth" style="max-width:360px">',
    '<h1>' + titleText + '</h1>',
    '<p style="color:var(--muted);font-size:14px;margin-bottom:24px">' + subtitleText + '</p>',
    '<div class="pin-dots" id="pin-dots">',
    '<div class="pin-dot" id="d0"></div><div class="pin-dot" id="d1"></div>',
    '<div class="pin-dot" id="d2"></div><div class="pin-dot" id="d3"></div>',
    '<div class="pin-dot" id="d4"></div><div class="pin-dot" id="d5"></div>',
    '</div>',
    '<div class="pin-keypad" id="pin-keypad">',
    [1,2,3,4,5,6,7,8,9].map(function(n){return '<button type="button" class="pin-key" data-v="'+n+'">'+n+'</button>';}).join(''),
    '<button type="button" class="pin-key empty" disabled></button>',
    '<button type="button" class="pin-key" data-v="0">0</button>',
    '<button type="button" class="pin-key del" id="pin-del">⌫</button>',
    '</div>',
    '<form method="post" action="' + formAction + '" id="pin-form" style="display:none">',
    (extraInputs || ''),
    '<input type="hidden" name="pin" id="pin-value" />',
    '</form>',
    '<script>',
    '(function(){',
    'var val="";',
    'var dots=[0,1,2,3,4,5].map(function(i){return document.getElementById("d"+i);});',
    'function render(){dots.forEach(function(d,i){d.classList.toggle("filled",i<val.length);});}',
    'document.getElementById("pin-keypad").addEventListener("click",function(e){',
    '  var btn=e.target.closest("[data-v]");',
    '  if(btn&&val.length<6){val+=btn.dataset.v;render();}',
    '  if(val.length===6){',
    '    document.getElementById("pin-value").value=val;',
    '    document.getElementById("pin-form").submit();',
    '  }',
    '});',
    'document.getElementById("pin-del").addEventListener("click",function(){val=val.slice(0,-1);render();});',
    '})();',
    '</script>',
    '</section>'
  ].join('');
}

app.get("/wallet/pin-setup", requireAuth, function (req, res) {
  const keys = [1,2,3,4,5,6,7,8,9].map(function(n){
    return '<button type="button" class="pin-key" data-v="'+n+'">'+n+'</button>';
  }).join('') +
    '<button type="button" class="pin-key empty" disabled></button>' +
    '<button type="button" class="pin-key" data-v="0">0</button>';
  res.send(layout(req, "송금 비밀번호 설정", [
    '<section class="card auth" style="max-width:360px">',
    '<div id="ps1">',
    '<h1>송금 비밀번호 설정</h1>',
    '<p style="color:var(--muted);font-size:14px;margin-bottom:24px">처음 사용 시 6자리 비밀번호를 설정합니다.<br>새 비밀번호를 입력하세요.</p>',
    '<div class="pin-dots">',
    [0,1,2,3,4,5].map(function(i){return '<div class="pin-dot" id="d'+i+'"></div>';}).join(''),
    '</div>',
    '<div class="pin-keypad" id="pk1">' + keys + '<button type="button" class="pin-key del" id="del1">⌫</button></div>',
    '</div>',
    '<div id="ps2" style="display:none">',
    '<h1>비밀번호 확인</h1>',
    '<p style="color:var(--muted);font-size:14px;margin-bottom:24px">한 번 더 입력해주세요</p>',
    '<div class="pin-dots">',
    [0,1,2,3,4,5].map(function(i){return '<div class="pin-dot" id="e'+i+'"></div>';}).join(''),
    '</div>',
    '<div class="pin-keypad" id="pk2">' + keys + '<button type="button" class="pin-key del" id="del2">⌫</button></div>',
    '<p id="pm" style="color:var(--danger);font-size:13px;margin-top:12px;display:none">비밀번호가 일치하지 않습니다.</p>',
    '</div>',
    '<form method="post" action="/wallet/pin-setup" id="psf" style="display:none">',
    '<input type="hidden" name="pin" id="pv1" />',
    '<input type="hidden" name="pin_confirm" id="pv2" />',
    '</form>',
    '<script>(function(){',
    'var v1="",v2="";',
    'var d1=[0,1,2,3,4,5].map(function(i){return document.getElementById("d"+i);});',
    'var d2=[0,1,2,3,4,5].map(function(i){return document.getElementById("e"+i);});',
    'function r1(){d1.forEach(function(d,i){d.classList.toggle("filled",i<v1.length);});}',
    'function r2(){d2.forEach(function(d,i){d.classList.toggle("filled",i<v2.length);});}',
    'document.getElementById("pk1").addEventListener("click",function(e){',
    '  var b=e.target.closest("[data-v]");if(b&&v1.length<6){v1+=b.dataset.v;r1();}',
    '  if(v1.length===6){document.getElementById("ps1").style.display="none";document.getElementById("ps2").style.display="";}',
    '});',
    'document.getElementById("del1").addEventListener("click",function(){v1=v1.slice(0,-1);r1();});',
    'document.getElementById("pk2").addEventListener("click",function(e){',
    '  var b=e.target.closest("[data-v]");if(b&&v2.length<6){v2+=b.dataset.v;r2();}',
    '  if(v2.length===6){',
    '    if(v2===v1){document.getElementById("pv1").value=v1;document.getElementById("pv2").value=v2;document.getElementById("psf").submit();}',
    '    else{document.getElementById("pm").style.display="";v2="";r2();}',
    '  }',
    '});',
    'document.getElementById("del2").addEventListener("click",function(){v2=v2.slice(0,-1);r2();document.getElementById("pm").style.display="none";});',
    '})();</script>',
    '</section>'
  ].join('')));
});

app.post("/wallet/pin-setup", requireAuth, async function (req, res, next) {
  try {
    const pin = String(req.body.pin || "").trim();
    const pinConfirm = String(req.body.pin_confirm || "").trim();
    if (!/^\d{6}$/.test(pin) || pin !== pinConfirm) {
      req.session.error = "비밀번호 입력이 올바르지 않습니다. 다시 시도해주세요.";
      return res.redirect("/wallet/pin-setup");
    }
    const hash = await bcrypt.hash(pin, 10);
    await pool.query("UPDATE users SET wallet_pin_hash = $1 WHERE id = $2", [hash, req.session.user.id]);
    req.session.success = "송금 비밀번호가 설정되었습니다.";
    res.redirect("/wallet");
  } catch (e) { next(e); }
});

app.get("/wallet", requireAuth, async function (req, res, next) {
  try {
    const pinRow = await queryOne("SELECT wallet_pin_hash FROM users WHERE id = $1", [req.session.user.id]);
    if (!pinRow || !pinRow.wallet_pin_hash) return res.redirect("/wallet/pin-setup");
    const receiverId = Number(req.query.receiver || 0);
    const selectedReceiver = receiverId ? await currentUserRow(receiverId) : null;
    const transfers = await query(
      `SELECT t.id, t.amount, t.note, t.created_at AS "createdAt",
       sender.display_name AS "senderName", receiver.display_name AS "receiverName",
       t.sender_id AS "senderId", t.receiver_id AS "receiverId",
       EXISTS (SELECT 1 FROM reviews rv WHERE rv.reviewer_id = $1 AND rv.transfer_id = t.id) AS "hasReview"
       FROM transfers t
       JOIN users sender ON sender.id = t.sender_id
       JOIN users receiver ON receiver.id = t.receiver_id
       WHERE t.sender_id = $1 OR t.receiver_id = $1
       ORDER BY t.created_at DESC LIMIT 20`,
      [req.session.user.id]
    );
    const preVal = selectedReceiver ? h(selectedReceiver.displayName) + " (@" + h(selectedReceiver.username) + ")" : "";
    const preId = selectedReceiver ? selectedReceiver.id : "";
    res.send(layout(req, "지갑", [
      '<section class="grid two-col">',
      '<article class="card"><h1>내 지갑</h1>',
      '<p class="price">' + amount(req.session.user.balance) + "</p>",
      "<p style=\"color:var(--muted);font-size:13px\">가입 시 기본 잔액 " + amount(DEFAULT_BALANCE) + "이 지급됩니다.</p>",
      '<form method="post" action="/wallet/transfer" class="stack" style="margin-top:20px" id="transfer-form">',
      '<label>받는 사람',
      '<div class="user-search-wrap">',
      '<input id="user-search-input" placeholder="아이디 또는 닉네임으로 검색..." autocomplete="off" value="' + preVal + '" />',
      '<div id="user-search-dropdown" class="search-dropdown"></div>',
      '</div>',
      '<input type="hidden" name="receiverId" id="receiver-id-input" value="' + preId + '" required />',
      '<small id="selected-label" class="hint">' + (preVal ? "선택됨: " + preVal : "") + '</small>',
      '</label>',
      '<label>송금 금액<input type="number" name="amount" min="1" required /></label>',
      '<label>메모<textarea name="note" rows="2"></textarea></label>',
      '<input type="hidden" name="pin" id="transfer-pin-value" />',
      "<button type=\"button\" class=\"primary\" id=\"open-pin-overlay\">송금하기</button>",
      "</form>",
      '<div class="pin-overlay" id="pin-overlay">',
      '<div class="pin-box">',
      '<h3>송금 비밀번호</h3>',
      '<p id="pin-overlay-sub">6자리 비밀번호를 입력하세요</p>',
      '<div class="pin-dots" id="po-dots">',
      '<div class="pin-dot" id="po0"></div><div class="pin-dot" id="po1"></div>',
      '<div class="pin-dot" id="po2"></div><div class="pin-dot" id="po3"></div>',
      '<div class="pin-dot" id="po4"></div><div class="pin-dot" id="po5"></div>',
      '</div>',
      '<div class="pin-keypad" id="po-keypad">',
      [1,2,3,4,5,6,7,8,9].map(function(n){return '<button type="button" class="pin-key" data-v="'+n+'">'+n+'</button>';}).join(''),
      '<button type="button" class="pin-key empty" disabled></button>',
      '<button type="button" class="pin-key" data-v="0">0</button>',
      '<button type="button" class="pin-key del" id="po-del">⌫</button>',
      '</div>',
      '<div class="pin-cancel" id="pin-cancel">취소</div>',
      '</div>',
      '</div>',
      '<script>',
      '(function(){',
      'var pval="";',
      'var pdots=[0,1,2,3,4,5].map(function(i){return document.getElementById("po"+i);});',
      'function prender(){pdots.forEach(function(d,i){d.classList.toggle("filled",i<pval.length);});}',
      'document.getElementById("open-pin-overlay").addEventListener("click",function(){',
      '  var rid=document.getElementById("receiver-id-input");',
      '  if(!rid.value){alert("받는 사람을 선택해주세요.");return;}',
      '  pval="";prender();document.getElementById("pin-overlay-sub").textContent="6자리 비밀번호를 입력하세요";',
      '  document.getElementById("pin-overlay").classList.add("active");',
      '});',
      'document.getElementById("pin-cancel").addEventListener("click",function(){document.getElementById("pin-overlay").classList.remove("active");});',
      'document.getElementById("po-keypad").addEventListener("click",function(e){',
      '  var btn=e.target.closest("[data-v]");',
      '  if(btn&&pval.length<6){pval+=btn.dataset.v;prender();}',
      '  if(pval.length===6){',
      '    document.getElementById("transfer-pin-value").value=pval;',
      '    document.getElementById("pin-overlay").classList.remove("active");',
      '    document.getElementById("transfer-form").submit();',
      '  }',
      '});',
      'document.getElementById("po-del").addEventListener("click",function(){pval=pval.slice(0,-1);prender();});',
      '})();',
      '</script>',
      '<script>',
      '(function(){',
      'var inp=document.getElementById("user-search-input");',
      'var drop=document.getElementById("user-search-dropdown");',
      'var rid=document.getElementById("receiver-id-input");',
      'var lbl=document.getElementById("selected-label");',
      'var timer;',
      'inp.addEventListener("input",function(){',
      '  clearTimeout(timer);',
      '  rid.value=""; lbl.textContent="";',
      '  var q=this.value.trim();',
      '  if(!q){drop.style.display="none";return;}',
      '  timer=setTimeout(function(){',
      '    fetch("/api/users/search?q="+encodeURIComponent(q))',
      '    .then(function(r){return r.json();})',
      '    .then(function(users){',
      '      if(!users.length){drop.innerHTML=\'<div class="search-result-item" style="color:var(--muted)">결과 없음</div>\';}',
      '      else{drop.innerHTML=users.map(function(u){return\'<div class="search-result-item" data-id="\'+u.id+\'" data-label="\'+u.displayName+\' (@\'+u.username+\')"><strong>\'+u.displayName+"</strong> <span style=\'color:var(--muted)\'>@"+u.username+"</span></div>";}).join("");}',
      '      drop.style.display="block";',
      '      drop.querySelectorAll("[data-id]").forEach(function(el){',
      '        el.addEventListener("click",function(){',
      '          rid.value=this.dataset.id;',
      '          inp.value=this.dataset.label;',
      '          lbl.textContent="선택됨: "+this.dataset.label;',
      '          drop.style.display="none";',
      '        });',
      '      });',
      '    });',
      '  },300);',
      '});',
      'document.addEventListener("click",function(e){if(!inp.contains(e.target)&&!drop.contains(e.target))drop.style.display="none";});',
      'document.getElementById("transfer-form").addEventListener("submit",function(e){if(!rid.value){e.preventDefault();alert("받는 사람을 선택해주세요.");}});',
      '})();',
      '</script>',
      "</article>",
      '<article class="card"><h2>최근 송금 내역</h2><div class="stack">' +
        (transfers.map(function (item) {
          const myId = req.session.user.id;
          const isSender = item.senderId === myId;
          const dir = isSender ? "보냄" : "받음";
          const reviewBtn = isSender && !item.hasReview
            ? '<a class="button primary" href="/users/' + item.receiverId + '?review=' + item.id + '">후기 남기기</a>'
            : (isSender && item.hasReview ? '<span class="badge muted">후기 완료</span>' : "");
          return '<div class="subcard"><strong>' + dir + " · " + amount(item.amount) + "</strong>" +
            "<span>" + h(item.senderName) + " → " + h(item.receiverName) + "</span>" +
            "<span>" + h(item.note || "메모 없음") + "</span>" +
            "<small>" + formatKST(item.createdAt) + "</small>" +
            (reviewBtn ? '<div style="margin-top:8px">' + reviewBtn + '</div>' : "") +
            "</div>";
        }).join("") || "<p>송금 내역이 없습니다.</p>") + "</div></article>",
      "</section>"
    ].join("")));
  } catch (e) { next(e); }
});

app.post("/wallet/transfer", requireAuth, async function (req, res, next) {
  try {
    const senderId = req.session.user.id;
    const receiverId = Number(req.body.receiverId);
    const value = Number(req.body.amount);
    const note = (req.body.note || "").trim();
    const pin = String(req.body.pin || "").trim();
    if (!receiverId || !Number.isFinite(value) || value < 1) {
      req.session.error = "유효한 송금 정보를 입력해주세요.";
      return res.redirect("/wallet");
    }
    if (receiverId === senderId) {
      req.session.error = "자기 자신에게 송금할 수 없습니다.";
      return res.redirect("/wallet");
    }
    const pinRow = await queryOne("SELECT wallet_pin_hash FROM users WHERE id = $1", [senderId]);
    if (!pinRow || !pinRow.wallet_pin_hash) return res.redirect("/wallet/pin-setup");
    const pinOk = await bcrypt.compare(pin, pinRow.wallet_pin_hash);
    if (!pinOk) {
      req.session.error = "송금 비밀번호가 틀렸습니다.";
      return res.redirect("/wallet");
    }
    const sender = await currentUserRow(senderId);
    const receiver = await currentUserRow(receiverId);
    if (!receiver || receiver.isDormant) {
      req.session.error = "받는 사용자를 찾을 수 없습니다.";
      return res.redirect("/wallet");
    }
    if (sender.balance < value) {
      req.session.error = "잔액이 부족합니다.";
      return res.redirect("/wallet");
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE users SET balance = balance - $1 WHERE id = $2", [value, senderId]);
      await client.query("UPDATE users SET balance = balance + $1 WHERE id = $2", [value, receiverId]);
      await client.query("INSERT INTO transfers (sender_id, receiver_id, amount, note) VALUES ($1, $2, $3, $4)",
        [senderId, receiverId, value, note]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    // 송금 완료 후 DM방에 거래 카드 메시지 삽입 + 실시간 전송
    try {
      const transferRow = await queryOne(
        "SELECT id FROM transfers WHERE sender_id=$1 AND receiver_id=$2 ORDER BY id DESC LIMIT 1",
        [senderId, receiverId]
      );
      const roomId = await getDirectRoomId(senderId, receiverId);
      const meta = JSON.stringify({ transferId: transferRow.id, amount: value, note: note, senderName: sender.displayName });
      const content = sender.displayName + "님이 " + value.toLocaleString() + "원을 송금했습니다.";
      const msgRow = await queryOne(
        "INSERT INTO messages (room_type, room_id, sender_id, content, type, meta) VALUES ('direct',$1,$2,$3,'transfer',$4) RETURNING id, created_at",
        [roomId, senderId, content, meta]
      );
      const socketPayload = {
        id: msgRow.id, roomType: "direct", roomId: roomId,
        senderId: senderId, senderUsername: sender.username,
        displayName: sender.displayName, content: content,
        type: "transfer", meta: meta, createdAt: msgRow.created_at
      };
      io.to("direct:" + roomId).emit("chat-message", socketPayload);
    } catch (_me) { /* DM 카드 삽입 실패해도 송금은 완료 */ }
    // 알림 발송
    try {
      const notifMsg = sender.displayName + "님이 " + value.toLocaleString() + "원을 송금했습니다." + (note ? " (" + note + ")" : "");
      await pool.query(
        "INSERT INTO notifications (user_id, type, message, link) VALUES ($1, 'transfer', $2, '/wallet')",
        [receiverId, notifMsg]
      );
      const nc = await queryOne("SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1 AND is_read = 0", [receiverId]);
      io.to("user:" + receiverId).emit("notification", {
        message: notifMsg, link: "/wallet", count: parseInt(nc.count) || 0
      });
    } catch (_ne) {}
    await refreshSessionUser(req);
    req.session.success = "송금이 완료되었습니다.";
    res.redirect("/chat/start/" + receiverId);
  } catch (e) { next(e); }
});

app.get("/products", async function (req, res, next) {
  try {
    const q = (req.query.q || "").trim();
    const category = (req.query.category || "").trim();
    const region = (req.query.region || "").trim();
    const status = (req.query.status || "").trim();
    const minPrice = Number(req.query.minPrice || 0);
    const maxPrice = Number(req.query.maxPrice || 0);
    const sort = (req.query.sort || "recent").trim();
    const orderBy = { recent: "p.created_at DESC", priceAsc: "p.price ASC", priceDesc: "p.price DESC", nameAsc: "p.name ASC" }[sort] || "p.created_at DESC";
    const products = await query(
      `SELECT p.id, p.name, p.price, p.image_path AS "imagePath", p.category, p.region, p.status,
       u.display_name AS "sellerName" FROM products p
       JOIN users u ON u.id = p.seller_id
       WHERE p.is_blocked = 0
       AND ($1 = '' OR p.name ILIKE '%' || $1 || '%' OR p.description ILIKE '%' || $1 || '%')
       AND ($2 = '' OR p.category = $2)
       AND ($3 = '' OR p.region = $3)
       AND ($4 = '' OR p.status = $4)
       AND ($5 = 0 OR p.price >= $5)
       AND ($6 = 0 OR p.price <= $6)
       ORDER BY ` + orderBy,
      [q, category, region, status, minPrice, maxPrice]
    );
    res.send(layout(req, "상품 목록", [
      '<section class="section-head"><h1>상품 목록</h1></section>',
      '<form method="get" action="/products" class="card search-panel">',
      '<div class="grid search-grid">',
      '<label>검색어<input name="q" value="' + h(q) + '" placeholder="상품명 또는 설명" /></label>',
      '<label>카테고리<select name="category"><option value="">전체</option>' +
        ["전자기기", "가구", "도서", "의류", "기타"].map(function (c) {
          return '<option' + (category === c ? " selected" : "") + ">" + c + "</option>";
        }).join("") + "</select></label>",
      '<label>지역<select name="region"><option value="">전체</option>' + REGIONS.map(function(r){return '<option'+(region===r?' selected':'')+'>'+r+'</option>';}).join('') + '</select></label>',
      '<label>상태<select name="status"><option value="">전체</option>' +
        ["판매중", "예약중", "판매완료"].map(function (s) {
          return '<option' + (status === s ? " selected" : "") + ">" + s + "</option>";
        }).join("") + "</select></label>",
      '<label>최소 가격<input type="number" name="minPrice" min="0" value="' + (minPrice || "") + '" /></label>',
      '<label>최대 가격<input type="number" name="maxPrice" min="0" value="' + (maxPrice || "") + '" /></label>',
      '<label>정렬<select name="sort">' +
        [["recent", "최신순"], ["priceAsc", "가격 낮은순"], ["priceDesc", "가격 높은순"], ["nameAsc", "이름순"]].map(function (o) {
          return '<option value="' + o[0] + '"' + (sort === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
        }).join("") + "</select></label>",
      "</div>",
      '<div class="actions"><button type="submit" class="primary">검색</button><a class="button" href="/products">초기화</a></div>',
      "</form>",
      '<div class="grid">' + (products.map(productCard).join("") || "<p>조건에 맞는 상품이 없습니다.</p>") + "</div>"
    ].join("")));
  } catch (e) { next(e); }
});

app.get("/product/new", requireAuth, function (req, res) {
  res.send(layout(req, "상품 등록", [
    '<section class="card"><h1>상품 등록</h1>',
    '<form method="post" action="/product/new" enctype="multipart/form-data" class="stack">',
    "<label>상품명<input name=\"name\" required /></label>",
    "<label>설명<textarea name=\"description\" rows=\"5\" required></textarea></label>",
    "<label>가격<input name=\"price\" type=\"number\" min=\"0\" required /></label>",
    '<label>카테고리<select name="category"><option>전자기기</option><option>가구</option><option>도서</option><option>의류</option><option selected>기타</option></select></label>',
    '<label>지역<select name="region" required><option value="">선택</option>' + REGIONS.map(function(r){return '<option>'+r+'</option>';}).join('') + '</select></label>',
    '<label>판매 상태<select name="status"><option selected>판매중</option><option>예약중</option><option>판매완료</option></select></label>',
    '<label>사진<input name="image" type="file" accept="image/*" required /></label>',
    "<button type=\"submit\">등록하기</button>",
    "</form></section>"
  ].join("")));
});

app.post("/product/new", requireAuth, function (req, res, next) {
  upload.single("image")(req, res, async function (err) {
    if (err) {
      req.session.error = err.message;
      return res.redirect("/product/new");
    }
    try {
      const name = (req.body.name || "").trim();
      const description = (req.body.description || "").trim();
      const price = Number(req.body.price || 0);
      const category = (req.body.category || "기타").trim();
      const region = (req.body.region || "미지정").trim();
      const status = (req.body.status || "판매중").trim();
      if (!name || !description || !req.file) {
        req.session.error = "모든 상품 정보를 입력해주세요.";
        return res.redirect("/product/new");
      }
      const imagePath = await uploadImage(req.file);
      await pool.query(
        "INSERT INTO products (seller_id, name, description, price, image_path, category, region, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [req.session.user.id, name, description, price, imagePath, category, region, status]
      );
      req.session.success = "상품이 등록되었습니다.";
      res.redirect("/my-products");
    } catch (e) { next(e); }
  });
});

app.get("/my-products", requireAuth, async function (req, res, next) {
  try {
    const products = await query(
      `SELECT id, name, price, image_path AS "imagePath", category, region, status, is_blocked AS "isBlocked"
       FROM products WHERE seller_id = $1 ORDER BY created_at DESC`,
      [req.session.user.id]
    );
    res.send(layout(req, "내 상품", [
      '<section class="section-head"><h1>내 상품 관리</h1><a class="button primary" href="/product/new">새 상품 등록</a></section>',
      '<div class="stack">',
      products.map(function (product) {
        return '<article class="card inline-card"><img src="' + h(product.imagePath) + '" alt="' + h(product.name) + '" /><div>' +
          '<h3><a href="/products/' + product.id + '">' + h(product.name) + "</a></h3>" +
          "<p>" + amount(product.price) + "</p>" +
          "<p>" + h(product.category) + " · " + h(product.region) + " · " + h(product.status) + "</p>" +
          "<p>" + (product.isBlocked ? "차단됨" : "노출 중") + "</p>" +
          '<div class="actions"><a class="button" href="/products/' + product.id + '/edit">수정</a>' +
          '<form method="post" action="/products/' + product.id + '/delete" class="inline"><button type="submit">삭제</button></form></div>' +
          "</div></article>";
      }).join("") || "<p>등록한 상품이 없습니다.</p>",
      "</div>"
    ].join("")));
  } catch (e) { next(e); }
});

app.post("/products/:id/delete", requireAuth, async function (req, res, next) {
  try {
    await pool.query("DELETE FROM products WHERE id = $1 AND seller_id = $2",
      [Number(req.params.id), req.session.user.id]);
    req.session.success = "상품이 삭제되었습니다.";
    res.redirect("/my-products");
  } catch (e) { next(e); }
});

app.get("/products/:id/edit", requireAuth, async function (req, res, next) {
  try {
    const product = await queryOne(
      "SELECT id, name, description, price, category, region, status FROM products WHERE id = $1 AND seller_id = $2",
      [Number(req.params.id), req.session.user.id]
    );
    if (!product) {
      req.session.error = "상품을 찾을 수 없거나 수정 권한이 없습니다.";
      return res.redirect("/my-products");
    }
    const statusOptions = ["판매중", "예약중", "판매완료"];
    res.send(layout(req, "상품 수정", [
      '<section class="card"><h1>상품 수정</h1>',
      '<form method="post" action="/products/' + product.id + '/edit" class="stack">',
      '<label>상품명<input name="name" value="' + h(product.name) + '" required /></label>',
      '<label>설명<textarea name="description" rows="5" required>' + h(product.description) + '</textarea></label>',
      '<label>가격<input name="price" type="number" min="0" value="' + product.price + '" required /></label>',
      '<label>카테고리<select name="category">' +
        ["전자기기","가구","도서","의류","기타"].map(function(c){
          return '<option' + (product.category === c ? " selected" : "") + ">" + c + "</option>";
        }).join("") + "</select></label>",
      '<label>지역<select name="region" required><option value="">선택</option>' +
        REGIONS.map(function(r){
          return '<option' + (product.region === r ? " selected" : "") + ">" + r + "</option>";
        }).join("") + "</select></label>",
      '<label>판매 상태<select name="status">' +
        statusOptions.map(function(s){
          return '<option' + (product.status === s ? " selected" : "") + ">" + s + "</option>";
        }).join("") + "</select></label>",
      '<div class="actions"><button type="submit" class="primary">저장</button><a class="button" href="/products/' + product.id + '">취소</a></div>',
      "</form></section>"
    ].join("")));
  } catch (e) { next(e); }
});

app.post("/products/:id/edit", requireAuth, async function (req, res, next) {
  try {
    const id = Number(req.params.id);
    const product = await queryOne("SELECT id FROM products WHERE id = $1 AND seller_id = $2", [id, req.session.user.id]);
    if (!product) {
      req.session.error = "상품을 찾을 수 없거나 수정 권한이 없습니다.";
      return res.redirect("/my-products");
    }
    const name = (req.body.name || "").trim();
    const description = (req.body.description || "").trim();
    const price = Number(req.body.price || 0);
    const category = (req.body.category || "기타").trim();
    const region = (req.body.region || "미지정").trim();
    const status = (req.body.status || "판매중").trim();
    if (!name || !description) {
      req.session.error = "상품명과 설명을 입력해주세요.";
      return res.redirect("/products/" + id + "/edit");
    }
    await pool.query(
      "UPDATE products SET name=$1, description=$2, price=$3, category=$4, region=$5, status=$6 WHERE id=$7",
      [name, description, price, category, region, status, id]
    );
    req.session.success = "상품이 수정되었습니다.";
    res.redirect("/products/" + id);
  } catch (e) { next(e); }
});

app.get("/products/:id", async function (req, res, next) {
  try {
    const product = await queryOne(
      `SELECT p.id, p.name, p.description, p.price, p.image_path AS "imagePath",
       p.category, p.region, p.status, p.is_blocked AS "isBlocked",
       u.id AS "sellerId", u.display_name AS "sellerName"
       FROM products p JOIN users u ON u.id = p.seller_id WHERE p.id = $1`,
      [Number(req.params.id)]
    );
    if (!product || product.isBlocked) {
      return res.status(404).send(layout(req, "상품 없음", "<p>상품을 찾을 수 없습니다.</p>"));
    }
    const isOwner = req.session.user && req.session.user.id === product.sellerId;
    const me = req.session.user && !isOwner;
    const chatButton = me ? '<a class="button primary" href="/chat/start/' + product.sellerId + '">판매자와 1:1 채팅</a>' : "";
    const transferButton = me ? '<a class="button" href="/wallet?receiver=' + product.sellerId + '">판매자에게 송금</a>' : "";
    const editButton = isOwner ? '<a class="button" href="/products/' + product.id + '/edit">수정</a>' : "";
    const reportSection = me ? reportForm("product", product.id) : "";
    res.send(layout(req, product.name, [
      '<section class="detail">',
      '<img class="detail-image" src="' + h(product.imagePath) + '" alt="' + h(product.name) + '" />',
      '<div class="card">',
      "<h1>" + h(product.name) + "</h1>",
      '<p class="price">' + amount(product.price) + "</p>",
      '<p>판매자: <a href="/users/' + product.sellerId + '">' + h(product.sellerName) + "</a></p>",
      "<p>카테고리: " + h(product.category) + "</p>",
      "<p>지역: " + h(product.region) + "</p>",
      "<p>상태: " + h(product.status) + "</p>",
      "<p>" + h(product.description) + "</p>",
      '<div class="actions">' + chatButton + transferButton + editButton + "</div>",
      reportSection, "</div></section>"
    ].join("")));
  } catch (e) { next(e); }
});

app.post("/reports", requireAuth, async function (req, res, next) {
  try {
    const targetType = req.body.targetType;
    const targetId = Number(req.body.targetId);
    const reason = (req.body.reason || "").trim();
    if (!targetType || !targetId || !reason) {
      req.session.error = "신고 정보를 모두 입력해주세요.";
      return res.redirect(req.get("referer") || "/");
    }
    try {
      await pool.query(
        "INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES ($1, $2, $3, $4)",
        [req.session.user.id, targetType, targetId, reason]
      );
    } catch (err) {
      if (err.code === "23505") {
        req.session.error = "같은 대상은 한 번만 신고할 수 있습니다.";
        return res.redirect(req.get("referer") || "/");
      }
      throw err;
    }
    await enforceModeration(targetType, targetId);
    await refreshSessionUser(req);
    req.session.success = "신고가 접수되었습니다.";
    res.redirect(req.get("referer") || "/");
  } catch (e) { next(e); }
});

function chatTabNav(active) {
  return [
    '<div class="chat-tabs">',
    '<a href="/chat" class="tab-btn' + (active === "global" ? " active" : "") + '">전체 채팅</a>',
    '<a href="/chat?tab=dms" class="tab-btn' + (active === "dms" ? " active" : "") + '">1:1 채팅</a>',
    '</div>'
  ].join("");
}

app.get("/chat", requireAuth, async function (req, res, next) {
  try {
    const tab = req.query.tab || "global";
    if (tab === "dms") {
      const rooms = await query(
        `SELECT dr.id,
          CASE WHEN dr.user_a_id = $1 THEN ub.display_name ELSE ua.display_name END AS "partnerName",
          CASE WHEN dr.user_a_id = $1 THEN ub.id ELSE ua.id END AS "partnerId",
          CASE WHEN dr.user_a_id = $1 THEN ub.username ELSE ua.username END AS "partnerUsername",
          (SELECT content FROM messages WHERE room_type='direct' AND room_id=dr.id ORDER BY id DESC LIMIT 1) AS "lastMessage",
          (SELECT created_at FROM messages WHERE room_type='direct' AND room_id=dr.id ORDER BY id DESC LIMIT 1) AS "lastAt",
          (SELECT COUNT(*) FROM messages m
           WHERE m.room_type='direct' AND m.room_id=dr.id AND m.sender_id != $1
             AND m.created_at::TIMESTAMPTZ > COALESCE(
               (CASE WHEN dr.user_a_id=$1 THEN dr.user_a_last_read ELSE dr.user_b_last_read END)::TIMESTAMPTZ,
               '1970-01-01'::TIMESTAMPTZ
             )
          ) AS "unreadCount"
        FROM direct_rooms dr
        JOIN users ua ON ua.id = dr.user_a_id
        JOIN users ub ON ub.id = dr.user_b_id
        WHERE (dr.user_a_id = $1 AND COALESCE(dr.user_a_left,0) = 0)
           OR (dr.user_b_id = $1 AND COALESCE(dr.user_b_left,0) = 0)
        ORDER BY "lastAt" DESC NULLS LAST`,
        [req.session.user.id]
      );
      res.send(layout(req, "1:1 채팅 목록", [
        chatTabNav("dms"),
        '<section class="card"><h2>1:1 채팅 목록</h2>',
        '<div class="stack">',
        rooms.length ? rooms.map(function (r) {
          const unread = parseInt(r.unreadCount) || 0;
          const badge = unread > 0
            ? '<span class="dm-unread-badge">' + (unread > 99 ? '99+' : unread) + '</span>'
            : '';
          return '<a href="/chat/direct/' + r.id + '" class="dm-item' + (unread > 0 ? ' dm-item-unread' : '') + '">' +
            '<div class="avatar">' + h(r.partnerName).charAt(0) + '</div>' +
            '<div class="dm-item-info">' +
            '<strong>' + h(r.partnerName) + '</strong>' +
            '<span class="last-msg">@' + h(r.partnerUsername) + (r.lastMessage ? ' · ' + h(r.lastMessage) : '') + '</span>' +
            '</div>' +
            '<div class="dm-item-meta">' +
            (r.lastAt ? '<small>' + formatKST(r.lastAt) + '</small>' : '') +
            badge +
            '</div>' +
            '</a>';
        }).join("") : '<p style="color:var(--muted);text-align:center;padding:24px 0">아직 1:1 채팅이 없습니다.</p>',
        '</div></section>'
      ].join("")));
    } else {
      const messages = await query(
        `SELECT m.content, m.created_at AS "createdAt", u.display_name AS "displayName",
         u.id AS "senderId", u.username AS "senderUsername"
         FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.room_type = 'global' ORDER BY m.id ASC LIMIT 100`
      );
      res.send(layout(req, "전체 채팅", chatTabNav("global") + chatPage("전체 채팅", "global", "", messages, req.session.user.id)));
    }
  } catch (e) { next(e); }
});

app.get("/chat/start/:userId", requireAuth, async function (req, res, next) {
  try {
    const myId = req.session.user.id;
    const targetId = Number(req.params.userId);
    if (!targetId || targetId === myId) return res.redirect("/chat");
    const blockCheck = await queryOne(
      "SELECT id FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)",
      [myId, targetId]
    );
    if (blockCheck) {
      req.session.error = "차단 관계에 있어 채팅을 시작할 수 없습니다.";
      return res.redirect("/chat");
    }
    const roomId = await getDirectRoomId(myId, targetId);
    res.redirect("/chat/direct/" + roomId);
  } catch (e) { next(e); }
});

app.get("/chat/direct/:roomId", requireAuth, async function (req, res, next) {
  try {
    const roomId = Number(req.params.roomId);
    const room = await queryOne("SELECT * FROM direct_rooms WHERE id = $1", [roomId]);
    if (!room || [room.user_a_id, room.user_b_id].indexOf(req.session.user.id) === -1) {
      req.session.error = "채팅방에 접근할 수 없습니다.";
      return res.redirect("/chat");
    }
    const isA = room.user_a_id === req.session.user.id;
    const partnerId = isA ? room.user_b_id : room.user_a_id;
    const partner = await currentUserRow(partnerId);
    const partnerLastRead = isA ? room.user_b_last_read : room.user_a_last_read;
    // Update my last_read and mark DM notifications as read
    await pool.query(
      `UPDATE direct_rooms SET ${isA ? "user_a_last_read" : "user_b_last_read"} = $1, ${isA ? "user_a_left" : "user_b_left"} = 0 WHERE id = $2`,
      [new Date().toISOString(), roomId]
    );
    await pool.query("UPDATE notifications SET is_read = 1 WHERE user_id = $1 AND link = $2",
      [req.session.user.id, "/chat/direct/" + roomId]);
    const messages = await query(
      `SELECT m.content, m.created_at AS "createdAt", u.display_name AS "displayName",
       u.id AS "senderId", u.username AS "senderUsername",
       m.type, m.meta AS "metaJson"
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.room_type = 'direct' AND m.room_id = $1 ORDER BY m.id ASC LIMIT 100`,
      [roomId]
    );
    const header = [
      '<div class="dm-header">',
      '<a href="/chat?tab=dms" class="back-link">← 채팅 목록</a>',
      '<form method="post" action="/chat/direct/' + roomId + '/leave" class="inline" onsubmit="return confirm(\'채팅방을 나가시겠습니까?\')">',
      '<button type="submit" class="leave-btn">나가기</button>',
      '</form></div>'
    ].join("");
    res.send(layout(req, "1:1 채팅", header + chatPage(partner.displayName + "님과의 대화", "direct", roomId, messages, req.session.user.id, partnerLastRead, partnerId)));
  } catch (e) { next(e); }
});

app.post("/chat/direct/:roomId/leave", requireAuth, async function (req, res, next) {
  try {
    const roomId = Number(req.params.roomId);
    const room = await queryOne("SELECT * FROM direct_rooms WHERE id = $1", [roomId]);
    if (!room || [room.user_a_id, room.user_b_id].indexOf(req.session.user.id) === -1) {
      return res.redirect("/chat?tab=dms");
    }
    const isA = room.user_a_id === req.session.user.id;
    await pool.query(`UPDATE direct_rooms SET ${isA ? "user_a_left" : "user_b_left"} = 1 WHERE id = $1`, [roomId]);
    req.session.success = "채팅방을 나갔습니다.";
    res.redirect("/chat?tab=dms");
  } catch (e) { next(e); }
});

function adminSection(title, link, rows, empty) {
  return '<article class="card">' +
    '<div class="section-head" style="margin-bottom:12px"><h2>' + title + '</h2><a class="button" href="' + link + '">전체 보기</a></div>' +
    '<div class="stack">' + (rows || empty || "") + '</div></article>';
}

app.get("/admin", requireAuth, requireAdmin, async function (req, res, next) {
  try {
    const [mu, mdorm, mp, mblock, mr, mm, mt, mwarn] = await Promise.all([
      queryOne("SELECT COUNT(*) AS count FROM users"),
      queryOne("SELECT COUNT(*) AS count FROM users WHERE is_dormant = 1"),
      queryOne("SELECT COUNT(*) AS count FROM products"),
      queryOne("SELECT COUNT(*) AS count FROM products WHERE is_blocked = 1"),
      queryOne("SELECT COUNT(*) AS count FROM reports"),
      queryOne("SELECT COUNT(*) AS count FROM messages"),
      queryOne("SELECT COUNT(*) AS count FROM transfers"),
      queryOne("SELECT COUNT(*) AS count FROM users WHERE warnings > 0")
    ]);
    const metrics = {
      users: parseInt(mu.count), dormantUsers: parseInt(mdorm.count),
      products: parseInt(mp.count), blockedProducts: parseInt(mblock.count),
      reports: parseInt(mr.count), messages: parseInt(mm.count),
      transfers: parseInt(mt.count), warnedUsers: parseInt(mwarn.count)
    };
    const [recentUsers, recentReports, recentTransfers, recentMessages] = await Promise.all([
      query(`SELECT id, username, display_name AS "displayName", is_dormant AS "isDormant", warnings, created_at AS "createdAt"
             FROM users ORDER BY created_at DESC LIMIT 5`),
      query(`SELECT r.id, r.target_type AS "targetType", r.target_id AS "targetId", r.reason, r.created_at AS "createdAt",
             reporter.display_name AS "reporterName"
             FROM reports r JOIN users reporter ON reporter.id = r.reporter_id ORDER BY r.created_at DESC LIMIT 5`),
      query(`SELECT t.id, t.amount, t.created_at AS "createdAt",
             sender.display_name AS "senderName", receiver.display_name AS "receiverName"
             FROM transfers t JOIN users sender ON sender.id = t.sender_id
             JOIN users receiver ON receiver.id = t.receiver_id ORDER BY t.created_at DESC LIMIT 5`),
      query(`SELECT m.id, m.room_type AS "roomType", m.content, m.created_at AS "createdAt", u.display_name AS "displayName"
             FROM messages m JOIN users u ON u.id = m.sender_id
             WHERE m.type = 'text' ORDER BY m.created_at DESC LIMIT 5`)
    ]);
    res.send(layout(req, "관리자 대시보드", [
      '<section class="stats-grid">',
      '<article class="card stat"><strong>' + metrics.users + '</strong><span>전체 사용자</span></article>',
      '<article class="card stat"><strong>' + metrics.dormantUsers + '</strong><span>영구정지</span></article>',
      '<article class="card stat"><strong>' + metrics.warnedUsers + '</strong><span>경고 유저</span></article>',
      '<article class="card stat"><strong>' + metrics.products + '</strong><span>전체 상품</span></article>',
      '<article class="card stat"><strong>' + metrics.blockedProducts + '</strong><span>차단 상품</span></article>',
      '<article class="card stat"><strong>' + metrics.reports + '</strong><span>누적 신고</span></article>',
      '<article class="card stat"><strong>' + metrics.transfers + '</strong><span>총 송금</span></article>',
      '<article class="card stat"><strong>' + metrics.messages + '</strong><span>총 메시지</span></article>',
      '</section>',
      '<div class="admin-dash-grid">',
      adminSection("최근 가입 유저", "/admin/users",
        recentUsers.map(function (u) {
          return '<div class="subcard row"><span>' + h(u.displayName) + ' <small>@' + h(u.username) + '</small>' +
            (u.isDormant ? ' <span class="badge danger">영구정지</span>' : '') +
            (u.warnings > 0 ? ' <span class="badge warn">경고 ' + u.warnings + '</span>' : '') +
            '</span><small>' + formatKST(u.createdAt) + '</small></div>';
        }).join(""), "<p>없음</p>"),
      adminSection("최근 신고", "/admin/reports",
        recentReports.map(function (r) {
          return '<div class="subcard"><span><strong>' + h(r.reporterName) + '</strong> → ' +
            h(r.targetType) + ' #' + r.targetId + '</span>' +
            '<span style="color:var(--muted);font-size:13px">' + h(r.reason) + '</span>' +
            '<small>' + formatKST(r.createdAt) + '</small></div>';
        }).join(""), "<p>없음</p>"),
      adminSection("최근 송금", "/admin/transfers",
        recentTransfers.map(function (t) {
          return '<div class="subcard row"><span>' + h(t.senderName) + ' → ' + h(t.receiverName) +
            ' · <strong>' + amount(t.amount) + '</strong></span>' +
            '<small>' + formatKST(t.createdAt) + '</small></div>';
        }).join(""), "<p>없음</p>"),
      adminSection("최근 채팅", "/admin/messages",
        recentMessages.map(function (m) {
          return '<div class="subcard row"><span>' +
            '<strong>' + h(m.displayName) + '</strong>' +
            ' <small>[' + (m.roomType === 'direct' ? 'DM' : '전체') + ']</small> ' +
            h(m.content) + '</span>' +
            '<small>' + formatKST(m.createdAt) + '</small></div>';
        }).join(""), "<p>없음</p>"),
      '</div>'
    ].join("")));
  } catch (e) { next(e); }
});

// ── Admin 상세 페이지들 ─────────────────────────────────

app.get("/admin/users", requireAuth, requireAdmin, async function (req, res, next) {
  try {
    const q = (req.query.q || "").trim();
    const filter = req.query.filter || "all";
    const page = Math.max(1, parseInt(req.query.page || 1));
    const limit = 20, offset = (page - 1) * limit;
    const where = [
      q ? "(username ILIKE '%'||$1||'%' OR display_name ILIKE '%'||$1||'%')" : null,
      filter === "dormant" ? "is_dormant = 1" : null,
      filter === "warned" ? "warnings > 0" : null,
      filter === "suspended" ? "suspended_until > NOW()" : null
    ].filter(Boolean);
    const cond = where.length ? "WHERE " + where.join(" AND ") : "";
    const params = q ? [q] : [];
    const [total, users] = await Promise.all([
      queryOne("SELECT COUNT(*) AS count FROM users " + cond, params),
      query("SELECT id, username, display_name AS \"displayName\", balance, is_dormant AS \"isDormant\", is_admin AS \"isAdmin\", warnings, suspended_until AS \"suspendedUntil\", created_at AS \"createdAt\" FROM users " + cond + " ORDER BY created_at DESC LIMIT " + limit + " OFFSET " + offset, params)
    ]);
    const totalPages = Math.ceil(parseInt(total.count) / limit);
    const filters = [["all","전체"],["dormant","영구정지"],["warned","경고"],["suspended","정지중"]];
    res.send(layout(req, "유저 관리", [
      '<section class="section-head"><h1>유저 관리</h1><a class="button" href="/admin">← 대시보드</a></section>',
      '<form method="get" action="/admin/users" class="card search-panel" style="margin-bottom:16px">',
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">',
      '<input name="q" value="' + h(q) + '" placeholder="아이디 또는 닉네임" style="max-width:220px" />',
      filters.map(function(f){ return '<a class="button' + (filter===f[0]?' primary':'') + '" href="/admin/users?filter=' + f[0] + (q?'&q='+encodeURIComponent(q):'') + '">' + f[1] + '</a>'; }).join(""),
      '<button type="submit" class="primary">검색</button></div></form>',
      '<div class="stack">',
      users.map(function (u) {
        const statusText = u.isDormant ? "영구정지" : suspendLabel(u.suspendedUntil);
        return '<div class="subcard"><div class="row"><span>' +
          h(u.displayName) + ' <small>@' + h(u.username) + '</small> · ' + amount(u.balance) +
          ' · ' + (u.isAdmin ? '관리자' : '일반') +
          ' · <strong>' + statusText + '</strong> · 경고 ' + (u.warnings||0) + '회' +
          '</span><small>' + formatKST(u.createdAt) + '</small></div>' +
          '<div class="actions">' +
          '<form method="post" action="/admin/users/' + u.id + '/suspend" class="inline">' +
          '<select name="duration"><option value="0">정지 해제</option>' +
          '<option value="1">1일</option><option value="3">3일</option>' +
          '<option value="7">7일</option><option value="30">30일</option>' +
          '<option value="365">1년</option></select>' +
          '<button type="submit">적용</button></form>' +
          '<form method="post" action="/admin/users/' + u.id + '/toggle-dormant" class="inline">' +
          '<button type="submit">' + (u.isDormant ? '영구정지 해제' : '영구정지') + '</button></form>' +
          '</div></div>';
      }).join("") || "<p>해당하는 유저가 없습니다.</p>",
      '</div>',
      totalPages > 1 ? '<div class="pagination">' + Array.from({length:totalPages},function(_,i){
        return '<a class="button' + (page===i+1?' primary':'') + '" href="/admin/users?page='+(i+1)+(q?'&q='+encodeURIComponent(q):'')+'&filter='+filter+'">'+(i+1)+'</a>';
      }).join("") + '</div>' : ""
    ].join("")));
  } catch (e) { next(e); }
});

app.get("/admin/products", requireAuth, requireAdmin, async function (req, res, next) {
  try {
    const q = (req.query.q || "").trim();
    const filter = req.query.filter || "all";
    const page = Math.max(1, parseInt(req.query.page || 1));
    const limit = 20, offset = (page - 1) * limit;
    const conds = [filter === "blocked" ? "p.is_blocked = 1" : null, q ? "(p.name ILIKE '%'||$1||'%')" : null].filter(Boolean);
    const cond = conds.length ? "WHERE " + conds.join(" AND ") : "";
    const params = q ? [q] : [];
    const [total, products] = await Promise.all([
      queryOne("SELECT COUNT(*) AS count FROM products p " + cond, params),
      query(`SELECT p.id, p.name, p.price, p.status, p.is_blocked AS "isBlocked", p.created_at AS "createdAt", u.display_name AS "sellerName"
             FROM products p JOIN users u ON u.id = p.seller_id ` + cond + " ORDER BY p.created_at DESC LIMIT " + limit + " OFFSET " + offset, params)
    ]);
    const totalPages = Math.ceil(parseInt(total.count) / limit);
    res.send(layout(req, "상품 관리", [
      '<section class="section-head"><h1>상품 관리</h1><a class="button" href="/admin">← 대시보드</a></section>',
      '<form method="get" action="/admin/products" class="card search-panel" style="margin-bottom:16px">',
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">',
      '<input name="q" value="' + h(q) + '" placeholder="상품명" style="max-width:220px" />',
      '<a class="button' + (filter==='all'?' primary':'') + '" href="/admin/products">전체</a>',
      '<a class="button' + (filter==='blocked'?' primary':'') + '" href="/admin/products?filter=blocked">차단됨</a>',
      '<button type="submit" class="primary">검색</button></div></form>',
      '<div class="stack">',
      products.map(function (p) {
        return '<div class="subcard"><div class="row"><span><strong>' + h(p.name) + '</strong> · ' + h(p.sellerName) +
          ' · ' + amount(p.price) + ' · ' + h(p.status) + ' · ' + (p.isBlocked ? '<strong style="color:var(--danger)">차단</strong>' : '정상') +
          '</span><small>' + formatKST(p.createdAt) + '</small></div>' +
          '<div class="actions">' +
          '<form method="post" action="/admin/products/' + p.id + '/toggle-block" class="inline"><button type="submit">' + (p.isBlocked ? '차단 해제' : '차단') + '</button></form>' +
          '<form method="post" action="/admin/products/' + p.id + '/delete" class="inline"><button type="submit">삭제</button></form>' +
          '</div></div>';
      }).join("") || "<p>상품이 없습니다.</p>",
      '</div>',
      totalPages > 1 ? '<div class="pagination">' + Array.from({length:totalPages},function(_,i){
        return '<a class="button' + (page===i+1?' primary':'') + '" href="/admin/products?page='+(i+1)+(q?'&q='+encodeURIComponent(q):'')+'&filter='+filter+'">'+(i+1)+'</a>';
      }).join("") + '</div>' : ""
    ].join("")));
  } catch (e) { next(e); }
});

app.get("/admin/reports", requireAuth, requireAdmin, async function (req, res, next) {
  try {
    const q = (req.query.q || "").trim();
    const type = req.query.type || "all";
    const page = Math.max(1, parseInt(req.query.page || 1));
    const limit = 20, offset = (page - 1) * limit;
    const conds = [type !== "all" ? "r.target_type = '" + (type === "user" ? "user" : "product") + "'" : null].filter(Boolean);
    const cond = conds.length ? "WHERE " + conds.join(" AND ") : "";
    const [total, reports] = await Promise.all([
      queryOne("SELECT COUNT(*) AS count FROM reports r " + cond),
      query(`SELECT r.id, r.target_type AS "targetType", r.target_id AS "targetId", r.reason, r.created_at AS "createdAt",
             reporter.display_name AS "reporterName"
             FROM reports r JOIN users reporter ON reporter.id = r.reporter_id ` + cond + " ORDER BY r.created_at DESC LIMIT " + limit + " OFFSET " + offset)
    ]);
    const totalPages = Math.ceil(parseInt(total.count) / limit);
    res.send(layout(req, "신고 내역", [
      '<section class="section-head"><h1>신고 내역</h1><a class="button" href="/admin">← 대시보드</a></section>',
      '<div style="display:flex;gap:8px;margin-bottom:16px">',
      '<a class="button' + (type==='all'?' primary':'') + '" href="/admin/reports">전체</a>',
      '<a class="button' + (type==='user'?' primary':'') + '" href="/admin/reports?type=user">유저 신고</a>',
      '<a class="button' + (type==='product'?' primary':'') + '" href="/admin/reports?type=product">상품 신고</a>',
      '</div>',
      '<div class="stack">',
      reports.map(function (r) {
        return '<div class="subcard"><div class="row"><span><strong>' + h(r.reporterName) + '</strong> → ' +
          h(r.targetType) + ' #' + r.targetId + '</span><small>' + formatKST(r.createdAt) + '</small></div>' +
          '<p style="color:var(--muted);font-size:13px">' + h(r.reason) + '</p></div>';
      }).join("") || "<p>신고가 없습니다.</p>",
      '</div>',
      totalPages > 1 ? '<div class="pagination">' + Array.from({length:totalPages},function(_,i){
        return '<a class="button' + (page===i+1?' primary':'') + '" href="/admin/reports?page='+(i+1)+'&type='+type+'">'+(i+1)+'</a>';
      }).join("") + '</div>' : ""
    ].join("")));
  } catch (e) { next(e); }
});

app.get("/admin/transfers", requireAuth, requireAdmin, async function (req, res, next) {
  try {
    const q = (req.query.q || "").trim();
    const date = (req.query.date || "").trim();
    const page = Math.max(1, parseInt(req.query.page || 1));
    const limit = 20, offset = (page - 1) * limit;
    const conds = [
      q ? "(sender.display_name ILIKE '%'||$1||'%' OR receiver.display_name ILIKE '%'||$1||'%')" : null,
      date ? "t.created_at::DATE = '" + date.replace(/[^0-9-]/g,"") + "'" : null
    ].filter(Boolean);
    const cond = conds.length ? "WHERE " + conds.join(" AND ") : "";
    const params = q ? [q] : [];
    const [total, transfers] = await Promise.all([
      queryOne("SELECT COUNT(*) AS count FROM transfers t JOIN users sender ON sender.id=t.sender_id JOIN users receiver ON receiver.id=t.receiver_id " + cond, params),
      query(`SELECT t.id, t.amount, t.note, t.created_at AS "createdAt",
             sender.display_name AS "senderName", receiver.display_name AS "receiverName"
             FROM transfers t JOIN users sender ON sender.id = t.sender_id
             JOIN users receiver ON receiver.id = t.receiver_id ` + cond + " ORDER BY t.created_at DESC LIMIT " + limit + " OFFSET " + offset, params)
    ]);
    const totalPages = Math.ceil(parseInt(total.count) / limit);
    res.send(layout(req, "송금 로그", [
      '<section class="section-head"><h1>송금 로그</h1><a class="button" href="/admin">← 대시보드</a></section>',
      '<form method="get" action="/admin/transfers" class="card search-panel" style="margin-bottom:16px">',
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">',
      '<input name="q" value="' + h(q) + '" placeholder="보낸이 또는 받는이" style="max-width:200px" />',
      '<input type="date" name="date" value="' + h(date) + '" />',
      '<button type="submit" class="primary">검색</button>',
      q||date ? '<a class="button" href="/admin/transfers">초기화</a>' : '',
      '</div></form>',
      '<div class="stack">',
      transfers.map(function (t) {
        return '<div class="subcard row"><span><strong>' + amount(t.amount) + '</strong> · ' +
          h(t.senderName) + ' → ' + h(t.receiverName) +
          (t.note ? ' · <small>' + h(t.note) + '</small>' : '') +
          '</span><small>' + formatKST(t.createdAt, {seconds:true}) + '</small></div>';
      }).join("") || "<p>송금 내역이 없습니다.</p>",
      '</div>',
      totalPages > 1 ? '<div class="pagination">' + Array.from({length:totalPages},function(_,i){
        return '<a class="button' + (page===i+1?' primary':'') + '" href="/admin/transfers?page='+(i+1)+(q?'&q='+encodeURIComponent(q):'')+(date?'&date='+date:'')+'">'+(i+1)+'</a>';
      }).join("") + '</div>' : ""
    ].join("")));
  } catch (e) { next(e); }
});

app.post("/admin/users/:id/suspend", requireAuth, requireAdmin, async function (req, res, next) {
  try {
    const days = Number(req.body.duration || 0);
    const uid = Number(req.params.id);
    if (days === 0) {
      await pool.query("UPDATE users SET suspended_until = NULL WHERE id = $1", [uid]);
      req.session.success = "정지를 해제했습니다.";
    } else {
      const until = new Date(Date.now() + days * 86400000);
      await pool.query("UPDATE users SET suspended_until = $1 WHERE id = $2", [until.toISOString(), uid]);
      const notifMsg = days + "일 정지 처리되었습니다. (" + until.toLocaleDateString("ko-KR") + " 해제)";
      await pool.query(
        "INSERT INTO notifications (user_id, type, message, link) VALUES ($1, 'suspend', $2, '/mypage')",
        [uid, notifMsg]
      );
      io.to("user:" + uid).emit("notification", { message: notifMsg, link: "/mypage" });
      req.session.success = days + "일 정지를 적용했습니다.";
    }
    res.redirect("/admin/users");
  } catch (e) { next(e); }
});

app.post("/admin/users/:id/toggle-dormant", requireAuth, requireAdmin, async function (req, res, next) {
  try {
    const user = await queryOne("SELECT is_dormant AS \"isDormant\" FROM users WHERE id = $1", [Number(req.params.id)]);
    if (user) {
      await pool.query("UPDATE users SET is_dormant = $1 WHERE id = $2",
        [user.isDormant ? 0 : 1, Number(req.params.id)]);
      if (!user.isDormant) {
        await pool.query(
          "INSERT INTO notifications (user_id, type, message, link) VALUES ($1, 'suspend', $2, '/mypage')",
          [Number(req.params.id), "계정이 영구 정지되었습니다. 관리자에게 문의하세요.", "/mypage"]
        );
      }
    }
    req.session.success = "유저 상태를 변경했습니다.";
    res.redirect("/admin/users");
  } catch (e) { next(e); }
});

app.post("/admin/products/:id/toggle-block", requireAuth, requireAdmin, async function (req, res, next) {
  try {
    const product = await queryOne("SELECT is_blocked AS \"isBlocked\" FROM products WHERE id = $1", [Number(req.params.id)]);
    if (product) {
      await pool.query("UPDATE products SET is_blocked = $1 WHERE id = $2",
        [product.isBlocked ? 0 : 1, Number(req.params.id)]);
    }
    req.session.success = "상품 상태를 변경했습니다.";
    res.redirect("/admin/products");
  } catch (e) { next(e); }
});

app.get("/admin/messages", requireAuth, requireAdmin, async function (req, res, next) {
  try {
    const q = (req.query.q || "").trim();
    const type = req.query.type || "all";
    const date = (req.query.date || "").trim();
    const page = Math.max(1, parseInt(req.query.page || 1));
    const limit = 30, offset = (page - 1) * limit;
    const conds = [
      q ? "(m.content ILIKE '%'||$1||'%' OR u.display_name ILIKE '%'||$1||'%')" : null,
      type !== "all" ? "m.room_type = '" + (type === "global" ? "global" : "direct") + "'" : null,
      date ? "m.created_at::DATE = '" + date.replace(/[^0-9-]/g, "") + "'" : null
    ].filter(Boolean);
    const cond = conds.length ? "WHERE " + conds.join(" AND ") : "";
    const params = q ? [q] : [];
    const [total, messages] = await Promise.all([
      queryOne("SELECT COUNT(*) AS count FROM messages m JOIN users u ON u.id = m.sender_id " + cond, params),
      query(`SELECT m.id, m.room_type AS "roomType", m.room_id AS "roomId", m.content,
             m.created_at AS "createdAt", m.type, u.display_name AS "displayName", u.id AS "senderId"
             FROM messages m JOIN users u ON u.id = m.sender_id ` + cond +
             " ORDER BY m.created_at DESC LIMIT " + limit + " OFFSET " + offset, params)
    ]);
    const totalPages = Math.ceil(parseInt(total.count) / limit);
    res.send(layout(req, "채팅 로그", [
      '<section class="section-head"><h1>채팅 로그</h1><a class="button" href="/admin">← 대시보드</a></section>',
      '<form method="get" action="/admin/messages" class="card search-panel" style="margin-bottom:16px">',
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">',
      '<input name="q" value="' + h(q) + '" placeholder="내용 또는 발신자" style="max-width:200px" />',
      '<input type="date" name="date" value="' + h(date) + '" />',
      '<a class="button' + (type==='all'?' primary':'') + '" href="/admin/messages' + (date?'?date='+date:'') + '">전체</a>',
      '<a class="button' + (type==='global'?' primary':'') + '" href="/admin/messages?type=global' + (date?'&date='+date:'') + '">전체채팅</a>',
      '<a class="button' + (type==='direct'?' primary':'') + '" href="/admin/messages?type=direct' + (date?'&date='+date:'') + '">DM</a>',
      '<button type="submit" class="primary">검색</button>',
      q||date ? '<a class="button" href="/admin/messages">초기화</a>' : '',
      '</div></form>',
      '<div class="stack">',
      messages.map(function (m) {
        const roomLink = m.roomType === 'direct'
          ? '<a href="/chat/direct/' + m.roomId + '">[DM #' + m.roomId + ']</a>'
          : '[전체채팅]';
        return '<div class="subcard row"><span>' +
          roomLink + ' <strong>' + h(m.displayName) + '</strong> ' +
          (m.type === 'transfer' ? '<span class="badge warn">송금카드</span> ' : '') +
          h(m.content) +
          '</span><small>' + formatKST(m.createdAt, {seconds: true}) + '</small></div>';
      }).join("") || "<p>메시지가 없습니다.</p>",
      '</div>',
      totalPages > 1 ? '<div class="pagination">' + Array.from({length: totalPages}, function(_, i) {
        return '<a class="button' + (page===i+1?' primary':'') + '" href="/admin/messages?page='+(i+1)+(q?'&q='+encodeURIComponent(q):'')+(date?'&date='+date:'')+'&type='+type+'">'+(i+1)+'</a>';
      }).join("") + '</div>' : ""
    ].join("")));
  } catch (e) { next(e); }
});

app.post("/admin/products/:id/delete", requireAuth, requireAdmin, async function (req, res, next) {
  try {
    await pool.query("DELETE FROM products WHERE id = $1", [Number(req.params.id)]);
    req.session.success = "상품을 삭제했습니다.";
    res.redirect("/admin/products");
  } catch (e) { next(e); }
});

io.on("connection", function (socket) {
  const su0 = socket.request.session && socket.request.session.user;
  if (su0) socket.join("user:" + su0.id);

  socket.on("join", async function (payload) {
    const su = socket.request.session && socket.request.session.user;
    if (!su) return;
    const key = payload.roomType === "global" ? "global" : "direct:" + payload.roomId;
    socket.join(key);
    if (payload.roomType === "direct" && payload.roomId) {
      try {
        const roomId = Number(payload.roomId);
        const room = await queryOne("SELECT * FROM direct_rooms WHERE id = $1", [roomId]);
        if (room && [room.user_a_id, room.user_b_id].indexOf(su.id) !== -1) {
          const isA = room.user_a_id === su.id;
          await pool.query(
            `UPDATE direct_rooms SET ${isA ? "user_a_last_read" : "user_b_last_read"} = $1 WHERE id = $2`,
            [new Date().toISOString(), roomId]
          );
          // Notify the PARTNER that their sent messages have been read
          const partnerId = isA ? room.user_b_id : room.user_a_id;
          io.to("user:" + partnerId).emit("messages-read");
        }
      } catch (_e) { /* ignore */ }
    }
  });

  socket.on("mark-read", async function (payload) {
    const su = socket.request.session && socket.request.session.user;
    if (!su) return;
    try {
      const roomId = Number(payload.roomId);
      const room = await queryOne("SELECT * FROM direct_rooms WHERE id = $1", [roomId]);
      if (!room || [room.user_a_id, room.user_b_id].indexOf(su.id) === -1) return;
      const isA = room.user_a_id === su.id;
      await pool.query(
        `UPDATE direct_rooms SET ${isA ? "user_a_last_read" : "user_b_last_read"} = $1 WHERE id = $2`,
        [new Date().toISOString(), roomId]
      );
      const partnerId = isA ? room.user_b_id : room.user_a_id;
      io.to("user:" + partnerId).emit("messages-read");
    } catch (_e) {}
  });

  socket.on("chat-message", async function (payload) {
    try {
      const su = socket.request.session && socket.request.session.user;
      if (!su || su.isDormant) return;
      const content = String(payload.content || "").trim().slice(0, 500);
      if (!content) return;
      const roomType = payload.roomType === "direct" ? "direct" : "global";
      const roomId = roomType === "direct" ? Number(payload.roomId) : null;
      if (roomType === "direct") {
        const room = await queryOne("SELECT * FROM direct_rooms WHERE id = $1", [roomId]);
        if (!room || [room.user_a_id, room.user_b_id].indexOf(su.id) === -1) return;
        const recipientId = room.user_a_id === su.id ? room.user_b_id : room.user_a_id;
        const isRecipA = room.user_a_id === recipientId;
        await pool.query(
          `UPDATE direct_rooms SET ${isRecipA ? "user_a_left" : "user_b_left"} = 0 WHERE id = $1`, [roomId]
        );
        try {
          const preview = su.displayName + ": " + (content.length > 30 ? content.slice(0, 30) + "…" : content);
          await pool.query(
            "INSERT INTO notifications (user_id, type, message, link) VALUES ($1, 'dm', $2, $3)",
            [recipientId, preview, "/chat/direct/" + roomId]
          );
          const nc = await queryOne("SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1 AND is_read = 0", [recipientId]);
          io.to("user:" + recipientId).emit("notification", {
            message: preview, link: "/chat/direct/" + roomId, count: parseInt(nc.count) || 0
          });
        } catch (_ne) { /* notification failure must not block message delivery */ }
      }
      await pool.query(
        "INSERT INTO messages (room_type, room_id, sender_id, content) VALUES ($1, $2, $3, $4)",
        [roomType, roomId, su.id, content]
      );
      io.to(roomType === "global" ? "global" : "direct:" + roomId).emit("chat-message", {
        displayName: su.displayName, senderUsername: su.username, senderId: su.id,
        content: content, createdAt: new Date().toISOString()
      });
    } catch (_e) { /* ignore */ }
  });
});

async function main() {
  await initDB();
  await initStorage();
  server.listen(PORT, function () {
    console.log("UsedHub server started on http://localhost:" + PORT);
  });
}

main().catch(function (e) {
  console.error("서버 시작 실패:", e);
  process.exit(1);
});
