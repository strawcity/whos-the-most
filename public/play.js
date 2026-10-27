const app = document.querySelector("#app");
const linkStatus = document.querySelector("#link-status");
const storageKey = "whos-the-most-player";

let state = null;
let socket = null;
let viewKey = "";
let editing = false;
let renaming = false;
let restoring = Boolean(savedPlayer()?.id);
let error = "";
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

function savedPlayer() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (!saved || typeof saved.id !== "string" || typeof saved.name !== "string") return null;
    return saved;
  } catch {
    return null;
  }
}

function remember(player) {
  localStorage.setItem(storageKey, JSON.stringify({ id: player.id, name: player.name }));
}

function socketUrl() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}

function send(message) {
  if (!socket || socket.readyState !== 1) {
    error = "Reconnecting…";
    updateLive();
    return;
  }
  socket.send(JSON.stringify(message));
}

function answerStamp(answer) {
  if (!answer) return "";
  const items = Array.isArray(answer.items) ? answer.items.join("|") : "";
  return `${answer.value}|${answer.showName || ""}|${items}`;
}

function currentKey() {
  if (!state) return "boot";
  const answer = state.you?.answer;
  return [
    state.phase,
    state.question?.number ?? 0,
    state.you?.id ?? "",
    state.you?.name ?? "",
    answerStamp(answer),
    editing ? "edit" : "view",
    renaming ? "rename" : "named",
    restoring ? "restoring" : "ready",
  ].join("~");
}

function nameForm(label) {
  const current = renaming ? state?.you?.name || "" : "";
  return `
    <p class="eyebrow">Who's the Most</p>
    <h1 class="question">${renaming ? "Edit your name" : "What's your name?"}</h1>
    <form id="name-form">
      <label for="name">Your name</label>
      <input id="name" name="name" maxlength="24" autocomplete="nickname" enterkeyhint="join" value="${esc(current)}" required>
      <p id="form-error" class="form-error"></p>
      <button class="primary" type="submit">${esc(label)}</button>
    </form>
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

function answerForm() {
  const question = state.question;
  const answer = state.you?.answer;
  if (question.kind === "list") {
    const listed = answer?.items?.length ? answer.items.join("\n") : "";
    return `
      ${roundHead(question)}
      <h1 class="question">${esc(question.prompt)}</h1>
      <form id="answer-form">
        <label for="items">${esc(question.listLabel || "List them, one per line.")}</label>
        <textarea id="items" name="items" rows="6" enterkeyhint="done">${esc(listed)}</textarea>
        <p id="form-error" class="form-error"></p>
        <button class="primary" type="submit">${answer ? "Update answer" : "Submit"}</button>
      </form>
      <p class="progress" id="progress"></p>
    `;
  }
  const showField = question.kind === "show"
    ? `<label for="show">${esc(question.detailLabel || "Name")}</label>
       <input id="show" name="show" maxlength="60" enterkeyhint="next" value="${esc(answer?.showName || "")}">`
    : "";
  const valueLabel = question.kind === "show" && question.unit === "times"
    ? "How many times"
    : question.unit
      ? `Your answer in ${question.unit}`
      : "Your answer";
  return `
    ${roundHead(question)}
    <h1 class="question">${esc(question.prompt)}</h1>
    <form id="answer-form">
      ${showField}
      <label for="amount">${esc(valueLabel)}</label>
      <input id="amount" class="amount" name="amount" inputmode="decimal" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="done" value="${answer ? esc(answer.value) : ""}">
      <p id="form-error" class="form-error"></p>
      <button class="primary" type="submit">${answer ? "Update answer" : "Submit"}</button>
    </form>
    <p class="progress" id="progress"></p>
  `;
}

function waitingAnswer() {
  const question = state.question;
  return `
    ${roundHead(question)}
    <h1 class="question">${esc(question.prompt)}</h1>
    <p class="sub">Your answer</p>
    <p class="big-answer">${esc(state.you.answer.label)}</p>
    <p class="sub">You can change it until the host moves on.</p>
    <button class="text-button" type="button" id="edit">Change answer</button>
    <p class="progress" id="progress"></p>
  `;
}

function lobbyWait() {
  return `
    <p class="eyebrow">You're in</p>
    <h1 class="question">${esc(state.you.name)}</h1>
    <p class="sub">Waiting for the host to start.</p>
    <p class="progress" id="progress"></p>
    <button class="text-button" type="button" id="rename">Edit name</button>
  `;
}

function pointingHtml() {
  const yours = state.you?.answer
    ? `<p class="sub">You said ${esc(state.you.answer.label)}</p>`
    : `<p class="sub">You didn't answer this one.</p>`;
  return `
    <p class="eyebrow">Look at the TV</p>
    <h1 class="question">${esc(state.pointingLine)}</h1>
    ${yours}
    <p class="quiet">${esc(state.question.text)}</p>
    <p class="progress" id="progress"></p>
  `;
}

