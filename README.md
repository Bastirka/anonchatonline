# 🎭 Anon Čats

Anonīms 1:1 čats latviešu valodā: nejauša partnera atrašana, reāllaika ziņas, rakstīšanas indikators un abpusējs sarunas vērtējums. Ja abi izvēlas 👍, serveris saglabā unikālu pāra kodu PostgreSQL datubāzē. Ar šo kodu divi cilvēki var atgriezties kopīgā istabā.

Nav reģistrācijas, profilu, e-pasta vai `localStorage`. Ziņas un vērtējumi glabājas tikai atmiņā; datubāzē glabājas vienīgi pāra kodi un to lietošanas statistika. Node.js ≥18, Express 4, Socket.IO 4, PostgreSQL (`pg`), `dotenv`; viens HTML fails ar iebūvētu CSS un JavaScript, bez būvēšanas soļa.

## Lokāla palaišana

Komandas izpildi projekta saknes mapē, kur atrodas `package.json`:

```sh
npm install
cp .env.example .env
```

Izveido Supabase tabulu pēc tālāk dotās instrukcijas un `.env` failā ievadi savu īsto `DATABASE_URL`. Tā ir PostgreSQL savienojuma adrese ar datubāzes paroli, nevis Supabase API atslēga. Paroles īpašās rakstzīmes savienojuma URL ir jākodē procentu formātā.

```dotenv
DATABASE_URL=postgresql://postgres.PROJEKTA_ID:PAROLE@TAVA_POOLER_ADRESE:5432/postgres
PORT=3000
```

```sh
npm start
```

Atver <http://localhost:3000> divos pārlūkos vai divās cilnēs un abās spied **Sākt čatu**. Sūti ziņas, beidz sarunu un abās pusēs nospied 👍. Nokopē saņemto kodu, abās pusēs atgriezies sākumā un ievadi kodu. Kodam jāsakrīt abās pusēs.

Bez konfigurētas datubāzes serveris un nejaušais čats darbojas, bet pāra koda izveide un izmantošana nav pieejama. Pilnam scenārijam nepieciešama datubāze un `pairs` tabula. Serveris startējot pārbauda abas un izvada ✅ vai ❌. `/health` vienmēr atgriež `ok`, kamēr HTTP serveris darbojas; tā ir servera dzīvības, nevis DB gatavības pārbaude.

## Supabase datubāze

