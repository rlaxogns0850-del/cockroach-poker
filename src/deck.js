// src/deck.js
// Card pool: 8 bug types x 8 copies = 64 cards (dynamically trimmed for small player counts)

const BUG_TYPES = [
  'Cockroach',
  'Bat',
  'Fly',
  'Toad',
  'Rat',
  'Scorpion',
  'StinkBug',
  'Mosquito',
];

const BUG_META = {
  Cockroach: { emoji: '\u{1FAB3}', ko: '\uBC14\uAD34\uBC8C\uB808' },
  Bat: { emoji: '\u{1F987}', ko: '\uBC15\uC950' },
  Fly: { emoji: '\u{1FAB0}', ko: '\uD30C\uB9AC' },
  Toad: { emoji: '\u{1F438}', ko: '\uB450\uAEB0\uAC1C\uAD6C\uB9AC' },
  Rat: { emoji: '\u{1F400}', ko: '\uC950' },
  Scorpion: { emoji: '\u{1F982}', ko: '\uC804\uAC08' },
  StinkBug: { emoji: '\u{1FAB2}', ko: '\uB178\uB791\uC7A5\uBBF8' },
  Mosquito: { emoji: '\u{1F99F}', ko: '\uBAA8\uAE30' },
};

let _cardIdCounter = 1;
function nextCardId() {
  return `card_${_cardIdCounter++}`;
}

/**
 * Builds a full shuffled deck.
 * For very small player counts (<=3) we can optionally trim the number of
 * bug TYPES (not copies) so the game ends faster / matches physical rules
 * more closely, while always keeping 8 copies per included type.
 */
function generateDeck(playerCount = 4) {
  let typesToUse = BUG_TYPES;
  if (playerCount <= 2) {
    // 2-player quick mode: fewer types, faster elimination
    typesToUse = BUG_TYPES.slice(0, 6);
  }

  const deck = [];
  for (const type of typesToUse) {
    for (let i = 0; i < 8; i++) {
      deck.push({ id: nextCardId(), type });
    }
  }
  return shuffle(deck);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Deals the full deck round-robin across players. Returns map playerId -> [cards] */
function dealCards(deck, playerIds) {
  const hands = {};
  playerIds.forEach((id) => (hands[id] = []));
  deck.forEach((card, idx) => {
    const pid = playerIds[idx % playerIds.length];
    hands[pid].push(card);
  });
  return hands;
}

module.exports = { BUG_TYPES, BUG_META, generateDeck, shuffle, dealCards };
