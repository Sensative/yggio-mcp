# yggio-mcp

En MCP-server som låter Claude arbeta mot Yggio via REST-API:t, inloggad som din egen Yggio-användare.

- Byggd på **MCP SDK v2** (`@modelcontextprotocol/server` 2.4). Den svarar på protokollet **2026-07-28** och faller tillbaka på 2025-handskakningen för äldre klienter, så den fungerar i dagens Claude Code och Claude Desktop.
- Kör lokalt över stdio. Inget behöver driftas, och varje person använder sitt eget konto och sina egna behörigheter.
- Allt ligger i **en fil** (`yggio-mcp.mjs`, cirka 1,2 MB). Det enda som krävs är Node.js 20 eller senare.
- Innehåller en sökbar kopia av hela Yggios API-referens (229 operationer från `storm/externals/swagger` i Sensative/yggio), så Claude kan hitta och anropa vilken endpoint som helst, inte bara de med egna verktyg.

## Verktyg

| Verktyg | Vad det gör |
|---|---|
| `yggio_whoami` | Visar vem du är inloggad som och mot vilken Yggio. Bra första test. |
| `yggio_find_devices` | Listar och filtrerar enheter (iotnodes) med namn, devEui, valfria fält eller `q`-fråga. Ger en kompakt sammanfattning, och `fields`/`full` ger mer. |
| `yggio_get_device` | Hämtar en enhet med alla aktuella värden. |
| `yggio_device_measurements` | Visar vilka mätvärden en enhet har historik för. |
| `yggio_device_history` | Hämtar tidsserien för ett mätvärde. Tider kan anges som ISO-datum, unix-ms eller `now-7d`, och `distance` aggregerar. |
| `yggio_search_api` | Söker i API-referensen ("device groups", "rules", "organization members"…). |
| `yggio_describe_endpoint` | Visar parametrar, request body och svarsschema för en endpoint. |
| `yggio_api_get` | Anropar valfri GET-endpoint. |
| `yggio_api_write` | Anropar POST/PUT/PATCH/DELETE och **ändrar riktig data**. Finns inte med i läsläge. |

Läsverktygen är märkta `readOnlyHint` och skrivverktyget `destructiveHint`. I Claude Code kan du därför godkänna läsverktygen permanent och ändå få en fråga före varje ändring.

## Installera i Claude Code

1. Lägg `yggio-mcp.mjs` någonstans där den får ligga kvar, till exempel `~/tools/yggio-mcp.mjs`.
2. Kontrollera inloggningen:

   ```bash
   YGGIO_URL=https://<din-yggio> YGGIO_USERNAME=<användare> YGGIO_PASSWORD='<lösenord>' \
     node ~/tools/yggio-mcp.mjs --check
   # OK: logged in to https://<din-yggio> as <användare>
   ```

3. Lägg till servern för din användare (gäller i alla projekt):

   ```bash
   claude mcp add yggio --scope user \
     -e YGGIO_URL=https://<din-yggio> \
     -e YGGIO_USERNAME=<användare> \
     -e YGGIO_PASSWORD='<lösenord>' \
     -e YGGIO_READ_ONLY=true \
     -- node ~/tools/yggio-mcp.mjs
   ```

   Börja gärna med `YGGIO_READ_ONLY=true`. Ta bort raden (eller sätt `false`) när du vill att Claude ska kunna ändra saker.

4. Starta `claude` och kör `/mcp`. Där ska `yggio` stå som connected. Fråga till exempel: *"Vilka enheter har inte rapporterat på ett dygn?"* eller *"Visa temperaturen för strips-1 senaste veckan, timvis."*

Lösenordet hamnar i klartext i `~/.claude.json`. Använd gärna ett separat Yggio-konto med bara de behörigheter du vill att Claude ska ha.

## Inloggning via Keycloak (2FA/SSO)

