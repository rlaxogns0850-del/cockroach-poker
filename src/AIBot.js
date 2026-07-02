// src/AIBot.js
// Smart-ish AI for Cockroach Poker: risk aversion, bluff-probability estimation,
// aggressive targeting of vulnerable players, and a human-like bluffing ratio.
const { BUG_TYPES } = require('./deck');

const TOTAL_PER_TYPE = 8;
const NOISE_FACTOR = 0.15; // 15% chance to ignore the read and act "unpredictably"
const BASE_TRUTH_CHANCE = 0.65; // 65% truth / 35% bluff baseline
const VULNERABLE_TRUTH_CHANCE = 0.45; // 55% bluff chance when hunting a vulnerable player

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Counts all cards currently visible to this bot: its own hand + every face-up pile. */
function countVisibleCards(bot, players) {
  const visible = {};
  BUG_TYPES.forEach((t) => (visible[t] = 0));
  bot.hand.forEach((c) => {
    if (visible[c.type] !== undefined) visible[c.type]++;
  });
  players.forEach((p) => {
    Object.entries(p.faceUp || {}).forEach(([type, count]) => {
      if (visible[type] !== undefined) visible[type] += count;
    });
  });
  return visible;
}

/** Estimates P(declared type is the truth) from the bot's visible information, given a total deck size. */
function estimateTruthProbability(bot, declaredType, players, deckTypeCount) {
  const visible = countVisibleCards(bot, players);
  const totalCards = deckTypeCount * TOTAL_PER_TYPE;
  const seenTotal = Object.values(visible).reduce((a, b) => a + b, 0);
  const unseenTotal = Math.max(totalCards - seenTotal - 1, 1); // -1 for the pending card itself
  const seenOfType = visible[declaredType] || 0;
  const unseenOfType = Math.max(TOTAL_PER_TYPE - seenOfType, 0);

  let prob = unseenOfType / unseenTotal;
  prob = Math.min(Math.max(prob, 0.05), 0.95);
  return prob;
}

function mostStackedType(player) {
  let best = null;
  Object.entries(player.faceUp || {}).forEach(([type, count]) => {
    if (count > 0 && (!best || count > best.count)) best = { type, count };
  });
  return best;
}

class AIBot {
  /**
   * Called when the bot is the currentHolder of a pending card exchange.
   * Returns either { action: 'pass', targetId, declaredType } or { action: 'guess', guessedTruth }.
   */
  static decideResponse(bot, pendingPublic, room) {
    const declaredType = pendingPublic.declaredType;
    const riskCount = (bot.faceUp && bot.faceUp[declaredType]) || 0;
    const validTargets = room.getValidPassTargets(bot.id);
    const canPass = validTargets.length > 0;

    // --- Risk aversion: the higher our own pile of this bug, the more we want to dodge it ---
    if (canPass) {
      let passChance = 0.2; // baseline strategic pass, even at low risk
      if (riskCount === 2) passChance = 0.6;
      if (riskCount >= 3) passChance = 0.85;

      if (Math.random() < passChance) {
        const newTarget = AIBot._choosePassTarget(bot, validTargets);
        const newDeclaredType = AIBot._maybeRelabel(declaredType);
        return { action: 'pass', targetId: newTarget.id, declaredType: newDeclaredType };
      }
    }

    // --- Otherwise, guess: estimate bluff probability from visible cards, + noise ---
    const deckTypeCount = room.players.length <= 2 ? 6 : BUG_TYPES.length;
    let truthProb = estimateTruthProbability(bot, declaredType, room.players, deckTypeCount);

    if (Math.random() < NOISE_FACTOR) {
      truthProb = Math.random(); // simulate a "gut feeling" / human unpredictability
    }

    const guessedTruth = truthProb >= 0.5;
    return { action: 'guess', guessedTruth };
  }

  /** When passing along, a bot may keep or change the declared type to keep bluffing alive. */
  static _maybeRelabel(currentDeclared) {
    if (Math.random() < 0.3) {
      return randomChoice(BUG_TYPES.filter((t) => t !== currentDeclared).concat([currentDeclared]));
    }
    return currentDeclared;
  }

  static _choosePassTarget(bot, validTargets) {
    // Prefer passing to whoever looks safest to burden (lowest current risk for the declared type is
    // irrelevant to us as passer; we simply prefer a semi-random target to avoid predictability)
    return randomChoice(validTargets);
  }

  /**
   * Called when it's the bot's turn to actively start a round: pick a target, a card, and a declaration.
   */
  static decideTurn(bot, room) {
    const others = room.players.filter((p) => p.id !== bot.id && p.connected && p.hand.length >= 0);
    if (others.length === 0 || bot.hand.length === 0) return null;

    // --- Aggressive targeting: prioritize players (human or bot) sitting on 2-3 of one type ---
    const vulnerable = others
      .map((p) => ({ player: p, stacked: mostStackedType(p) }))
      .filter((x) => x.stacked && x.stacked.count >= 2)
      .sort((a, b) => b.stacked.count - a.stacked.count);

    let target;
    let vulnerableType = null;
    if (vulnerable.length > 0 && Math.random() < 0.7) {
      target = vulnerable[0].player;
      vulnerableType = vulnerable[0].stacked.type;
    } else {
      target = randomChoice(others);
    }

    const card = randomChoice(bot.hand);

    // --- Bluffing logic ---
    const truthChance = vulnerableType ? VULNERABLE_TRUTH_CHANCE : BASE_TRUTH_CHANCE;
    let declaredType;
    const tellTruth = Math.random() < truthChance;

    if (tellTruth) {
      declaredType = card.type;
    } else if (vulnerableType) {
      // Bluff by naming the exact bug type the target is already vulnerable to,
      // to bait them into a risk-averse pass or a panicked wrong guess.
      declaredType = vulnerableType;
    } else {
      declaredType = randomChoice(BUG_TYPES.filter((t) => t !== card.type));
    }

    return { targetId: target.id, cardId: card.id, declaredType };
  }
}

module.exports = { AIBot, estimateTruthProbability, countVisibleCards, mostStackedType };
