"use strict";

const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");
const QRCode = require("qrcode");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const OPEN = 1;

const SPAN_LABELS = {
  year: "2026",
  decade: "The last 10 years",
  life: "Lifetime",
};

const questions = [
  {
    span: "year",
    title: "Who has left their phone locked the longest during waking hours in 2026?",
    prompt: "During waking hours in 2026, what's the longest your phone has been locked, in hours?",
    unit: "hours",
    direction: "higher",
    kind: "number",
  },
  {
    span: "year",
    title: "Who has taken the longest flight in 2026?",
    prompt: "What's your longest flight in 2026, in hours?",
    unit: "hours",
    direction: "higher",
    kind: "number",
  },
  {
    span: "year",
    title: "Who has eaten the most semlor in 2026?",
    prompt: "In 2026, how many semlor have you eaten?",
    unit: "semla",
    direction: "higher",
    kind: "number",
  },
  {
    span: "year",
    title: "Who has been to Systembolaget the most in 2026?",
    prompt: "How many times have you been to Systembolaget in 2026?",
    unit: "times",
    direction: "higher",
    kind: "number",
  },
  {
    span: "decade",
    title: "Who has slept the longest in the last 10 years?",
    prompt: "What's the longest you have slept in the last 10 years, in hours?",
    unit: "hours",
    direction: "higher",
    kind: "number",
  },
  {
    span: "decade",
    title: "Who has been awake the longest in the last 10 years?",
    prompt: "What's the longest you've been awake in the last 10 years, in hours?",
    unit: "hours",
    direction: "higher",
    kind: "number",
  },
  {
    span: "decade",
    title: "Who has been closest to the equator in the last 10 years?",
    prompt: "How close have you been to the equator in the last 10 years, in km?",
    unit: "km",
    direction: "lower",
    kind: "number",
  },
  {
    span: "decade",
    title: "Who has the most hours in one video game from the last 10 years?",
    prompt: "How many hours do you have logged in your most played video game from the last 10 years? Name the game.",
    unit: "hours",
    direction: "higher",
    kind: "show",
    detailLabel: "Name of the game",
  },
  {
    span: "life",
    title: "Who has pet the most types of animals?",
    prompt: "How many types of animals have you pet?",
    unit: "types",
    direction: "higher",
    kind: "list",
    listLabel: "Which animals? One per line.",
  },
  {
    span: "life",
    title: "Who has been to the highest elevation without a plane?",
    prompt: "What's the highest elevation you have been to without a plane, in meters?",
    unit: "meters",
    direction: "higher",
    kind: "number",
  },
  {
    span: "life",
    title: "Who has taken the longest bath at home?",
    prompt: "What's your longest bath at home, in minutes?",
    unit: "min",
    direction: "higher",
    kind: "number",
  },
  {
    span: "life",
    title: "Who has had the most toppings on a pizza at once?",
    prompt: "What's the most toppings you've had on one pizza? Sauce doesn't count, and one cheese doesn't count.",
    unit: "toppings",
    direction: "higher",
    kind: "number",
  },
  {
    span: "life",
    title: "Who can do the most skateboard tricks?",
    prompt: "How many tricks can you do on a skateboard?",
    unit: "tricks",
    direction: "higher",
    kind: "number",
  },
  {
    span: "life",
    title: "Who can say thank you in the most languages?",
    prompt: "How many languages can you say \"thank you\" in?",
    unit: "languages",
    direction: "higher",
    kind: "list",
    listLabel: "Which languages? One per line.",
  },
];

const UNIT_WORDS = {
  types: ["type", "types"],
  hours: ["hour", "hours"],
  toppings: ["topping", "toppings"],
  languages: ["language", "languages"],
  times: ["time", "times"],
  tricks: ["trick", "tricks"],
  semla: ["semla", "semlor"],
};

function createRoom() {
  return {
    phase: "lobby",
    questionIndex: 0,
    players: [],
    answers: {},
    history: [],
  };
}

let room = createRoom();
const clients = new Set();

