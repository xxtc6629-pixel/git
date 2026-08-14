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
  playerProfiles: {},
  profileAvatarDraft: "",
  boardGeometry: null,
};

const BOARD_POINTS = 15;
const BOARD_INTERVALS = BOARD_POINTS - 1;
const BOARD_INSET_RATIO = 0.05;
const GRID_LINE_WIDTH = 1;

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

  for (let index = 0; index < BOARD_POINTS; index++) {
    const vertical = document.createElement("span");
    vertical.className = "grid-line vertical";
    vertical.dataset.index = index;
    const horizontal = document.createElement("span");
    horizontal.className = "grid-line horizontal";
    horizontal.dataset.index = index;
    board.append(vertical, horizontal);
  }

  for (let row = 0; row < BOARD_POINTS; row++) {
    for (let col = 0; col < BOARD_POINTS; col++) {
      const cell = document.createElement("button");
      cell.className = "cell";
      cell.dataset.row = row;
      cell.dataset.col = col;
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

  requestAnimationFrame(() => syncGameLayout(true));
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
  const geometry = state.boardGeometry;
  if (geometry?.centers?.length === BOARD_POINTS && Math.abs(geometry.size - boardSize) < 2) {
    return Math.max(0, Math.min(BOARD_INTERVALS, Math.round((position - geometry.gridLeft) / geometry.spacing)));
  }
  const geometryFromSize = boardGeometryForSize(boardSize);
  return Math.max(0, Math.min(BOARD_INTERVALS, Math.round((position - geometryFromSize.gridLeft) / geometryFromSize.spacing)));
}

function boardGeometryForSize(size) {
  const maxGridSize = Math.max(BOARD_INTERVALS, size * (1 - BOARD_INSET_RATIO * 2));
  const gridSize = Math.max(BOARD_INTERVALS, Math.floor(maxGridSize / BOARD_INTERVALS) * BOARD_INTERVALS);
  const spacing = gridSize / BOARD_INTERVALS;
  const lineEdgeStart = Math.max(0, Math.round((size - gridSize - GRID_LINE_WIDTH) / 2));
  const gridLeft = lineEdgeStart + GRID_LINE_WIDTH / 2;
  const centers = Array.from({ length: BOARD_POINTS }, (_, index) => gridLeft + index * spacing);
  const lineEdges = centers.map((center) => center - GRID_LINE_WIDTH / 2);
  return {
    size,
    maxGridSize,
    gridSize,
    spacing,
    gridLeft,
    gridTop: gridLeft,
    lineEdges,
    centers,
    pointSize: Math.max(12, spacing),
  };
}

function syncBoardGeometry() {
  const board = $("#board");
  if (!board || board.clientWidth <= 0 || board.clientHeight <= 0) return;
  const size = Math.min(board.clientWidth, board.clientHeight);
  const geometry = boardGeometryForSize(size);
  const first = geometry.lineEdges[0];
  const gridLength = geometry.gridSize + GRID_LINE_WIDTH;

  state.boardGeometry = geometry;
  board.style.setProperty("--grid-start", `${first}px`);
  board.style.setProperty("--grid-length", `${gridLength}px`);

  document.querySelectorAll(".grid-line.vertical").forEach((line) => {
    const edge = geometry.lineEdges[Number(line.dataset.index)];
    line.style.left = `${edge}px`;
  });
  document.querySelectorAll(".grid-line.horizontal").forEach((line) => {
    const edge = geometry.lineEdges[Number(line.dataset.index)];
    line.style.top = `${edge}px`;
  });
  document.querySelectorAll(".cell").forEach((cell) => {
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    cell.style.setProperty("--point-left", `${geometry.centers[col]}px`);
    cell.style.setProperty("--point-top", `${geometry.centers[row]}px`);
    cell.style.setProperty("--point-size", `${geometry.pointSize}px`);
  });
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

function displayName(user) {
  return user?.nickname || user?.display_name || user?.username || "";
}

function escapeSvgText(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[char]);
}

function defaultAvatar(name, color = "black") {
  const initial = escapeSvgText((name || colorName(color) || "棋").trim().slice(0, 1).toUpperCase());
  const dark = color === "black";
  const bg = dark ? "#252926" : "#f7f3ea";
  const fg = dark ? "#fffdf7" : "#38594a";
  const ring = dark ? "#38594a" : "#d7d1c3";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="48" fill="${bg}"/><circle cx="48" cy="48" r="45" fill="none" stroke="${ring}" stroke-width="6"/><text x="50%" y="55%" text-anchor="middle" dominant-baseline="middle" fill="${fg}" font-family="Arial, sans-serif" font-size="40" font-weight="700">${initial}</text></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function playerForColor(color) {
  return state.playerProfiles[color] || null;
}

function renderPlayerCards() {
  ["black", "white"].forEach((color) => {
    const player = playerForColor(color);
    const name = displayName(player) || `等待${colorName(color)}`;
    const card = $(`#${color}PlayerCard`);
    const avatar = $(`#${color}Avatar`);
    const nameNode = $(`#${color}Name`);
    nameNode.textContent = name;
    avatar.src = player?.avatar || defaultAvatar(name, color);
    avatar.alt = `${name}头像`;
    card.classList.toggle("is-active", state.ready && !state.finished && state.turn === color);
    card.classList.toggle("is-mine", state.color === color);
    card.classList.toggle("is-waiting", !player);
    card.classList.toggle("is-offline", Boolean(player && !player.online));
  });
}

function updateTimerNode(color, seconds) {
  const timer = $(`#${color}Timer`);
  timer.classList.remove("timer-warning", "timer-urgent", "timer-critical");
  if (seconds === null) {
    timer.textContent = "--";
    return;
  }
  timer.textContent = `${seconds}s`;
  if (seconds <= 5) timer.classList.add("timer-critical");
  else if (seconds <= 10) timer.classList.add("timer-urgent");
  else if (seconds <= 20) timer.classList.add("timer-warning");
}

function updateState(data) {
  const wasFinished = state.finished;
  clearPreview();
  state.ready = data.ready;
  state.turn = data.turn;
  state.playerNames = data.player_names || {};
  state.playerProfiles = data.player_profiles || {};
  state.finished = Boolean(data.winner || data.draw);
  state.lastResult = state.finished ? { winner: data.winner, draw: data.draw, reason: data.result_reason } : null;
  if (typeof data.server_time === "number") {
    state.serverClockOffsetMs = data.server_time * 1000 - Date.now();
  }
  renderBoard(data.board);
  renderPlayerCards();
  syncCountdown(data.turn_deadline);

  if (!data.ready) $("#status").textContent = "等待好友加入…";
  else if (data.winner && data.result_reason === "timeout") $("#status").textContent = `${colorName(data.turn)}超时，${colorName(data.winner)}获胜`;
  else if (data.winner) $("#status").textContent = `${colorName(data.winner)}获胜`;
  else if (data.draw) $("#status").textContent = "棋盘已满，本局平局";
  else {
    const turnPlayer = displayName(playerForColor(data.turn));
    $("#status").textContent = data.turn === state.color ? "轮到你落子" : `等待${turnPlayer ? ` ${turnPlayer} ` : "对方"}落子`;
  }

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
  if (state.turnDeadline === null || state.finished || !state.ready) {
    updateTimerNode("black", null);
    updateTimerNode("white", null);
    return;
  }
  const serverNow = Date.now() + state.serverClockOffsetMs;
  const seconds = Math.max(0, Math.ceil((state.turnDeadline * 1000 - serverNow) / 1000));
  updateTimerNode("black", state.turn === "black" ? seconds : 60);
  updateTimerNode("white", state.turn === "white" ? seconds : 60);
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
      renderPlayerCards();
    } else if (data.type === "state") {
      updateState(data);
    } else if (data.type === "chat") {
      addMessage(data);
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
      renderPlayerCards();
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

function addMessage(data) {
  const { color, message, username } = data;
  const messages = $("#messages");
  const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 56;
  const isMine = username === state.account?.username;
  const authorName = data.display_name || data.nickname || username || colorName(color);
  const item = document.createElement("p");
  item.className = `message ${isMine ? "me" : ""}`;
  const name = document.createElement("b");
  name.textContent = isMine ? `我（${authorName}）` : authorName;
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
  state.unreadCount = 0;
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
    syncGameLayout(false);
  });
}

function closeChatSheet() {
  $(".chat-card").classList.remove("sheet-open");
  $("#chatInput").blur();
  requestAnimationFrame(() => syncGameLayout(false));
}

function isMobileLayout() {
  return window.matchMedia("(max-width: 768px)").matches;
}

function syncGameLayout(forceBoardResize = false) {
  syncMobileLayout(forceBoardResize);
  requestAnimationFrame(syncBoardGeometry);
}

function syncMobileLayout(forceBoardResize = false) {
  if (!isMobileLayout() || !document.body.classList.contains("game-active")) {
    document.documentElement.style.removeProperty("--mobile-board-size");
    return;
  }
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
  if (sheetOpen && state.mobileBoardSize && !forceBoardResize) return;

  const game = $("#game");
  const gameStyles = getComputedStyle(game);
  const gameColumnGap = Number.parseFloat(gameStyles.rowGap || gameStyles.gap) || 0;
  const visibleSections = keyboardOpen ? 4 : 5;
  const layoutGap = Math.max(0, gameColumnGap * (visibleSections - 1));
  const safeBottom = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--safe-bottom")) || 0;
  const horizontalSpace = game.clientWidth;
  const roomHeight = $(".room-card").getBoundingClientRect().height;
  const playersHeight = $(".players-bar").getBoundingClientRect().height;
  const hintHeight = $("#moveHint").getBoundingClientRect().height;
  const chatHeight = chatCard.getBoundingClientRect().height || state.normalChatHeight;
  const chromeHeight = roomHeight + playersHeight + hintHeight + chatHeight + layoutGap + safeBottom;
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
  $("#profilePage").classList.add("hidden");
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
  $("#currentAccount").textContent = displayName(state.account) || state.account.username;
  $("#adminLink").classList.toggle("hidden", state.account.role !== "developer");
  $("#lobby").classList.remove("hidden");
  const hashRoom = location.hash.slice(1).toUpperCase();
  if (/^[A-Z0-9]{6}$/.test(hashRoom)) {
    roomExists(hashRoom).then((exists) => exists ? connect(hashRoom) : toast("分享的房间不存在"));
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("无法读取头像文件"));
    reader.readAsDataURL(file);
  });
}

