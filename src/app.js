const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const http = require("http");
const Database = require("better-sqlite3");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "market.db");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret-change-me";
const DEFAULT_BALANCE = 100000;
const PRODUCT_REPORT_THRESHOLD = 3;
const USER_REPORT_THRESHOLD = 3;

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec([
  "CREATE TABLE IF NOT EXISTS users (",
  "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  username TEXT NOT NULL UNIQUE,",
  "  display_name TEXT NOT NULL,",
  "  password_hash TEXT NOT NULL,",
  "  bio TEXT NOT NULL DEFAULT '',",
  "  balance INTEGER NOT NULL DEFAULT 0,",
  "  is_dormant INTEGER NOT NULL DEFAULT 0,",
  "  is_admin INTEGER NOT NULL DEFAULT 0,",
  "  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
  ");",
  "CREATE TABLE IF NOT EXISTS products (",
  "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  seller_id INTEGER NOT NULL,",
  "  name TEXT NOT NULL,",
  "  description TEXT NOT NULL,",
  "  price INTEGER NOT NULL,",
  "  image_path TEXT NOT NULL,",
  "  category TEXT NOT NULL DEFAULT '기타',",
  "  region TEXT NOT NULL DEFAULT '미지정',",
  "  status TEXT NOT NULL DEFAULT '판매중',",
  "  is_blocked INTEGER NOT NULL DEFAULT 0,",
  "  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,",
  "  FOREIGN KEY (seller_id) REFERENCES users(id)",
  ");",
  "CREATE TABLE IF NOT EXISTS reports (",
  "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  reporter_id INTEGER NOT NULL,",
  "  target_type TEXT NOT NULL CHECK(target_type IN ('user', 'product')),",
  "  target_id INTEGER NOT NULL,",
  "  reason TEXT NOT NULL,",
  "  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,",
  "  UNIQUE(reporter_id, target_type, target_id),",
  "  FOREIGN KEY (reporter_id) REFERENCES users(id)",
  ");",
  "CREATE TABLE IF NOT EXISTS direct_rooms (",
  "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  user_a_id INTEGER NOT NULL,",
  "  user_b_id INTEGER NOT NULL,",
  "  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
  ");",
  "CREATE TABLE IF NOT EXISTS messages (",
  "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  room_type TEXT NOT NULL CHECK(room_type IN ('global', 'direct')),",
  "  room_id INTEGER,",
  "  sender_id INTEGER NOT NULL,",
  "  content TEXT NOT NULL,",
  "  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,",
  "  FOREIGN KEY (sender_id) REFERENCES users(id)",
  ");",
  "CREATE TABLE IF NOT EXISTS transfers (",
  "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  sender_id INTEGER NOT NULL,",
  "  receiver_id INTEGER NOT NULL,",
  "  amount INTEGER NOT NULL,",
  "  note TEXT NOT NULL DEFAULT '',",
  "  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,",
  "  FOREIGN KEY (sender_id) REFERENCES users(id),",
  "  FOREIGN KEY (receiver_id) REFERENCES users(id)",
  ");"
].join("\n"));

const adminExists = db.prepare("SELECT COUNT(*) AS count FROM users WHERE is_admin = 1").get().count;
if (!adminExists) {
  db.prepare("INSERT INTO users (username, display_name, password_hash, bio, balance, is_admin) VALUES (?, ?, ?, ?, ?, 1)")
    .run("admin", "관리자", bcrypt.hashSync("admin1234", 10), "기본 관리자 계정", 1000000);
}

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax"
  }
});

const upload = multer({
  storage: multer.diskStorage({
    destination: function (_req, _file, cb) {
      cb(null, UPLOAD_DIR);
    },
    filename: function (_req, file, cb) {
      cb(null, Date.now() + "-" + file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_"));
    }
  }),
  fileFilter: function (_req, file, cb) {
    if (file.mimetype && file.mimetype.startsWith("image/")) {
      cb(null, true);
      return;
    }
    cb(new Error("이미지 파일만 업로드할 수 있습니다."));
  }
});

app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR));

io.use(function (socket, next) {
  sessionMiddleware(socket.request, {}, next);
});

function h(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function amount(value) {
  return Number(value || 0).toLocaleString("ko-KR") + "원";
}

function flash(req) {
  const error = req.session.error || "";
  const success = req.session.success || "";
  delete req.session.error;
  delete req.session.success;
  return [
    error ? '<div class="flash error">' + h(error) + '</div>' : '',
    success ? '<div class="flash success">' + h(success) + '</div>' : ''
  ].join("");
}

function navLinks(user) {
  if (!user) {
    return '<a href="/login">로그인</a><a href="/register">회원가입</a>';
  }
  return [
    '<a href="/users">사용자</a>',
    '<a href="/wallet">지갑</a>',
    '<a href="/mypage">마이페이지</a>',
    '<a href="/my-products">내 상품</a>',
    user.isAdmin ? '<a href="/admin">관리</a>' : '',
    '<form method="post" action="/logout" class="inline"><button type="submit">로그아웃</button></form>'
  ].join("");
}

function layout(req, title, body) {
  const user = req.session.user;
  return [
    '<!DOCTYPE html>',
    '<html lang="ko">',
    '<head>',
    '  <meta charset="UTF-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    '  <title>' + h(title) + '</title>',
    '  <link rel="stylesheet" href="/style.css" />',
    '</head>',
    '<body>',
    '  <header class="topbar">',
    '    <a class="brand" href="/">UsedHub</a>',
    '    <nav><a href="/products">상품</a><a href="/chat">전체 채팅</a>' + navLinks(user) + '</nav>',
    '  </header>',
    '  <main class="container">' + flash(req) + body + '</main>',
    '</body>',
    '</html>'
  ].join("");
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    req.session.error = "로그인이 필요합니다.";
    res.redirect("/login");
    return;
  }
  if (req.session.user.isDormant) {
    req.session.error = "휴면 계정은 이용할 수 없습니다.";
    res.redirect("/login");
    return;
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || !req.session.user.isAdmin) {
    req.session.error = "관리자만 접근할 수 있습니다.";
    res.redirect("/");
    return;
  }
  next();
}