let publicOrigin = null;
let tunnelStatus = "starting";
let tunnelHint = "";
let tunnelProcess = null;

function joinUrl() {
  return publicOrigin ? `${publicOrigin}/play` : null;
}

function pointingLine(question) {
  if (question.direction === "lower") return "Point at who you think is the closest";
  return "Point at who you think has the most";
}

function formatNumber(value) {
  const rounded = Math.round(value * 100) / 100;
  const parts = String(rounded).split(".");
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return parts.join(".");
}

function unitWord(unit, value) {
  if (!unit) return "";
  const pair = UNIT_WORDS[unit];
  if (!pair) return unit;
  return value === 1 ? pair[0] : pair[1];
}

function formatAmount(value, unit) {
  const number = formatNumber(value);
  const label = unitWord(unit, value);
  return label ? `${number} ${label}` : number;
}

function joinNames(names) {
  if (names.length <= 1) return names[0] || "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function answerLabel(answer, unit) {
  const amount = formatAmount(answer.value, unit);
  if (answer.items) {
    if (!answer.items.length) return amount;
    return `${answer.items.join(", ")} · ${amount}`;
  }
  return answer.showName ? `${answer.showName} · ${amount}` : amount;
}

function parseList(raw) {
  const text = typeof raw === "string" ? raw : "";
  const seen = new Set();
  const items = [];
  for (const piece of text.split(/[\n,;]+/)) {
    const trimmed = piece.replace(/\s+/g, " ").trim();
    if (!trimmed) continue;
    if (trimmed.length > 40 || /[\u0000-\u001F]/.test(trimmed)) {
      return { error: "Keep each one to a short name." };
    }
    const key = trimmed.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(trimmed);
  }
  if (items.length > 40) return { error: "Keep the list to 40." };
  return { items };
}

function winnerSummary(winners) {
  if (!winners.length) return "No answers";
  return joinNames(
    winners.map((winner) => {
      if (winner.showName) return `${winner.name} (${winner.showName}, ${winner.amount})`;
      return `${winner.name} (${winner.amount})`;
    })
  );
}

function winnerHeadline(ranking, question) {
  const winners = ranking.filter((row) => row.isWinner);
  if (!winners.length) return "Nobody answered";
  const names = joinNames(winners.map((row) => row.name));
  const amount = winners[0].amount;
  if (winners.length > 1) return `${names} are tied at ${amount}`;
  if (question.direction === "lower") return `${names} is the closest, at ${amount}`;
  return `${names} has the most, at ${amount}`;
}

function currentQuestion() {
  return questions[room.questionIndex] || null;
}

function currentAnswers() {
  return room.answers[room.questionIndex] || {};
}

function rankCurrent() {
  const question = currentQuestion();
  const answers = currentAnswers();
  const rows = [];
  for (const player of room.players) {
    const answer = answers[player.id];
    if (!answer) continue;
    rows.push({
      playerId: player.id,
      name: player.name,
      showName: answer.showName,
      items: answer.items || null,
      value: answer.value,
      amount: formatAmount(answer.value, question.unit),
    });
  }
  rows.sort((a, b) =>
    question.direction === "lower" ? a.value - b.value : b.value - a.value
  );
  let place = 1;
  for (let index = 0; index < rows.length; index += 1) {
    if (index > 0 && rows[index].value !== rows[index - 1].value) place = index + 1;
    rows[index].place = place;
    rows[index].isWinner = rows[index].value === rows[0].value;
  }
  return rows;
}

function questionPayload() {
  const question = currentQuestion();
  if (!question) return null;
  return {
    number: room.questionIndex + 1,
    total: questions.length,
    text: question.title,
    prompt: question.prompt,
    span: SPAN_LABELS[question.span] || "",
    spanStart: room.questionIndex === 0 || questions[room.questionIndex - 1].span !== question.span,
    unit: question.unit,
    direction: question.direction,
    kind: question.kind,
    detailLabel: question.detailLabel || "",
    listLabel: question.listLabel || "",
  };
}

function showsAnswers() {
  return room.phase === "answering" || room.phase === "pointing" || room.phase === "reveal";
}

