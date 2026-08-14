const $ = (selector) => document.querySelector(selector);
const quickMessages = ["你好", "开始吧", "轮到你了", "等一下", "厉害", "哈哈", "差一点", "GG", "再来一局"];
const state = {
  roomId: "",
  color: null,
  socket: null,
  board: [],
  turn: null,
  ready: false,
  finished: false,
  preMove: null,
  movePending: false,
  lastResult: null,
  unreadCount: 0,
  normalChatHeight: 0,
  mobileBoardSize: 0,
  turnDeadline: null,
  countdownTimer: null,
  serverClockOffsetMs: 0,
  account: null,
  playerNames: {},
};

const BOARD_POINTS = 15;
const BOARD_INTERVALS = BOARD_POINTS - 1;
const BOARD_INSET_RATIO = 0.05;

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), 1800);
}

function buildBoard() {
  const board = $("#board");
  board.innerHTML = "";
  const insetPercent = BOARD_INSET_RATIO * 100;
  const usablePercent = 100 - insetPercent * 2;
  const pointSizePercent = usablePercent / BOARD_INTERVALS;

  for (let index = 0; index < BOARD_POINTS; index++) {
    const position = insetPercent + index * pointSizePercent;
    const vertical = document.createElement("span");
    vertical.className = "grid-line vertical";
    vertical.style.left = `${position}%`;
    const horizontal = document.createElement("span");
    horizontal.className = "grid-line horizontal";
    horizontal.style.top = `${position}%`;
    board.append(vertical, horizontal);
  }

  for (let row = 0; row < BOARD_POINTS; row++) {
    for (let col = 0; col < BOARD_POINTS; col++) {
      const cell = document.createElement("button");
      cell.className = "cell";
      cell.dataset.row = row;
      cell.dataset.col = col;
      cell.style.setProperty("--point-left", `${insetPercent + col * pointSizePercent}%`);
      cell.style.setProperty("--point-top", `${insetPercent + row * pointSizePercent}%`);
      cell.style.setProperty("--point-size", `${pointSizePercent}%`);
      cell.setAttribute("role", "gridcell");
      cell.setAttribute("aria-label", `第 ${row + 1} 行，第 ${col + 1} 列`);
      cell.addEventListener("click", (event) => {
        event.stopPropagation();
        selectIntersection(row, col);
      });
      board.appendChild(cell);
    }
  }

  board.onpointerup = (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const point = boardPointFromEvent(event, board);
    selectIntersection(point.row, point.col);
  };

  requestAnimationFrame(() => syncMobileLayout(true));
}

function boardPointFromEvent(event, board) {
  const rect = board.getBoundingClientRect();
  const x = event.clientX - rect.left - board.clientLeft;
  const y = event.clientY - rect.top - board.clientTop;
  return {
    col: nearestBoardIndex(x, board.clientWidth),
    row: nearestBoardIndex(y, board.clientHeight),
  };
}

function nearestBoardIndex(position, boardSize) {
  const inset = boardSize * BOARD_INSET_RATIO;
  const spacing = (boardSize - inset * 2) / BOARD_INTERVALS;
  return Math.max(0, Math.min(BOARD_INTERVALS, Math.round((position - inset) / spacing)));
}

function selectIntersection(row, col) {
  if (!state.color) return void toast("你还不是对局玩家");
  if (!state.ready) return void toast("请等待另一名玩家加入");
  if (state.finished) return void toast("本局已经结束");
  if (state.turn !== state.color) return void toast("还没有轮到你");
  if (state.movePending) return;
  if (state.board[row]?.[col]) return void toast("这个位置已经有棋子了");

  if (state.preMove?.row === row && state.preMove?.col === col) {
    state.movePending = true;
    if (!send({ type: "move", row, col })) state.movePending = false;
    return;
  }

  setPreview(row, col);
}

