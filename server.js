const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const QUESTIONS_PATH = path.join(__dirname, 'questions.json');
function loadQuestions() {
  return JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf8'));
}
function saveQuestions(qs) {
  fs.writeFileSync(QUESTIONS_PATH, JSON.stringify(qs, null, 2));
}

// ---------- in-memory session store ----------
const sessions = new Map();
const connections = new Map(); // connId -> { ws, sessionPin, role, playerId }

function genPin() {
  let pin;
  do {
    pin = String(Math.floor(100000 + Math.random() * 900000));
  } while (sessions.has(pin));
  return pin;
}
function genId() {
  return crypto.randomBytes(8).toString('hex');
}

// ---------- REST: questions (admin) ----------
app.get('/api/questions', (req, res) => {
  res.json(loadQuestions());
});
app.post('/api/questions', (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'expected an array of questions' });
  saveQuestions(req.body);
  res.json({ ok: true });
});

// ---------- REST: sessions ----------
app.post('/api/sessions', (req, res) => {
  const pin = genPin();
  const id = genId();
  sessions.set(pin, {
    id,
    pin,
    quiz: loadQuestions(),
    hostConnId: null,
    status: 'lobby',
    currentIndex: -1,
    players: new Map(),
    answers: new Map(),
  });
  res.json({ pin, sessionId: id });
});

app.get('/api/sessions/:pin', (req, res) => {
  const session = sessions.get(req.params.pin);
  if (!session) return res.status(404).json({ error: 'not_found' });
  if (session.status !== 'lobby') return res.status(409).json({ error: 'already_started' });
  res.json({ ok: true });
});

app.post('/api/sessions/:pin/players', (req, res) => {
  const session = sessions.get(req.params.pin);
  if (!session) return res.status(404).json({ error: 'not_found' });
  if (session.status !== 'lobby') return res.status(409).json({ error: 'already_started' });
  const { nickname, avatar } = req.body;
  if (!nickname || nickname.trim().length < 2) return res.status(400).json({ error: 'invalid_nickname' });

  const playerId = genId();
  const player = { id: playerId, nickname: nickname.trim(), avatar: avatar || '🦊', score: 0, streak: 0 };
  session.players.set(playerId, player);

  broadcastToSession(session.pin, {
    type: 'player_joined',
    player: { id: playerId, nickname: player.nickname, avatar: player.avatar },
    totalPlayers: session.players.size,
  });

  res.json({ playerToken: playerId, sessionId: session.id });
});

app.get('/api/sessions/:pin/results', (req, res) => {
  const session = sessions.get(req.params.pin);
  if (!session) return res.status(404).json({ error: 'not_found' });
  const leaderboard = [...session.players.values()].sort((a, b) => b.score - a.score);
  res.json({ leaderboard });
});

// ---------- WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcastToSession(pin, msg, opts = {}) {
  const data = JSON.stringify(msg);
  for (const [connId, conn] of connections) {
    if (conn.sessionPin === pin) {
      if (opts.excludeConnId && connId === opts.excludeConnId) continue;
      if (conn.ws.readyState === 1) conn.ws.send(data);
    }
  }
}
function sendTo(connId, msg) {
  const conn = connections.get(connId);
  if (conn && conn.ws.readyState === 1) conn.ws.send(JSON.stringify(msg));
}

function currentQuestion(session) {
  return session.quiz[session.currentIndex] || null;
}

function tallyAnswers(session) {
  const q = currentQuestion(session);
  if (!q) return null;
  const counts = q.answers.map(() => 0);
  const answerMap = session.answers.get(q.id) || new Map();
  for (const idx of answerMap.values()) counts[idx] = (counts[idx] || 0) + 1;
  return { counts, answered: answerMap.size, totalPlayers: session.players.size };
}

