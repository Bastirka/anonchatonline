'use strict';

require('dotenv').config();
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { randomInt } = require('node:crypto');
const { Server } = require('socket.io');
const { Pool } = require('pg');

const WORDS_A = ['ZILA', 'ZALA', 'SARKANA', 'BALTA', 'MELNA', 'DZELTENA', 'PELEKA', 'ROZA', 'VIOLETA', 'BRUNA'];
const WORDS_B = ['TIGERIS', 'LAPSA', 'VILKS', 'LACIS', 'ZAKIS', 'EZIS', 'PUTNS', 'KAKIS', 'SUNS', 'BRIEDIS'];
const RATING_TIMEOUT = 120000;

function createChatServer({ database } = {}) {
  // SSL parametri URL nedrīkst atslēgt piespiedu šifrēšanu.
  let connectionString = process.env.DATABASE_URL;
  if (connectionString) {
    try {
      const url = new URL(connectionString);
      for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'ssl']) url.searchParams.delete(key);
      connectionString = url.toString();
    } catch {
      console.error('❌ DATABASE_URL formāts nav derīgs.');
      connectionString = undefined;
    }
  }
  const pool = database || new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    query_timeout: 5000,
    statement_timeout: 5000
  });
  pool.on('error', () => console.error('❌ Datubāzes savienojuma kļūda.'));
  const app = express();
  const server = http.createServer(app);
  // Noklusējuma ping/pong saglabāts; paketes izmērs ir ierobežots.
  const io = new Server(server, { maxHttpBufferSize: 16384 });
  let waiting = null;
  const sessions = new Set();
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => res.type('text/plain').send('ok'));
  app.use(express.static(path.join(__dirname, 'public')));

  const error = (socket, message) => socket.emit('error-msg', message);
  const lookup = (id) => io.sockets.sockets.get(id);
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const validCode = (value) => typeof value === 'string' && value.length <= 20 && /^[A-Z]+-[A-Z]+-[1-9][0-9]$/.test(value.trim().toUpperCase());
  const cleanMessage = (value) => typeof value === 'string' ? value.slice(0, 500).trim() : '';

  function finishRating(session, event, value) {
    if (session.done) return;
    session.done = true;
    clearTimeout(session.timer);
    sessions.delete(session);
    for (const id of session.ids) {
      const socket = lookup(id);
      if (socket?.ratingSession === session) {
        socket.ratingSession = null;
        socket.myRating = null;
        if (event) socket.emit(event, value);
      }
    }
  }

  function abandonRating(socket) {
    if (socket.ratingSession) finishRating(socket.ratingSession, 'no-pair');
  }

  function leaveRoom(socket) {
    if (!socket.roomCode) return;
    socket.to(socket.roomCode).emit('typing', false);
    socket.to(socket.roomCode).emit('partner-left');
    socket.leave(socket.roomCode);
    socket.roomCode = null;
  }

  function endPair(socket, disconnected = false) {
    if (waiting === socket) waiting = null;
    const partner = lookup(socket.partner);
    socket.partner = null;
    if (!partner || partner.partner !== socket.id) return;
    partner.partner = null;
    const session = { ids: [socket.id, partner.id], done: false, processing: false, timer: null };
    sessions.add(session);
    for (const member of [socket, partner]) {
      member.ratingSession = session;
      member.myRating = null;
      if (member !== socket || !disconnected) {
        member.emit('typing', false);
        member.emit('partner-left');
        member.emit('show-rating');
      }
    }
    session.timer = setTimeout(() => finishRating(session, 'no-pair'), RATING_TIMEOUT);
    session.timer.unref();
  }

  async function generateCode() {
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = `${WORDS_A[randomInt(WORDS_A.length)]}-${WORDS_B[randomInt(WORDS_B.length)]}-${randomInt(10, 100)}`;
      // Viena atomāra operācija pasargā arī no vienlaicīgas kodu sakritības.
      const result = await pool.query('INSERT INTO pairs (code) VALUES ($1) ON CONFLICT (code) DO NOTHING RETURNING code', [code]);
      if (result.rows.length) return code;
    }
    throw new Error('Neizdevās izveidot unikālu kodu.');
  }

  io.on('connection', (socket) => {
    console.log('✅ Čata savienojums izveidots.');
    socket.partner = null;
    socket.roomCode = null;
    socket.ratingSession = null;
    socket.myRating = null;
    let roomRequest = 0;
    let joining = false;
    let tokens = 40;
    let lastRefill = Date.now();
    let codeWindow = Date.now();
    let codeAttempts = 0;

    // Ierobežojums glabājas tikai savienojuma atmiņā, bez IP uzskaites.
    function allowed() {
      const now = Date.now();
      tokens = Math.min(40, tokens + (now - lastRefill) / 100);
      lastRefill = now;
      if (tokens < 1) {
        error(socket, 'Pārāk daudz darbību. Mazliet uzgaidi.');
        return false;
      }
      tokens--;
      return true;
    }
    function noPayload(args) {
      if (!allowed()) return false;
      if (args.length) { error(socket, 'Šai darbībai dati nav nepieciešami.'); return false; }
      return true;
    }

    socket.on('find-partner', (...args) => {
      if (!noPayload(args)) return;
      if (socket.partner || socket.roomCode || joining) return error(socket, 'Vispirms beidz pašreizējo sarunu.');
      abandonRating(socket);
      if (waiting && waiting !== socket && waiting.connected && !waiting.partner && !waiting.roomCode) {
        const partner = waiting;
        waiting = null;
        socket.partner = partner.id;
        partner.partner = socket.id;
        socket.emit('matched');
        partner.emit('matched');
      } else {
        waiting = socket;
        socket.emit('waiting');
      }
    });

    socket.on('message', (value) => {
      if (!allowed()) return;
      const msg = cleanMessage(value);
      if (!msg) return error(socket, 'Ievadi derīgu ziņu.');
      const partner = lookup(socket.partner);
      if (!partner || partner.partner !== socket.id) return error(socket, 'Nav aktīvas sarunas.');
      partner.emit('message', msg);
    });

    socket.on('typing', (value) => {
      if (!allowed()) return;
      if (typeof value !== 'boolean') return error(socket, 'Nederīgs rakstīšanas indikators.');
      if (socket.roomCode) socket.to(socket.roomCode).emit('typing', value);
      else if (socket.partner) lookup(socket.partner)?.emit('typing', value);
    });

    socket.on('end-chat', (...args) => {
      if (!noPayload(args)) return;
      roomRequest++;
      joining = false;
      leaveRoom(socket);
      endPair(socket);
    });

    socket.on('rate', async (data) => {
      if (!allowed()) return;
      if (!object(data) || (data.rating !== 1 && data.rating !== -1)) return error(socket, 'Nederīgs vērtējums.');
      const session = socket.ratingSession;
      if (!session || session.done) return error(socket, 'Nav sarunas, ko novērtēt.');
      if (session.processing || socket.myRating !== null) return;
      socket.myRating = data.rating;
      const partner = lookup(session.ids.find((id) => id !== socket.id));
      if (!partner || partner.ratingSession !== session) return finishRating(session, 'no-pair');
      if (partner.myRating === null) return socket.emit('waiting-rating');
      if (socket.myRating !== 1 || partner.myRating !== 1) return finishRating(session, 'no-pair');
      session.processing = true;
      try {
        const code = await generateCode();
        finishRating(session, 'pair-code', code);
      } catch {
        console.error('❌ Neizdevās saglabāt pāra kodu.');
        if (!session.done) {
          for (const id of session.ids) {
            const member = lookup(id);
            if (member?.ratingSession === session) {
              member.myRating = null;
              error(member, 'Kodu neizdevās saglabāt. Abi varat mēģināt novērtēt vēlreiz.');
              member.emit('show-rating');
            }
          }
          session.processing = false;
        }
      }
    });

    socket.on('use-code', async (data) => {
      if (!allowed()) return;
      if (!object(data) || !validCode(data.code)) return error(socket, 'Ievadi derīgu pāra kodu (līdz 20 rakstzīmēm).');
      if (socket.partner || socket.roomCode || joining) return error(socket, 'Vispirms beidz pašreizējo sarunu.');
      if (Date.now() - codeWindow > 60000) { codeWindow = Date.now(); codeAttempts = 0; }
      if (++codeAttempts > 10) return error(socket, 'Pārāk daudz koda mēģinājumu. Uzgaidi minūti.');
      if (waiting === socket) waiting = null;
      const code = data.code.trim().toUpperCase();
      const request = ++roomRequest;
      joining = true;
      try {
        const result = await pool.query('UPDATE pairs SET last_used = NOW(), use_count = use_count + 1 WHERE code = $1 RETURNING code', [code]);
        if (!socket.connected || request !== roomRequest) return;
        if (!result.rows.length) return error(socket, 'Šāds pāra kods nav atrasts.');
        if ((io.sockets.adapter.rooms.get(code)?.size || 0) >= 2) return error(socket, 'Šajā istabā jau ir divi cilvēki.');
        abandonRating(socket);
        // Noklusējuma atmiņas adapteris pievieno sinhroni: trešais netiek ielaists.
        socket.join(code);
        socket.roomCode = code;
        socket.emit('in-room', code);
        socket.to(code).emit('partner-joined');
        if (io.sockets.adapter.rooms.get(code).size === 2) socket.emit('partner-joined');
      } catch {
        console.error('❌ Neizdevās atvērt pāra istabu.');
        if (socket.connected && request === roomRequest) error(socket, 'Datubāze pašlaik nav pieejama. Mēģini vēlreiz.');
      } finally {
        if (request === roomRequest) joining = false;
      }
    });

    socket.on('room-message', (data) => {
      if (!allowed()) return;
      if (!object(data) || !validCode(data.code)) return error(socket, 'Nederīgi istabas dati.');
      const msg = cleanMessage(data.msg);
      if (!msg) return error(socket, 'Ievadi derīgu ziņu.');
      const code = data.code.trim().toUpperCase();
      if (socket.roomCode !== code || !socket.rooms.has(code)) return error(socket, 'Tu neesi šīs istabas dalībnieks.');
      if ((io.sockets.adapter.rooms.get(code)?.size || 0) < 2) return error(socket, 'Sagaidi otru istabas dalībnieku.');
      socket.to(code).emit('room-message', msg);
    });

    socket.on('disconnect', () => {
      roomRequest++;
      joining = false;
      leaveRoom(socket);
      abandonRating(socket);
      endPair(socket, true);
      // Atvienotajam nav iespējams balsot; partnera balss nevar izveidot kodu.
      socket.ratingSession = null;
      socket.myRating = null;
      console.log('Čata savienojums pārtraukts.');
    });
  });

  async function checkDatabase() {
    try {
      if (!database && !connectionString) throw new Error('Nav DATABASE_URL.');
      await pool.query('SELECT code FROM pairs LIMIT 0');
      console.log('✅ Datubāze un pairs tabula ir pieejama.');
      return true;
    } catch {
      console.error('❌ Datubāze nav gatava. Pārbaudi DATABASE_URL un pairs tabulu; parastais čats turpina darboties.');
      return false;
    }
  }

  async function close() {
    for (const session of sessions) finishRating(session);
    await new Promise((resolve) => io.close(resolve));
    // Atvienošanās laikā var rasties jaunas vērtēšanas sesijas.
    for (const session of sessions) finishRating(session);
    await pool.end();
  }
  return { app, server, io, checkDatabase, close };
}

if (require.main === module) {
  const chat = createChatServer();
  const port = Number(process.env.PORT || 3000);
  chat.server.listen(port, '0.0.0.0', () => console.log(`✅ Anon Čats darbojas portā ${port}.`));
  chat.server.on('error', () => { console.error('❌ Serveri nevar palaist. Pārbaudi PORT.'); process.exitCode = 1; });
  void chat.checkDatabase();
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => process.exit(1), 8000);
    timer.unref();
    try { await chat.close(); } catch { console.error('❌ Kļūda, aizverot savienojumus.'); }
    clearTimeout(timer);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createChatServer };