function setPreview(row, col) {
  clearPreview();
  state.preMove = { row, col };
  const cell = document.querySelector(`.cell[data-row="${row}"][data-col="${col}"]`);
  if (cell) cell.innerHTML = `<span class="stone ${state.color} preview"></span>`;
  $("#moveHint").textContent = "再次点击该位置确认落子";
}

function clearPreview() {
  if (state.preMove) {
    const { row, col } = state.preMove;
    const cell = document.querySelector(`.cell[data-row="${row}"][data-col="${col}"]`);
    if (cell && !state.board[row]?.[col]) cell.innerHTML = "";
  }
  state.preMove = null;
  state.movePending = false;
  $("#moveHint").textContent = "";
}

function renderBoard(boardState) {
  state.board = boardState;
  document.querySelectorAll(".cell").forEach((cell) => {
    const value = boardState[+cell.dataset.row][+cell.dataset.col];
    cell.innerHTML = value ? `<span class="stone ${value}"></span>` : "";
    cell.classList.toggle("occupied", Boolean(value));
  });
}

function colorName(color) {
  return color === "black" ? "黑棋" : color === "white" ? "白棋" : "—";
}

function updateState(data) {
  const wasFinished = state.finished;
  clearPreview();
  state.ready = data.ready;
  state.turn = data.turn;
  state.playerNames = data.player_names || {};
  state.finished = Boolean(data.winner || data.draw);
  state.lastResult = state.finished ? { winner: data.winner, draw: data.draw, reason: data.result_reason } : null;
  if (typeof data.server_time === "number") {
    state.serverClockOffsetMs = data.server_time * 1000 - Date.now();
  }
  syncCountdown(data.turn_deadline);
  renderBoard(data.board);

  const turnPlayer = state.playerNames[data.turn];
  $("#turn").textContent = state.finished ? "已结束" : `${colorName(data.turn)}${turnPlayer ? ` · ${turnPlayer}` : ""}`;
  if (!data.ready) $("#status").textContent = "等待好友加入…";
  else if (data.winner && data.result_reason === "timeout") $("#status").textContent = `${colorName(data.turn)}超时，${colorName(data.winner)}获胜`;
  else if (data.winner) $("#status").textContent = `${colorName(data.winner)}获胜`;
  else if (data.draw) $("#status").textContent = "棋盘已满，本局平局";
  else $("#status").textContent = data.turn === state.color ? "轮到你落子" : "等待对方落子";

  if (state.finished && (!wasFinished || $("#resultOverlay").classList.contains("hidden"))) {
    showBaseResult();
  }
}

function showBaseResult() {
  if (!state.lastResult) return;
  const { winner, draw, reason } = state.lastResult;
  if (draw) {
    $("#resultIcon").textContent = "＝";
    $("#resultTitle").textContent = "本局平局";
    $("#resultText").textContent = "棋逢对手，再来一盘？";
  } else if (reason === "timeout" && winner === state.color) {
    $("#resultIcon").textContent = "⏱";
    $("#resultTitle").textContent = "对方超时，你赢了！";
    $("#resultText").textContent = "对方未在 60 秒内完成落子。";
  } else if (reason === "timeout") {
    $("#resultIcon").textContent = "⏱";
    $("#resultTitle").textContent = "超时，你输了";
    $("#resultText").textContent = "本回合未在 60 秒内完成落子。";
  } else if (winner === state.color) {
    $("#resultIcon").textContent = "🎉";
    $("#resultTitle").textContent = "你赢了！";
    $("#resultText").textContent = "漂亮的一局，要不要继续？";
  } else {
    $("#resultIcon").textContent = "●";
    $("#resultTitle").textContent = "你输了";
    $("#resultText").textContent = "这局输了，再来一盘？";
  }
  $("#rematchBtn").disabled = false;
  $("#rematchBtn").textContent = "再来一局";
  $("#resultActions").classList.remove("hidden");
  $("#rematchDecision").classList.add("hidden");
  $("#resultOverlay").classList.remove("hidden");
}

