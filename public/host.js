const app = document.querySelector("#app");
const linkStatus = document.querySelector("#link-status");

let state = null;
let joinInfo = null;
let socket = null;
let viewKey = "";
let reconnectTimer = null;

function esc(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character]));
}

function socketUrl() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}

function send(type) {
  if (!socket || socket.readyState !== 1) return;
  socket.send(JSON.stringify({ type }));
}

function currentKey() {
  if (state.phase === "lobby") return `lobby|${joinInfo?.url || ""}|${joinInfo?.status || ""}`;
  if (state.phase === "done") return "done";
  return `${state.phase}|${state.question.number}|${state.headline || ""}`;
}

function chipHtml(player) {
  const classes = ["chip"];
  if (player.submitted) classes.push("in");
  if (!player.connected) classes.push("off");
  const mark = player.submitted ? "✓ " : "";
  return `<span class="${classes.join(" ")}">${mark}${esc(player.name)}</span>`;
}

function qrBlock() {
  if (!joinInfo) return `<p class="url">Finding the join address…</p>`;
  if (joinInfo.error) return `<p class="url">Couldn't load the QR code. Refresh the TV.</p>`;
  if (!joinInfo.qr || joinInfo.status === "starting") {
    return `<p class="url">Opening a public link so phones can join without your Wi-Fi…</p>`;
  }
  if (joinInfo.status === "unavailable") {
    return `<p class="warn">${esc(joinInfo.hint || "No public link yet.").replace(/\n/g, "<br>")}</p>`;
  }
  return `
    <div class="qr-card"><img id="qr" alt="QR code to join the game" src="${esc(joinInfo.qr)}"></div>
    <p class="url">${esc(joinInfo.url).split("/").join("/<wbr>")}</p>
  `;
}

function lobbyHtml() {
  return `
    <div class="lobby">
      <div>
        <h1 class="question">Scan to join</h1>
        ${qrBlock()}
      </div>
      <div>
        <p class="eyebrow" id="lobby-count"></p>
        <div class="chips" id="players" aria-live="polite"></div>
      </div>
    </div>
  `;
}

function roundHead(question) {
  const count = `Question ${question.number} of ${question.total}`;
  if (question.spanStart) {
    return `<p class="chunk">${esc(question.span)}</p><p class="eyebrow">${count}</p>`;
  }
  const label = question.span ? `${question.span} · ${count}` : count;
  return `<p class="eyebrow">${esc(label)}</p>`;
}

function questionHtml(mode) {
  const question = state.question;
  const hero = mode === "point"
    ? `<h1 class="question">${esc(question.text)}</h1><p class="call point">${esc(state.pointingLine)}</p>`
    : `<h1 class="question">${esc(question.prompt)}</h1><p class="banner" id="banner"></p>`;
  return `
    ${roundHead(question)}
    ${hero}
    <p class="count" id="count"></p>
    <div class="chips" id="players" aria-live="polite"></div>
  `;
}

function listed(row) {
  if (row.items?.length) return `<span class="show">${esc(row.items.join(", "))}</span>`;
  if (row.showName) return `<span class="show">${esc(row.showName)}</span>`;
  return "";
}

function revealHtml() {
  const question = state.question;
  const rows = (state.ranking || []).map((row) => `
    <li class="rank${row.isWinner ? " winner" : ""}">
      <span class="place">${row.place}</span>
      <span class="who">${esc(row.name)}${listed(row)}</span>
      <span class="amount">${esc(row.amount)}</span>
    </li>
  `).join("");
  const missing = state.missing?.length
    ? `<p class="missing">No answer: ${esc(state.missing.join(", "))}</p>`
    : "";
  return `
    ${roundHead(question)}
    <p class="quiet">${esc(question.text)}</p>
    <h1 class="question">${esc(state.headline || "Nobody answered")}</h1>
    <ol class="ranking">${rows}</ol>
    ${missing}
  `;
}

function doneHtml() {
  const items = (state.recap || []).map((round) => `
    <li>
      <span class="n">${round.number}</span>
      <span>
        <span class="q">${round.span ? `${esc(round.span)} · ` : ""}${esc(round.text)}</span>
        <span class="a">${esc(round.summary)}</span>
      </span>
    </li>
  `).join("");
  return `
    <p class="eyebrow">Final round</p>
    <h1 class="question">That's the game</h1>
    <ol class="recap">${items}</ol>
  `;
}

