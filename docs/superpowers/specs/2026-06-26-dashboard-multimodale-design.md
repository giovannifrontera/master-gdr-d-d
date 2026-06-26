# Design — Dashboard multimodale + immagini facoltative (master-dnd)

Data: 2026-06-26
Componente: `master-dnd-plugin`

## Obiettivo

Rendere la sessione di gioco più immersiva sfruttando la capacità multimodale
del modello del bot per generare immagini di scene, NPC, luoghi, oggetti e
ritratti dei personaggi — **senza** che la generazione sia obbligatoria. Chi
usa un modello non multimodale deve avere un'esperienza piena (placeholder SVG),
senza errori né scuse del Game Master.

In parallelo, la dashboard va potenziata molto: scena clou al centro, galleria
NPC/luoghi, schede personaggio complete con tutti gli attributi, relazioni
strutturate, mantenendo la chat (ridotta e riposizionata, sempre disponibile).

## Principi

- **Immagini opzionali**: l'assenza di immagini non è mai un errore di gioco.
- **Path e formato canonici**: se prodotte, le immagini stanno nel path per-run
  corretto e in formato visualizzabile, così la dashboard le mostra sempre.
- **Retro-compatibilità**: stati salvati senza i nuovi campi continuano a
  funzionare (fallback su dati esistenti e su SVG).
- **Nessuna nuova dipendenza**: grafo relazioni e rendering in SVG/JS vanilla.

## 1. Modello dati (stato run)

Stato esistente (riferimento reale): `personaggi[]`, `mondo { locazione, tempo,
npcs_incontrati[] {nome,descrizione,stato}, stato_trame }`, `combattimento`.

Aggiunte (tutte opzionali, retro-compatibili):

### 1.1 Immagine scena corrente
```json
mondo.scena = {
  "immagine": "assets/<slug>.png",   // path RELATIVO alla cartella run
  "didascalia": "testo breve",
  "turno": 12
}
```

### 1.2 Relazioni strutturate
Nuovo campo `relazioni` su personaggi e su NPC:
```json
"relazioni": [
  { "verso": "Kaelen", "tipo": "alleato", "intensita": 2, "nota": "gli deve la vita" }
]
```
- `tipo`: `alleato | rivale | amante | nemico | familiare | mentore | conoscente | ...`
- `intensita`: 1–3 (debole/media/forte) → spessore arco nel grafo.
- Fallback se assente: derivare relazioni da `legami` testuali e da
  `npcs_incontrati[].stato`.

### 1.3 Ritratti
Campo `ritratto` (già normalizzato per i PG: `ritratto|portrait|portrait_url|
avatar|immagine|image_url`) esteso anche agli NPC. Path relativo alla run.

### 1.4 Formato e posizione asset
- Cartella: `wiki-works/avventure/<run_id>/assets/`
- Formati ammessi: `.png` (preferito), `.jpg/.jpeg`, `.webp`.
- Riferimenti nello stato: sempre **relativi** (`assets/<slug>.png`), risolti
  dalla dashboard via rotta `/assets/`.

## 2. Backend (`index.js`)

### 2.1 Rotta statica `/assets/<file>`
Il server dashboard (attuale: `/api/state`, `/api/chat`, `/api/config`, HTML)
aggiunge una rotta che serve i file dalla cartella `assets/` della **run
attiva**:
- Risolve `<run_id>` dall'active run, legge da
  `wiki-works/avventure/<run_id>/assets/<file>`.
- Content-Type per estensione (`png/jpeg/webp`).
- Guardia anti path-traversal: rifiuta `..`, path assoluti, separatori
  sospetti; serve solo file dentro la cartella assets.
- 404 pulito se il file non esiste (la dashboard ricade su SVG).

### 2.2 Tool `rpg_save_image` (opzionale, non distruttivo)
Input:
```
{
  tipo: "scena" | "ritratto" | "luogo" | "oggetto",
  target?: "nome PG/NPC",          // richiesto per ritratto
  source: "<path su disco>" | "data:image/png;base64,...",
  slug?: "nome-file"               // altrimenti derivato da target/tipo+timestamp
}
```
Comportamento:
- Accetta **path su disco** o **base64 inline** (`data:` URI o stringa base64).
- Valida che il contenuto sia un'immagine in formato ammesso (magic bytes).
- Scrive in `wiki-works/avventure/<run_id>/assets/<slug>.<ext>`.
- Registra il riferimento relativo nello stato:
  - `tipo=scena` → `mondo.scena = { immagine, didascalia?, turno }`
  - `tipo=ritratto` → `ritratto` del `target` (PG in `personaggi` o NPC in
    `npcs_incontrati`)
  - `tipo=luogo|oggetto` → ritorna il path (uso libero in narrazione/galleria)