function syncCountdown(deadline) {
  state.turnDeadline = typeof deadline === "number" ? deadline : null;
  clearInterval(state.countdownTimer);
  state.countdownTimer = null;
  renderCountdown();
  if (state.turnDeadline !== null) {
    state.countdownTimer = setInterval(renderCountdown, 250);
  }
}

function renderCountdown() {
  const countdown = $("#countdown");
  countdown.classList.remove("timer-warning", "timer-urgent", "timer-critical");
  if (state.turnDeadline === null || state.finished) {
    countdown.textContent = "--";
    return;
  }
  const serverNow = Date.now() + state.serverClockOffsetMs;
  const seconds = Math.max(0, Math.ceil((state.turnDeadline * 1000 - serverNow) / 1000));
  countdown.textContent = `${seconds}s`;
  if (seconds <= 5) countdown.classList.add("timer-critical");
  else if (seconds <= 10) countdown.classList.add("timer-urgent");
  else if (seconds <= 20) countdown.classList.add("timer-warning");
}

function showRematchRequest() {
  $("#resultIcon").textContent = "↻";
  $("#resultTitle").textContent = "对方想再来一局";
  $("#resultText").textContent = "接受后将交换黑白棋，并立即开始。";
  $("#resultActions").classList.add("hidden");
  $("#rematchDecision").classList.remove("hidden");
  $("#resultOverlay").classList.remove("hidden");
}

function send(data) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(data));
    return true;
  }
  toast("连接尚未就绪");
  return false;
}

function connect(roomId) {
  state.roomId = roomId.toUpperCase();
  clearPreview();
  $("#resultOverlay").classList.add("hidden");
  document.body.classList.add("game-active");
  $("#lobby").classList.add("hidden");
  $("#game").classList.remove("hidden");
  $("#roomCode").textContent = state.roomId;
  history.replaceState(null, "", `#${state.roomId}`);
  buildBoard();

  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${location.host}/ws/${state.roomId}`);
  state.socket = socket;
  socket.onopen = () => {
    $("#connection").classList.add("online");
    $("#connection").innerHTML = "<span></span> 已连接";
  };
  socket.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "welcome") {
      state.color = data.color;
      $("#myColor").textContent = `${colorName(data.color)} · ${state.account.username}`;
    } else if (data.type === "state") {
      updateState(data);
    } else if (data.type === "chat") {
      addMessage(data.color, data.message, data.username);
    } else if (data.type === "rematch_request") {
      clearPreview();
      showRematchRequest();
    } else if (data.type === "rematch_pending") {
      $("#rematchBtn").disabled = true;
      $("#rematchBtn").textContent = "等待对方回应…";
    } else if (data.type === "rematch_declined") {
      toast("对方拒绝了再来一局");
      showBaseResult();
    } else if (data.type === "rematch_declined_ack") {
      showBaseResult();
    } else if (data.type === "game_restart") {
      state.color = data.color;
      state.finished = false;
      state.lastResult = null;
      clearPreview();
      resetChatForNewGame();
      $("#myColor").textContent = `${colorName(data.color)} · ${state.account.username}`;
      $("#resultOverlay").classList.add("hidden");
      toast(`新一局开始，你是${colorName(data.color)}`);
    } else if (data.type === "error") {
      clearPreview();
      toast(data.message);
    }
  };
  socket.onclose = () => {
    clearPreview();
    $("#connection").classList.remove("online");
    $("#connection").innerHTML = "<span></span> 连接已断开";
  };
}

function addMessage(color, message, username) {
  const messages = $("#messages");
  const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 56;
  const isMine = username === state.account?.username;
  const item = document.createElement("p");
  item.className = `message ${isMine ? "me" : ""}`;
  const name = document.createElement("b");
  name.textContent = isMine ? `我（${username}）` : (username || colorName(color));
  item.append(name, document.createTextNode(message));
  messages.appendChild(item);
  showChatBubble(isMine, message);

  const sheetOpen = $(".chat-card").classList.contains("sheet-open");
  if (!isMine && isMobileLayout() && !sheetOpen) setUnreadCount(state.unreadCount + 1);
  if (nearBottom || !sheetOpen) requestAnimationFrame(() => { messages.scrollTop = messages.scrollHeight; });
}

function showChatBubble(isMine, message) {
  const container = $("#chatBubbles");
  while (container.children.length >= 2) container.firstElementChild.remove();
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${isMine ? "me" : "other"}`;
  bubble.textContent = `${isMine ? "我" : "朋友"}：${message}`;
  container.appendChild(bubble);
  setTimeout(() => bubble.classList.add("leaving"), 2600);
  setTimeout(() => bubble.remove(), 2820);
}