function currentUserRow(userId) {
  return db.prepare([
    "SELECT id, username, display_name AS displayName, bio, balance,",
    "is_dormant AS isDormant, is_admin AS isAdmin",
    "FROM users WHERE id = ?"
  ].join(" ")).get(userId);
}

function refreshSessionUser(req) {
  if (req.session.user) {
    req.session.user = currentUserRow(req.session.user.id) || null;
  }
}

function directRoomId(userAId, userBId) {
  const sorted = [Number(userAId), Number(userBId)].sort(function (a, b) { return a - b; });
  let room = db.prepare("SELECT id FROM direct_rooms WHERE user_a_id = ? AND user_b_id = ?").get(sorted[0], sorted[1]);
  if (!room) {
    const inserted = db.prepare("INSERT INTO direct_rooms (user_a_id, user_b_id) VALUES (?, ?)").run(sorted[0], sorted[1]);
    room = { id: Number(inserted.lastInsertRowid) };
  }
  return room.id;
}

function reportCount(targetType, targetId) {
  return db.prepare("SELECT COUNT(*) AS count FROM reports WHERE target_type = ? AND target_id = ?").get(targetType, targetId).count;
}

function enforceModeration(targetType, targetId) {
  const count = reportCount(targetType, targetId);
  if (targetType === "product" && count >= PRODUCT_REPORT_THRESHOLD) {
    db.prepare("UPDATE products SET is_blocked = 1 WHERE id = ?").run(targetId);
  }
  if (targetType === "user" && count >= USER_REPORT_THRESHOLD) {
    db.prepare("UPDATE users SET is_dormant = 1 WHERE id = ?").run(targetId);
  }
}

function reportForm(targetType, targetId) {
  return [
    '<form method="post" action="/reports" class="stack report-form">',
    '  <input type="hidden" name="targetType" value="' + h(targetType) + '" />',
    '  <input type="hidden" name="targetId" value="' + Number(targetId) + '" />',
    '  <label>신고 사유<textarea name="reason" rows="3" required></textarea></label>',
    '  <button type="submit">신고하기</button>',
    '</form>'
  ].join("");
}

function productCard(product) {
  return [
    '<article class="card product-card">',
    '  <a href="/products/' + product.id + '">',
    '    <img src="' + h(product.imagePath) + '" alt="' + h(product.name) + '" />',
    '    <h3>' + h(product.name) + '</h3>',
    '  </a>',
    '</article>'
  ].join("");
}

function chatPage(title, roomType, roomId, messages) {
  const initial = messages.map(function (message) {
    return [
      '<div class="chat-message">',
      '  <strong>' + h(message.displayName) + '</strong>',
      '  <span>' + h(message.content) + '</span>',
      '  <small>' + h(message.createdAt) + '</small>',
      '</div>'
    ].join("");
  }).join("");
  return [
    '<section class="card">',
    '  <h1>' + h(title) + '</h1>',
    '  <div id="messages" class="chat-box">' + initial + '</div>',
    '  <form id="chat-form" class="row">',
    '    <input id="content" autocomplete="off" maxlength="500" placeholder="메시지를 입력하세요." />',
    '    <button type="submit">전송</button>',
    '  </form>',
    '</section>',
    '<script src="/socket.io/socket.io.js"></script>',
    '<script>',
    '  const socket = io();',
    '  const chatConfig = ' + JSON.stringify({ roomType: roomType, roomId: roomId }) + ';',
    '  const messages = document.getElementById("messages");',
    '  const form = document.getElementById("chat-form");',
    '  const input = document.getElementById("content");',
    '  socket.emit("join", chatConfig);',
    '  socket.on("chat-message", function (message) {',
    '    const div = document.createElement("div");',
    '    div.className = "chat-message";',
    '    div.innerHTML = "<strong>" + safe(message.displayName) + "</strong><span>" + safe(message.content) + "</span><small>" + safe(message.createdAt) + "</small>";',
    '    messages.appendChild(div);',
    '    messages.scrollTop = messages.scrollHeight;',
    '  });',
    '  form.addEventListener("submit", function (event) {',
    '    event.preventDefault();',
    '    if (!input.value.trim()) return;',
    '    socket.emit("chat-message", { roomType: chatConfig.roomType, roomId: chatConfig.roomId, content: input.value });',
    '    input.value = "";',
    '  });',
    '  function safe(value) {',
    '    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/\'/g, "&#39;");',
    '  }',
    '</script>'
  ].join("");
}

app.use(function (req, _res, next) {
  refreshSessionUser(req);
  next();
});

app.get("/health", function (_req, res) {
  res.json({ ok: true });
});