function stageHtml() {
  if (state.phase === "lobby") return lobbyHtml();
  if (state.phase === "answering") return questionHtml("answer");
  if (state.phase === "pointing") return questionHtml("point");
  if (state.phase === "reveal") return revealHtml();
  return doneHtml();
}

function controlsHtml() {
  if (state.phase === "lobby") {
    const disabled = state.playerCount === 0 ? "disabled" : "";
    return `<span></span><button class="primary" type="button" data-action="start" ${disabled}>Start game</button>`;
  }
  if (state.phase === "answering") {
    return `<button class="ghost" type="button" data-action="reset">Back to lobby</button>
      <button class="primary" type="button" data-action="point">Point</button>`;
  }
  if (state.phase === "pointing") {
    return `<button class="ghost" type="button" data-action="reset">Back to lobby</button>
      <button class="primary" type="button" data-action="reveal">Reveal</button>`;
  }
  if (state.phase === "reveal") {
    const label = state.question.number === state.question.total ? "Finish" : "Next question";
    return `<button class="ghost" type="button" data-action="reset">Back to lobby</button>
      <button class="primary" type="button" data-action="next">${label}</button>`;
  }
  return `<span></span><button class="primary" type="button" data-action="reset">Play again</button>`;
}

function shell() {
  return `
    <div class="screen">
      <header class="top"><p class="mark">Who's the Most</p></header>
      <div class="stage">${stageHtml()}</div>
      <footer class="controls">${controlsHtml()}</footer>
    </div>
  `;
}

function updateDynamic() {
  const players = document.querySelector("#players");
  if (players) players.innerHTML = state.players.map(chipHtml).join("");

  const lobbyCount = document.querySelector("#lobby-count");
  if (lobbyCount) {
    lobbyCount.textContent = state.playerCount === 0
      ? "Waiting for players"
      : `${state.playerCount} ${state.playerCount === 1 ? "player" : "players"}`;
  }

  const count = document.querySelector("#count");
  if (count) count.textContent = `${state.submittedCount} of ${state.playerCount} answered`;

  const banner = document.querySelector("#banner");
  if (banner) {
    const ready = state.playerCount > 0 && state.submittedCount === state.playerCount;
    banner.textContent = ready ? "Everyone has answered" : "";
  }

  const start = document.querySelector("[data-action=start]");
  if (start) start.disabled = state.playerCount === 0;

  const point = document.querySelector("[data-action=point]");
  if (point && !point.dataset.armed) {
    const ready = state.playerCount > 0 && state.submittedCount === state.playerCount;
    point.textContent = ready ? "Everyone's in — Point" : "Point";
  }

  linkStatus.textContent = socket && socket.readyState !== 1 && socket.readyState !== 0
    ? "Reconnecting…"
    : "";
}

function render() {
  if (!state) {
    app.innerHTML = `<p class="status">Connecting…</p>`;
    viewKey = "";
    linkStatus.textContent = "";
    return;
  }
  document.body.dataset.phase = state.phase;
  const key = currentKey();
  if (key !== viewKey) {
    viewKey = key;
    app.innerHTML = shell();
  }
  updateDynamic();
}

app.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  if (action === "reset" && state && state.phase !== "done" && state.phase !== "lobby") {
    if (!button.dataset.armed) {
      button.dataset.armed = "yes";
      button.textContent = "Clear the game?";
      return;
    }
  }
  send(action);
});

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 800);
}

function connect() {
  if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;
  socket = new WebSocket(socketUrl());
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "host" }));
    render();
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type !== "state") return;
    state = message;
    render();
  });
  socket.addEventListener("close", () => {
    render();
    scheduleReconnect();
  });
}

async function loadJoin() {
  try {
    const response = await fetch("/api/join");
    if (!response.ok) throw new Error("join failed");
    const next = await response.json();
    if (next.qr && !String(next.qr).startsWith("data:image/")) next.error = true;
    joinInfo = next;
    if (next.status === "starting") setTimeout(loadJoin, 1000);
  } catch {
    joinInfo = { error: true, status: "error" };
  }
  render();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") connect();
});

render();
connect();
loadJoin();