function setUnreadCount(count) {
  state.unreadCount = count;
  const badge = $("#unreadBadge");
  badge.textContent = count > 99 ? "99+" : String(count);
  badge.classList.toggle("hidden", count === 0);
}

function resetChatForNewGame() {
  $("#messages").replaceChildren();
  $("#chatBubbles").replaceChildren();
  $("#chatInput").value = "";
  setUnreadCount(0);
  closeChatSheet();
}

function openChatSheet() {
  const card = $(".chat-card");
  card.classList.add("sheet-open");
  setUnreadCount(0);
  requestAnimationFrame(() => {
    const messages = $("#messages");
    messages.scrollTop = messages.scrollHeight;
    syncMobileLayout(false);
  });
}

function closeChatSheet() {
  $(".chat-card").classList.remove("sheet-open");
  $("#chatInput").blur();
  requestAnimationFrame(() => syncMobileLayout(false));
}

function isMobileLayout() {
  return window.matchMedia("(max-width: 768px)").matches;
}

function syncMobileLayout(forceBoardResize = false) {
  if (!isMobileLayout() || !document.body.classList.contains("game-active")) return;
  const viewport = window.visualViewport;
  const viewportHeight = viewport?.height || window.innerHeight;
  const keyboardOffset = viewport
    ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
    : 0;
  document.documentElement.style.setProperty("--app-height", `${Math.round(viewportHeight)}px`);
  document.documentElement.style.setProperty("--keyboard-offset", `${Math.round(keyboardOffset)}px`);

  const chatCard = $(".chat-card");
  const sheetOpen = chatCard.classList.contains("sheet-open");
  if (!sheetOpen) state.normalChatHeight = chatCard.getBoundingClientRect().height;

  const inputFocused = document.activeElement === $("#chatInput");
  const keyboardOpen = Boolean(viewport && inputFocused && viewport.height < window.innerHeight * 0.82);
  if ((keyboardOpen || sheetOpen) && state.mobileBoardSize && !forceBoardResize) return;

  const horizontalSpace = document.documentElement.clientWidth - 16;
  const roomHeight = $(".room-card").getBoundingClientRect().height;
  const bubblesHeight = $("#chatBubbles").getBoundingClientRect().height;
  const hintHeight = $("#moveHint").getBoundingClientRect().height;
  const chromeHeight = roomHeight + bubblesHeight + hintHeight + state.normalChatHeight + 28;
  const verticalSpace = viewportHeight - chromeHeight;
  const size = Math.floor(Math.max(120, Math.min(horizontalSpace, verticalSpace)));
  state.mobileBoardSize = size;
  document.documentElement.style.setProperty("--mobile-board-size", `${size}px`);
}

function leaveRoom() {
  clearPreview();
  resetChatForNewGame();
  syncCountdown(null);
  document.body.classList.remove("game-active");
  state.socket?.close();
  location.hash = "";
  location.reload();
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json", ...(options.headers || {}) } : options.headers,
  });
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    const error = new Error(data?.detail || "请求失败，请稍后重试");
    error.status = response.status;
    throw error;
  }
  return data;
}

