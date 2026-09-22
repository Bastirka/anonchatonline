'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { io } = require('socket.io-client');
const { createChatServer } = require('../server');

// Datubāzes aizvietotājs ļauj pārbaudīt kļūmes bez īstas paroles.
class TestDatabase extends EventEmitter {
  constructor() { super(); this.codes = new Set(); this.failed = false; this.collisions = 0; this.inserts = 0; this.delay = null; }
  async query(sql, params) {
    if (this.failed) throw new Error('Testa datubāze nav pieejama.');
    if (sql.startsWith('SELECT')) return { rows: [] };
    if (sql.startsWith('INSERT')) {
      this.inserts++;
      if (this.collisions-- > 0 || this.codes.has(params[0])) return { rows: [] };
      this.codes.add(params[0]);
      return { rows: [{ code: params[0] }] };
    }
    if (sql.startsWith('UPDATE')) {
      if (this.delay) await this.delay;
      return { rows: this.codes.has(params[0]) ? [{ code: params[0] }] : [] };
    }
    throw new Error('Negaidīts SQL.');
  }
  async end() {}
}

function event(socket, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, handler); reject(new Error('Nav saņemts notikums: ' + name)); }, 2000);
    function handler(value) { clearTimeout(timer); resolve(value); }
    socket.once(name, handler);
  });
}