app.get("/", function (req, res) {
  const featured = db.prepare([
    "SELECT p.id, p.name, p.price, p.image_path AS imagePath, p.category, p.region, p.status,",
    "u.display_name AS sellerName FROM products p",
    "JOIN users u ON u.id = p.seller_id",
    "WHERE p.is_blocked = 0 ORDER BY p.created_at DESC LIMIT 6"
  ].join(" ")).all();
  const stats = {
    users: db.prepare("SELECT COUNT(*) AS count FROM users").get().count,
    products: db.prepare("SELECT COUNT(*) AS count FROM products WHERE is_blocked = 0").get().count,
    messages: db.prepare("SELECT COUNT(*) AS count FROM messages").get().count,
    transfers: db.prepare("SELECT COUNT(*) AS count FROM transfers").get().count
  };
  res.send(layout(req, "UsedHub", [
    '<section class="hero">',
    '  <div>',
    '    <h1>중고거래 플랫폼</h1>',
    '    <p>회원 관리, 상품 거래, 전체/1대1 채팅, 신고 차단, 송금, 관리자 통합 관리 기능을 포함한 실제 사용형 과제 구현입니다.</p>',
    '    <div class="actions"><a class="button primary" href="/products">상품 둘러보기</a>' + (req.session.user ? '<a class="button" href="/wallet">송금하기</a>' : '<a class="button" href="/register">회원가입</a>') + '</div>',
    '  </div>',
    '</section>',
    '<section class="stats-grid">',
    '  <article class="card stat"><strong>' + stats.users + '</strong><span>사용자</span></article>',
    '  <article class="card stat"><strong>' + stats.products + '</strong><span>상품</span></article>',
    '  <article class="card stat"><strong>' + stats.messages + '</strong><span>메시지</span></article>',
    '  <article class="card stat"><strong>' + stats.transfers + '</strong><span>송금</span></article>',
    '</section>',
    '<section><h2>최근 등록 상품</h2><div class="grid">' + (featured.map(productCard).join("") || '<p>등록된 상품이 없습니다.</p>') + '</div></section>'
  ].join("")));
});

app.get("/register", function (req, res) {
  res.send(layout(req, "회원가입", [
    '<section class="card auth">',
    '  <h1>회원가입</h1>',
    '  <form method="post" action="/register" class="stack">',
    '    <label>아이디<input name="username" required /></label>',
    '    <label>표시 이름<input name="displayName" required /></label>',
    '    <label>비밀번호<input type="password" name="password" required /></label>',
    '    <label>소개글<textarea name="bio" rows="4"></textarea></label>',
    '    <button type="submit">가입하기</button>',
    '  </form>',
    '</section>'
  ].join("")));
});

app.post("/register", function (req, res) {
  const username = (req.body.username || "").trim();
  const displayName = (req.body.displayName || "").trim();
  const password = req.body.password || "";
  const bio = (req.body.bio || "").trim();
  if (!username || !displayName || !password) {
    req.session.error = "필수 항목을 모두 입력해주세요.";
    res.redirect("/register");
    return;
  }
  if (db.prepare("SELECT id FROM users WHERE username = ?").get(username)) {
    req.session.error = "이미 사용 중인 아이디입니다.";
    res.redirect("/register");
    return;
  }
  db.prepare("INSERT INTO users (username, display_name, password_hash, bio, balance) VALUES (?, ?, ?, ?, ?)")
    .run(username, displayName, bcrypt.hashSync(password, 10), bio, DEFAULT_BALANCE);
  req.session.success = "회원가입이 완료되었습니다. 로그인해주세요.";
  res.redirect("/login");
});

app.get("/login", function (req, res) {
  res.send(layout(req, "로그인", [
    '<section class="card auth">',
    '  <h1>로그인</h1>',
    '  <form method="post" action="/login" class="stack">',
    '    <label>아이디<input name="username" required /></label>',
    '    <label>비밀번호<input type="password" name="password" required /></label>',
    '    <button type="submit">로그인</button>',
    '  </form>',
    '  <p>기본 관리자: admin / admin1234</p>',
    '</section>'
  ].join("")));
});

app.post("/login", function (req, res) {
  const username = (req.body.username || "").trim();
  const password = req.body.password || "";
  const user = db.prepare([
    "SELECT id, username, display_name AS displayName, password_hash AS passwordHash, bio, balance,",
    "is_dormant AS isDormant, is_admin AS isAdmin FROM users WHERE username = ?"
  ].join(" ")).get(username);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    req.session.error = "아이디 또는 비밀번호가 올바르지 않습니다.";
    res.redirect("/login");
    return;
  }
  if (user.isDormant) {
    req.session.error = "신고 누적으로 휴면 전환된 계정입니다.";
    res.redirect("/login");
    return;
  }
  req.session.user = {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    balance: user.balance,
    isDormant: user.isDormant,
    isAdmin: user.isAdmin
  };
  req.session.success = "로그인되었습니다.";
  res.redirect("/");
});

app.post("/logout", function (req, res) {
  req.session.destroy(function () {
    res.redirect("/");
  });
});

app.get("/users", requireAuth, function (req, res) {
  const users = db.prepare([
    "SELECT id, username, display_name AS displayName, bio, balance, is_dormant AS isDormant",
    "FROM users ORDER BY created_at DESC"
  ].join(" ")).all();
  res.send(layout(req, "사용자 목록", [
    '<section><h1>사용자 목록</h1><div class="stack">',
    users.map(function (user) {
      return '<article class="card"><h3><a href="/users/' + user.id + '">' + h(user.displayName) + '</a></h3><p>@' + h(user.username) + '</p><p>' + h(user.bio || '소개글 없음') + '</p><p>잔액: ' + amount(user.balance) + '</p><p>' + (user.isDormant ? '휴면 계정' : '활동 중') + '</p></article>';
    }).join(""),
    '</div></section>'
  ].join("")));
});

