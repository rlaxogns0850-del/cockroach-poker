// src/GameRoom.js
const { generateDeck, dealCards, BUG_TYPES } = require('./deck');

const STATES = {
  LOBBY: 'LOBBY', // room just created, nobody joined the wait list yet (transient)
  WAITING_ROOM: 'WAITING_ROOM',
  PLAYING: 'PLAYING',
  GAME_OVER: 'GAME_OVER',
};

const MAX_PLAYERS = 6;
const MIN_PLAYERS = 2;

let _roomCounter = 1;
function generateRoomId() {
  // Short, human-typeable room code
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

class GameError extends Error {
  constructor(message, code = 'GAME_ERROR') {
    super(message);
    this.code = code;
  }
}

class GameRoom {
  constructor(hostId, hostName) {
    this.roomId = generateRoomId();
    this.hostId = hostId;
    this.state = STATES.WAITING_ROOM;
    this.players = []; // { id, name, isBot, hand:[], faceUp:{type:count}, connected }
    this.activePlayerId = null;
    this.pending = null; // in-flight card exchange
    this.lastResolution = null;
    this.loserId = null;
    this.loseReason = null;
    this.createdAt = Date.now();
    this.log = []; // human-readable event log for the client feed

    this.addPlayer(hostId, hostName, false);
  }

  // ---------- Player / room management ----------

  addPlayer(id, name, isBot = false) {
    if (this.state !== STATES.WAITING_ROOM) {
      throw new GameError('Cannot join: game already in progress', 'BAD_STATE');
    }
    if (this.players.length >= MAX_PLAYERS) {
      throw new GameError('Room is full', 'ROOM_FULL');
    }
    if (this.players.some((p) => p.id === id)) return;
    this.players.push({
      id,
      name: name || (isBot ? `Bot ${this.players.length + 1}` : `Player ${this.players.length + 1}`),
      isBot,
      hand: [],
      faceUp: {},
      connected: true,
    });
    this._pushLog(`${name} joined the room.`);
  }

  addBot(name) {
    const botId = `bot_${Math.random().toString(36).slice(2, 9)}`;
    this.addPlayer(botId, name || `Bot ${this.players.filter((p) => p.isBot).length + 1}`, true);
    return botId;
  }

  removePlayer(id) {
    const idx = this.players.findIndex((p) => p.id === id);
    if (idx === -1) return;

    if (this.state === STATES.WAITING_ROOM) {
      this.players.splice(idx, 1);
      if (id === this.hostId && this.players.length > 0) {
        this.hostId = this.players[0].id; // migrate host
      }
      return;
    }

    if (this.state === STATES.PLAYING) {
      const player = this.players[idx];
      player.connected = false;
      // A disconnecting player during an active game forfeits as loser.
      this.endGame(id, 'disconnected mid-game');
    }
  }

  isEmpty() {
    return this.players.filter((p) => !p.isBot && p.connected).length === 0;
  }

  // ---------- Game lifecycle ----------

  startGame() {
    if (this.state !== STATES.WAITING_ROOM) {
      throw new GameError('Game already started', 'BAD_STATE');
    }
    if (this.players.length < MIN_PLAYERS) {
      throw new GameError(`Need at least ${MIN_PLAYERS} players`, 'NOT_ENOUGH_PLAYERS');
    }

    const deck = generateDeck(this.players.length);
    const hands = dealCards(deck, this.players.map((p) => p.id));
    this.players.forEach((p) => {
      p.hand = hands[p.id];
      p.faceUp = {};
      BUG_TYPES.forEach((t) => (p.faceUp[t] = 0));
    });

    this.state = STATES.PLAYING;
    this.pending = null;
    this.loserId = null;
    this.loseReason = null;
    this.activePlayerId = this.players[0].id;
    this._pushLog('The game has started!');
    this._checkHandEmptyAtTurnStart();
  }

  endGame(loserId, reason) {
    this.state = STATES.GAME_OVER;
    this.loserId = loserId;
    this.loseReason = reason;
    this.pending = null;
    const loser = this.players.find((p) => p.id === loserId);
    this._pushLog(`${loser ? loser.name : loserId} lost! (${reason})`);
  }

  resetToWaitingRoom() {
    this.state = STATES.WAITING_ROOM;
    this.players.forEach((p) => {
      p.hand = [];
      p.faceUp = {};
    });
    this.activePlayerId = null;
    this.pending = null;
    this.loserId = null;
    this.loseReason = null;
    this.log = [];
  }

  // ---------- Turn flow ----------

  /** Active player passes a card face-down to target, declaring a bug type (may be a lie). */
  startTurn(activePlayerId, targetId, cardId, declaredType) {
    this._assertPlaying();
    if (activePlayerId !== this.activePlayerId) {
      throw new GameError('Not your turn', 'NOT_YOUR_TURN');
    }
    if (this.pending) {
      throw new GameError('A card exchange is already in progress', 'BAD_STATE');
    }
    if (targetId === activePlayerId) {
      throw new GameError('Cannot target yourself', 'BAD_TARGET');
    }
    const target = this._getPlayer(targetId);
    if (!target || !target.connected) throw new GameError('Invalid target', 'BAD_TARGET');
    if (!BUG_TYPES.includes(declaredType)) {
      throw new GameError('Invalid declared bug type', 'BAD_DECLARATION');
    }

    const sender = this._getPlayer(activePlayerId);
    const cardIdx = sender.hand.findIndex((c) => c.id === cardId);
    if (cardIdx === -1) throw new GameError('Card not in hand', 'BAD_CARD');
    const [card] = sender.hand.splice(cardIdx, 1);

    this.pending = {
      card,
      declaredType,
      originalSenderId: activePlayerId,
      lastSenderId: activePlayerId,
      currentHolderId: targetId,
      seenBy: new Set([activePlayerId]),
      path: [{ from: activePlayerId, to: targetId, declaredType }],
    };
    this._pushLog(`${sender.name} passed a card to ${target.name}, calling it "${declaredType}".`);
    return this.pending;
  }

  /** Current holder chooses to look and pass it along instead of guessing. */
  respondPass(playerId, newTargetId, newDeclaredType) {
    this._assertPlaying();
    const pending = this._assertPending(playerId);
    if (newTargetId === playerId) throw new GameError('Cannot pass to yourself', 'BAD_TARGET');

    const validTargets = this.getValidPassTargets(playerId);
    if (validTargets.length === 0) {
      throw new GameError('No one left to pass to \u2014 you must guess', 'MUST_GUESS');
    }
    if (!validTargets.some((p) => p.id === newTargetId)) {
      throw new GameError('That player has already seen this card', 'BAD_TARGET');
    }
    if (newDeclaredType && !BUG_TYPES.includes(newDeclaredType)) {
      throw new GameError('Invalid declared bug type', 'BAD_DECLARATION');
    }

    pending.seenBy.add(playerId);
    pending.lastSenderId = playerId;
    pending.currentHolderId = newTargetId;
    if (newDeclaredType) pending.declaredType = newDeclaredType;
    pending.path.push({ from: playerId, to: newTargetId, declaredType: pending.declaredType });

    const passer = this._getPlayer(playerId);
    const newTarget = this._getPlayer(newTargetId);
    this._pushLog(`${passer.name} passed the card on to ${newTarget.name}, calling it "${pending.declaredType}".`);
    return pending;
  }

  /** Current holder guesses whether the declared type is Truth or Lie. */
  respondGuess(playerId, guessedTruth) {
    this._assertPlaying();
    const pending = this._assertPending(playerId);
    if (typeof guessedTruth !== 'boolean') {
      throw new GameError('guessedTruth must be true (Truth) or false (Lie)', 'BAD_GUESS');
    }
    return this._resolveGuess(playerId, guessedTruth);
  }

  getValidPassTargets(playerId) {
    if (!this.pending) return [];
    return this.players.filter(
      (p) => p.id !== playerId && p.connected && !this.pending.seenBy.has(p.id)
    );
  }

  mustGuess(playerId) {
    return this.pending && this.pending.currentHolderId === playerId && this.getValidPassTargets(playerId).length === 0;
  }

  // ---------- Internal resolution ----------

  _resolveGuess(guesserId, guessedTruth) {
    const pending = this.pending;
    const actualType = pending.card.type;
    const declared = pending.declaredType;
    const isActuallyTrue = actualType === declared;
    const guessedCorrectly = guessedTruth === isActuallyTrue;

    // Correct guess -> the last person who handed off the card (the "sender" in
    // this exchange) takes it face-up. Incorrect guess -> the guesser (receiver) does.
    const recipientId = guessedCorrectly ? pending.lastSenderId : guesserId;
    const recipient = this._getPlayer(recipientId);
    recipient.faceUp[actualType] = (recipient.faceUp[actualType] || 0) + 1;

    this.lastResolution = {
      actualType,
      declaredType: declared,
      wasTruth: isActuallyTrue,
      guesserId,
      guessedTruth,
      guessedCorrectly,
      recipientId,
      path: pending.path,
    };

    const guesser = this._getPlayer(guesserId);
    this._pushLog(
      `${guesser.name} guessed "${guessedTruth ? 'Truth' : 'Lie'}" \u2014 it was actually ${actualType}. ` +
        `${recipient.name} takes the card face-up (now ${recipient.faceUp[actualType]}x ${actualType}).`
    );

    this.pending = null;

    // Check elimination on the player who just received the face-up card.
    if (this._checkFourOfAKind(recipientId)) {
      return this.lastResolution;
    }

    // Next round is started by whoever just resolved the exchange (the guesser).
    this.activePlayerId = guesserId;
    this._checkHandEmptyAtTurnStart();
    return this.lastResolution;
  }

  _checkFourOfAKind(playerId) {
    const player = this._getPlayer(playerId);
    for (const type of Object.keys(player.faceUp)) {
      if (player.faceUp[type] >= 4) {
        this.endGame(playerId, `collected 4x ${type}`);
        return true;
      }
    }
    return false;
  }

  _checkHandEmptyAtTurnStart() {
    const player = this._getPlayer(this.activePlayerId);
    if (player && player.hand.length === 0) {
      this.endGame(player.id, 'ran out of cards at the start of their turn');
      return true;
    }
    return false;
  }

  // ---------- Helpers ----------

  _getPlayer(id) {
    return this.players.find((p) => p.id === id);
  }

  _assertPlaying() {
    if (this.state !== STATES.PLAYING) throw new GameError('Game is not in progress', 'BAD_STATE');
  }

  _assertPending(playerId) {
    if (!this.pending) throw new GameError('No card exchange in progress', 'BAD_STATE');
    if (this.pending.currentHolderId !== playerId) {
      throw new GameError('You are not holding the pending card', 'NOT_YOUR_TURN');
    }
    return this.pending;
  }

  _pushLog(msg) {
    this.log.push({ t: Date.now(), msg });
    if (this.log.length > 100) this.log.shift();
  }

  // ---------- Serialization (hides hidden info per viewer) ----------

  getPublicState(viewerId) {
    return {
      roomId: this.roomId,
      hostId: this.hostId,
      state: this.state,
      activePlayerId: this.activePlayerId,
      loserId: this.loserId,
      loseReason: this.loseReason,
      log: this.log.slice(-30),
      lastResolution: this.lastResolution,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        isBot: p.isBot,
        connected: p.connected,
        handCount: p.hand.length,
        hand: p.id === viewerId ? p.hand : undefined, // only reveal own hand
        faceUp: p.faceUp,
      })),
      pending: this.pending
        ? {
            declaredType: this.pending.declaredType,
            currentHolderId: this.pending.currentHolderId,
            lastSenderId: this.pending.lastSenderId,
            originalSenderId: this.pending.originalSenderId,
            seenBy: Array.from(this.pending.seenBy),
            // Only the current holder is allowed to see the real card face
            card: this.pending.currentHolderId === viewerId ? this.pending.card : undefined,
            canPass: this.getValidPassTargets(this.pending.currentHolderId).length > 0,
          }
        : null,
    };
  }
}

module.exports = { GameRoom, GameError, STATES, MAX_PLAYERS, MIN_PLAYERS };