function stateFor(client) {
  const question = room.phase === "lobby" || room.phase === "done" ? null : questionPayload();
  const answers = currentAnswers();
  const active = showsAnswers();
  const payload = {
    type: "state",
    phase: room.phase,
    question,
    pointingLine: question ? pointingLine(currentQuestion()) : null,
    players: room.players.map((player) => ({
      name: player.name,
      connected: player.connected,
      submitted: active ? Boolean(answers[player.id]) : false,
    })),
    submittedCount: active
      ? room.players.filter((player) => answers[player.id]).length
      : 0,
    playerCount: room.players.length,
  };

  if (room.phase === "reveal") {
    const ranking = rankCurrent();
    payload.ranking = ranking.map((row) => ({
      name: row.name,
      showName: row.showName,
      items: row.items || null,
      amount: row.amount,
      place: row.place,
      isWinner: row.isWinner,
      isYou: client.playerId === row.playerId,
    }));
    payload.headline = winnerHeadline(ranking, currentQuestion());
    payload.missing = room.players
      .filter((player) => !answers[player.id])
      .map((player) => player.name);
  }

  if (room.phase === "done") {
    payload.recap = room.history;
  }

  if (client.role === "player") {
    const me = room.players.find((player) => player.id === client.playerId);
    if (!me) {
      payload.you = null;
    } else {
      const mine = active ? answers[me.id] : null;
      payload.you = {
        id: me.id,
        name: me.name,
        answer: mine
          ? {
              value: mine.value,
              showName: mine.showName,
              items: mine.items || null,
              amount: formatAmount(mine.value, currentQuestion().unit),
              label: answerLabel(mine, currentQuestion().unit),
            }
          : null,
      };
    }
  }

  return payload;
}

function send(client, message) {
  if (client.ws.readyState === OPEN) {
    client.ws.send(JSON.stringify(message));
  }
}

function broadcast() {
  for (const client of clients) send(client, stateFor(client));
}

function cleanText(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed || trimmed.length > max) return null;
  if (/[\u0000-\u001F]/.test(trimmed)) return null;
  return trimmed;
}

function parseValue(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    return value;
  }
  if (typeof value !== "string") return null;
  let text = value.trim().replace(/\s/g, "");
  if (!text) return null;
  if (text.includes(",") && text.includes(".")) {
    text = text.replace(/\./g, "").replace(",", ".");
  } else if (text.includes(",")) {
    text = text.replace(",", ".");
  }
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(text)) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1_000_000_000) return null;
  return parsed;
}

function playerSockets(playerId, except) {
  return [...clients].filter(
    (client) => client !== except && client.playerId === playerId && client.ws.readyState === OPEN
  );
}

function handleJoin(client, message) {
  const token = typeof message.token === "string" ? message.token : "";
  const name = cleanText(message.name, 24);
  const existing = token ? room.players.find((player) => player.id === token) : null;

  if (existing) {
    if (name) existing.name = name;
    existing.connected = true;
    client.role = "player";
    client.playerId = existing.id;
    broadcast();
    return;
  }

  if (!name) {
    send(client, { type: "error", message: "Enter your name to join." });
    send(client, stateFor(client));
    return;
  }

  const player = { id: crypto.randomUUID(), name, connected: true };
  room.players.push(player);
  client.role = "player";
  client.playerId = player.id;
  broadcast();
}