app.get("/users/:id", requireAuth, function (req, res) {
  const user = currentUserRow(Number(req.params.id));
  if (!user) {
    res.status(404).send(layout(req, "사용자 없음", '<p>사용자를 찾을 수 없습니다.</p>'));
    return;
  }
  const roomButton = req.session.user.id !== user.id ? '<a class="button primary" href="/chat/direct/' + directRoomId(req.session.user.id, user.id) + '">1:1 채팅하기</a>' : '';
  const transferButton = req.session.user.id !== user.id ? '<a class="button" href="/wallet?receiver=' + user.id + '">송금하기</a>' : '';
  const reportSection = req.session.user.id !== user.id ? reportForm("user", user.id) : '';
  res.send(layout(req, user.displayName, [
    '<section class="card">',
    '  <h1>' + h(user.displayName) + '</h1>',
    '  <p>아이디: @' + h(user.username) + '</p>',
    '  <p>소개글: ' + h(user.bio || '소개글 없음') + '</p>',
    '  <p>잔액: ' + amount(user.balance) + '</p>',
    '  <p>상태: ' + (user.isDormant ? '휴면 계정' : '활동 중') + '</p>',
    '  <div class="actions">' + roomButton + transferButton + '</div>',
    reportSection,
    '</section>'
  ].join("")));
});

app.get("/mypage", requireAuth, function (req, res) {
  const user = req.session.user;
  res.send(layout(req, "마이페이지", [
    '<section class="card">',
    '  <h1>마이페이지</h1>',
    '  <form method="post" action="/mypage" class="stack">',
    '    <label>표시 이름<input name="displayName" value="' + h(user.displayName) + '" required /></label>',
    '    <label>소개글<textarea name="bio" rows="4">' + h(user.bio || '') + '</textarea></label>',
    '    <label>새 비밀번호<input type="password" name="password" placeholder="변경하지 않으려면 비워두기" /></label>',
    '    <button type="submit">수정하기</button>',
    '  </form>',
    '</section>'
  ].join("")));
});

app.post("/mypage", requireAuth, function (req, res) {
  const displayName = (req.body.displayName || "").trim();
  const bio = (req.body.bio || "").trim();
  const password = req.body.password || "";
  if (!displayName) {
    req.session.error = "표시 이름은 필수입니다.";
    res.redirect("/mypage");
    return;
  }
  if (password) {
    db.prepare("UPDATE users SET display_name = ?, bio = ?, password_hash = ? WHERE id = ?")
      .run(displayName, bio, bcrypt.hashSync(password, 10), req.session.user.id);
  } else {
    db.prepare("UPDATE users SET display_name = ?, bio = ? WHERE id = ?")
      .run(displayName, bio, req.session.user.id);
  }
  refreshSessionUser(req);
  req.session.success = "마이페이지가 업데이트되었습니다.";
  res.redirect("/mypage");
});

app.get("/wallet", requireAuth, function (req, res) {
  const receiverId = Number(req.query.receiver || 0);
  const selectedReceiver = receiverId ? currentUserRow(receiverId) : null;
  const users = db.prepare("SELECT id, display_name AS displayName, username FROM users WHERE id != ? AND is_dormant = 0 ORDER BY display_name ASC").all(req.session.user.id);
  const transfers = db.prepare([
    "SELECT t.id, t.amount, t.note, t.created_at AS createdAt,",
    "sender.display_name AS senderName, receiver.display_name AS receiverName,",
    "t.sender_id AS senderId, t.receiver_id AS receiverId",
    "FROM transfers t",
    "JOIN users sender ON sender.id = t.sender_id",
    "JOIN users receiver ON receiver.id = t.receiver_id",
    "WHERE t.sender_id = ? OR t.receiver_id = ?",
    "ORDER BY t.created_at DESC LIMIT 20"
  ].join(" ")).all(req.session.user.id, req.session.user.id);
  res.send(layout(req, "지갑", [
    '<section class="grid two-col">',
    '  <article class="card">',
    '    <h1>내 지갑</h1>',
    '    <p class="price">' + amount(req.session.user.balance) + '</p>',
    '    <p>가입 시 기본 잔액 ' + amount(DEFAULT_BALANCE) + '이 지급됩니다.</p>',
    '    <form method="post" action="/wallet/transfer" class="stack">',
    '      <label>받는 사람<select name="receiverId" required>' + users.map(function (user) { return '<option value="' + user.id + '"' + (selectedReceiver && selectedReceiver.id === user.id ? ' selected' : '') + '>' + h(user.displayName) + ' (@' + h(user.username) + ')</option>'; }).join("") + '</select></label>',
    '      <label>송금 금액<input type="number" name="amount" min="1" required /></label>',
    '      <label>메모<textarea name="note" rows="3"></textarea></label>',
    '      <button type="submit">송금하기</button>',
    '    </form>',
    '  </article>',
    '  <article class="card">',
    '    <h2>최근 송금 내역</h2>',
    '    <div class="stack">' + (transfers.map(function (item) {
            const direction = item.senderId === req.session.user.id ? '보냄' : '받음';
            return '<div class="subcard"><strong>' + direction + ' · ' + amount(item.amount) + '</strong><span>' + h(item.senderName) + ' -> ' + h(item.receiverName) + '</span><span>' + h(item.note || '메모 없음') + '</span><small>' + h(item.createdAt) + '</small></div>';
          }).join("") || '<p>송금 내역이 없습니다.</p>') + '</div>',
    '  </article>',
    '</section>'
  ].join("")));
});