function hideMainSections() {
  $("#login").classList.add("hidden");
  $("#lobby").classList.add("hidden");
  $("#admin").classList.add("hidden");
  $("#historyPage").classList.add("hidden");
  $("#historyDetail").classList.add("hidden");
  $("#adminHistory").classList.add("hidden");
  $("#game").classList.add("hidden");
}

function showLogin() {
  hideMainSections();
  document.body.classList.remove("game-active");
  $("#login").classList.remove("hidden");
  $("#loginUsername").focus();
}

function showLobby() {
  hideMainSections();
  $("#currentAccount").textContent = state.account.username;
  $("#adminLink").classList.toggle("hidden", state.account.role !== "developer");
  $("#lobby").classList.remove("hidden");
  const hashRoom = location.hash.slice(1).toUpperCase();
  if (/^[A-Z0-9]{6}$/.test(hashRoom)) {
    roomExists(hashRoom).then((exists) => exists ? connect(hashRoom) : toast("分享的房间不存在"));
  }
}

async function showAdmin() {
  hideMainSections();
  $("#admin").classList.remove("hidden");
  await loadUsers();
}

function formatHistoryDate(value) {
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

function formatDuration(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return minutes ? `${minutes}分${rest}秒` : `${rest}秒`;
}

function reasonName(reason) {
  return ({ five_in_a_row: "五连", timeout: "60 秒超时", draw: "平局", resign: "认输" })[reason] || reason;
}

function outcomeInfo(record, adminView) {
  if (adminView) {
    if (!record.winner_username) return { text: "和", className: "draw" };
    return { text: `${record.winner_username} 胜`, className: "win" };
  }
  return ({
    win: { text: "胜", className: "win" },
    loss: { text: "负", className: "loss" },
    draw: { text: "和", className: "draw" },
  })[record.outcome];
}

function createFact(label, value) {
  const fact = document.createElement("p");
  fact.className = "history-fact";
  const caption = document.createElement("span");
  caption.textContent = label;
  const content = document.createElement("strong");
  content.textContent = value;
  fact.append(caption, content);
  return fact;
}

function createHistoryItem(record, adminView = false) {
  const item = document.createElement("article");
  item.className = "history-item card";
  const time = document.createElement("p");
  time.className = "history-time";
  time.textContent = formatHistoryDate(record.finished_at);
  const matchup = document.createElement("p");
  matchup.className = "history-matchup";
  const title = document.createElement("strong");
  title.textContent = adminView
    ? `${record.black_username} vs ${record.white_username}`
    : `VS ${record.opponent_username}`;
  const subtitle = document.createElement("span");
  subtitle.textContent = adminView
    ? `房间 ${record.room_code}`
    : `${colorName(record.my_color)} · 房间 ${record.room_code}`;
  matchup.append(title, subtitle);
  const outcome = outcomeInfo(record, adminView);
  const result = document.createElement("span");
  result.className = `history-result ${outcome.className}`;
  result.textContent = outcome.text;
  const link = document.createElement("a");
  link.className = "history-detail-link";
  link.href = `/history/${encodeURIComponent(record.game_id)}${adminView ? "?from=admin" : ""}`;
  link.textContent = "查看详情 ›";
  item.append(
    time,
    matchup,
    result,
    createFact("结束方式", reasonName(record.result_reason)),
    createFact("手数", `${record.move_count} 手`),
    createFact("用时", formatDuration(record.duration_seconds)),
    link,
  );
  return item;
}

function renderHistoryStats(records) {
  const wins = records.filter((record) => record.outcome === "win").length;
  const losses = records.filter((record) => record.outcome === "loss").length;
  const draws = records.filter((record) => record.outcome === "draw").length;
  const rate = records.length ? Math.round(wins / records.length * 100) : 0;
  const values = [["总对局", records.length], ["胜", wins], ["负", losses], ["和", draws], ["胜率", `${rate}%`]];
  const container = $("#historyStats");
  container.replaceChildren(...values.map(([label, value]) => {
    const item = document.createElement("div");
    item.className = "history-stat";
    const caption = document.createElement("span");
    caption.textContent = label;
    const content = document.createElement("strong");
    content.textContent = value;
    item.append(caption, content);
    return item;
  }));
}

async function showHistory() {
  hideMainSections();
  document.body.classList.remove("game-active");
  $("#historyPage").classList.remove("hidden");
  const records = await apiRequest("/api/history");
  renderHistoryStats(records);
  $("#historyList").replaceChildren(...records.map((record) => createHistoryItem(record)));
  $("#historyEmpty").classList.toggle("hidden", records.length > 0);
}

function renderHistoryBoard(boardState) {
  const board = $("#historyBoard");
  board.replaceChildren();
  const insetPercent = BOARD_INSET_RATIO * 100;
  const usablePercent = 100 - insetPercent * 2;
  const pointSizePercent = usablePercent / BOARD_INTERVALS;
  for (let index = 0; index < BOARD_POINTS; index++) {
    const position = insetPercent + index * pointSizePercent;
    const vertical = document.createElement("span");
    vertical.className = "grid-line vertical";
    vertical.style.left = `${position}%`;
    const horizontal = document.createElement("span");
    horizontal.className = "grid-line horizontal";
    horizontal.style.top = `${position}%`;
    board.append(vertical, horizontal);
  }
  boardState.forEach((row, rowIndex) => row.forEach((color, colIndex) => {
    if (!color) return;
    const point = document.createElement("span");
    point.className = "history-point";
    point.style.setProperty("--point-left", `${insetPercent + colIndex * pointSizePercent}%`);
    point.style.setProperty("--point-top", `${insetPercent + rowIndex * pointSizePercent}%`);
    point.style.setProperty("--point-size", `${pointSizePercent}%`);
    point.innerHTML = `<span class="stone ${color}"></span>`;
    board.appendChild(point);
  }));
}

function coordinateName(row, col) {
  return `${String.fromCharCode(65 + col)}${row + 1}`;
}

async function showHistoryDetail(gameId) {
  hideMainSections();
  document.body.classList.remove("game-active");
  $("#historyDetail").classList.remove("hidden");
  const record = await apiRequest(`/api/history/${encodeURIComponent(gameId)}`);
  const winner = record.winner_username || "平局";
  const meta = [
    ["房间", record.room_code], ["黑棋", record.black_username], ["白棋", record.white_username],
    ["胜者", winner], ["结束方式", reasonName(record.result_reason)],
    ["手数 / 用时", `${record.move_count} 手 · ${formatDuration(record.duration_seconds)}`],
  ];
  $("#historyMeta").replaceChildren(...meta.map(([label, value]) => {
    const item = document.createElement("div");
    const caption = document.createElement("span");
    caption.textContent = label;
    const content = document.createElement("strong");
    content.textContent = value;
    item.append(caption, content);
    return item;
  }));
  $("#historyMoves").replaceChildren(...record.moves.map((move) => {
    const item = document.createElement("li");
    item.textContent = `${colorName(move.color)} · ${move.username} · ${coordinateName(move.row, move.col)}`;
    return item;
  }));
  $("#historyBackLink").href = new URLSearchParams(location.search).get("from") === "admin" ? "/admin/history" : "/history";
  renderHistoryBoard(record.final_board);
}

async function loadAdminHistory() {
  const params = new URLSearchParams();
  const filters = {
    username: $("#historyUsernameFilter").value.trim(),
    room_code: $("#historyRoomFilter").value.trim().toUpperCase(),
    result_reason: $("#historyReasonFilter").value,
    date_from: $("#historyDateFrom").value,
    date_to: $("#historyDateTo").value,
  };
  Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, value); });
  const records = await apiRequest(`/api/admin/history${params.size ? `?${params}` : ""}`);
  $("#adminHistoryList").replaceChildren(...records.map((record) => createHistoryItem(record, true)));
  $("#adminHistoryEmpty").classList.toggle("hidden", records.length > 0);
}