Har ditt konto tvåfaktorsinloggning (OTP) i Keycloak fungerar inte användarnamn och lösenord, eftersom `POST /api/auth/local` inte kan fråga efter koden. Utelämna då `YGGIO_USERNAME` och `YGGIO_PASSWORD`. Servern loggar i stället in på samma sätt som Yggios webbgränssnitt: den öppnar Keycloaks inloggningssida i webbläsaren, där du anger lösenord och engångskod, och tar emot svaret på `http://127.0.0.1:53682/callback`.

```bash
YGGIO_URL=https://<din-yggio> node ~/tools/yggio-mcp.mjs --check   # öppnar webbläsaren första gången
claude mcp add yggio --scope user -e YGGIO_URL=https://<din-yggio> -e YGGIO_READ_ONLY=true -- node ~/tools/yggio-mcp.mjs
```

- Token sparas i `~/.yggio-mcp/tokens.json` (bara läsbar för dig) och delas mellan Claude-sessioner. När den gått ut (Yggio-realmen: 6 h) öppnar servern webbläsaren igen vid nästa anrop. Är du fortfarande inloggad i Keycloak går det igenom direkt, utan ny kod.
- Sätt `BROWSER=none` om webbläsaren inte ska öppnas automatiskt, till exempel över SSH. Adressen skrivs då ut på stderr.
- **Engångsinställning i Keycloak (admin):** lägg till `http://127.0.0.1:53682/*` under *Valid Redirect URIs* för klienten `yggio-services` i realmen `yggio`. Annars svarar Keycloak *Invalid parameter: redirect_uri*. Om porten är upptagen kan du välja en annan med `YGGIO_OAUTH_PORT` och registrera den i stället.

## Installera i Claude Desktop

Dubbelklicka på `yggio-mcp-0.2.0.mcpb` (eller dra in den under *Settings → Extensions*). Fyll sedan i Yggio-adress, användarnamn och lösenord, och välj om den ska vara skrivskyddad. Lämna användarnamn och lösenord tomma om du loggar in med 2FA (se nedan). Lösenordet sparas i operativsystemets nyckelring.

## Inställningar

| Variabel | Betydelse |
|---|---|
| `YGGIO_URL` | Adressen du öppnar Yggio på i webbläsaren. En avslutande `/api` eller `/swagger` tas bort automatiskt. |
| `YGGIO_USERNAME` / `YGGIO_PASSWORD` | Loggar in via `POST /api/auth/local`. Servern loggar in igen själv när token går ut. Utelämnas de (och `YGGIO_TOKEN`) sker inloggningen i webbläsaren via Keycloak, se ovan. |
| `YGGIO_TOKEN` | Alternativ till lösenord, till exempel för konton som bara har SSO. Den förnyas inte, så servern slutar fungera när token går ut. |
| `YGGIO_OAUTH_PORT` | Lokal port för webbläsarinloggningens callback (standard 53682). |
| `YGGIO_READ_ONLY` | `true` tar bort `yggio_api_write`. |
| `YGGIO_TIMEOUT_MS` | Timeout per anrop (standard 30000). |
| `YGGIO_MAX_RESPONSE_CHARS` | Längre svar kortas av med en notis till Claude om att snäva in frågan (standard 60000). |

## Bygga från källkod

```bash
npm install
npm run spec -- <yggio-checkout>/storm/externals/swagger/src  # uppdatera API-referensen från en yggio-checkout
npm test        # typkontroll, bygger dist/yggio-mcp.mjs, kör e2e-tester mot en fejkad Yggio över båda protokollversionerna
npm run mcpb    # bygger dist/yggio-mcp-<version>.mcpb för Claude Desktop
```

`src/generated/openapi.json` är incheckad, så projektet går att bygga utan yggio-repot. Kör bara `npm run spec` när API:t har ändrats.

## Säkerhet

- `yggio_api_get` och `yggio_api_write` når bara sökvägar under `<YGGIO_URL>/api`. Sökvägar med `..`, kodade punkter/snedstreck, `//` eller query-sträng i sökvägen avvisas.
- Servern kan inte göra mer än ditt Yggio-konto får göra, men allt som kontot får göra kan Claude göra via `yggio_api_write`. Använd läsläge eller ett begränsat konto om det inte är vad du vill.

## Licens

MIT, se [LICENSE](LICENSE).