app.post("/wallet/transfer", requireAuth, function (req, res) {
  const senderId = req.session.user.id;
  const receiverId = Number(req.body.receiverId);
  const value = Number(req.body.amount);
  const note = (req.body.note || "").trim();
  if (!receiverId || !Number.isFinite(value) || value < 1) {
    req.session.error = "유효한 송금 정보를 입력해주세요.";
    res.redirect("/wallet");
    return;
  }
  if (receiverId === senderId) {
    req.session.error = "자기 자신에게 송금할 수 없습니다.";
    res.redirect("/wallet");
    return;
  }
  const sender = currentUserRow(senderId);
  const receiver = currentUserRow(receiverId);
  if (!receiver || receiver.isDormant) {
    req.session.error = "받는 사용자를 찾을 수 없습니다.";
    res.redirect("/wallet");
    return;
  }
  if (sender.balance < value) {
    req.session.error = "잔액이 부족합니다.";
    res.redirect("/wallet");
    return;
  }
  const transfer = db.transaction(function () {
    db.prepare("UPDATE users SET balance = balance - ? WHERE id = ?").run(value, senderId);
    db.prepare("UPDATE users SET balance = balance + ? WHERE id = ?").run(value, receiverId);
    db.prepare("INSERT INTO transfers (sender_id, receiver_id, amount, note) VALUES (?, ?, ?, ?)").run(senderId, receiverId, value, note);
  });
  transfer();
  refreshSessionUser(req);
  req.session.success = "송금이 완료되었습니다.";
  res.redirect("/wallet");
});

app.get("/products", function (req, res) {
  const q = (req.query.q || "").trim();
  const category = (req.query.category || "").trim();
  const region = (req.query.region || "").trim();
  const status = (req.query.status || "").trim();
  const minPrice = Number(req.query.minPrice || 0);
  const maxPrice = Number(req.query.maxPrice || 0);
  const sort = (req.query.sort || "recent").trim();
  const orderBy = {
    recent: "p.created_at DESC",
    priceAsc: "p.price ASC",
    priceDesc: "p.price DESC",
    nameAsc: "p.name ASC"
  }[sort] || "p.created_at DESC";
  const products = db.prepare([
    "SELECT p.id, p.name, p.price, p.image_path AS imagePath, p.category, p.region, p.status,",
    "u.display_name AS sellerName FROM products p",
    "JOIN users u ON u.id = p.seller_id",
    "WHERE p.is_blocked = 0",
    "AND (? = '' OR p.name LIKE '%' || ? || '%' OR p.description LIKE '%' || ? || '%')",
    "AND (? = '' OR p.category = ?)",
    "AND (? = '' OR p.region = ?)",
    "AND (? = '' OR p.status = ?)",
    "AND (? = 0 OR p.price >= ?)",
    "AND (? = 0 OR p.price <= ?)",
    "ORDER BY " + orderBy
  ].join(" ")).all(q, q, q, category, category, region, region, status, status, minPrice, minPrice, maxPrice, maxPrice);
  res.send(layout(req, "상품 목록", [
    '<section class="section-head"><h1>상품 목록</h1></section>',
    '<form method="get" action="/products" class="card search-panel">',
    '  <div class="grid search-grid">',
    '    <label>검색어<input name="q" value="' + h(q) + '" placeholder="상품명 또는 설명" /></label>',
    '    <label>카테고리<select name="category"><option value="">전체</option><option' + (category === '전자기기' ? ' selected' : '') + '>전자기기</option><option' + (category === '가구' ? ' selected' : '') + '>가구</option><option' + (category === '도서' ? ' selected' : '') + '>도서</option><option' + (category === '의류' ? ' selected' : '') + '>의류</option><option' + (category === '기타' ? ' selected' : '') + '>기타</option></select></label>',
    '    <label>지역<input name="region" value="' + h(region) + '" placeholder="예: 서울" /></label>',
    '    <label>상태<select name="status"><option value="">전체</option><option' + (status === '판매중' ? ' selected' : '') + '>판매중</option><option' + (status === '예약중' ? ' selected' : '') + '>예약중</option><option' + (status === '판매완료' ? ' selected' : '') + '>판매완료</option></select></label>',
    '    <label>최소 가격<input type="number" name="minPrice" min="0" value="' + (minPrice || '') + '" /></label>',
    '    <label>최대 가격<input type="number" name="maxPrice" min="0" value="' + (maxPrice || '') + '" /></label>',
    '    <label>정렬<select name="sort"><option value="recent"' + (sort === 'recent' ? ' selected' : '') + '>최신순</option><option value="priceAsc"' + (sort === 'priceAsc' ? ' selected' : '') + '>가격 낮은순</option><option value="priceDesc"' + (sort === 'priceDesc' ? ' selected' : '') + '>가격 높은순</option><option value="nameAsc"' + (sort === 'nameAsc' ? ' selected' : '') + '>이름순</option></select></label>',
    '  </div>',
    '  <div class="actions"><button type="submit" class="primary">검색</button><a class="button" href="/products">초기화</a></div>',
    '</form>',
    '<div class="grid">' + (products.map(productCard).join("") || '<p>조건에 맞는 상품이 없습니다.</p>') + '</div>'
  ].join("")));
});

