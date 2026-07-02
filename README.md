# Cockroach Poker (\uBC14\uAD34\uBC8C\uB808 \uD3EC\uCEE4)

A full-stack, production-ready web implementation of Cockroach Poker with real-time
multiplayer rooms and a psychologically-modeled AI bot for single-player.

## Stack

- **Backend:** Node.js + Express + Socket.io (same pattern as your `dalmuti-game` project)
- **Frontend:** Vanilla JS + Socket.io client + Tailwind CDN, no build step. Visual design
  and Korean copy match the "속임수의 법칙" neon cyberpunk mockups (Montserrat / Space Mono /
  Geist, the exact custom color token set, glass-panel + neon-glow treatment).
- **Architecture:** One authoritative `GameRoom` state machine per room, driving both
  human sockets and AI bots through the *exact same* validated code path — a bot's
  action is just another `startTurn` / `respondPass` / `respondGuess` call, scheduled
  by `RoomManager` with a human-like "thinking" delay instead of arriving over a socket.

## Run it

```bash
npm install
npm start
```

Then open `http://localhost:3000` in a few browser tabs (or share your machine's LAN
IP for friends on the same network, or deploy to Render like your other Socket.io
projects).

## Project layout

```
server.js              Express + Socket.io wiring, event validation, error responses
src/deck.js             64-card deck generation (8 types x 8 copies), shuffle, deal
src/GameRoom.js          Core state machine: rooms, turns, passing, guessing, loss checks
src/AIBot.js             AI decision logic (risk aversion, bluff estimation, targeting)
src/RoomManager.js       Tracks all rooms; schedules bot "thinking" after every action
public/index.html        Lobby(rules) / waiting room / game table / propose+pass modals / game-over — all in Korean
public/client.js         Socket event handling + rendering for the neon UI
test/simulate.js         Headless bot-vs-bot engine test (run: node test/simulate.js)
```

## Rules implemented

- **Deck:** 8 bug types x 8 copies = 64 cards. For 2-player games the pool is
  automatically trimmed to 6 types (48 cards) for a faster, tighter game — still
  8 copies per included type. Dealt round-robin at game start.
- **Loss conditions** (checked every resolution and at the start of every turn):
  1. A player collects 4 face-up cards of the same bug type.
  2. The active player's hand is empty when their turn begins.
  - The triggering player is the absolute loser — there is no winner, only survivors.
- **Turn flow:**
  1. Active player picks a card from their hand, a target, and declares a bug type
     (truthfully or as a bluff) — `startTurn`.
  2. The holder of the face-down card chooses:
     - **Guess** (`respondGuess`): call "Truth" or "Lie". Correct guess \u2192 the person
       who just handed them the card takes it face-up. Incorrect guess \u2192 the holder
       takes it face-up themselves.
     - **Pass** (`respondPass`): look at the real card privately, then hand it to
       anyone who hasn't seen it yet this round, keeping or changing the declared type.
  3. Once every other player has already seen the card, the current holder has no one
     left to pass to and is server-side forced into a guess (`getValidPassTargets` /
     `mustGuess`).
  4. Whoever resolves the guess becomes the next active player and starts a new round.

## Room & connection management

- `createRoom` / `joinRoom` / `leaveRoom` / `deleteRoom` (host-only) all validated
  server-side against the room's current state machine (`WAITING_ROOM` / `PLAYING` /
  `GAME_OVER`).
- Leaving mid-`WAITING_ROOM` simply removes you from the list (host migrates if the
  host leaves). Disconnecting mid-`PLAYING` immediately forfeits you as the loser so
  the game resolves gracefully instead of hanging.
- Deleting a room (host-only) force-disconnects every socket in that room and the
  client redirects everyone back to the lobby.
- All actions are turn/holder validated server-side (`GameError` with codes like
  `NOT_YOUR_TURN`, `BAD_TARGET`, `MUST_GUESS`) — a client can't act out of turn even
  by forging socket events.

## AI bot algorithm

Implemented in `src/AIBot.js`, driven identically for single-player (bots fill empty
seats in a normal room) and as extra "players" in any multiplayer room:

**When receiving a pending card (`decideResponse`):**
- *Risk factor:* if the bot already has 2 of the declared type face-up, it passes
  ~60% of the time instead of guessing; at 3+, ~85% of the time — real risk aversion,
  not just randomness, and it only ever passes to players who haven't already seen the
  card that round.
- *Bluff estimation:* counts every card visible to the bot (its own hand + all
  players' face-up piles) to estimate how many copies of the declared type are still
  unseen, and derives `P(truth)` from that ratio — a bot that's already looking at 5
  of the 8 "Rat" cards knows a newly-declared "Rat" is probably a lie.
- A flat **15% noise factor** randomizes the read entirely on some turns to avoid
  perfectly optimal, robotic play.

**When starting a turn (`decideTurn`):**
- *Aggressive targeting:* 70% of the time it targets whichever opponent (human or
  bot) already has 2-3 of one bug type face-up, to press an existing advantage.
- *Bluffing ratio:* 65% truth / 35% bluff by default; against a vulnerable target it
  shifts to 45% truth / 55% bluff, and its bluffs specifically name the bug type the
  target is already stacking — baiting a risk-averse pass or a bad guess.

`test/simulate.js` runs 30 full bot-vs-bot games across 2-6 players headlessly through
the real engine to confirm games always terminate with exactly one loser and full card
conservation (no cards created/lost).
