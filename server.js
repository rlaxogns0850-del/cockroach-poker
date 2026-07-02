// server.js
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { RoomManager } = require('./src/RoomManager');
const { GameError } = require('./src/GameRoom');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const roomManager = new RoomManager(io);

function fail(socket, event, err) {
  const message = err instanceof GameError ? err.message : 'Something went wrong.';
  const code = err instanceof GameError ? err.code : 'UNKNOWN';
  socket.emit('errorMessage', { event, code, message });
}

io.on('connection', (socket) => {
  // ---------- Room management ----------

  socket.on('createRoom', ({ name }) => {
    try {
      const room = roomManager.createRoom(socket.id, name || 'Host');
      socket.join(room.roomId);
      socket.emit('roomCreated', { roomId: room.roomId });
      roomManager.broadcastState(room);
    } catch (err) {
      fail(socket, 'createRoom', err);
    }
  });

  socket.on('joinRoom', ({ roomId, name }) => {
    try {
      const room = roomManager.joinRoom(roomId, socket.id, name || 'Player');
      socket.join(room.roomId);
      socket.emit('roomJoined', { roomId: room.roomId });
      roomManager.broadcastState(room);
    } catch (err) {
      fail(socket, 'joinRoom', err);
    }
  });

  socket.on('leaveRoom', ({ roomId }) => {
    try {
      const room = roomManager.leaveRoom(roomId, socket.id);
      socket.leave(roomId);
      if (room) roomManager.broadcastState(room);
    } catch (err) {
      fail(socket, 'leaveRoom', err);
    }
  });

  socket.on('deleteRoom', ({ roomId }) => {
    try {
      const room = roomManager.deleteRoom(roomId, socket.id);
      io.to(room.roomId).emit('roomDeleted');
      io.in(room.roomId).socketsLeave(room.roomId);
    } catch (err) {
      fail(socket, 'deleteRoom', err);
    }
  });

  socket.on('addBot', ({ roomId, name }) => {
    try {
      const room = roomManager.getRoom(roomId);
      if (room.hostId !== socket.id) throw new GameError('Only the host can add bots', 'NOT_HOST');
      room.addBot(name);
      roomManager.broadcastState(room);
    } catch (err) {
      fail(socket, 'addBot', err);
    }
  });

  socket.on('removeBot', ({ roomId, botId }) => {
    try {
      const room = roomManager.getRoom(roomId);
      if (room.hostId !== socket.id) throw new GameError('Only the host can remove bots', 'NOT_HOST');
      room.removePlayer(botId);
      roomManager.broadcastState(room);
    } catch (err) {
      fail(socket, 'removeBot', err);
    }
  });

  socket.on('startGame', ({ roomId }) => {
    try {
      const room = roomManager.getRoom(roomId);
      if (room.hostId !== socket.id) throw new GameError('Only the host can start the game', 'NOT_HOST');
      room.startGame();
      roomManager.broadcastState(room);
      roomManager._maybeTriggerBots(room);
    } catch (err) {
      fail(socket, 'startGame', err);
    }
  });

  socket.on('rematch', ({ roomId }) => {
    try {
      const room = roomManager.getRoom(roomId);
      if (room.hostId !== socket.id) throw new GameError('Only the host can start a rematch', 'NOT_HOST');
      room.resetToWaitingRoom();
      roomManager.broadcastState(room);
    } catch (err) {
      fail(socket, 'rematch', err);
    }
  });

  // ---------- Gameplay ----------

  socket.on('startTurn', ({ roomId, targetId, cardId, declaredType }) => {
    try {
      const room = roomManager.getRoom(roomId);
      room.startTurn(socket.id, targetId, cardId, declaredType);
      roomManager.broadcastState(room);
      roomManager._maybeTriggerBots(room);
    } catch (err) {
      fail(socket, 'startTurn', err);
    }
  });

  socket.on('respondPass', ({ roomId, targetId, declaredType }) => {
    try {
      const room = roomManager.getRoom(roomId);
      room.respondPass(socket.id, targetId, declaredType);
      roomManager.broadcastState(room);
      roomManager._maybeTriggerBots(room);
    } catch (err) {
      fail(socket, 'respondPass', err);
    }
  });

  socket.on('respondGuess', ({ roomId, guessedTruth }) => {
    try {
      const room = roomManager.getRoom(roomId);
      room.respondGuess(socket.id, guessedTruth);
      roomManager.broadcastState(room);
      roomManager._maybeTriggerBots(room);
    } catch (err) {
      fail(socket, 'respondGuess', err);
    }
  });

  // ---------- Disconnect ----------

  socket.on('disconnect', () => {
    const room = roomManager.findRoomBySocket(socket.id);
    if (!room) return;
    try {
      const result = roomManager.leaveRoom(room.roomId, socket.id);
      if (result) roomManager.broadcastState(result);
    } catch (_) {
      /* ignore */
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Cockroach Poker server running on http://localhost:${PORT}`);
});
