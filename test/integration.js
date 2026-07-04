// test/integration.js — connects real socket.io-client sockets to a live server
// instance to catch bugs that the headless GameRoom-only simulation can't see:
// card-visibility leaks, bot participation over the scheduler, and turn handoff.
const http = require('http');
const { Server } = require('socket.io');
const { io: ioClient } = require('socket.io-client');
const express = require('express');
const path = require('path');
const { RoomManager } = require('../src/RoomManager');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
const server = http.createServer(app);
const io = new Server(server);
const roomManager = new RoomManager(io);

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name }) => {
    const room = roomManager.createRoom(socket.id, name);
    socket.join(room.roomId);
    socket.emit('roomCreated', { roomId: room.roomId });
    roomManager.broadcastState(room);
  });
  socket.on('addBot', ({ roomId }) => {
    const room = roomManager.getRoom(roomId);
    room.addBot();
    roomManager.broadcastState(room);
  });
  socket.on('startGame', ({ roomId }) => {
    const room = roomManager.getRoom(roomId);
    room.startGame();
    roomManager.broadcastState(room);
    roomManager._maybeTriggerBots(room);
  });
  socket.on('startTurn', ({ roomId, targetId, cardId, declaredType }) => {
    const room = roomManager.getRoom(roomId);
    room.startTurn(socket.id, targetId, cardId, declaredType);
    roomManager.broadcastState(room);
    roomManager._maybeTriggerBots(room);
  });
  socket.on('respondPass', ({ roomId, targetId, declaredType }) => {
    const room = roomManager.getRoom(roomId);
    room.respondPass(socket.id, targetId, declaredType);
    roomManager.broadcastState(room);
    roomManager._maybeTriggerBots(room);
  });
  socket.on('respondGuess', ({ roomId, guessedTruth }) => {
    const room = roomManager.getRoom(roomId);
    room.respondGuess(socket.id, guessedTruth);
    roomManager.broadcastState(room);
    roomManager._maybeTriggerBots(room);
  });
});

const PORT = 4123;

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`test server listening on ${PORT}`);

  const alice = ioClient(`http://localhost:${PORT}`);
  const bob = ioClient(`http://localhost:${PORT}`);

  let leakDetected = false;
  let cardLeakDetails = null;
  let botActionsObserved = 0;
  let lastKnownActivePlayer = null;
  let roomId = null;
  const stateLogAlice = [];

  alice.on('connect', () => {});
  bob.on('connect', () => {});

  alice.on('gameState', (state) => {
    stateLogAlice.push(state);
    // Bug check #1: if there's a pending card and Alice is NOT the current holder,
    // she should never receive a `card` field.
    if (state.pending && state.pending.currentHolderId !== alice.id && state.pending.card) {
      leakDetected = true;
      cardLeakDetails = { viewer: 'alice', pending: state.pending };
    }
    lastKnownActivePlayer = state.activePlayerId;
  });
  bob.on('gameState', (state) => {
    if (state.pending && state.pending.currentHolderId !== bob.id && state.pending.card) {
      leakDetected = true;
      cardLeakDetails = { viewer: 'bob', pending: state.pending };
    }
  });

  await new Promise((resolve) => alice.on('connect', resolve));
  await new Promise((resolve) => bob.on('connect', resolve));

  alice.emit('createRoom', { name: 'Alice' });
  const { roomId: rid } = await new Promise((resolve) => alice.once('roomCreated', resolve));
  roomId = rid;
  console.log('room created:', roomId);

  bob.emit('joinRoom', { roomId, name: 'Bob' });
  await wait(300);

  // Add 2 bots so we can observe bot participation.
  alice.emit('addBot', { roomId });
  alice.emit('addBot', { roomId });
  await wait(300);

  alice.emit('startGame', { roomId });
  await wait(500);

  // Track bot turns/responses by watching the log feed for bot-authored entries
  // over a stretch of real wall-clock time (bots "think" for 700-1800ms).
  let sawBotLogEntry = false;
  let sawHumanTurnResumed = false;
  let priorLoserOfExchangeBecameActive = null;

  alice.on('gameState', (state) => {
    (state.log || []).forEach((entry) => {
      if (/Bot/i.test(entry.msg)) sawBotLogEntry = true;
    });
  });

  // Let the game run driven entirely by bots for a while, playing Alice's own
  // turns automatically (truthful, random target) so the game can progress.
  const maxRounds = 40;
  for (let i = 0; i < maxRounds; i++) {
    await wait(400);
    const state = stateLogAlice[stateLogAlice.length - 1];
    if (!state || state.state === 'GAME_OVER') break;

    const me = state.players.find((p) => p.id === alice.id);
    if (!me) continue;

    if (state.pending && state.pending.currentHolderId === alice.id && state.pending.card) {
      // Alternate between passing (to exercise multi-hop leak checks) and guessing.
      if (state.pending.canPass && i % 2 === 0) {
        const validTargets = state.players.filter((p) => p.id !== alice.id && p.connected && !state.pending.seenBy.includes(p.id));
        if (validTargets.length > 0) {
          const t = validTargets[0];
          alice.emit('respondPass', { roomId, targetId: t.id, declaredType: state.pending.declaredType });
          await wait(200);
          continue;
        }
      }
      // Alice must guess or pass. Record who the "loser" of this exchange should be
      // to check the turn-handoff rule afterward.
      const actualType = state.pending.card.type;
      const guessedTruth = actualType === state.pending.declaredType; // guess correctly on purpose
      alice.emit('respondGuess', { roomId, guessedTruth });
      await wait(200);
      const after = stateLogAlice[stateLogAlice.length - 1];
      if (after && after.lastResolution) {
        const r = after.lastResolution;
        // Per official rules: whoever took the face-up card (the "loser" of the
        // exchange) should become the next active player, not the guesser.
        priorLoserOfExchangeBecameActive = after.activePlayerId === r.recipientId;
      }
    } else if (state.activePlayerId === alice.id && !state.pending) {
      const others = state.players.filter((p) => p.id !== alice.id && p.connected);
      const target = others[Math.floor(Math.random() * others.length)];
      const card = me.hand[0];
      if (card && target) {
        alice.emit('startTurn', { roomId, targetId: target.id, cardId: card.id, declaredType: card.type });
      }
    }
  }

  const finalState = stateLogAlice[stateLogAlice.length - 1];

  console.log('\n=== RESULTS ===');
  console.log('1) Card visibility leak to non-holder:', leakDetected ? `LEAK DETECTED -> ${JSON.stringify(cardLeakDetails)}` : 'none detected (OK)');
  console.log('2) Bot activity observed in log feed:', sawBotLogEntry ? 'YES (OK)' : 'NO BOT ACTIVITY OBSERVED (BUG)');
  console.log('3) After a resolution, next active player = exchange LOSER (recipient of face-up card):',
    priorLoserOfExchangeBecameActive === null ? 'not observed in this run' : priorLoserOfExchangeBecameActive ? 'YES (matches expected rule)' : 'NO — active player was someone else (BUG per requested rule)');
  console.log('Final game state:', finalState ? finalState.state : 'unknown', finalState && finalState.loseReason);

  alice.close();
  bob.close();
  server.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('Integration test crashed:', err);
  process.exit(1);
});