function rankingHtml() {
  if (!state.ranking?.length) {
    return `
      ${roundHead(state.question)}
      <h1 class="question">${esc(state.headline || "Nobody answered")}</h1>
      <p class="quiet">${esc(state.question.text)}</p>
    `;
  }
  const rows = state.ranking.map((row) => {
    const classes = ["rank"];
    if (row.isWinner) classes.push("winner");
    if (row.isYou) classes.push("me");
    return `
      <li class="${classes.join(" ")}">
        <span class="place">${row.place}</span>
        <span class="who">${esc(row.name)}${row.items?.length ? `<span class="show">${esc(row.items.join(", "))}</span>` : row.showName ? `<span class="show">${esc(row.showName)}</span>` : ""}</span>
        <span class="amount">${esc(row.amount)}</span>
      </li>
    `;
  }).join("");
  const missing = state.missing?.length
    ? `<p class="missing">No answer: ${esc(state.missing.join(", "))}</p>`
    : "";
  return `
    ${roundHead(state.question)}
    <h1 class="question">${esc(state.headline)}</h1>
    <p class="quiet">${esc(state.question.text)}</p>
    <ol class="ranking">${rows}</ol>
    ${missing}
  `;
}

function doneHtml() {
  const items = (state.recap || []).map((round) => `
    <li>
      <span class="n">${round.number}</span>
      <span class="q">${round.span ? `${esc(round.span)} · ` : ""}${esc(round.text)}</span>
      <span class="a">${esc(round.summary)}</span>
    </li>
  `).join("");
  return `
    <p class="eyebrow">That's the game</p>
    <h1 class="question">Nice work</h1>
    <ol class="recap">${items}</ol>
  `;
}

function screenHtml() {
  if (!state || restoring) return `<p class="status">Joining…</p>`;
  if (!state.you || renaming) return nameForm(renaming ? "Save name" : "Join");
  if (state.phase === "lobby") return lobbyWait();
  if (state.phase === "answering" && (!state.you.answer || editing)) return answerForm();
  if (state.phase === "answering") return waitingAnswer();
  if (state.phase === "pointing") return pointingHtml();
  if (state.phase === "reveal") return rankingHtml();
  if (state.phase === "done") return doneHtml();
  return `<p class="status">Waiting…</p>`;
}

function updateLive() {
  const progress = document.querySelector("#progress");
  if (progress && state) {
    progress.textContent = state.phase === "lobby"
      ? `${state.playerCount} in the lobby`
      : `${state.submittedCount} of ${state.playerCount} answered`;
  }
  const formError = document.querySelector("#form-error");
  if (formError) formError.textContent = error;
  linkStatus.textContent = socket && socket.readyState !== 1 && socket.readyState !== 0
    ? "Reconnecting…"
    : "";
}

function render() {
  const key = currentKey();
  if (key !== viewKey) {
    viewKey = key;
    app.innerHTML = `<div class="phone">${screenHtml()}</div>`;
  }
  updateLive();
}

function submitName(form) {
  const name = form.name.value;
  error = "";
  const saved = savedPlayer();
  send({ type: "join", name, token: saved?.id });
}

function submitAnswer(form) {
  error = "";
  const message = { type: "submit" };
  if (form.items) message.items = form.items.value;
  else message.value = form.amount.value;
  if (form.show) message.showName = form.show.value;
  send(message);
}

app.addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.target.id === "name-form") submitName(event.target);
  if (event.target.id === "answer-form") submitAnswer(event.target);
});

app.addEventListener("click", (event) => {
  if (event.target.id === "edit") {
    editing = true;
    error = "";
    render();
  }
  if (event.target.id === "rename") {
    renaming = true;
    error = "";
    render();
  }
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
    const saved = savedPlayer();
    if (saved?.id) send({ type: "join", token: saved.id, name: saved.name });
    else restoring = false;
    render();
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "error") {
      error = message.message;
      restoring = false;
      render();
      return;
    }
    if (message.type !== "state") return;

    const previousPhase = state?.phase;
    const previousQuestion = state?.question?.number;
    const previousName = state?.you?.name;
    const previousAnswer = answerStamp(state?.you?.answer);
    if (previousPhase !== message.phase || previousQuestion !== message.question?.number) {
      editing = false;
      renaming = false;
      error = "";
    }

    state = message;
    const nextAnswer = answerStamp(state.you?.answer);
    if (state.you) {
      remember(state.you);
      restoring = false;
      if (nextAnswer && nextAnswer !== previousAnswer) editing = false;
      if (previousName && state.you.name !== previousName) renaming = false;
    }
    render();
  });
  socket.addEventListener("close", () => {
    render();
    scheduleReconnect();
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") connect();
});

render();
connect();