function handleSubmit(client, message) {
  if (client.role !== "player" || !client.playerId) {
    send(client, { type: "error", message: "Join before you answer." });
    return;
  }
  if (room.phase !== "answering") {
    send(client, { type: "error", message: "Answers are closed for this question." });
    return;
  }

  const question = currentQuestion();
  if (question.kind === "list") {
    const parsed = parseList(message.items);
    if (parsed.error) {
      send(client, { type: "error", message: parsed.error });
      return;
    }
    if (!room.answers[room.questionIndex]) room.answers[room.questionIndex] = {};
    room.answers[room.questionIndex][client.playerId] = {
      value: parsed.items.length,
      showName: null,
      items: parsed.items,
    };
    broadcast();
    return;
  }

  const value = parseValue(message.value);
  if (value === null) {
    send(client, { type: "error", message: "Enter a number that is zero or more." });
    return;
  }

  let showName = null;
  if (question.kind === "show") {
    showName = cleanText(message.showName, 60);
    if (!showName) {
      send(client, {
        type: "error",
        message: question.detailLabel === "Name of the game" ? "Name the game." : "Name the show.",
      });
      return;
    }
  }

  if (!room.answers[room.questionIndex]) room.answers[room.questionIndex] = {};
  room.answers[room.questionIndex][client.playerId] = { value, showName };
  broadcast();
}

function rememberWinners() {
  const ranking = rankCurrent();
  const winners = ranking
    .filter((row) => row.isWinner)
    .map((row) => ({
      name: row.name,
      showName: row.showName,
      amount: row.amount,
    }));
  room.history.push({
    number: room.questionIndex + 1,
    text: currentQuestion().title,
    span: SPAN_LABELS[currentQuestion().span] || "",
    summary: winnerSummary(winners),
  });
}

function handleHost(client, type) {
  if (client.role !== "host") return;

  if (type === "start") {
    if (room.phase !== "lobby" || room.players.length === 0) return;
    room.phase = "answering";
    room.questionIndex = 0;
  } else if (type === "point") {
    if (room.phase !== "answering") return;
    room.phase = "pointing";
  } else if (type === "reveal") {
    if (room.phase !== "pointing") return;
    rememberWinners();
    room.phase = "reveal";
  } else if (type === "next") {
    if (room.phase !== "reveal") return;
    if (room.questionIndex >= questions.length - 1) {
      room.phase = "done";
    } else {
      room.questionIndex += 1;
      room.phase = "answering";
    }
  } else if (type === "reset") {
    const players = room.players.map((player) => ({
      id: player.id,
      name: player.name,
      connected: player.connected,
    }));
    room = createRoom();
    room.players = players;
  } else {
    return;
  }

  broadcast();
}

function onMessage(client, message) {
  if (!message || typeof message.type !== "string") return;
  switch (message.type) {
    case "host":
      client.role = "host";
      client.playerId = null;
      send(client, stateFor(client));
      break;
    case "join":
      handleJoin(client, message);
      break;
    case "submit":
      handleSubmit(client, message);
      break;
    case "start":
    case "point":
    case "reveal":
    case "next":
    case "reset":
      handleHost(client, message.type);
      break;
    default:
      break;
  }
}

function onClose(client) {
  clients.delete(client);
  if (client.playerId) {
    const player = room.players.find((item) => item.id === client.playerId);
    if (player) player.connected = playerSockets(client.playerId).length > 0;
  }
  broadcast();
}

const app = express();
app.use((_req, res, next) => {
  res.set("Cache-Control", "no-cache");
  next();
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "host.html"));
});

app.get("/play", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "play.html"));
});