app.get("/product/new", requireAuth, function (req, res) {
  res.send(layout(req, "상품 등록", [
    '<section class="card">',
    '  <h1>상품 등록</h1>',
    '  <form method="post" action="/product/new" enctype="multipart/form-data" class="stack">',
    '    <label>상품명<input name="name" required /></label>',
    '    <label>설명<textarea name="description" rows="5" required></textarea></label>',
    '    <label>가격<input name="price" type="number" min="0" required /></label>',
    '    <label>카테고리<select name="category"><option>전자기기</option><option>가구</option><option>도서</option><option>의류</option><option selected>기타</option></select></label>',
    '    <label>지역<input name="region" value="서울" required /></label>',
    '    <label>판매 상태<select name="status"><option selected>판매중</option><option>예약중</option><option>판매완료</option></select></label>',
    '    <label>사진<input name="image" type="file" accept="image/*" required /></label>',
    '    <button type="submit">등록하기</button>',
    '  </form>',
    '</section>'
  ].join("")));
});

app.post("/product/new", requireAuth, function (req, res, next) {
  upload.single("image")(req, res, function (err) {
    if (err) {
      req.session.error = err.message;
      res.redirect("/product/new");
      return;
    }
    next();
  });
}, function (req, res) {
  const name = (req.body.name || "").trim();
  const description = (req.body.description || "").trim();
  const price = Number(req.body.price || 0);
  const category = (req.body.category || "기타").trim();
  const region = (req.body.region || "미지정").trim();
  const status = (req.body.status || "판매중").trim();
  if (!name || !description || !req.file) {
    req.session.error = "모든 상품 정보를 입력해주세요.";
    res.redirect("/product/new");
    return;
  }
  db.prepare("INSERT INTO products (seller_id, name, description, price, image_path, category, region, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(req.session.user.id, name, description, price, "/uploads/" + req.file.filename, category, region, status);
  req.session.success = "상품이 등록되었습니다.";
  res.redirect("/my-products");
});

app.get("/my-products", requireAuth, function (req, res) {
  const products = db.prepare([
    "SELECT id, name, price, image_path AS imagePath, category, region, status, is_blocked AS isBlocked",
    "FROM products WHERE seller_id = ? ORDER BY created_at DESC"
  ].join(" ")).all(req.session.user.id);
  res.send(layout(req, "내 상품", [
    '<section class="section-head"><h1>내 상품 관리</h1><a class="button primary" href="/product/new">새 상품 등록</a></section>',
    '<div class="stack">',
    products.map(function (product) {
      return '<article class="card inline-card"><img src="' + h(product.imagePath) + '" alt="' + h(product.name) + '" /><div><h3><a href="/products/' + product.id + '">' + h(product.name) + '</a></h3><p>' + amount(product.price) + '</p><p>' + h(product.category) + ' · ' + h(product.region) + ' · ' + h(product.status) + '</p><p>' + (product.isBlocked ? '차단됨' : '노출 중') + '</p><form method="post" action="/products/' + product.id + '/delete"><button type="submit">삭제</button></form></div></article>';
    }).join("") || '<p>등록한 상품이 없습니다.</p>',
    '</div>'
  ].join("")));
});

app.post("/products/:id/delete", requireAuth, function (req, res) {
  db.prepare("DELETE FROM products WHERE id = ? AND seller_id = ?").run(Number(req.params.id), req.session.user.id);
  req.session.success = "상품이 삭제되었습니다.";
  res.redirect("/my-products");
});

app.get("/products/:id", function (req, res) {
  const product = db.prepare([
    "SELECT p.id, p.name, p.description, p.price, p.image_path AS imagePath, p.category, p.region, p.status, p.is_blocked AS isBlocked,",
    "u.id AS sellerId, u.display_name AS sellerName FROM products p",
    "JOIN users u ON u.id = p.seller_id WHERE p.id = ?"
  ].join(" ")).get(Number(req.params.id));
  if (!product || product.isBlocked) {
    res.status(404).send(layout(req, "상품 없음", '<p>상품을 찾을 수 없습니다.</p>'));
    return;
  }
  const chatButton = req.session.user && req.session.user.id !== product.sellerId ? '<a class="button primary" href="/chat/direct/' + directRoomId(req.session.user.id, product.sellerId) + '">판매자와 1:1 채팅</a>' : '';
  const transferButton = req.session.user && req.session.user.id !== product.sellerId ? '<a class="button" href="/wallet?receiver=' + product.sellerId + '">판매자에게 송금</a>' : '';
  const reportSection = req.session.user ? reportForm("product", product.id) : '';
  res.send(layout(req, product.name, [
    '<section class="detail">',
    '  <img class="detail-image" src="' + h(product.imagePath) + '" alt="' + h(product.name) + '" />',
    '  <div class="card">',
    '    <h1>' + h(product.name) + '</h1>',
    '    <p class="price">' + amount(product.price) + '</p>',
    '    <p>판매자: <a href="/users/' + product.sellerId + '">' + h(product.sellerName) + '</a></p>',
    '    <p>카테고리: ' + h(product.category) + '</p>',
    '    <p>지역: ' + h(product.region) + '</p>',
    '    <p>상태: ' + h(product.status) + '</p>',
    '    <p>' + h(product.description) + '</p>',
    '    <div class="actions">' + chatButton + transferButton + '</div>',
    reportSection,
    '  </div>',
    '</section>'
  ].join("")));
});

app.post("/reports", requireAuth, function (req, res) {
  const targetType = req.body.targetType;
  const targetId = Number(req.body.targetId);
  const reason = (req.body.reason || "").trim();
  if (!targetType || !targetId || !reason) {
    req.session.error = "신고 정보를 모두 입력해주세요.";
    res.redirect(req.get("referer") || "/");
    return;
  }
  try {
    db.prepare("INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES (?, ?, ?, ?)")
      .run(req.session.user.id, targetType, targetId, reason);
  } catch (_error) {
    req.session.error = "같은 대상은 한 번만 신고할 수 있습니다.";
    res.redirect(req.get("referer") || "/");
    return;
  }
  enforceModeration(targetType, targetId);
  refreshSessionUser(req);
  req.session.success = "신고가 접수되었습니다.";
  res.redirect(req.get("referer") || "/");
});

app.get("/chat", requireAuth, function (req, res) {
  const messages = db.prepare([
    "SELECT m.content, m.created_at AS createdAt, u.display_name AS displayName",
    "FROM messages m JOIN users u ON u.id = m.sender_id",
    "WHERE m.room_type = 'global' ORDER BY m.id ASC LIMIT 100"
  ].join(" ")).all();
  res.send(layout(req, "전체 채팅", chatPage("전체 채팅", "global", "", messages)));
});

app.get("/chat/direct/:roomId", requireAuth, function (req, res) {
  const roomId = Number(req.params.roomId);
  const room = db.prepare("SELECT * FROM direct_rooms WHERE id = ?").get(roomId);
  if (!room || [room.user_a_id, room.user_b_id].indexOf(req.session.user.id) === -1) {
    req.session.error = "채팅방에 접근할 수 없습니다.";
    res.redirect("/chat");
    return;
  }
  const partnerId = room.user_a_id === req.session.user.id ? room.user_b_id : room.user_a_id;
  const partner = currentUserRow(partnerId);
  const messages = db.prepare([
    "SELECT m.content, m.created_at AS createdAt, u.display_name AS displayName",
    "FROM messages m JOIN users u ON u.id = m.sender_id",
    "WHERE m.room_type = 'direct' AND m.room_id = ? ORDER BY m.id ASC LIMIT 100"
  ].join(" ")).all(roomId);
  res.send(layout(req, "1:1 채팅", chatPage(partner.displayName + "님과의 대화", "direct", roomId, messages)));
});

app.get("/admin", requireAuth, requireAdmin, function (req, res) {
  const metrics = {
    users: db.prepare("SELECT COUNT(*) AS count FROM users").get().count,
    dormantUsers: db.prepare("SELECT COUNT(*) AS count FROM users WHERE is_dormant = 1").get().count,
    products: db.prepare("SELECT COUNT(*) AS count FROM products").get().count,
    blockedProducts: db.prepare("SELECT COUNT(*) AS count FROM products WHERE is_blocked = 1").get().count,
    reports: db.prepare("SELECT COUNT(*) AS count FROM reports").get().count,
    messages: db.prepare("SELECT COUNT(*) AS count FROM messages").get().count,
    transfers: db.prepare("SELECT COUNT(*) AS count FROM transfers").get().count
  };
  const users = db.prepare("SELECT id, username, display_name AS displayName, balance, is_dormant AS isDormant, is_admin AS isAdmin FROM users ORDER BY created_at DESC LIMIT 30").all();
  const products = db.prepare("SELECT p.id, p.name, p.price, p.status, p.is_blocked AS isBlocked, u.display_name AS sellerName FROM products p JOIN users u ON u.id = p.seller_id ORDER BY p.created_at DESC LIMIT 30").all();
  const reports = db.prepare("SELECT r.id, r.target_type AS targetType, r.target_id AS targetId, r.reason, r.created_at AS createdAt, reporter.display_name AS reporterName FROM reports r JOIN users reporter ON reporter.id = r.reporter_id ORDER BY r.created_at DESC LIMIT 30").all();
  const transfers = db.prepare("SELECT t.id, t.amount, t.note, t.created_at AS createdAt, sender.display_name AS senderName, receiver.display_name AS receiverName FROM transfers t JOIN users sender ON sender.id = t.sender_id JOIN users receiver ON receiver.id = t.receiver_id ORDER BY t.created_at DESC LIMIT 20").all();
  const messages = db.prepare("SELECT m.id, m.room_type AS roomType, m.content, m.created_at AS createdAt, u.display_name AS displayName FROM messages m JOIN users u ON u.id = m.sender_id ORDER BY m.created_at DESC LIMIT 20").all();
  res.send(layout(req, "관리자", [
    '<section class="stats-grid">',
    '<article class="card stat"><strong>' + metrics.users + '</strong><span>전체 사용자</span></article>',
    '<article class="card stat"><strong>' + metrics.dormantUsers + '</strong><span>휴면 사용자</span></article>',
    '<article class="card stat"><strong>' + metrics.products + '</strong><span>전체 상품</span></article>',
    '<article class="card stat"><strong>' + metrics.blockedProducts + '</strong><span>차단 상품</span></article>',
    '<article class="card stat"><strong>' + metrics.reports + '</strong><span>신고</span></article>',
    '<article class="card stat"><strong>' + metrics.messages + '</strong><span>메시지</span></article>',
    '<article class="card stat"><strong>' + metrics.transfers + '</strong><span>송금</span></article>',
    '</section>',
    '<section class="grid admin-grid">',
    '<article class="card"><h2>유저 관리</h2><div class="stack">' + users.map(function (user) { return '<form method="post" action="/admin/users/' + user.id + '/toggle-dormant" class="row"><span>' + h(user.displayName) + ' (@' + h(user.username) + ') · ' + amount(user.balance) + ' · ' + (user.isAdmin ? '관리자' : '일반') + ' · ' + (user.isDormant ? '휴면' : '활동') + '</span><button type="submit">' + (user.isDormant ? '복구' : '휴면 전환') + '</button></form>'; }).join('') + '</div></article>',
    '<article class="card"><h2>상품 관리</h2><div class="stack">' + products.map(function (product) { return '<div class="subcard"><strong>' + h(product.name) + '</strong><span>' + h(product.sellerName) + ' · ' + amount(product.price) + ' · ' + h(product.status) + ' · ' + (product.isBlocked ? '차단됨' : '정상') + '</span><div class="actions"><form method="post" action="/admin/products/' + product.id + '/toggle-block"><button type="submit">' + (product.isBlocked ? '차단 해제' : '차단') + '</button></form><form method="post" action="/admin/products/' + product.id + '/delete"><button type="submit">삭제</button></form></div></div>'; }).join('') + '</div></article>',
    '<article class="card"><h2>신고 내역</h2><div class="stack">' + (reports.map(function (report) { return '<div class="subcard"><strong>#' + report.id + ' ' + h(report.targetType) + ':' + report.targetId + '</strong><span>신고자 ' + h(report.reporterName) + '</span><span>' + h(report.reason) + '</span><small>' + h(report.createdAt) + '</small></div>'; }).join('') || '<p>신고가 없습니다.</p>') + '</div></article>',
    '<article class="card"><h2>송금 로그</h2><div class="stack">' + (transfers.map(function (item) { return '<div class="subcard"><strong>' + amount(item.amount) + '</strong><span>' + h(item.senderName) + ' -> ' + h(item.receiverName) + '</span><span>' + h(item.note || '메모 없음') + '</span><small>' + h(item.createdAt) + '</small></div>'; }).join('') || '<p>송금 내역이 없습니다.</p>') + '</div></article>',
    '<article class="card"><h2>채팅 로그</h2><div class="stack">' + (messages.map(function (message) { return '<div class="subcard"><strong>' + h(message.displayName) + ' · ' + h(message.roomType) + '</strong><span>' + h(message.content) + '</span><small>' + h(message.createdAt) + '</small></div>'; }).join('') || '<p>메시지가 없습니다.</p>') + '</div></article>',
    '</section>'
  ].join('')));
});

app.post("/admin/users/:id/toggle-dormant", requireAuth, requireAdmin, function (req, res) {
  const user = db.prepare("SELECT is_dormant AS isDormant FROM users WHERE id = ?").get(Number(req.params.id));
  if (user) {
    db.prepare("UPDATE users SET is_dormant = ? WHERE id = ?").run(user.isDormant ? 0 : 1, Number(req.params.id));
  }
  req.session.success = "유저 상태를 변경했습니다.";
  res.redirect("/admin");
});

app.post("/admin/products/:id/toggle-block", requireAuth, requireAdmin, function (req, res) {
  const product = db.prepare("SELECT is_blocked AS isBlocked FROM products WHERE id = ?").get(Number(req.params.id));
  if (product) {
    db.prepare("UPDATE products SET is_blocked = ? WHERE id = ?").run(product.isBlocked ? 0 : 1, Number(req.params.id));
  }
  req.session.success = "상품 상태를 변경했습니다.";
  res.redirect("/admin");
});

app.post("/admin/products/:id/delete", requireAuth, requireAdmin, function (req, res) {
  db.prepare("DELETE FROM products WHERE id = ?").run(Number(req.params.id));
  req.session.success = "상품을 삭제했습니다.";
  res.redirect("/admin");
});

io.on("connection", function (socket) {
  socket.on("join", function (payload) {
    const sessionUser = socket.request.session && socket.request.session.user;
    if (!sessionUser) {
      return;
    }
    const key = payload.roomType === "global" ? "global" : "direct:" + payload.roomId;
    socket.join(key);
  });

  socket.on("chat-message", function (payload) {
    const sessionUser = socket.request.session && socket.request.session.user;
    if (!sessionUser || sessionUser.isDormant) {
      return;
    }
    const content = String(payload.content || "").trim().slice(0, 500);
    if (!content) {
      return;
    }
    const roomType = payload.roomType === "direct" ? "direct" : "global";
    const roomId = roomType === "direct" ? Number(payload.roomId) : null;
    if (roomType === "direct") {
      const room = db.prepare("SELECT * FROM direct_rooms WHERE id = ?").get(roomId);
      if (!room || [room.user_a_id, room.user_b_id].indexOf(sessionUser.id) === -1) {
        return;
      }
    }
    db.prepare("INSERT INTO messages (room_type, room_id, sender_id, content) VALUES (?, ?, ?, ?)")
      .run(roomType, roomId, sessionUser.id, content);
    io.to(roomType === "global" ? "global" : "direct:" + roomId).emit("chat-message", {
      displayName: sessionUser.displayName,
      content: content,
      createdAt: new Date().toISOString()
    });
  });
});

server.listen(PORT, function () {
  console.log("UsedHub server started on http://localhost:" + PORT);
});