function renderProfileForm(profile) {
  state.profileAvatarDraft = profile.avatar || "";
  $("#profileUsername").textContent = profile.username;
  $("#profileNickname").value = profile.nickname || "";
  $("#profileAvatarPreview").src = profile.avatar || defaultAvatar(displayName(profile) || profile.username, "black");
  $("#profileAvatarPreview").alt = `${displayName(profile) || profile.username}头像`;
  $("#profileAvatarFile").value = "";
  $("#profileMessage").textContent = "";
  $("#profileMessage").classList.remove("error-message");
}

async function showProfile() {
  hideMainSections();
  document.body.classList.remove("game-active");
  $("#profilePage").classList.remove("hidden");
  const profile = await apiRequest("/api/profile");
  state.account = profile;
  renderProfileForm(profile);
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
    } else if (location.pathname === "/profile") {
      await showProfile();
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

$("#profileAvatarFile").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const message = $("#profileMessage");
  message.textContent = "";
  message.classList.remove("error-message");
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) {
    message.textContent = "头像只支持 PNG、JPG、WebP 或 GIF 图片";
    message.classList.add("error-message");
    event.target.value = "";
    return;
  }
  if (file.size > 512 * 1024) {
    message.textContent = "头像图片不能超过 512KB";
    message.classList.add("error-message");
    event.target.value = "";
    return;
  }
  try {
    state.profileAvatarDraft = await fileToDataUrl(file);
    $("#profileAvatarPreview").src = state.profileAvatarDraft;
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error-message");
  }
});

