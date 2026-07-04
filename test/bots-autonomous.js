// test/bots-autonomous.js — makes every seat a bot (including the host seat) and
// then does NOTHING but wait, to prove the timer-based bot scheduler alone can
// carry a full game through RoomManager/GameRoom to GAME_OVER.
const http = require('http');
const { Server } = require('socket.io');
const { io: ioClient } = require('socket.io-client');
const { RoomManager } = require('../src/RoomManager');

const server = http.createServer();
const io = new Server(server);
const roomManager = new RoomManager(io);

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name }) => {
    const room = roomManager.createRoom(socket.id, name);
    socket.join(room.roomId);
    socket.emit('roomCreated', { roomId: room.roomId });
  });
  socket.on('addBot', ({ roomId }) => {
    roomManager.getRoom(roomId).addBot();
  });
  socket.on('startGame', ({ roomId }) => {
    const room = roomManager.getRoom(roomId);
    room.players[0].isBot = true; // convert the host seat itself into a bot
    room.startGame();
    roomManager.broadcastState(room);
    roomManager._maybeTriggerBots(room);
  });
  socket.on('getState', ({ roomId }, cb) => {
    const room = roomManager.getRoom(roomId);
    cb(room.getPublicState(socket.id));
  });
});

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  await new Promise((resolve) => server.listen(4124, resolve));
  const client = ioClient('http://localhost:4124');
  await new Promise((resolve) => client.on('connect', resolve));

  client.emit('createRoom', { name: 'HostBot' });
  const { roomId } = await new Promise((resolve) => client.once('roomCreated', resolve));
  client.emit('addBot', { roomId });
  client.emit('addBot', { roomId });
  client.emit('addBot', { roomId });
  await wait(200);
  client.emit('startGame', { roomId });

  const botNamesSeenActing = new Set();
  let lastLogLen = 0;
  let finalState = null;

  for (let i = 0; i < 500; i++) { // up to ~2.5 minutes of real time
    await wait(300);
    const state = await new Promise((resolve) => client.emit('getState', { roomId }, resolve));
    (state.log || []).slice(lastLogLen).forEach((entry) => {
      const m = entry.msg.match(/^(\S+)/);
      if (m) botNamesSeenActing.add(m[1]);
      console.log('  log:', entry.msg);
    });
    lastLogLen = (state.log || []).length;
    if (state.state === 'GAME_OVER') {
      finalState = state;
      break;
    }
  }

  console.log('\n=== AUTONOMOUS BOT RUN RESULT ===');
  console.log('Distinct actors seen in log:', Array.from(botNamesSeenActing));
  console.log('Reached GAME_OVER purely via bot timers:', !!finalState);
  if (finalState) console.log('Loser:', finalState.loserId, 'Reason:', finalState.loseReason);

  client.close();
  server.close();
  process.exit(finalState ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
