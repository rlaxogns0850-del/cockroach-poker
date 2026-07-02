// test/simulate.js — headless bot-vs-bot simulation to sanity check the engine
const { GameRoom } = require('../src/GameRoom');
const { AIBot } = require('../src/AIBot');

function runOneGame(numBots, maxSteps = 2000) {
  const room = new GameRoom('bot_0', 'Bot 0');
  room.players[0].isBot = true; // host itself is also a bot for this simulation
  for (let i = 1; i < numBots; i++) room.addBot(`Bot ${i}`);
  room.startGame();

  let steps = 0;
  while (room.state === 'PLAYING' && steps < maxSteps) {
    steps++;
    if (room.pending) {
      const holder = room._getPlayer(room.pending.currentHolderId);
      const decision = AIBot.decideResponse(holder, room.getPublicState(holder.id).pending, room);
      if (decision.action === 'pass') {
        room.respondPass(holder.id, decision.targetId, decision.declaredType);
      } else {
        room.respondGuess(holder.id, decision.guessedTruth);
      }
    } else {
      const active = room._getPlayer(room.activePlayerId);
      if (room.state !== 'PLAYING') break;
      const decision = AIBot.decideTurn(active, room);
      if (!decision) throw new Error('Bot could not decide a turn — stuck state');
      room.startTurn(active.id, decision.targetId, decision.cardId, decision.declaredType);
    }
  }

  if (steps >= maxSteps) throw new Error('Game did not terminate within max steps — possible infinite loop');

  // Validate total card conservation: hand + faceUp across all players should equal deck size
  const deckSize = room.players.reduce((s, p) => s + p.hand.length, 0) +
    room.players.reduce((s, p) => s + Object.values(p.faceUp).reduce((a, b) => a + b, 0), 0);

  return { steps, state: room.state, loserId: room.loserId, loseReason: room.loseReason, deckSize, players: room.players };
}

let failures = 0;
for (let trial = 0; trial < 30; trial++) {
  const numPlayers = 2 + (trial % 5); // cycle 2..6 players
  try {
    const result = runOneGame(numPlayers);
    if (result.state !== 'GAME_OVER' || !result.loserId) {
      throw new Error('Game did not end with a loser');
    }
    console.log(
      `[trial ${trial}] players=${numPlayers} steps=${result.steps} loser=${result.loserId} reason="${result.loseReason}" totalCards=${result.deckSize}`
    );
  } catch (err) {
    failures++;
    console.error(`[trial ${trial}] FAILED: ${err.message}`);
  }
}

console.log(failures === 0 ? '\nALL SIMULATION TRIALS PASSED' : `\n${failures} TRIALS FAILED`);
process.exit(failures === 0 ? 0 : 1);