async function showAdminHistory() {
  hideMainSections();
  document.body.classList.remove("game-active");
  $("#adminHistory").classList.remove("hidden");
  await loadAdminHistory();
}

async function bootstrapAuth() {
  try {
    state.account = await apiRequest("/api/me");
    if (location.pathname === "/admin/history") {
      if (state.account.role !== "developer") return void (location.href = "/");
      await showAdminHistory();
    } else if (location.pathname === "/admin") {
      if (state.account.role !== "developer") return void (location.href = "/");
      await showAdmin();
    } else if (location.pathname.startsWith("/history/")) {
      await showHistoryDetail(decodeURIComponent(location.pathname.slice("/history/".length)));
    } else if (location.pathname === "/history") {
      await showHistory();
    } else {
      showLobby();
    }
  } catch {
    state.account = null;
    showLogin();
  }
}

async function logout() {
  try { await apiRequest("/api/logout", { method: "POST" }); } catch { /* Cookie is also discarded on reload. */ }
  state.account = null;
  resetChatForNewGame();
  syncCountdown(null);
  location.href = "/";
}

async function roomExists(roomId) {
  try {
    await apiRequest(`/api/rooms/${roomId}`);
    return true;
  } catch (error) {
    if (error.status === 401) showLogin();
    return false;
  }
}