app.get("/api/join", async (_req, res, next) => {
  try {
    const url = joinUrl();
    if (!url) {
      res.json({ url: null, qr: null, status: tunnelStatus, hint: tunnelHint });
      return;
    }
    const qr = await QRCode.toDataURL(url, {
      margin: 2,
      width: 560,
      errorCorrectionLevel: "Q",
      color: { dark: "#000000", light: "#ffffff" },
    });
    res.json({ url, qr, status: "ready", hint: "" });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 16_000 });

wss.on("connection", (ws) => {
  const client = { ws, role: null, playerId: null };
  clients.add(client);
  send(client, stateFor(client));

  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    const text = raw.toString();
    if (text.length > 8_000) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    onMessage(client, message);
  });

  ws.on("close", () => onClose(client));
  ws.on("error", () => {});
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use.`);
    process.exit(1);
  }
  throw error;
});

function cloudflaredAsset() {
  if (process.platform === "darwin" && process.arch === "arm64") return "cloudflared-darwin-arm64.tgz";
  if (process.platform === "darwin") return "cloudflared-darwin-amd64.tgz";
  if (process.platform === "linux" && process.arch === "arm64") return "cloudflared-linux-arm64";
  if (process.platform === "linux") return "cloudflared-linux-amd64";
  return null;
}

function executable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function existingCloudflared() {
  const found = spawnSync("which", ["cloudflared"], { encoding: "utf8" });
  if (found.status === 0 && found.stdout.trim() && executable(found.stdout.trim())) {
    return found.stdout.trim();
  }
  const bundled = path.join(__dirname, "bin", "cloudflared");
  const candidates = ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared", bundled];
  return candidates.find((candidate) => executable(candidate)) || null;
}

function downloadCloudflared() {
  const asset = cloudflaredAsset();
  if (!asset) return null;
  const dir = path.join(__dirname, "bin");
  fs.mkdirSync(dir, { recursive: true });
  const destination = path.join(dir, "cloudflared");
  if (executable(destination)) return destination;
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
  console.log("  Downloading Cloudflare Tunnel (one time) so phones can join from cellular…");
  if (asset.endsWith(".tgz")) {
    const archive = path.join(dir, asset);
    const downloaded = spawnSync("curl", ["-fsSL", "-o", archive, url], { stdio: "inherit" });
    if (downloaded.status !== 0) return null;
    const extracted = spawnSync("tar", ["-xzf", archive, "-C", dir]);
    fs.rmSync(archive, { force: true });
    if (extracted.status !== 0 || !executable(destination)) return null;
    return destination;
  }
  const downloaded = spawnSync("curl", ["-fsSL", "-o", destination, url], { stdio: "inherit" });
  if (downloaded.status !== 0) return null;
  fs.chmodSync(destination, 0o755);
  return executable(destination) ? destination : null;
}

function tunnelHelp() {
  return [
    "Phones need a public link, and Cloudflare Tunnel is not available.",
    "Install it once, then run npm start again:",
    "",
    "  brew install cloudflared",
    "",
    `The TV still works at http://localhost:${PORT}`,
  ].join("\n");
}

let tunnelLog = "";

function noteTunnel(chunk) {
  tunnelLog = (tunnelLog + chunk.toString()).slice(-4000);
  const match = tunnelLog.match(/https:\/\/[-a-z0-9]+\.trycloudflare\.com/i);
  if (!match || publicOrigin) return;
  publicOrigin = match[0];
  tunnelStatus = "ready";
  console.log(`  Phones: ${publicOrigin}/play`);
  console.log("  That link is in the TV QR code. Cellular is fine.");
  console.log("");
}

function startTunnel() {
  let binary = existingCloudflared();
  if (!binary) binary = downloadCloudflared();
  if (!binary) {
    tunnelStatus = "unavailable";
    tunnelHint = tunnelHelp();
    console.log("");
    console.log(tunnelHint);
    console.log("");
    return;
  }

  tunnelProcess = spawn(
    binary,
    ["tunnel", "--url", `http://127.0.0.1:${PORT}`, "--no-autoupdate"],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  tunnelProcess.stdout.on("data", noteTunnel);
  tunnelProcess.stderr.on("data", noteTunnel);
  tunnelProcess.on("error", () => {
    if (tunnelStatus === "ready") return;
    tunnelStatus = "unavailable";
    tunnelHint = tunnelHelp();
  });
  tunnelProcess.on("exit", () => {
    if (tunnelStatus === "ready") return;
    tunnelStatus = "unavailable";
    tunnelHint = tunnelHelp();
    console.log("");
    console.log(tunnelHint);
    console.log("");
  });
}

function stopTunnel() {
  if (tunnelProcess && !tunnelProcess.killed) tunnelProcess.kill();
}

process.on("SIGINT", () => {
  stopTunnel();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopTunnel();
  process.exit(0);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("  Who's the Most");
  console.log(`  TV:  http://localhost:${PORT}`);
  console.log("  Open that on the TV. Phones join from the QR code, on cellular or any network.");
  console.log("");
  startTunnel();
});
