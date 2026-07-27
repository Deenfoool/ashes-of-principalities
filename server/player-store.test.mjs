import test from 'node:test'
import assert from 'node:assert/strict'
import { GameStore } from './store.mjs'
import { PlayerStore } from './player-store.mjs'

const requestId = (label) => `${label}_${crypto.randomUUID().replaceAll('-', '')}`

function setup() {
  const store = new GameStore(':memory:')
  const players = new PlayerStore(store)
  const account = store.register({
    username: `hero_${Math.random().toString(36).slice(2, 9)}`,
    password: '12345678',
    displayName: 'Испытатель',
  })
  return { store, players, user: account.user }
}

test('character creation and expedition start are idempotent', () => {
  const { store, players, user } = setup()
  try {
    const createId = requestId('create')
    const first = players.createCharacter(user.id, {
      requestId: createId,
      name: 'Ратибор',
      profession: 'hunter',
    })
    const repeated = players.createCharacter(user.id, {
      requestId: createId,
      name: 'Другое имя',
      profession: 'scribe',
    })
    assert.deepEqual(repeated, first)
    assert.equal(first.character.name, 'Ратибор')

    const startId = requestId('start')
    const started = players.startExpedition(user.id, { requestId: startId, contractId: 'ash-wolf' })
    const duplicate = players.startExpedition(user.id, { requestId: startId, contractId: 'drowned-dead' })
    assert.equal(duplicate.character.activeExpedition.id, started.character.activeExpedition.id)
    assert.equal(players.getCharacter(user.id).stamina, first.character.stamina - 2)
  } finally {
    store.close()
  }
})

test('repeating the final combat request cannot duplicate rewards', () => {
  const { store, players, user } = setup()
  try {
    players.createCharacter(user.id, {
      requestId: requestId('create'),
      name: 'Милован',
      profession: 'blacksmith',
    })
    let state = players.startExpedition(user.id, {
      requestId: requestId('start'),
      contractId: 'ash-wolf',
    })
    let finalId = ''
    for (let turn = 0; turn < 12 && state.character.activeExpedition; turn += 1) {
      finalId = requestId(`hit${turn}`)
      state = players.actExpedition(user.id, {
        requestId: finalId,
        expeditionId: state.character.activeExpedition.id,
        action: 'profession',
      })
    }
    assert.equal(state.character.activeExpedition, null)
    assert.equal(state.character.completedContracts, 1)
    const rewardedCoins = state.character.coins
    const repeated = players.actExpedition(user.id, {
      requestId: finalId,
      expeditionId: 'ignored-on-receipt',
      action: 'profession',
    })
    assert.equal(repeated.character.coins, rewardedCoins)
    assert.equal(repeated.character.completedContracts, 1)
  } finally {
    store.close()
  }
})

test('guild donation deducts real character coins exactly once', () => {
  const { store, players, user } = setup()
  try {
    store.createGuild(user.id, { name: 'Северный круг', tag: 'СК' })
    const created = players.createCharacter(user.id, {
      requestId: requestId('create'),
      name: 'Добромир',
      profession: 'scribe',
    })
    const before = created.character.coins
    const donationId = requestId('donate')
    const first = players.donateCoins(user.id, { requestId: donationId, amount: 5 })
    const repeated = players.donateCoins(user.id, { requestId: donationId, amount: 5 })
    assert.equal(first.character.coins, before - 5)
    assert.equal(repeated.character.coins, before - 5)
    assert.equal(repeated.guild.treasuryCoins, 5)
    assert.equal(store.getTreasuryLog(user.id).length, 1)
  } finally {
    store.close()
  }
})

test('a dead hero can be replaced by an heir while legacy remains', () => {
  const { store, players, user } = setup()
  try {
    players.createCharacter(user.id, {
      requestId: requestId('create'),
      name: 'Первый',
      profession: 'scribe',
    })
    const started = players.startExpedition(user.id, {
      requestId: requestId('start'),
      contractId: 'drowned-dead',
    })
    let state = started
    for (let turn = 0; turn < 20 && state.character.alive; turn += 1) {
      state = players.actExpedition(user.id, {
        requestId: requestId(`wait${turn}`),
        expeditionId: state.character.activeExpedition.id,
        action: 'prepare',
      })
    }
    assert.equal(state.character.alive, false)
    const glory = state.character.legacyGlory
    const heir = players.createHeir(user.id, {
      requestId: requestId('heir'),
      name: 'Второй',
      profession: 'hunter',
    })
    assert.equal(heir.character.alive, true)
    assert.equal(heir.character.generation, 2)
    assert.equal(heir.character.legacyGlory, glory)
  } finally {
    store.close()
  }
})