$("#clearAvatarBtn").addEventListener("click", () => {
  state.profileAvatarDraft = "";
  const name = $("#profileNickname").value.trim() || state.account?.username || "棋";
  $("#profileAvatarPreview").src = defaultAvatar(name, "black");
  $("#profileAvatarFile").value = "";
});

$("#profileForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.currentTarget.querySelector("button[type=submit]");
  const message = $("#profileMessage");
  submit.disabled = true;
  message.textContent = "";
  message.classList.remove("error-message");
  try {
    state.account = await apiRequest("/api/profile", {
      method: "PATCH",
      body: JSON.stringify({
        nickname: $("#profileNickname").value,
        avatar: state.profileAvatarDraft,
      }),
    });
    renderProfileForm(state.account);
    message.textContent = "资料已保存";
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error-message");
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
$("#chatInput").addEventListener("focus", () => setTimeout(() => syncGameLayout(true), 80));
$("#chatInput").addEventListener("blur", () => setTimeout(() => syncGameLayout(true), 80));

window.addEventListener("load", () => requestAnimationFrame(() => syncGameLayout(true)));
window.addEventListener("resize", () => requestAnimationFrame(() => syncGameLayout(false)));
window.addEventListener("orientationchange", () => setTimeout(() => syncGameLayout(true), 120));
window.visualViewport?.addEventListener("resize", () => requestAnimationFrame(() => syncGameLayout(false)));
window.visualViewport?.addEventListener("scroll", () => requestAnimationFrame(() => syncGameLayout(false)));

bootstrapAuth();