1. Izveido projektu [Supabase](https://supabase.com/dashboard) un saglabā datubāzes paroli.
2. Projekta **SQL Editor** izpildi zemāk norādīto shēmu.
3. Projekta **Connect** dialogā izvēlies PostgreSQL **Session pooler**, portu `5432`. Nokopē tieši savam projektam norādīto adresi un aizvieto paroles vietturi. Šis pieslēgums der ilgstoši strādājošam Node serverim un atbalsta IPv4.
4. Saglabā adresi lokālajā `.env` un vēlāk Render `DATABASE_URL` mainīgajā. `.env` nedrīkst publicēt Git repozitorijā.

```sql
CREATE TABLE IF NOT EXISTS pairs (
    code VARCHAR(20) PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_used TIMESTAMPTZ,
    use_count INT DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_pairs_last_used ON pairs(last_used);
```

Ja tabula pieejama arī Supabase Data API, SQL Editor papildus izpildi:

```sql
ALTER TABLE pairs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE pairs FROM anon, authenticated;
```

Lietotnes serveris pieslēdzas tieši ar PostgreSQL datubāzes lietotāju. Pārlūkam netiek dotas DB paroles vai tiesības nolasīt kodu tabulu. Savienojums izmanto pieprasīto `ssl: { rejectUnauthorized: false }`: dati ir šifrēti, bet sertifikāta autentiskums netiek pārbaudīts.

Savienojumu veidi: [Supabase PostgreSQL dokumentācija](https://supabase.com/docs/guides/database/connecting-to-postgres).

## Izvietošana Render

1. Ievieto projekta failus GitHub vai GitLab repozitorija saknē. Iekļauj `package-lock.json`; neiekļauj `.env` un `node_modules`.
2. Render panelī izvēlies **New → Blueprint** un savieno repozitoriju.
3. Render nolasīs `render.yaml`: Node web serviss, Frankfurt, `free`, `npm install`, `npm start`, veselības pārbaude `/health`.
4. Blueprint izveides laikā ievadi **DATABASE_URL** — to pašu Supabase Session pooler savienojuma adresi.
5. Pēc izvietošanas atver Render piešķirto HTTPS adresi divos pārlūkos un pārbaudi sarunu. `PORT` Render piešķir pats; serveris klausās uz `0.0.0.0`.

SQL shēmai Supabase jābūt izveidotai pirms pilnā scenārija lietošanas. Nav atsevišķu frontend mainīgo vai būvēšanas soļa. Socket.IO pieslēdzas tai pašai adresei, no kuras ielādēta lapa.

Blueprint saglabā prasīto Node `18.20.0`; kods ir saderīgs ar Node ≥18. Vajadzības gadījumā `NODE_VERSION` vari nomainīt. [Render Blueprint dokumentācija](https://render.com/docs/blueprint-spec).

## Izvietošana Vercel

Repozitorijā ir arī `api/index.mjs` un `vercel.json`. Tie eksportē HTTP/Socket.IO serveri kā Vercel Function; Vercel vidē klients pieslēdzas funkcijas `/api/index/socket.io` ceļam, bet lokāli un Render vidē izmanto `/socket.io`. Sākumlapa un citi `public/` faili tiek pasniegti no Vercel CDN.

Vercel projekta **Settings → Environment Variables** pievieno `DATABASE_URL` visām vajadzīgajām vidēm un pēc tam veic jaunu deployment. WebSocket atbalsts Vercel pašlaik ir publiskā beta. Savienojums tiek piesaistīts vienai Function instancei, bet nākamais savienojums var nonākt citā instancē. Tādēļ šīs versijas procesa atmiņā glabātais matchmaking ir uzticams uz viena ilgstoša Node procesa (Render), bet Vercel mērogošanas laikā tam vajadzīga kopīga stāvokļa glabātuve, piemēram, Redis. Produkcijai ar garantētu pāru atrašanu izmanto Render konfigurāciju vai pārvieto gaidīšanas rindu uz Redis.

## Kā tas strādā

- Viens gaidošs savienojums (`waiting`) sagaida nākamo; abiem tiek uzstādīts `socket.partner` un nosūtīts `matched`.
- Ziņas ir līdz 500 rakstzīmēm, renderētas ar `textContent`. Rakstīšanas indikators nodziest pēc 1,5 sekundēm bez ievades.
- Beidzot sarunu, abu aktīvās partneru saites tiek notīrītas. Atsevišķa pagaidu vērtēšanas sesija ļauj abiem balsot vēl līdz divām minūtēm. Atvienots partneris vairs nevar balsot; pāra kodu šajā gadījumā neizsniedz.
- Tikai divi 👍 izveido kodu. `crypto.randomInt()` izvēlas latviešu krāsu un dzīvnieku vārdus bez diakritiskajām zīmēm, kā arī skaitli 10–99, piemēram, `ZILA-TIGERIS-42`. Atomārs `INSERT ... ON CONFLICT` ar ne vairāk kā desmit mēģinājumiem nodrošina unikalitāti.
- Koda istabā var atrasties līdz diviem savienojumiem. Kods ir vienīgā piekļuves atslēga: jebkurš tā zinātājs var ieiet, ja ir brīva vieta. Identitāte netiek pārbaudīta.
- `last_used` un `use_count` atjauninās pie derīga koda pārbaudes, arī ja istaba pēc pārbaudes izrādās pilna. Kodi automātiski nebeidz darboties.
- Ja koda saglabāšana neizdodas, abi var atkārtoti balsot atlikušajā vērtēšanas laikā. DB kļūda nepārtrauc citus čatus.
- Atvienošanās un jaunas sarunas notīra iepriekšējo stāvokli. Socket.IO automātiski atjauno transporta savienojumu ar noklusējuma ping/pong, bet iepriekšējo sarunu neatjauno. Istabai var pievienoties vēlreiz ar kodu.

## Pārbaudes

```sh
npm test
```

Integrācijas testi izmanto īstu HTTP/Socket.IO serveri, vairākus klientus un imitētu datubāzi. Tie pārbauda savienošanu, ziņas, vērtēšanu, kodu sadursmes, istabu piekļuvi un datubāzes kļūmes. Dzīva Supabase datubāze tiem nav nepieciešama; īstā PostgreSQL pieslēgšanās jāpārbauda ar savu `DATABASE_URL`.

## Darbības robežas

Lieto vienu Node procesu un vienu Render instanci: gaidīšana, aktīvās sarunas un istabas ir procesa atmiņā. Restarts pārtrauc sarunas; PostgreSQL saglabātie kodi paliek derīgi. Vairākām instancēm vajadzīga kopīga pāru meklēšana un Socket.IO adapteris.

Lietotne neglabā ziņu vēsturi vai lietotāju identitāti, taču tas nav pilnīgas tīkla anonimitātes vai pilnīgas šifrēšanas starp gala lietotājiem solījums. Serveris apstrādā ziņas. Īss, cilvēkam lasāms kods nav augstas entropijas parole. Iebūvēti vienkārši darbību un koda mēģinājumu ierobežojumi katram savienojumam; pēc atkārtotas pieslēgšanās tie sākas no jauna. Saglabā kodu pats un nepublicē to.