async function loadUsers() {
  const users = await apiRequest("/api/admin/users");
  const body = $("#userTableBody");
  body.replaceChildren();
  users.forEach((user) => body.appendChild(createUserRow(user)));
}

function createUserRow(user) {
  const row = document.createElement("tr");
  const username = document.createElement("td");
  username.textContent = user.username;
  const role = document.createElement("td");
  role.innerHTML = `<span class="role-badge ${user.role}">${user.role}</span>`;
  const created = document.createElement("td");
  created.textContent = new Date(user.created_at).toLocaleString("zh-CN");
  const statusCell = document.createElement("td");
  statusCell.innerHTML = `<span class="status-badge ${user.is_active ? "active" : "inactive"}">${user.is_active ? "已启用" : "已停用"}</span>`;
  const actions = document.createElement("td");
  actions.className = "user-actions";
  const reset = document.createElement("button");
  reset.textContent = "重置密码";
  reset.addEventListener("click", () => showPasswordEditor(actions, user));
  const toggle = document.createElement("button");
  toggle.textContent = user.is_active ? "停用" : "启用";
  toggle.addEventListener("click", () => toggleUserStatus(user));
  actions.append(reset, toggle);
  row.append(username, role, created, statusCell, actions);
  return row;
}

function showPasswordEditor(container, user) {
  container.replaceChildren();
  const input = document.createElement("input");
  input.type = "password";
  input.maxLength = 72;
  input.placeholder = "新密码";
  input.autocomplete = "new-password";
  const save = document.createElement("button");
  save.textContent = "保存";
  const cancel = document.createElement("button");
  cancel.textContent = "取消";
  cancel.addEventListener("click", loadUsers);
  save.addEventListener("click", async () => {
    try {
      await apiRequest(`/api/admin/users/${user.id}/password`, {
        method: "PATCH",
        body: JSON.stringify({ password: input.value }),
      });
      setAdminMessage(`已重置 ${user.username} 的密码`);
      await loadUsers();
    } catch (error) { setAdminMessage(error.message, true); }
  });
  container.append(input, save, cancel);
  input.focus();
}