wss.on('connection', (ws) => {
  const connId = genId();
  connections.set(connId, { ws, sessionPin: null, role: null, playerId: null });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const conn = connections.get(connId);

    if (msg.type === 'join_channel') {
      const session = sessions.get(msg.pin);
      if (!session) return sendTo(connId, { type: 'error', message: 'session_not_found' });
      conn.sessionPin = msg.pin;
      conn.role = msg.role;
      if (msg.role === 'host') {
        session.hostConnId = connId;
      } else {
        conn.playerId = msg.playerToken;
      }
      sendTo(connId, { type: 'channel_joined', status: session.status, currentIndex: session.currentIndex });
      return;
    }

    const session = sessions.get(conn.sessionPin);
    if (!session) return;

    if (msg.type === 'start_game' && conn.role === 'host') {
      session.status = 'question';
      session.currentIndex = 0;
      const q = currentQuestion(session);
      broadcastToSession(session.pin, {
        type: 'question_started',
        index: session.currentIndex,
        total: session.quiz.length,
        question: { id: q.id, text: q.text, image: q.image, timeLimit: q.time, skill: q.skill, answers: q.answers.map(a => a.text) },
      });
    }

    if (msg.type === 'submit_answer' && conn.role === 'player') {
      const q = currentQuestion(session);
      if (!q || session.status !== 'question') return;
      if (!session.answers.has(q.id)) session.answers.set(q.id, new Map());
      const answerMap = session.answers.get(q.id);
      if (answerMap.has(conn.playerId)) return;
      answerMap.set(conn.playerId, msg.answerIndex);

      const correct = q.answers[msg.answerIndex]?.correct === true;
      const player = session.players.get(conn.playerId);
      if (player) {
        if (correct) {
          const base = 500;
          const speedBonus = Math.round(500 * (msg.timeRemainingMs || 0) / (q.time * 1000));
          player.streak += 1;
          const streakBonus = Math.min(player.streak * 20, 200);
          player.score += base + Math.max(0, speedBonus) + streakBonus;
        } else {
          player.streak = 0;
        }
      }

      sendTo(connId, { type: 'answer_ack', correct, score: player ? player.score : 0 });
      if (session.hostConnId) {
        sendTo(session.hostConnId, { type: 'answer_tally', ...tallyAnswers(session) });
      }
    }

    if (msg.type === 'lock_and_reveal' && conn.role === 'host') {
      session.status = 'reveal';
      const q = currentQuestion(session);
      const correctIndex = q.answers.findIndex(a => a.correct);
      broadcastToSession(session.pin, { type: 'question_locked', correctIndex });
    }

    if (msg.type === 'show_leaderboard' && conn.role === 'host') {
      session.status = 'leaderboard';
      const leaderboard = [...session.players.values()]
        .sort((a, b) => b.score - a.score)
        .map((p, i) => ({ rank: i + 1, name: p.nickname, points: p.score, avatar: p.avatar }));
      broadcastToSession(session.pin, { type: 'leaderboard_update', leaderboard });
    }

    if (msg.type === 'next_question' && conn.role === 'host') {
      session.currentIndex += 1;
      if (session.currentIndex >= session.quiz.length) {
        session.status = 'podium';
        const leaderboard = [...session.players.values()]
          .sort((a, b) => b.score - a.score)
          .map((p, i) => ({ rank: i + 1, name: p.nickname, points: p.score, avatar: p.avatar }));
        broadcastToSession(session.pin, { type: 'game_ended', leaderboard });
      } else {
        session.status = 'question';
        const q = currentQuestion(session);
        broadcastToSession(session.pin, {
          type: 'question_started',
          index: session.currentIndex,
          total: session.quiz.length,
          question: { id: q.id, text: q.text, image: q.image, timeLimit: q.time, skill: q.skill, answers: q.answers.map(a => a.text) },
        });
      }
    }
  });

  ws.on('close', () => {
    connections.delete(connId);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Spark Quiz server running on http://localhost:${PORT}`));
