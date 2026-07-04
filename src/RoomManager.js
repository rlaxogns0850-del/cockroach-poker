// src/RoomManager.js
const { GameRoom, GameError } = require('./GameRoom');
const { AIBot } = require('./AIBot');

const BOT_THINK_DELAY_MIN = 700;
const BOT_THINK_DELAY_MAX = 1800;

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map(); // roomId -> GameRoom
  }

  // ---------- Room CRUD ----------

  createRoom(hostSocketId, hostName) {
    const room = new GameRoom(hostSocketId, hostName);
    this.rooms.set(room.roomId, room);
    return room;
  }

  getRoom(roomId) {
    const room = this.rooms.get((roomId || '').toUpperCase());
    if (!room) throw new GameError('Room not found', 'ROOM_NOT_FOUND');
    return room;
  }

  deleteRoom(roomId, requesterId) {
    const room = this.getRoom(roomId);
    if (room.hostId !== requesterId) {
      throw new GameError('Only the host can delete the room', 'NOT_HOST');
    }
    this.rooms.delete(roomId);
    return room;
  }

  joinRoom(roomId, socketId, name) {
    const room = this.getRoom(roomId);
    room.addPlayer(socketId, name, false);
    return room;
  }

  leaveRoom(roomId, socketId) {
    const room = this.rooms.get((roomId || '').toUpperCase());
    if (!room) return null;
    room.removePlayer(socketId);
    if (room.isEmpty()) {
      this.rooms.delete(room.roomId);
      return null;
    }
    this._maybeTriggerBots(room);
    return room;
  }

  findRoomBySocket(socketId) {
    for (const room of this.rooms.values()) {
      if (room.players.some((p) => p.id === socketId)) return room;
    }
    return null;
  }

  // ---------- Broadcasting ----------

  broadcastState(room) {
    if (!room) return;
    room.players
      .filter((p) => !p.isBot)
      .forEach((p) => {
        this.io.to(p.id).emit('gameState', room.getPublicState(p.id));
      });
  }

  // ---------- Bot orchestration ----------
  // After any human (or bot) action, check whether a bot now needs to act
  // (either as the current holder of a pending card, or as the active player
  // starting a fresh round) and schedule it with a human-like "thinking" delay.

  _maybeTriggerBots(room) {
    if (room.state !== 'PLAYING') return;

    if (room.pending) {
      const holder = room._getPlayer(room.pending.currentHolderId);
      if (holder && holder.isBot) {
        this._scheduleBotResponse(room, holder.id);
      }
    } else if (room.activePlayerId) {
      const active = room._getPlayer(room.activePlayerId);
      if (active && active.isBot) {
        this._scheduleBotTurn(room, active.id);
      }
    }
  }

  _thinkDelay() {
    return BOT_THINK_DELAY_MIN + Math.random() * (BOT_THINK_DELAY_MAX - BOT_THINK_DELAY_MIN);
  }

  _scheduleBotResponse(room, botId) {
    setTimeout(() => {
      // Room or pending state may have changed (e.g. game ended) by the time this fires.
      const current = this.rooms.get(room.roomId);
      if (!current || current.state !== 'PLAYING' || !current.pending) return;
      if (current.pending.currentHolderId !== botId) return;

      const bot = current._getPlayer(botId);
      const decision = AIBot.decideResponse(bot, current.getPublicState(botId).pending, current);

      try {
        if (decision.action === 'pass') {
          current.respondPass(botId, decision.targetId, decision.declaredType);
        } else {
          current.respondGuess(botId, decision.guessedTruth);
        }
      } catch (err) {
        console.error(`[bot ${botId}] response action failed (${err.message}); forcing a guess fallback`);
        // Fallback: if the chosen action was somehow invalid, force a guess.
        if (current.pending && current.pending.currentHolderId === botId) {
          try {
            current.respondGuess(botId, Math.random() < 0.5);
          } catch (err2) {
            console.error(`[bot ${botId}] guess fallback also failed (${err2.message}); retrying shortly`);
            // Last resort: retry the whole decision loop shortly instead of freezing the game.
            setTimeout(() => this._maybeTriggerBots(current), 500);
          }
        }
      }

      this.broadcastState(current);
      this._maybeTriggerBots(current);
    }, this._thinkDelay());
  }

  _scheduleBotTurn(room, botId) {
    setTimeout(() => {
      const current = this.rooms.get(room.roomId);
      if (!current || current.state !== 'PLAYING') return;
      if (current.activePlayerId !== botId || current.pending) return;

      const bot = current._getPlayer(botId);
      const decision = AIBot.decideTurn(bot, current);
      if (!decision) {
        console.error(`[bot ${botId}] could not decide a turn (no valid targets/cards); retrying shortly`);
        setTimeout(() => this._maybeTriggerBots(current), 500);
        return;
      }

      try {
        current.startTurn(botId, decision.targetId, decision.cardId, decision.declaredType);
      } catch (err) {
        console.error(`[bot ${botId}] startTurn failed (${err.message}); retrying shortly`);
        setTimeout(() => this._maybeTriggerBots(current), 500);
        return;
      }

      this.broadcastState(current);
      this._maybeTriggerBots(current);
    }, this._thinkDelay());
  }
}

module.exports = { RoomManager };