async function toggleUserStatus(user) {
  try {
    await apiRequest(`/api/admin/users/${user.id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ is_active: !user.is_active }),
    });
    setAdminMessage(`${user.username} 已${user.is_active ? "停用" : "启用"}`);
    await loadUsers();
  } catch (error) { setAdminMessage(error.message, true); }
}

function setAdminMessage(message, isError = false) {
  const node = $("#adminMessage");
  node.textContent = message;
  node.classList.toggle("error-message", isError);
}

$("#createBtn").addEventListener("click", async () => {
  $("#createBtn").disabled = true;
  try {
    const data = await apiRequest("/api/rooms", { method: "POST" });
    connect(data.room_id);
  } catch (error) {
    $("#lobbyError").textContent = error.message;
  } finally {
    $("#createBtn").disabled = false;
  }
});

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#loginError").textContent = "";
  const submit = event.currentTarget.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    state.account = await apiRequest("/api/login", {
      method: "POST",
      body: JSON.stringify({ username: $("#loginUsername").value, password: $("#loginPassword").value }),
    });
    $("#loginPassword").value = "";
    showLobby();
  } catch (error) {
    $("#loginError").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

$("#createUserForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const username = $("#newUsername").value;
  try {
    await apiRequest("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ username, password: $("#newPassword").value }),
    });
    setAdminMessage(`账号 ${username} 创建成功`);
    form.reset();
    await loadUsers();
  } catch (error) { setAdminMessage(error.message, true); }
});

$("#joinForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const roomId = $("#roomInput").value.trim().toUpperCase();
  $("#lobbyError").textContent = "";
  if (!/^[A-Z0-9]{6}$/.test(roomId)) return void ($("#lobbyError").textContent = "请输入 6 位房间号");
  try {
    if (await roomExists(roomId)) connect(roomId);
    else $("#lobbyError").textContent = "没有找到这个房间";
  } catch {
    $("#lobbyError").textContent = "无法连接服务器";
  }
});

$("#chatForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("#chatInput");
  const message = input.value.trim();
  if (message) {
    send({ type: "chat", message });
    input.value = "";
  }
});

quickMessages.forEach((message) => {
  const button = document.createElement("button");
  button.textContent = message;
  button.addEventListener("click", () => send({ type: "chat", message }));
  $("#quickChats").appendChild(button);
});

$("#rematchBtn").addEventListener("click", () => {
  if (send({ type: "rematch_request" })) {
    $("#rematchBtn").disabled = true;
    $("#rematchBtn").textContent = "发送请求中…";
  }
});
$("#acceptRematchBtn").addEventListener("click", () => send({ type: "rematch_accept" }));
$("#declineRematchBtn").addEventListener("click", () => send({ type: "rematch_decline" }));
$("#copyBtn").addEventListener("click", async () => {
  await navigator.clipboard.writeText(state.roomId);
  toast("房间号已复制");
});
$("#leaveBtn").addEventListener("click", leaveRoom);
$("#resultExitBtn").addEventListener("click", leaveRoom);
$("#mobileLeaveBtn").addEventListener("click", leaveRoom);
$("#logoutBtn").addEventListener("click", logout);
$("#adminLogoutBtn").addEventListener("click", logout);
$("#refreshUsersBtn").addEventListener("click", () => loadUsers().catch((error) => setAdminMessage(error.message, true)));
$("#historyFilterForm").addEventListener("submit", (event) => {
  event.preventDefault();
  loadAdminHistory().catch((error) => toast(error.message));
});
$("#historyRoomFilter").addEventListener("input", (event) => {
  event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
});
$("#openChatBtn").addEventListener("click", openChatSheet);
$("#closeChatBtn").addEventListener("click", closeChatSheet);
$("#roomInput").addEventListener("input", (event) => {
  event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
});

window.addEventListener("resize", () => requestAnimationFrame(() => syncMobileLayout(false)));
window.addEventListener("orientationchange", () => setTimeout(() => syncMobileLayout(true), 120));
window.visualViewport?.addEventListener("resize", () => requestAnimationFrame(() => syncMobileLayout(false)));

bootstrapAuth();