- **Errore soft**: source mancante/formato errato → ritorna `{ ok:false,
  motivo }` senza interrompere il gioco. Nessuna eccezione propagata al ciclo.
- Ritorna `{ ok:true, path:"assets/<slug>.ext" }`.

### 2.3 Normalizzazione `relazioni`
`rpg_create_character` e `rpg_update_state` accettano e normalizzano l'array
`relazioni` (validano `tipo`/`intensita`, scartano voci malformate). Nessun
campo obbligatorio: se assente, non si crea.

## 3. Dashboard (`dashboard.html`) — layout

Tre colonne: **Party (sinistra, stretta)** · **Scena (centro, ampia)** ·
**Chat (destra, ridotta, sempre visibile)**.

### 3.1 Party (sx)
Card compatte cliccabili: ritratto (img reale o SVG per classe) + nome + hp/ca.
Click → seleziona il PG mostrato in dettaglio al centro.

### 3.2 Centro (scena + galleria + scheda)
1. **Immagine clou di scena** in cima: da `mondo.scena.immagine` via `/assets/`;
   fallback a illustrazione SVG d'ambiente + didascalia.
2. **Galleria** NPC/luoghi: miniature (ritratto reale o SVG), nome, stato.
3. **Scheda completa** del PG selezionato con *tutti* gli attributi presenti:
   stats, hp/ca, velocità, bonus competenza, tiri salvezza, abilità,
   competenze, attacchi, incantesimi, inventario, tratti, obiettivo, legami,
   personalità, aspetto. Sistema-agnostico: mostra i campi presenti.
4. In **combattimento**: il centro mostra iniziativa/griglia come oggi.

### 3.3 Relazioni
Pannello nel centro (sotto la scheda) con **grafo** SVG: nodi = PG/NPC, archi
colorati per `tipo`, spessore per `intensita`. Versione lista come fallback se
i dati sono pochi/assenti. Nessuna libreria esterna.

### 3.4 Chat (dx)
Funzioni invariate (WS, invio messaggi). Larghezza ridotta. Sempre attiva
quando non nascosta.

### 3.5 Interazioni
- **Fullscreen / lightbox**: click su immagine scena, ritratto, miniatura
  galleria o scheda PG → overlay a tutto schermo. Chiusura con ESC o click
  fuori. La scheda in fullscreen è leggibile senza compressione.
- **Pannelli comprimibili**: toggle per nascondere la **chat** e/o la colonna
  **destra**; con pannelli nascosti la **scena si allarga**. Stato persistito
  in `localStorage`.

## 4. Skill (`rpg-gm.md`)

Stringere la sezione "Schede personaggio e NPC" / asset visivi:

- **Condizionale esplicita**: «Genera immagini SOLO se disponi di capacità
  multimodale e puoi davvero produrre un'immagine. Altrimenti **non** tentare,
  **non** scusarti, **non** menzionare la mancanza: gioca normalmente.»
- **Strumento**: usare `rpg_save_image` per salvare; mai inventare path a mano.
- **Quando**: cambio di scena clou, comparsa di NPC importante, ritratto di un
  PG, oggetto chiave, o richiesta esplicita del giocatore. Con parsimonia.
- **Path/formato**: ricordare cartella `assets/` per-run e formati ammessi
  (gestiti dal tool).
- **Relazioni**: imporre il campo `relazioni` strutturato quando si crea o
  aggiorna un PG o un NPC rilevante (verso/tipo/intensità), oltre ai `legami`
  narrativi.
- **Regola guida**: l'assenza di immagini non è mai un errore di gioco.

## 5. Out of scope

- Generazione immagini lato server / integrazione con estensioni
  `comfy/fal/runway` (la generazione resta responsabilità del modello).
- Editing immagini, upscaling, cache CDN.
- Mappe tattiche generate (oltre alla griglia di combattimento esistente).

## 6. Verifica

- `rpg_save_image`: self-check con base64 di un PNG 1x1 → file scritto, path
  relativo corretto, riferimento in stato; source invalida → `ok:false` senza
  throw; path-traversal rifiutato dalla rotta `/assets/`.
- Dashboard: con stato che ha `mondo.scena.immagine` e ritratti → mostra
  immagini; senza → SVG; toggle pannelli e lightbox funzionanti.
- Retro-compatibilità: stato vecchio (senza `scena`/`relazioni`) si carica e
  renderizza senza errori.