async function setup(t, count = 2) {
  const database = new TestDatabase();
  const chat = createChatServer({ database });
  await new Promise((resolve) => chat.server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + chat.server.address().port;
  const clients = [];
  t.after(async () => { for (const socket of clients) socket.disconnect(); await chat.close(); });
  for (let i = 0; i < count; i++) {
    const socket = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    clients.push(socket);
    await event(socket, 'connect');
  }
  return { chat, database, clients, url };
}

async function match(a, b) {
  const waiting = event(a, 'waiting');
  a.emit('find-partner');
  await waiting;
  const ready = Promise.all([event(a, 'matched'), event(b, 'matched')]);
  b.emit('find-partner');
  await ready;
}

async function end(a, b) {
  const rating = Promise.all([event(a, 'show-rating'), event(b, 'show-rating')]);
  a.emit('end-chat');
  await rating;
}

async function vote(a, b, second = 1, result = 'pair-code') {
  const waiting = event(a, 'waiting-rating');
  a.emit('rate', { rating: 1 });
  await waiting;
  const ready = Promise.all([event(a, result), event(b, result)]);
  b.emit('rate', { rating: second });
  return ready;
}

test('Pilna saruna, divi vērtējumi un atkārtota satikšanās', async (t) => {
  const { clients: [a, b], database, url, chat } = await setup(t);
  assert.equal(await (await fetch(url + '/health')).text(), 'ok');
  assert.match(await (await fetch(url)).text(), /Sarunājies/);
  assert.equal(await chat.checkDatabase(), true);
  await match(a, b);
  const message = event(b, 'message');
  a.emit('message', 'Čau!');
  assert.equal(await message, 'Čau!');
  const typing = event(a, 'typing');
  b.emit('typing', true);
  assert.equal(await typing, true);
  await end(a, b);
  assert.equal(chat.io.sockets.sockets.get(a.id).partner, null);
  assert.equal(chat.io.sockets.sockets.get(b.id).partner, null);
  const [code, otherCode] = await vote(a, b);
  assert.equal(code, otherCode);
  assert.match(code, /^[A-Z]+-[A-Z]+-[1-9][0-9]$/);
  assert.ok(code.length <= 20);
  assert.ok(database.codes.has(code));
  for (const socket of [a, b]) {
    const joined = event(socket, 'in-room');
    socket.emit('use-code', { code: code.toLowerCase() });
    assert.equal(await joined, code);
  }
  const roomMessage = event(a, 'room-message');
  b.emit('room-message', { code, msg: 'Atkal satikāmies!' });
  assert.equal(await roomMessage, 'Atkal satikāmies!');
  const left = event(a, 'partner-left');
  b.emit('end-chat');
  await left;
  const rejoined = event(a, 'partner-joined');
  b.emit('use-code', { code });
  await rejoined;
});

test('Noraidīts vērtējums neizveido kodu; atkārtotas balsis nedublē kodus', async (t) => {
  const { clients: [a, b], database } = await setup(t);
  await match(a, b);
  await end(a, b);
  await vote(a, b, -1, 'no-pair');
  assert.equal(database.codes.size, 0);
  await match(a, b);
  await end(a, b);
  const received = await vote(a, b);
  assert.equal(received[0], received[1]);
  const invalid = event(a, 'error-msg');
  a.emit('rate', { rating: 1 });
  await invalid;
  assert.equal(database.inserts, 1);
});

test('Atvienošanās atbrīvo partneri un gaidīšanas rindu', async (t) => {
  const { clients: [a, b, c], chat } = await setup(t, 3);
  await match(a, b);
  const disconnected = event(b, 'show-rating');
  a.disconnect();
  await disconnected;
  assert.equal(chat.io.sockets.sockets.get(b.id).partner, null);
  const noCode = event(b, 'no-pair');
  b.emit('rate', { rating: 1 });
  await noCode;
  const waiting = event(c, 'waiting');
  c.emit('find-partner');
  await waiting;
  c.disconnect();
  const stillWaiting = event(b, 'waiting');
  b.emit('find-partner');
  await stillWaiting;
});

test('Validācija, 500 rakstzīmes, istabas tiesības un trešā dalībnieka aizliegums', async (t) => {
  const { clients: [a, b, c], database } = await setup(t, 3);
  for (const [name, payload] of [['find-partner', {}], ['message', {}], ['typing', 'true'], ['rate', { rating: '1' }], ['use-code', { code: 'x'.repeat(21) }], ['room-message', null]]) {
    const rejected = event(c, 'error-msg');
    c.emit(name, payload);
    await rejected;
  }
  await match(a, b);
  const message = event(b, 'message');
  a.emit('message', 'x'.repeat(600));
  assert.equal((await message).length, 500);
  await end(a, b);
  const code = 'ZILA-LAPSA-42';
  database.codes.add(code);
  const forbidden = event(c, 'error-msg');
  c.emit('room-message', { code, msg: 'Sveši dati' });
  await forbidden;
  for (const socket of [a, b]) {
    const joined = event(socket, 'in-room');
    socket.emit('use-code', { code });
    await joined;
  }
  const full = event(c, 'error-msg');
  c.emit('use-code', { code });
  assert.match(await full, /divi/);
  const stranger = event(c, 'error-msg');
  c.emit('room-message', { code, msg: 'Nepiederoša ziņa' });
  await stranger;
  const literal = event(b, 'room-message');
  a.emit('room-message', { code, msg: '<img src=x onerror=alert(1)>' });
  assert.equal(await literal, '<img src=x onerror=alert(1)>');
});

test('DB kļūme nepārtrauc čatu; vērtējumu var atkārtot pēc atjaunošanas', async (t) => {
  const { clients: [a, b], database, chat } = await setup(t);
  database.failed = true;
  assert.equal(await chat.checkDatabase(), false);
  const failure = event(a, 'error-msg');
  a.emit('use-code', { code: 'ZILA-LAPSA-42' });
  await failure;
  await match(a, b);
  await end(a, b);
  const retry = Promise.all([event(a, 'show-rating'), event(b, 'show-rating')]);
  await vote(a, b, 1, 'error-msg');
  await retry;
  database.failed = false;
  await vote(a, b);
  assert.equal(database.codes.size, 1);
});

test('Kodu sadursmes tiek atkārtotas, bet ne vairāk kā desmit reizes', async (t) => {
  const { clients: [a, b], database } = await setup(t);
  database.collisions = 9;
  await match(a, b);
  await end(a, b);
  await vote(a, b);
  assert.equal(database.inserts, 10);
  database.collisions = 10;
  await match(a, b);
  await end(a, b);
  await vote(a, b, 1, 'error-msg');
  assert.equal(database.inserts, 20);
  assert.equal(database.codes.size, 1);
});

test('Atcelta lēna DB atbilde neievieto lietotāju vecajā istabā', async (t) => {
  const { clients: [a, b], database, chat } = await setup(t);
  database.codes.add('ZILA-LAPSA-42');
  let release;
  database.delay = new Promise((resolve) => { release = resolve; });
  a.emit('use-code', { code: 'ZILA-LAPSA-42' });
  a.emit('end-chat');
  await match(a, b);
  release();
  // Nākamā ziņa apliecina, ka saglabājusies jaunā saruna.
  const received = event(b, 'message');
  a.emit('message', 'Jaunā saruna');
  await received;
  assert.equal(chat.io.sockets.sockets.get(a.id).roomCode, null);
  assert.equal(chat.io.sockets.sockets.get(a.id).partner, b.id);
});
